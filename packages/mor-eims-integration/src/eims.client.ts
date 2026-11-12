import * as https from "node:https";
import { Logger } from "@nestjs/common";
import {
  EimsError,
  EimsErrorKind,
  describeEimsErrorBody,
  isBuyerLookupUnavailable,
  kindForStatus,
  redactEimsErrorBody,
  rulesIn,
} from "./eims.errors";
import { HttpAnswer, createEimsAgent, isMorProductionHost, postText } from "./eims.http";
import { EimsModuleOptions, ResolvedEimsOptions, resolveEimsOptions } from "./eims.options";
import { eimsOperation, parseBody, redactEimsHeaders, redactEimsPayload } from "./eims.redaction";
import { normalizeAckDate } from "./eims.sequence";
import { EimsKeyMaterial, signEnvelope } from "./eims.signer";
import {
  EimsBulkCancelResponse,
  EimsBulkRegisterAccepted,
  EimsCancelRequest,
  EimsCancelResponse,
  EimsExchangeRecord,
  EimsInvoiceRequest,
  EimsLoginRequest,
  EimsLoginResponse,
  EimsReceiptResponse,
  EimsRegisterResponse,
  EimsSalesReceiptRequest,
  EimsSession,
  EimsVerifyResponse,
} from "./eims.types";

/** Where the signing pair comes from on each call. */
export interface EimsKeySource {
  material(): Promise<EimsKeyMaterial>;
  /**
   * Re-read the active pair now; true when it changed. Called once after MoR refuses a
   * certificate (67012): another instance may have rotated it moments ago.
   */
  refreshNow?(): Promise<boolean>;
}

/** What a call is about, for the exchange log. */
export interface EimsCallContext {
  documentIds?: string[];
  receiptId?: string | null;
  /** AUTO_SUBMIT, AUTO_RECEIPT, CREDENTIAL_ACTIVATION... */
  trigger?: string | null;
  /** Sign with this pair instead of the active one (credential activation only). */
  material?: EimsKeyMaterial;
  /** Use this bearer token instead of the cached session (credential activation only). */
  accessToken?: string;
}

export interface EimsLoginResult {
  accessToken: string;
  /** Seconds, as MoR reported them. */
  expiresIn: number;
  session: EimsSession;
}

export interface EimsRegistration {
  irn: string;
  ackDate: string | null;
  signedQr: string | null;
  documentNumber: string | null;
}

const FALLBACK_EXPIRES_IN_SECONDS = 3600;

/** Login answers worth naming (live). */
const LOGIN_CODE_HINTS: Record<string, string> = {
  "4400": "invalid credentials",
  "4408": "the API key is wrong (check for whitespace)",
  "4410": "the client id or client secret is wrong",
};

function decodeClaims(accessToken: string): Record<string, unknown> {
  const segment = accessToken.split(".")[1];
  if (!segment) throw new EimsError("UNKNOWN", "The EIMS access token is not a JWT", { code: "NOT_JWT", sent: true });
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new EimsError("UNKNOWN", "The EIMS access token payload does not decode", { code: "NOT_JWT", sent: true });
  }
}

/**
 * MoR EIMS over HTTP, usable without Nest. Every endpoint, login included, takes the signed
 * {request, signature, certificate} envelope (live, 2026-09-08 and 2026-09-17); protected calls
 * add `Authorization: Bearer <token>` and an `apikey` header. Tokens live in memory only.
 *
 * Every failure is an EimsError whose kind and details.sent say whether MoR can have stored what
 * was sent. Every exchange is handed to onExchange, redacted.
 */
export class EimsClient {
  private readonly logger = new Logger("EimsClient");
  readonly options: ResolvedEimsOptions;
  private readonly agent: https.Agent;
  private cache: { accessToken: string; expiresAt: number; session: EimsSession } | null = null;
  private loginInFlight: Promise<EimsLoginResult> | null = null;

  constructor(
    options: EimsModuleOptions | ResolvedEimsOptions,
    private readonly keys: EimsKeySource,
    private readonly onExchange?: (record: EimsExchangeRecord) => void | Promise<void>,
  ) {
    this.options = "tokenSkewMs" in options ? options : resolveEimsOptions(options);
    let host: string;
    try {
      host = new URL(this.options.baseUrl).hostname;
    } catch {
      throw new EimsError("CONFIG", "The EIMS base URL is not a valid URL", { sent: false });
    }
    if (this.options.insecureTls && isMorProductionHost(host)) {
      throw new EimsError("CONFIG", "insecureTls is refused for mor.gov.et; add the CA with the ca option instead", { sent: false });
    }
    if (this.options.insecureTls) this.logger.warn("EIMS TLS verification is OFF (insecureTls); development only");
    this.agent = createEimsAgent({ ca: this.options.ca, insecureTls: this.options.insecureTls });
  }

