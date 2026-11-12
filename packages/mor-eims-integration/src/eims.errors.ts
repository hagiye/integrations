/**
 * How a failed EIMS call is described: which kind of failure it was, and, the part that decides
 * everything downstream, whether MoR can have stored the document.
 */
export type EimsErrorKind =
  /** Options or credentials missing or unusable (no key, a key that is not RSA, insecureTls for mor.gov.et). */
  | "CONFIG"
  /** Refused locally before anything was sent: a buyer without a TIN, lines that do not add up, an old date... */
  | "INVALID"
  /** No answer within httpTimeoutMs after the request went out. MoR may have stored it. */
  | "TIMEOUT"
  /** Connection refused, DNS, reset, TLS. details.sent says whether the request can have reached MoR. */
  | "NETWORK"
  /** 400: the gateway's schema or envelope check refused it (also 67xxx certificate or signature errors). */
  | "SCHEMA_VALIDATION"
  /** 401 (after one re-login), or a login refused with 4400/4408/4410. */
  | "AUTH"
  /** 403. */
  | "FORBIDDEN"
  /** 406: a business rule refused it (7001, 7004, 7015, 7020, 7026...). */
  | "RULE_VALIDATION"
  /** 429: turned away by the gateway before processing. */
  | "RATE_LIMITED"
  /** 5xx. MoR may have stored it. */
  | "SERVER"
  /** An answer that is not what the call returns (no IRN on a 200, unknown status). MoR may have stored it. */
  | "UNKNOWN"
  /** MoR accepted the document but recording that locally failed. The IRN is in details. */
  | "PERSIST"
  /** Refused locally because the sequence is busy: a submission in flight, or the system number blocked. */
  | "BUSY";

/** The gateway's own error reporting. Nothing else from a response is ever kept on an error. */
export interface EimsErrorBody {
  message?: string;
  statusCode?: number;
  code?: string;
  details?: Array<{ errorMessage?: string; field?: string }>;
  errors?: Array<{ field?: string; message?: string }>;
  status?: string;
  body?: unknown;
}

export interface EimsErrorDetails {
  /** HTTP status, when there was an answer. */
  httpStatus?: number;
  /** MoR's error body, reduced to its error fields (see redactEimsErrorBody). */
  body?: EimsErrorBody;
  /** MoR rule numbers named in the answer, e.g. ["7015", "7001"]. */
  rules?: string[];
  /** A finer reason, safe to log: a TLS code, TOO_LARGE, NOT_JSON, BUYER_LOOKUP_UNAVAILABLE, a local refusal code... */
  code?: string;
  /**
   * True once the request can have reached MoR. False only when the connection never came up
   * (DNS, refused, TLS handshake) or the failure happened while building the request.
   */
  sent?: boolean;
  /** For PERSIST: the IRN or RRN MoR returned, which must not be lost. */
  acceptedReference?: string;
  cause?: unknown;
}

export class EimsError extends Error {
  constructor(
    readonly kind: EimsErrorKind,
    message: string,
    readonly details: EimsErrorDetails = {},
  ) {
    super(message);
    this.name = "EimsError";
  }
}

/**
 * Answers that prove MoR did not store the document: the gateway refused it outright. The one
 * list every writer uses (EDR had three copies; one treated 429 as ambiguous and froze filing
 * twice in an afternoon).
 */
export const DEFINITELY_NOT_STORED: ReadonlySet<EimsErrorKind> = new Set<EimsErrorKind>([
  "SCHEMA_VALIDATION",
  "RULE_VALIDATION",
  "AUTH",
  "FORBIDDEN",
  "RATE_LIMITED",
  "CONFIG",
  "INVALID",
]);

/**
 * Did MoR certainly not store what this error is about? True for the refusals above, and for a
 * network failure where the connection never came up (nothing was sent). Everything else (a
 * timeout, a reset after sending, a 5xx, an odd answer) leaves it open.
 */
export function definitelyNotStored(err: unknown): boolean {
  if (!(err instanceof EimsError)) return false;
  if (DEFINITELY_NOT_STORED.has(err.kind)) return true;
  return err.kind === "NETWORK" && err.details.sent === false;
}

/**
 * Not stored, and not the document's fault, so the same filing can simply be tried again later:
 * a 429, MoR unreachable before anything was sent, or MoR's own buyer lookup being down.
 */
export function retryableNotStored(err: unknown): boolean {
  if (!(err instanceof EimsError) || !definitelyNotStored(err)) return false;
  if (err.kind === "RATE_LIMITED") return true;
  if (err.kind === "NETWORK") return true;
  return err.details.code === "BUYER_LOOKUP_UNAVAILABLE";
}

