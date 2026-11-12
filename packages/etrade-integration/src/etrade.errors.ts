export type EtradeErrorKind =
  /** Options missing (baseUrl) or unsafe (insecureTls for etrade.gov.et), or no host where one is needed. */
  | "CONFIG"
  /** Bad input, refused before anything was sent: a TIN that is not 10 digits, an empty licence number... */
  | "INVALID"
  /** The TIN lookup budget refused this lookup. Nothing was sent to e-trade. */
  | "BUDGET"
  /** No answer within options.httpTimeoutMs (after the retries). */
  | "TIMEOUT"
  /** Connection refused, DNS, a TLS failure, or the circuit is open after repeated failures. */
  | "NETWORK"
  /** An HTTP error status (5xx, 429, an unexpected 4xx), or an answer that is not JSON. */
  | "HTTP"
  /** e-trade answered, but the answer cannot be used: refused our Referer (417), or answered for another TIN or licence. */
  | "API";

export class EtradeError extends Error {
  constructor(
    readonly kind: EtradeErrorKind,
    message: string,
    readonly details: {
      /** HTTP status, when there was an answer. */
      status?: number;
      /**
       * A finer reason: REFERER_REJECTED, TIN_MISMATCH, LICENCE_MISMATCH, CIRCUIT_OPEN,
       * NOT_JSON, TOO_LARGE, a TLS error code (UNABLE_TO_VERIFY_LEAF_SIGNATURE...), ACTOR_REQUIRED.
       */
      code?: string;
      /** From a 429 answer's Retry-After header. */
      retryAfterSeconds?: number;
      /** How many times the call was tried. */
      attempts?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "EtradeError";
  }
}

/** A failure worth trying again: no answer, a broken connection, or a 5xx. Never a 4xx or 429. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof EtradeError)) return false;
  if (error.details.code === "CIRCUIT_OPEN") return false;
  if (error.kind === "TIMEOUT" || error.kind === "NETWORK") return !isTlsCode(error.details.code);
  if (error.kind === "HTTP") return typeof error.details.status === "number" && error.details.status >= 500;
  return false;
}

/** Node's certificate error codes: retrying will not fix them. */
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