  // ── session ──────────────────────────────────────────────────────────────────────────────────

  /** The source-system identity MoR issued, logging in when needed. The authority for SourceSystem. */
  async session(context: EimsCallContext = {}): Promise<EimsSession> {
    await this.accessToken(context);
    return this.cache!.session;
  }

  /** The system number of the cached session, without logging in. */
  currentSystemNumber(): string | null {
    return this.cache?.session.systemNumber ?? null;
  }

  /** Drop the cached token: the next call logs in again. */
  invalidate(): void {
    this.cache = null;
  }

  /** Adopt a login obtained elsewhere (activation logs in with the new pair and installs it). */
  installSession(result: EimsLoginResult): void {
    this.cache = {
      accessToken: result.accessToken,
      expiresAt: Date.now() + Math.max(result.expiresIn * 1000 - this.options.tokenSkewMs, 1000),
      session: result.session,
    };
  }

  private async accessToken(context: EimsCallContext): Promise<string> {
    if (this.cache && Date.now() < this.cache.expiresAt) return this.cache.accessToken;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login(context).finally(() => {
        this.loginInFlight = null;
      });
    }
    const result = await this.loginInFlight;
    this.installSession(result);
    return result.accessToken;
  }

  /**
   * POST /auth/login with the four credentials inside the signed envelope. Returns the login
   * without caching it. MoR changed this contract once already (flat body on 2026-09-09, envelope
   * by 2026-09-17): `curl -d '{}'` against /auth/login answers which one it is today.
   */
  async login(context: EimsCallContext = {}): Promise<EimsLoginResult> {
    const missing = (["clientId", "clientSecret", "apiKey", "tin"] as const).filter((name) => !this.options[name]);
    if (missing.length) {
      throw new EimsError("CONFIG", `EIMS login is not configured: missing ${missing.join(", ")}`, { sent: false });
    }
    const request: EimsLoginRequest = {
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      apikey: this.options.apiKey,
      tin: this.options.tin,
    };
    const material = context.material ?? (await this.keys.material());
    const { body } = signEnvelope(material, request);
    const answer = await this.exchange("/auth/login", body, { "Content-Type": "application/json" }, context, 1);
    if (answer.status < 200 || answer.status >= 300) {
      const error = this.failure(answer, "login");
      const code = error.details.body?.code;
      if (error.kind === "AUTH" && code && LOGIN_CODE_HINTS[code]) {
        throw new EimsError("AUTH", `EIMS login refused (${code}): ${LOGIN_CODE_HINTS[code]}`, error.details);
      }
      throw error;
    }
    const parsed = this.json<EimsLoginResponse>(answer, "login");
    const accessToken = parsed?.data?.accessToken;
    if (!accessToken) throw new EimsError("UNKNOWN", "EIMS login returned no accessToken", { httpStatus: answer.status, sent: true });
    const expiresIn =
      Number.isFinite(parsed.data?.expiresIn) && Number(parsed.data?.expiresIn) > 0 ? Number(parsed.data?.expiresIn) : FALLBACK_EXPIRES_IN_SECONDS;
    return { accessToken, expiresIn, session: this.readSession(accessToken) };
  }

  /** systemNumber and systemType from the token, checked against the expected values when set. */
  private readSession(accessToken: string): EimsSession {
    const claims = decodeClaims(accessToken);
    const read = (name: string) => (typeof claims[name] === "string" ? (claims[name] as string).trim() : "");
    const systemNumber = read("systemNumber");
    const systemType = read("systemType");
    if (!systemNumber || !systemType) {
      throw new EimsError("UNKNOWN", "The EIMS access token names no systemNumber or systemType", { code: "NO_SYSTEM_CLAIMS", sent: true });
    }
    const mismatches = [
      this.options.expectedSystemNumber && this.options.expectedSystemNumber !== systemNumber
        ? `expected system ${this.options.expectedSystemNumber}, the token says ${systemNumber}`
        : null,
      this.options.expectedSystemType && this.options.expectedSystemType !== systemType
        ? `expected type ${this.options.expectedSystemType}, the token says ${systemType}`
        : null,
    ].filter(Boolean);
    if (mismatches.length) {
      throw new EimsError("CONFIG", `EIMS source system disagrees with the issued token: ${mismatches.join("; ")}`, {
        code: "SYSTEM_MISMATCH",
        sent: false,
      });
    }
    return { systemNumber, systemType };
  }

  // ── protected calls ──────────────────────────────────────────────────────────────────────────

  /**
   * Sign `request`, POST it to `path` with the bearer token and apikey header, and return the
   * parsed 2xx answer. A 401 drops the token and retries once (a 401 is refused before processing).
   */
  async postSigned<T>(path: string, request: unknown, context: EimsCallContext = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const token = context.accessToken && attempt === 1 ? context.accessToken : await this.accessToken(context);
      const material = context.material ?? (await this.keys.material());
      const { body } = signEnvelope(material, request);
      const answer = await this.exchange(
        path,
        body,
        { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: this.options.apiKey },
        context,
        attempt,
      );
      if (answer.status === 401 && attempt === 1) {
        this.logger.warn(`EIMS refused the token on ${path}; logging in again once`);
        this.invalidate();
        continue;
      }
      if (answer.status < 200 || answer.status >= 300) {
        const failure = this.failure(answer, `POST ${path}`);
        // A refused certificate is a certain refusal (nothing stored), so one retry with a pair
        // rotated by another instance is safe.
        if (failure.details.body?.code === "67012" && attempt === 1 && !context.material && (await this.keys.refreshNow?.())) {
          this.logger.warn(`MoR refused the certificate on ${path}; the active pair changed meanwhile, retrying once with it`);
          this.invalidate();
          continue;
        }
        throw failure;
      }
      const parsed = this.json<T & { statusCode?: unknown }>(answer, `POST ${path}`);
      // MoR wraps some answers as {statusCode, message, body}; a 2xx carrying an error status inside is a refusal.
      const inner = Number((parsed as { statusCode?: unknown } | null)?.statusCode);
      if (Number.isFinite(inner) && inner >= 400) throw this.failure({ ...answer, status: inner }, `POST ${path}`);
      return parsed;
    }
  }

  /** POST /v1/register. A 2xx without an IRN is ambiguous, not a rejection: MoR may have stored it. */
  async register(document: EimsInvoiceRequest, context: EimsCallContext = {}): Promise<EimsRegistration> {
    const response = await this.postSigned<EimsRegisterResponse>("/v1/register", document, context);
    const irn = response?.body?.irn?.trim();
    if (!irn) {
      throw new EimsError(
        "UNKNOWN",
        `EIMS register answered without an IRN${response?.body?.errorMessage ? `: ${response.body.errorMessage}` : ""}`,
        { code: "NO_IRN", sent: true },
      );
    }
    return {
      irn,
      ackDate: normalizeAckDate(response.body?.ackDate ?? null),
      signedQr: response.body?.signedQR ?? null,
      documentNumber: response.body?.documentNumber ?? null,
    };
  }

  /** POST /v1/verify by IRN (lowercase irn in, Irn out). A 2xx without an Irn confirms nothing. */
  async verify(irn: string, context: EimsCallContext = {}): Promise<EimsVerifyResponse> {
    const response = await this.postSigned<EimsVerifyResponse>("/v1/verify", { irn }, context);
    if (!response?.body?.Irn?.trim()) {
      throw new EimsError("UNKNOWN", "EIMS verify answered without an Irn", { code: "NO_IRN", sent: true });
    }
    return response;
  }

  async cancel(request: EimsCancelRequest, context: EimsCallContext = {}): Promise<EimsCancelResponse> {
    return this.postSigned<EimsCancelResponse>("/v1/cancel", request, context);
  }

  async bulkCancel(requests: EimsCancelRequest[], context: EimsCallContext = {}): Promise<EimsBulkCancelResponse> {
    return this.postSigned<EimsBulkCancelResponse>("/v1/bulkCancel", requests, context);
  }

  /** POST /v1/bulkRegister: one envelope around the array. Answers 202 with a conversationId; results come by webhook. */
  async bulkRegister(documents: EimsInvoiceRequest[], context: EimsCallContext = {}): Promise<string> {
    const response = await this.postSigned<EimsBulkRegisterAccepted>("/v1/bulkRegister", documents, context);
    const id = typeof response?.conversationId === "string" ? response.conversationId.trim() : "";
    if (!id) throw new EimsError("UNKNOWN", "EIMS bulkRegister answered without a conversationId", { code: "NO_CONVERSATION", sent: true });
    return id.slice(0, 128);
  }

  async salesReceipt(request: EimsSalesReceiptRequest, context: EimsCallContext = {}): Promise<{ rrn: string; qr: string | null; status: string | null }> {
    const response = await this.postSigned<EimsReceiptResponse>("/v1/receipt/sales", request, context);
    const rrn = response?.body?.rrn?.trim();
    if (!rrn) throw new EimsError("UNKNOWN", "EIMS receipt answered without an RRN", { code: "NO_RRN", sent: true });
    return { rrn, qr: response.body?.qr ?? null, status: response.body?.status ?? null };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private async exchange(
    path: string,
    body: string,
    headers: Record<string, string>,
    context: EimsCallContext,
    attempt: number,
  ): Promise<HttpAnswer> {
    const startedAt = Date.now();
    let answer: HttpAnswer | undefined;
    let error: EimsError | undefined;
    try {
      answer = await postText(`${this.options.baseUrl}${path}`, body, {
        headers: { Accept: "application/json", ...headers },
        timeoutMs: this.options.httpTimeoutMs,
        httpsAgent: this.agent,
        name: `POST ${path}`,
      });
      return answer;
    } catch (err) {
      error = err instanceof EimsError ? err : new EimsError("UNKNOWN", (err as Error).message, { sent: true, cause: err });
      throw error;
    } finally {
      await this.record(path, body, headers, context, attempt, startedAt, answer, error);
    }
  }

  private async record(
    path: string,
    body: string,
    headers: Record<string, string>,
    context: EimsCallContext,
    attempt: number,
    startedAt: number,
    answer: HttpAnswer | undefined,
    error: EimsError | undefined,
  ): Promise<void> {
    if (!this.onExchange) return;
    try {
      const responseBody = answer ? parseBody(answer.text) : null;
      const failed = error ?? (answer && (answer.status < 200 || answer.status >= 300) ? this.failure(answer, `POST ${path}`) : undefined);
      await this.onExchange({
        direction: "OUTBOUND",
        operation: eimsOperation(path),
        path,
        attempt,
        documentIds: context.documentIds ?? [],
        receiptId: context.receiptId ?? null,
        trigger: context.trigger ?? null,
        systemNumber: this.currentSystemNumber(),
        statusCode: answer?.status ?? null,
        isSuccess: !failed,
        failureKind: failed?.kind ?? null,
        errorMessage: failed ? failed.message.slice(0, 2000) : null,
        requestHeaders: redactEimsHeaders(headers),
        requestBody: redactEimsPayload(parseBody(body)),
        responseBody: redactEimsPayload(responseBody),
        durationMs: Date.now() - startedAt,
        at: new Date(),
      });
    } catch (err) {
      this.logger.warn(`Could not record the EIMS exchange: ${(err as Error).message}`);
    }
  }

  private json<T>(answer: HttpAnswer, operation: string): T {
    try {
      return JSON.parse(answer.text) as T;
    } catch {
      throw new EimsError("UNKNOWN", `EIMS ${operation} answered ${answer.status} with a body that is not JSON`, {
        httpStatus: answer.status,
        code: "NOT_JSON",
        sent: true,
      });
    }
  }

  /** A non-2xx answer as an EimsError carrying only MoR's error fields. */
  private failure(answer: HttpAnswer, operation: string): EimsError {
    const body = redactEimsErrorBody(parseBody(answer.text));
    // 400/401/403/406/429 are refusals; a 5xx stays SERVER and any other status UNKNOWN (both
    // ambiguous), whatever the body says.
    const kind: EimsErrorKind = kindForStatus(answer.status);
    const buyerLookup = isBuyerLookupUnavailable(body);
    return new EimsError(kind, `EIMS ${operation} failed (${answer.status}): ${describeEimsErrorBody(body)}`, {
      httpStatus: answer.status,
      body,
      rules: rulesIn(body),
      code: buyerLookup ? "BUYER_LOOKUP_UNAVAILABLE" : body?.code,
      sent: true,
    });
  }
}
