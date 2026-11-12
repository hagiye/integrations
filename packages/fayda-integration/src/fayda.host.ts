import type { FaydaIdentity, FaydaSessionStatus } from "./fayda.types";

export const FAYDA_HOST = Symbol("FAYDA_HOST");

/** One started verification, as your host stores it. */
export interface FaydaSessionRecord {
  /** A UUID, made by the package. */
  id: string;
  /** Unique. The single-use value that ties eSignet's redirect back to this row. */
  state: string;
  /** Must come back in the ID token. Wipe it when the session ends. */
  nonce: string;
  /** PKCE verifier. Never leaves the back end. Wipe it when the session ends. */
  codeVerifier: string;
  /** SHA-256 hex of the browser binding secret, or null for an unbound session (a native app). */
  browserBindingHash: string | null;
  purpose: string;
  channel: string;
  /** The exact redirect_uri sent at authorize; the token call sends it again. */
  redirectUri: string;
  accountId: string | null;
  status: FaydaSessionStatus;
  createdAt: Date;
  expiresAt: Date;
  metadata: Record<string, unknown> | null;
}

export interface FaydaSessionEnd {
  status: "COMPLETED" | "FAILED" | "EXPIRED";
  /** A failure code (FAYDA_...) or your refusal's code. Never personal data. */
  errorCode?: string;
  /** A fixed reason or an OAuth error code. Never personal data. */
  errorDescription?: string;
  at: Date;
}

export interface FaydaVerifiedContext {
  /** The session, claimed by this completion. */
  session: FaydaSessionRecord;
  /**
   * Accounts that hold the same verified phone (E.164) or email, from findContactMatches. The
   * package never links to them. A match is a hint for your own decision: ask the person to
   * sign in to that account first, then verify from inside it.
   */
  possibleMatches: string[];
}

/**
 * Thrown by your onVerified to refuse a verification for a business reason: the sub is already
 * linked to another account, the wrong person verified for an onboarding step... The session is
 * marked FAILED with your code, and the caller gets your status and message.
 */
export class FaydaHostRefusal extends Error {
  constructor(
    readonly code: string,
    /** Fit to show the user. */
    message: string,
    readonly httpStatus: number = 409,
  ) {
    super(message);
    this.name = "FaydaHostRefusal";
  }
}

/** One audit line. Holds no claim, token, code or verifier. */
export interface FaydaEvent {
  at: Date;
  type: "START" | "COMPLETE_OK" | "COMPLETE_FAIL" | "INVALID_STATE";
  sessionId?: string;
  purpose?: string;
  channel?: string;
  accountId?: string | null;
  /** The failure code, for COMPLETE_FAIL and INVALID_STATE. */
  code?: string;
  reason?: string;
}

/**
 * The port your app implements. The package keeps no state of its own: sessions live in your
 * database, so every instance behind a load balancer sees the same ones.
 */
export interface FaydaHost<R = unknown> {
  /** Store a new PENDING session. */
  createSession(session: FaydaSessionRecord): Promise<void>;

  /**
   * Take the session for this state, atomically, from PENDING to IN_PROGRESS, and return it; or
   * return null when there is no PENDING session with this state (unknown, used, failed). One
   * conditional UPDATE ... WHERE state = $1 AND status = 'PENDING' RETURNING * is enough: of two
   * completions racing with the same state, only one gets the row. Do not check the expiry
   * here; the package does, and ends an expired session itself.
   */
  claimSession(state: string): Promise<FaydaSessionRecord | null>;

  /** Close a claimed session: set the status, errorCode and errorDescription, and wipe nonce and codeVerifier. */
  endSession(sessionId: string, end: FaydaSessionEnd): Promise<void>;

  /**
   * The person is verified. Link them by identity.sub (unique on your side), never by phone or
   * email, and return what the caller should get back. Throw FaydaHostRefusal to refuse.
   *
   * Lock or upsert on sub so two completions for the same person cannot create two rows.
   */
  onVerified(identity: FaydaIdentity, context: FaydaVerifiedContext): Promise<R>;

  /** Ids of accounts with the same verified phone or email. Only reported, never linked. */
  findContactMatches?(identity: FaydaIdentity): Promise<string[]>;

  /** Called for starts, completions and invalid states. A failure here is logged and ignored. */
  recordEvent?(event: FaydaEvent): Promise<void>;
}
