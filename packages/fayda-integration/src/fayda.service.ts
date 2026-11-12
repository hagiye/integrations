import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import * as crypto from "node:crypto";
import { readIdentityFields } from "./fayda.claims";
import type { FaydaUserinfoClaims } from "./fayda.claims";
import { FaydaClient } from "./fayda.client";
import { FaydaError } from "./fayda.errors";
import { FAYDA_HOST, FaydaEvent, FaydaHost, FaydaHostRefusal, FaydaSessionRecord } from "./fayda.host";
import { safeEqual } from "./fayda.jose";
import { FAYDA_OPTIONS, ResolvedFaydaOptions } from "./fayda.options";
import { CODE_PATTERN, STATE_PATTERN, codeChallengeS256, createCodeVerifier, randomToken, sha256Hex } from "./fayda.pkce";
import { FaydaProofPayload, issueFaydaProof, verifyFaydaProof } from "./fayda.proof";
import {
  FAYDA_FAILURES,
  FaydaBrowserBinding,
  FaydaCompleteInput,
  FaydaCompleteResult,
  FaydaFailed,
  FaydaFailureCode,
  FaydaIdentity,
  FaydaStartInput,
  FaydaStartResult,
  FaydaTokenAnswer,
} from "./fayda.types";

const PURPOSE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A reason fit for logs and the session row: the error's code, never its message. */
function reasonOf(prefix: string, err: unknown): string {
  if (err instanceof FaydaError) return `${prefix}:${err.details.code ?? err.kind}`;
  return `${prefix}:unexpected`;
}

/**
 * The Fayda verification flow, on top of FaydaClient and your FaydaHost:
 *
 * - start(): a session (state, nonce, PKCE verifier, optional browser binding) stored by the
 *   host, and the authorize URL to send the browser to.
 * - complete(): eSignet's redirect back. Claims the session once, checks expiry and binding,
 *   exchanges the code, verifies the ID token and the signed userinfo, hands the verified
 *   identity to the host, closes the session. Never throws for a failed verification: it
 *   returns FAILED with a code, an HTTP status and a message for the user.
 *
 * Nothing here links accounts. The host links by sub; phone and email matches are only reported.
 */
@Injectable()
export class FaydaService<R = unknown> {
  private readonly logger = new Logger("FaydaService");

  constructor(
    @Inject(FAYDA_OPTIONS) private readonly options: ResolvedFaydaOptions,
    private readonly client: FaydaClient,
    @Optional() @Inject(FAYDA_HOST) private readonly host?: FaydaHost<R>,
  ) {}

