import type { FaydaIdentityFields } from "./fayda.claims";

/** eSignet's token answer. Only access_token and id_token are used; nothing is stored. */
export interface FaydaTokenAnswer {
  access_token: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  [field: string]: unknown;
}

/** A verified person. Every field comes from claims whose signature was checked. */
export interface FaydaIdentity extends FaydaIdentityFields {
  /** The client_id the sub is pairwise to. A sub means nothing under another client_id. */
  clientId: string;
  /** From the ID token. */
  acr?: string;
  /** From the ID token's auth_time. */
  authTime?: Date;
  verifiedAt: Date;
  /** false only when acceptJsonUserinfo let a plain JSON userinfo through. */
  userinfoSigned: boolean;
  /** Every userinfo claim as verified, for fields this package does not read. */
  claims: Record<string, unknown>;
}

export type FaydaSessionStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "EXPIRED";

/**
 * Why a completion failed. Each has an HTTP status and a message fit for the user in
 * FAYDA_FAILURES; the finer reason (for logs only) is in the result's reason.
 */
export type FaydaFailureCode =
  | "FAYDA_DISABLED"
  | "FAYDA_AUTH_ERROR"
  | "FAYDA_MISSING_PARAMETERS"
  | "FAYDA_INVALID_STATE"
  | "FAYDA_SESSION_EXPIRED"
  | "FAYDA_BINDING_MISMATCH"
  | "FAYDA_TOKEN_EXCHANGE_FAILED"
  | "FAYDA_TOKEN_INVALID"
  | "FAYDA_USERINFO_FAILED"
  | "FAYDA_INTERNAL_ERROR";

export const FAYDA_FAILURES: Record<FaydaFailureCode, { httpStatus: number; message: string }> = {
  FAYDA_DISABLED: { httpStatus: 503, message: "Verification is not available now." },
  FAYDA_AUTH_ERROR: { httpStatus: 400, message: "The verification was cancelled or refused. Try again." },
  FAYDA_MISSING_PARAMETERS: { httpStatus: 400, message: "The link is incomplete. Start the verification again." },
  FAYDA_INVALID_STATE: { httpStatus: 400, message: "This verification is no longer valid. Start again." },
  FAYDA_SESSION_EXPIRED: { httpStatus: 400, message: "Time ran out. Start the verification again." },
  FAYDA_BINDING_MISMATCH: {
    httpStatus: 400,
    message: "This verification was started in another browser. Start again here.",
  },
  FAYDA_TOKEN_EXCHANGE_FAILED: { httpStatus: 502, message: "Fayda is not answering. Try again later." },
  FAYDA_TOKEN_INVALID: { httpStatus: 502, message: "The verification failed. Try again." },
  FAYDA_USERINFO_FAILED: { httpStatus: 502, message: "Fayda is not answering. Try again later." },
  FAYDA_INTERNAL_ERROR: { httpStatus: 500, message: "Something went wrong. Try again." },
};

export interface FaydaStartInput {
  /** Default "VERIFY". Your word for why (VERIFY, LOGIN, ONBOARDING...); stored and handed back. */
  purpose?: string;
  /** A key of options.redirectUris. Default options.defaultChannel. */
  channel?: string;
  /** The signed-in account that starts it, if any. Your host decides what it means at the end. */
  accountId?: string | null;
  /** Override options.prompt for this one. */
  prompt?: "login" | "consent" | "select_account" | false;
  /** Override options.userinfoClaims for this one (ask only for what the use case needs). */
  userinfoClaims?: string[];
  /** false: do not bind this session to the browser, whatever the channel. */
  bindBrowser?: boolean;
  /** Stored with the session as it is (JSON). Never sent to eSignet. */
  metadata?: Record<string, unknown> | null;
}

export interface FaydaBrowserBinding {
  cookieName: string;
  /** The secret. Only its SHA-256 is stored with the session. */
  value: string;
  /** A ready Set-Cookie header value: HttpOnly, SameSite, Secure, Max-Age = the session's life. */
  setCookie: string;
}

export interface FaydaStartResult {
  sessionId: string;
  /** Send the browser here. */
  authorizationUrl: string;
  state: string;
  channel: string;
  expiresAt: Date;
  /** Set this cookie on the answer to the start request. Absent for unbound sessions. */
  browserBinding?: FaydaBrowserBinding;
}

export interface FaydaCompleteInput {
  code?: unknown;
  state?: unknown;
  /** eSignet's error redirect: ?error=...&error_description=... */
  error?: unknown;
  errorDescription?: unknown;
  /** The binding cookie's value, read by your controller (the built-in one reads it itself). */
  browserBinding?: string;
}

export interface FaydaVerified<R> {
  outcome: "VERIFIED";
  sessionId: string;
  purpose: string;
  channel: string;
  accountId: string | null;
  identity: FaydaIdentity;
  /** What your host's onVerified returned. */
  result: R;
  /** A signed proof of this verification, when options.proof is set. */
  proof?: string;
}

export interface FaydaFailed {
  outcome: "FAILED";
  code: FaydaFailureCode | string;
  httpStatus: number;
  /** Fit to show the user. */
  message: string;
  /** For logs: a fixed reason or an OAuth error code, never claims or tokens. */
  reason: string;
  sessionId?: string;
  channel?: string;
}

export type FaydaCompleteResult<R = unknown> = FaydaVerified<R> | FaydaFailed;
