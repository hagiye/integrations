import { Inject, Injectable } from "@nestjs/common";
import * as crypto from "node:crypto";
import type { Agent } from "node:https";
import { FaydaError } from "./fayda.errors";
import { HttpAnswer, httpCall } from "./fayda.http";
import { DecodedJws, FaydaJwsAlg, compactParts, decodeJws, signJws, verifyJws } from "./fayda.jose";
import { JwksCache, parseJwks } from "./fayda.jwks";
import { FAYDA_OPTIONS, ResolvedFaydaOptions, missingFaydaOptions } from "./fayda.options";
import { IdTokenFacts, checkIdTokenClaims, checkUserinfoClaims } from "./fayda.tokens";
import { createFaydaAgent } from "./fayda.tls";
import type { FaydaTokenAnswer } from "./fayda.types";

export interface AuthorizationUrlInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  prompt?: string;
  userinfoClaims?: string[];
}

export interface VerifiedIdToken {
  claims: Record<string, unknown>;
  facts: IdTokenFacts;
  alg: FaydaJwsAlg;
}

export interface VerifiedUserinfo {
  claims: Record<string, unknown>;
  signed: boolean;
}

/** An OAuth error code from an error answer, safe to log: [a-z0-9_.-], at most 64 characters. */
export function oauthErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

function readJson(answer: HttpAnswer, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    throw new FaydaError("HTTP", `${name} answered something that is not JSON`, { status: answer.status, code: "NOT_JSON", sent: true });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FaydaError("HTTP", `${name} answered JSON that is not an object`, { status: answer.status, code: "NOT_JSON", sent: true });
  }
  return parsed as Record<string, unknown>;
}

/**
 * The calls to eSignet, usable without Nest: `new FaydaClient(resolveFaydaOptions({...}))`.
 * Builds the authorize URL, signs the client assertion, exchanges the code, fetches the key
 * set and verifies the ID token and the signed userinfo. Holds no session state.
 *
 * The constructor refuses unusable options (CONFIG): a missing endpoint, an unreadable key,
 * insecureTls for a fayda.et host.
 */
@Injectable()
export class FaydaClient {
  readonly jwks: JwksCache;
  private readonly agent: Agent;

  constructor(@Inject(FAYDA_OPTIONS) private readonly options: ResolvedFaydaOptions) {
    if (options.enabled) {
      const problems = missingFaydaOptions(options);
      if (problems.length > 0) {
        throw new FaydaError("CONFIG", `Fayda options missing or unsafe: ${problems.join(", ")}`);
      }
    }
    this.agent = createFaydaAgent({ ca: options.ca, insecureTls: options.insecureTls });
    this.jwks = new JwksCache(() => this.fetchJwks(), {
      cacheMs: options.jwksCacheMs,
      minRefreshMs: options.jwksMinRefreshMs,
      maxStaleMs: options.jwksMaxStaleMs,
    });
  }