  /** Creates a session and returns the authorize URL, plus the binding cookie to set. */
  async start(input: FaydaStartInput = {}): Promise<FaydaStartResult> {
    if (!this.options.enabled) throw new FaydaError("CONFIG", "Fayda is switched off", { code: "FAYDA_DISABLED" });
    const host = this.requireHost();
    const channel = str(input.channel) || this.options.defaultChannel;
    const redirectUri = this.options.redirectUris[channel];
    if (!redirectUri) throw new FaydaError("INVALID", `Unknown channel ${JSON.stringify(channel).slice(0, 40)}`);
    const purpose = str(input.purpose) || "VERIFY";
    if (!PURPOSE_PATTERN.test(purpose)) throw new FaydaError("INVALID", "purpose must be 1 to 32 letters, digits, _ or -");
    const accountId = input.accountId === undefined || input.accountId === null ? null : str(input.accountId);
    if (accountId !== null && (!accountId || accountId.length > 200)) throw new FaydaError("INVALID", "accountId must be 1 to 200 characters");
    const prompt = input.prompt === undefined ? this.options.prompt : input.prompt || undefined;

    const now = new Date();
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = createCodeVerifier();
    const bind = input.bindBrowser !== false && !this.options.browserBinding.unboundChannels.includes(channel);
    const binding = bind ? randomToken() : undefined;
    const session: FaydaSessionRecord = {
      id: crypto.randomUUID(),
      state,
      nonce,
      codeVerifier,
      browserBindingHash: binding ? sha256Hex(binding) : null,
      purpose,
      channel,
      redirectUri,
      accountId,
      status: "PENDING",
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.options.sessionTtlMs),
      metadata: input.metadata ?? null,
    };
    await host.createSession(session);
    await this.record({ at: now, type: "START", sessionId: session.id, purpose, channel, accountId });
    this.logger.log(`Fayda verification started: session=${session.id} purpose=${purpose} channel=${channel}`);
    return {
      sessionId: session.id,
      authorizationUrl: this.client.authorizationUrl({
        state,
        nonce,
        codeChallenge: codeChallengeS256(codeVerifier),
        redirectUri,
        prompt,
        userinfoClaims: input.userinfoClaims,
      }),
      state,
      channel,
      expiresAt: session.expiresAt,
      ...(binding ? { browserBinding: this.bindingCookie(state, binding) } : {}),
    };
  }

  /**
   * eSignet's redirect back (?code&state, or ?error&state). See the class comment. Two calls
   * with one state: the host's claimSession lets only one through; the other gets
   * FAYDA_INVALID_STATE without eSignet being called.
   */
  async complete(input: FaydaCompleteInput): Promise<FaydaCompleteResult<R>> {
    if (!this.options.enabled) return this.failure("FAYDA_DISABLED", "disabled");
    const host = this.requireHost();
    const state = str(input.state);
    const code = str(input.code);
    const error = str(input.error);

    if (error) {
      const errorCode = /^[A-Za-z0-9_.-]{1,64}$/.test(error) ? error : "invalid_error_value";
      const session = STATE_PATTERN.test(state) ? await host.claimSession(state) : null;
      if (session) await this.end(session, "FAILED", "FAYDA_AUTH_ERROR", `esignet:${errorCode}`);
      return this.fail(session, "FAYDA_AUTH_ERROR", `esignet:${errorCode}`);
    }
    if (!code || !state) return this.failure("FAYDA_MISSING_PARAMETERS", "missing_code_or_state");
    if (!STATE_PATTERN.test(state)) {
      await this.record({ at: new Date(), type: "INVALID_STATE", code: "FAYDA_INVALID_STATE", reason: "malformed_state" });
      return this.failure("FAYDA_INVALID_STATE", "malformed_state");
    }
    if (!CODE_PATTERN.test(code)) return this.failure("FAYDA_MISSING_PARAMETERS", "malformed_code");

    const session = await host.claimSession(state);
    if (!session) {
      // Unknown, used or closed: possibly a forged or replayed redirect. eSignet is not called.
      await this.record({ at: new Date(), type: "INVALID_STATE", code: "FAYDA_INVALID_STATE", reason: "no_pending_session" });
      this.logger.warn("Fayda completion with an unknown or used state");
      return this.failure("FAYDA_INVALID_STATE", "no_pending_session");
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.end(session, "EXPIRED", "FAYDA_SESSION_EXPIRED", "session_expired");
      return this.fail(session, "FAYDA_SESSION_EXPIRED", "session_expired");
    }
    if (session.browserBindingHash) {
      const given = str(input.browserBinding);
      if (!given || !safeEqual(sha256Hex(given), session.browserBindingHash)) {
        await this.end(session, "FAILED", "FAYDA_BINDING_MISMATCH", given ? "binding_mismatch" : "binding_missing");
        return this.fail(session, "FAYDA_BINDING_MISMATCH", given ? "binding_mismatch" : "binding_missing");
      }
    }

    let tokens: FaydaTokenAnswer;
    try {
      tokens = await this.client.exchangeCode({ code, codeVerifier: session.codeVerifier, redirectUri: session.redirectUri });
    } catch (err) {
      return this.failAndEnd(session, "FAYDA_TOKEN_EXCHANGE_FAILED", reasonOf("token", err));
    }

    let subject: string | undefined;
    let acr: string | undefined;
    let authTime: Date | undefined;
    if (tokens.id_token) {
      try {
        const verified = await this.client.verifyIdToken(tokens.id_token, { nonce: session.nonce, accessToken: tokens.access_token });
        subject = verified.facts.sub;
        acr = verified.facts.acr;
        authTime = verified.facts.authTime;
      } catch (err) {
        return this.failAndEnd(session, "FAYDA_TOKEN_INVALID", reasonOf("id_token", err));
      }
    } else if (this.options.requireIdToken) {
      return this.failAndEnd(session, "FAYDA_TOKEN_INVALID", "id_token:missing");
    } else {
      // requireIdToken off and no ID token: no nonce check, and the userinfo's own sub is taken.
      subject = undefined;
    }

    let claims: Record<string, unknown>;
    let signed: boolean;
    try {
      const userinfo = await this.client.fetchUserinfo(tokens.access_token, subject);
      claims = userinfo.claims;
      signed = userinfo.signed;
    } catch (err) {
      return this.failAndEnd(session, "FAYDA_USERINFO_FAILED", reasonOf("userinfo", err));
    }

    const identity: FaydaIdentity = {
      ...readIdentityFields(claims as FaydaUserinfoClaims),
      clientId: this.options.clientId,
      ...(acr ? { acr } : {}),
      ...(authTime ? { authTime } : {}),
      verifiedAt: new Date(),
      userinfoSigned: signed,
      claims,
    };

    let possibleMatches: string[] = [];
    if (host.findContactMatches) {
      try {
        possibleMatches = await host.findContactMatches(identity);
      } catch (err) {
        this.logger.warn(`Fayda findContactMatches failed for session ${session.id}: ${(err as Error).message}`);
      }
    }

    let result: R;
    try {
      result = await host.onVerified(identity, { session, possibleMatches });
    } catch (err) {
      if (err instanceof FaydaHostRefusal) {
        await this.end(session, "FAILED", err.code, "host_refused");
        await this.record({ at: new Date(), type: "COMPLETE_FAIL", sessionId: session.id, purpose: session.purpose, channel: session.channel, accountId: session.accountId, code: err.code, reason: "host_refused" });
        return {
          outcome: "FAILED",
          code: err.code,
          httpStatus: err.httpStatus,
          message: err.message,
          reason: "host_refused",
          sessionId: session.id,
          channel: session.channel,
        };
      }
      this.logger.error(`Fayda onVerified failed for session ${session.id}: ${(err as Error).message}`);
      return this.failAndEnd(session, "FAYDA_INTERNAL_ERROR", "host_error");
    }

    await this.end(session, "COMPLETED");
    await this.record({ at: new Date(), type: "COMPLETE_OK", sessionId: session.id, purpose: session.purpose, channel: session.channel, accountId: session.accountId });
    this.logger.log(`Fayda verification completed: session=${session.id} channel=${session.channel}`);
    const proof = this.options.proof ? this.issueProof(identity.sub, session.id) : undefined;
    return {
      outcome: "VERIFIED",
      sessionId: session.id,
      purpose: session.purpose,
      channel: session.channel,
      accountId: session.accountId,
      identity,
      result,
      ...(proof ? { proof } : {}),
    };
  }

  /** The binding cookie's name for a state: the prefix plus 16 hex characters of its hash. */
  bindingCookieName(state: string): string {
    return `${this.options.browserBinding.cookiePrefix}${sha256Hex(str(state)).slice(0, 16)}`;
  }

  /** Set-Cookie to clear a session's binding cookie after completion. */
  clearBindingCookie(state: string): string {
    return this.cookieHeader(this.bindingCookieName(state), "", 0);
  }

  /** Where the built-in callback sends the browser for this result, or undefined (answer JSON). */
  returnUrlFor(result: FaydaCompleteResult<R>): string | undefined {
    const channel = result.outcome === "VERIFIED" ? result.channel : result.channel ?? this.options.defaultChannel;
    const urls = this.options.returnUrls[channel];
    if (!urls) return undefined;
    const target = new URL(result.outcome === "VERIFIED" ? urls.success : urls.failure);
    if (result.outcome === "VERIFIED") target.searchParams.set("result", result.sessionId);
    else target.searchParams.set("error", result.code);
    return target.toString();
  }

  /** A signed proof that `sub` was verified in session `sessionId`. CONFIG without options.proof. */
  issueProof(sub: string, sessionId: string): string {
    if (!this.options.proof) throw new FaydaError("CONFIG", "proof.secret is not set");
    return issueFaydaProof(
      { sub, clientId: this.options.clientId, sessionId, ttlMs: this.options.proof.ttlMs },
      this.options.proof.secrets[0],
    );
  }

  /** The proof's payload when it is ours, fresh, and for this sub; otherwise null. Never throws. */
  verifyProof(token: unknown, sub: string): FaydaProofPayload | null {
    if (!this.options.proof || typeof sub !== "string" || !sub.trim()) return null;
    return verifyFaydaProof(token, { sub, clientId: this.options.clientId }, this.options.proof.secrets);
  }

  private bindingCookie(state: string, value: string): FaydaBrowserBinding {
    const cookieName = this.bindingCookieName(state);
    return { cookieName, value, setCookie: this.cookieHeader(cookieName, value, Math.floor(this.options.sessionTtlMs / 1000)) };
  }

  private cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
    const b = this.options.browserBinding;
    const parts = [`${name}=${value}`, `Path=${b.cookiePath}`, `Max-Age=${maxAgeSeconds}`, "HttpOnly", `SameSite=${b.sameSite}`];
    if (b.secureCookie || b.sameSite === "None") parts.push("Secure");
    return parts.join("; ");
  }

  private requireHost(): FaydaHost<R> {
    if (!this.host) throw new FaydaError("CONFIG", "FaydaService needs a host (FaydaModule host option)");
    return this.host;
  }

  private failure(code: FaydaFailureCode, reason: string): FaydaFailed {
    return { outcome: "FAILED", code, httpStatus: FAYDA_FAILURES[code].httpStatus, message: FAYDA_FAILURES[code].message, reason };
  }

  private async fail(session: FaydaSessionRecord | null, code: FaydaFailureCode, reason: string): Promise<FaydaFailed> {
    await this.record({
      at: new Date(),
      type: "COMPLETE_FAIL",
      sessionId: session?.id,
      purpose: session?.purpose,
      channel: session?.channel,
      accountId: session?.accountId,
      code,
      reason,
    });
    this.logger.warn(`Fayda verification failed: session=${session?.id ?? "none"} code=${code} reason=${reason}`);
    return { ...this.failure(code, reason), ...(session ? { sessionId: session.id, channel: session.channel } : {}) };
  }

  private async failAndEnd(session: FaydaSessionRecord, code: FaydaFailureCode, reason: string): Promise<FaydaFailed> {
    await this.end(session, "FAILED", code, reason);
    return this.fail(session, code, reason);
  }

  private async end(
    session: FaydaSessionRecord,
    status: "COMPLETED" | "FAILED" | "EXPIRED",
    errorCode?: string,
    errorDescription?: string,
  ): Promise<void> {
    try {
      await this.requireHost().endSession(session.id, { status, errorCode, errorDescription, at: new Date() });
    } catch (err) {
      this.logger.error(`Fayda endSession failed for session ${session.id}: ${(err as Error).message}`);
    }
  }

  private async record(event: FaydaEvent): Promise<void> {
    if (!this.host?.recordEvent) return;
    try {
      await this.host.recordEvent(event);
    } catch (err) {
      this.logger.warn(`Fayda recordEvent failed: ${(err as Error).message}`);
    }
  }
}
