export type FaydaErrorKind =
  /** Options missing or unsafe (insecureTls for a fayda.et host, a key that is not RSA), or no host where one is needed. */
  | "CONFIG"
  /** Bad input, refused before anything was sent: an unknown channel, an over-long state... */
  | "INVALID"
  /** No answer within options.httpTimeoutMs. */
  | "TIMEOUT"
  /** Connection refused, DNS, a broken connection, a TLS failure. */
  | "NETWORK"
  /** An HTTP error status, an answer over 1 MB, or an answer that is not what the call returns. */
  | "HTTP"
  /** eSignet answered, but the answer cannot be used (no access_token, a token_type that is not Bearer...). */
  | "API"
  /** A signature, issuer, audience, expiry, nonce or subject check failed. */
  | "VERIFICATION";

export class FaydaError extends Error {
  constructor(
    readonly kind: FaydaErrorKind,
    message: string,
    readonly details: {
      /** HTTP status, when there was an answer. */
      status?: number;
      /**
       * A finer reason, safe to log: an OAuth error code from eSignet (invalid_grant...), a TLS
       * code, TOO_LARGE, NOT_JWT, UNKNOWN_KID, BAD_SIGNATURE, NONCE_MISMATCH, JWE_NOT_SUPPORTED...
       */
      code?: string;
      /**
       * True once the request was written out, so eSignet may have seen it. The token call is
       * retried only when this is false: an authorization code is single use.
       */
      sent?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "FaydaError";
  }
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