const SAFE_KEYS = ["message", "statusCode", "code", "details", "errors", "status", "body"] as const;

/** Keep only the gateway's error-reporting fields: an echoed request, a token or a signature never reaches a log. */
export function redactEimsErrorBody(data: unknown): EimsErrorBody | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const source = data as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_KEYS) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  return Object.keys(safe).length > 0 ? (safe as EimsErrorBody) : undefined;
}

/** The HTTP status of a refusal, as a failure kind. */
export function kindForStatus(status: number): EimsErrorKind {
  if (status === 400) return "SCHEMA_VALIDATION";
  if (status === 401) return "AUTH";
  if (status === 403) return "FORBIDDEN";
  if (status === 406) return "RULE_VALIDATION";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER";
  return "UNKNOWN";
}

const MAX_QUOTED = 4;

/** Every string anywhere in a body, whatever nesting MoR used (bounded). */
export function errorStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || out.length > 200) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) errorStrings(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) errorStrings(v, out, depth + 1);
  return out;
}

/** MoR rule numbers (4-digit 7xxx, 1xxx) and gateway codes (4xxx, 67xxx) named in a body. */
export function rulesIn(body: EimsErrorBody | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  if (body.code) found.add(String(body.code));
  for (const text of errorStrings(body)) {
    for (const match of text.matchAll(/\b(7\d{3}|1\d{3}|67\d{3})\b/g)) found.add(match[1]);
  }
  return [...found];
}

/**
 * The gateway's reporting in one line, with the field name of every entry: a bare "must not be
 * null" once cost a day of guessing which of request, signature and certificate was meant. Reads
 * both shapes: details[{field, errorMessage}] (protected endpoints) and errors[{field, message}]
 * (/auth/login).
 */
export function describeEimsErrorBody(body: EimsErrorBody | undefined): string {
  if (!body) return "no error body";
  const entries = [
    ...(Array.isArray(body.details) ? body.details : []).map((d) => ({ field: d.field, message: d.errorMessage })),
    ...(Array.isArray(body.errors) ? body.errors : []).map((e) => ({ field: e.field, message: e.message })),
  ].filter((e) => e.message || e.field);
  const quoted = entries
    .slice(0, MAX_QUOTED)
    .map((e) => [e.field, e.message].filter(Boolean).join(": "))
    .join("; ");
  const extra = entries.length > MAX_QUOTED ? ` (+${entries.length - MAX_QUOTED} more)` : "";
  const nested =
    !quoted && body.body !== undefined
      ? errorStrings(body.body).slice(0, MAX_QUOTED).join("; ").slice(0, 600)
      : "";
  return (
    [body.message ?? body.status, body.code && `code=${body.code}`, quoted ? `${quoted}${extra}` : nested]
      .filter(Boolean)
      .join(" ") || "no error body"
  );
}

/** MoR's own buyer lookup failing ("BUYER_TIN ... buyer not found 503"): MoR's fault, not the document's. */
export function isBuyerLookupUnavailable(body: EimsErrorBody | undefined): boolean {
  return errorStrings(body).some((text) => /buyer[_ ]?tin/i.test(text) && /\b503\b/.test(text));
}

/** Node's certificate error codes: the connection was refused before anything was sent. */
export function isTlsCode(code: string | undefined): boolean {
  if (!code) return false;
  return (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.includes("CERT") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  );
}

/** Connection-level codes that mean the request never left this machine. */
export function isNotConnectedCode(code: string | undefined): boolean {
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH";
}

/** An error as stored on a filing or receipt: kind, message, MoR's fields. Never a payload or a secret. */
export function toStoredError(err: unknown, at = new Date()): {
  kind: string;
  message: string;
  httpStatus?: number;
  rules?: string[];
  code?: string;
  details?: unknown;
  at: string;
} {
  if (err instanceof EimsError) {
    return {
      kind: err.kind,
      message: err.message.slice(0, 2000),
      ...(err.details.httpStatus !== undefined ? { httpStatus: err.details.httpStatus } : {}),
      ...(err.details.rules?.length ? { rules: err.details.rules } : {}),
      ...(err.details.code ? { code: err.details.code } : {}),
      ...(err.details.body ? { details: err.details.body } : {}),
      at: at.toISOString(),
    };
  }
  return { kind: "LOCAL", message: ((err as Error)?.message ?? "unknown error").slice(0, 2000), at: at.toISOString() };
}