  /**
   * The authorize URL, with EDR's parameters in EDR's order, plus nonce (EDR sent none) and
   * prompt when set. Every requested userinfo claim is essential, so eSignet shows them locked
   * on the consent screen.
   */
  authorizationUrl(input: AuthorizationUrlInput): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: "code",
      redirect_uri: input.redirectUri,
      scope: this.options.scope,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      acr_values: this.options.acrValues,
      claims_locales: this.options.claimsLocales,
    });
    if (this.options.uiLocales) params.set("ui_locales", this.options.uiLocales);
    if (input.prompt) params.set("prompt", input.prompt);
    const userinfo: Record<string, { essential: true }> = {};
    for (const claim of input.userinfoClaims ?? this.options.userinfoClaims) userinfo[claim] = { essential: true };
    params.set("claims", JSON.stringify({ userinfo, id_token: {} }));
    const separator = this.options.authorizationEndpoint.includes("?") ? "&" : "?";
    return `${this.options.authorizationEndpoint}${separator}${params.toString()}`;
  }

  /** A fresh private_key_jwt assertion: iss = sub = client_id, aud = the token endpoint. Never reused. */
  clientAssertion(now: Date = new Date()): string {
    const key = this.requireKey();
    const iat = Math.floor(now.getTime() / 1000);
    const payload: Record<string, unknown> = {
      iss: this.options.clientId,
      sub: this.options.clientId,
      aud: this.options.tokenEndpoint,
      iat,
      exp: iat + this.options.clientAssertion.lifetimeSeconds,
    };
    if (this.options.clientAssertion.jti) payload.jti = crypto.randomUUID();
    return signJws(payload, key, {
      alg: this.options.clientAssertion.alg,
      kid: this.options.keyId,
      typ: this.options.clientAssertion.typ ? "JWT" : undefined,
    });
  }

  /**
   * POST the code to the token endpoint, with EDR's form fields in EDR's order. Retried once,
   * and only when the first attempt never left this machine (the code is single use). Throws
   * FaydaError: HTTP with the OAuth error code for an error answer, API without an access
   * token or with a token_type that is not Bearer.
   */
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<FaydaTokenAnswer> {
    const call = () =>
      httpCall(this.options.tokenEndpoint, {
        method: "POST",
        name: "the token endpoint",
        timeoutMs: this.options.httpTimeoutMs,
        httpsAgent: this.agent,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
          client_id: this.options.clientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: this.clientAssertion(),
          code_verifier: input.codeVerifier,
        }).toString(),
      });
    let answer: HttpAnswer;
    try {
      answer = await call();
    } catch (err) {
      if (err instanceof FaydaError && (err.kind === "NETWORK" || err.kind === "TIMEOUT") && err.details.sent === false) {
        answer = await call();
      } else {
        throw err;
      }
    }
    if (answer.status < 200 || answer.status >= 300) {
      let code: string | undefined;
      try {
        code = oauthErrorCode((JSON.parse(answer.text) as { error?: unknown }).error);
      } catch {
        code = undefined;
      }
      throw new FaydaError("HTTP", `The token endpoint answered ${answer.status}${code ? ` ${code}` : ""}`, {
        status: answer.status,
        code: code ?? `HTTP_${answer.status}`,
        sent: true,
      });
    }
    const body = readJson(answer, "The token endpoint");
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new FaydaError("API", "The token answer has no access_token", { code: "NO_ACCESS_TOKEN" });
    }
    if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") {
      throw new FaydaError("API", "The token answer's token_type is not Bearer", { code: "TOKEN_TYPE" });
    }
    if (body.id_token !== undefined && typeof body.id_token !== "string") {
      throw new FaydaError("API", "The token answer's id_token is not a string", { code: "BAD_ID_TOKEN" });
    }
    return body as FaydaTokenAnswer;
  }

  /** The ID token's signature against eSignet's keys, then its claims (iss, aud, exp, iat, nonce, sub, at_hash). */
  async verifyIdToken(idToken: string, expect: { nonce: string; accessToken: string; now?: Date }): Promise<VerifiedIdToken> {
    const decoded = await this.verifySignature(idToken, this.options.idTokenAlgs);
    const facts = checkIdTokenClaims(decoded.payload, {
      issuer: this.options.issuer,
      clientId: this.options.clientId,
      nonce: expect.nonce,
      accessToken: expect.accessToken,
      alg: decoded.header.alg as FaydaJwsAlg,
      nowSeconds: Math.floor((expect.now ?? new Date()).getTime() / 1000),
      clockSkewSeconds: this.options.clockSkewSeconds,
      requireNonce: this.options.requireNonce,
      acrValues: this.options.acrValues.split(/\s+/).filter(Boolean),
      enforceAcr: this.options.enforceAcr,
    });
    return { claims: decoded.payload, facts, alg: decoded.header.alg as FaydaJwsAlg };
  }

  /**
   * GET userinfo with the access token, retried once on a network failure or a 5xx. A signed
   * JWT is verified against eSignet's keys; plain JSON is refused unless acceptJsonUserinfo; an
   * encrypted JWT (JWE) is refused (JWE_NOT_SUPPORTED). Then sub must equal the ID token's.
   */
  async fetchUserinfo(accessToken: string, expectedSub: string | undefined): Promise<VerifiedUserinfo> {
    const call = () =>
      httpCall(this.options.userinfoEndpoint, {
        method: "GET",
        name: "the userinfo endpoint",
        timeoutMs: this.options.httpTimeoutMs,
        httpsAgent: this.agent,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/jwt, application/json" },
      });
    let answer: HttpAnswer;
    try {
      answer = await call();
      if (answer.status >= 500) answer = await call();
    } catch (err) {
      if (err instanceof FaydaError && (err.kind === "NETWORK" || err.kind === "TIMEOUT")) answer = await call();
      else throw err;
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new FaydaError("HTTP", `The userinfo endpoint answered ${answer.status}`, { status: answer.status, code: `HTTP_${answer.status}`, sent: true });
    }
    const body = answer.text.trim();
    let claims: Record<string, unknown>;
    let signed: boolean;
    // Read by what the body is, not only by its label: JSON under any content type is unsigned.
    if (body.startsWith("{")) {
      if (!this.options.acceptJsonUserinfo) {
        throw new FaydaError("VERIFICATION", "The userinfo came as plain JSON, not a signed JWT", { code: "UNSIGNED_USERINFO" });
      }
      claims = readJson(answer, "The userinfo endpoint");
      signed = false;
    } else {
      const parts = compactParts(body);
      if (parts === "JWE") {
        throw new FaydaError("VERIFICATION", "The userinfo is encrypted (JWE); register the client for signed userinfo", {
          code: "JWE_NOT_SUPPORTED",
        });
      }
      if (parts !== "JWS") throw new FaydaError("HTTP", "The userinfo is neither a JWT nor JSON", { code: "NOT_JWT" });
      claims = (await this.verifySignature(body, this.options.userinfoAlgs)).payload;
      signed = true;
    }
    checkUserinfoClaims(claims, { sub: expectedSub, issuer: this.options.issuer, clientId: this.options.clientId });
    return { claims, signed };
  }

  /** eSignet's key set, fetched now (the cache calls this). */
  async fetchJwks() {
    const answer = await httpCall(this.options.jwksUri, {
      method: "GET",
      name: "the JWKS endpoint",
      timeoutMs: Math.min(this.options.httpTimeoutMs, 5000),
      httpsAgent: this.agent,
      headers: { Accept: "application/json, application/jwk-set+json" },
    });
    if (answer.status !== 200) {
      throw new FaydaError("HTTP", `The JWKS endpoint answered ${answer.status}`, { status: answer.status, code: `HTTP_${answer.status}` });
    }
    return parseJwks(readJson(answer, "The JWKS endpoint"));
  }

  private async verifySignature(token: string, allowedAlgs: readonly FaydaJwsAlg[]): Promise<DecodedJws> {
    const header = decodeJws(token).header;
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const keys = await this.jwks.keysFor(kid);
    if (keys.length === 0) {
      throw new FaydaError("VERIFICATION", kid ? "The token's kid is not in eSignet's key set" : "eSignet's key set has no signing key", {
        code: "UNKNOWN_KID",
      });
    }
    return verifyJws(token, { allowedAlgs, keys });
  }

  private requireKey(): crypto.KeyObject {
    if (!this.options.privateKey) {
      throw new FaydaError("CONFIG", `privateKey is ${this.options.privateKeyProblem ?? "missing"}`);
    }
    return this.options.privateKey;
  }
}
