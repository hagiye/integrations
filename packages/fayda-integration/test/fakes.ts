import { Injectable } from "@nestjs/common";
import type {
  FaydaEvent,
  FaydaHost,
  FaydaIdentity,
  FaydaSessionEnd,
  FaydaSessionRecord,
  FaydaVerifiedContext,
} from "../src";
import { FaydaHostRefusal, emailKey } from "../src";

export interface FakeAccount {
  id: string;
  phone?: string;
  email?: string;
}

/**
 * An in-memory host: sessions, accounts, identities linked by sub. claimSession is atomic the
 * way JavaScript is: the check and the update happen with no await between them.
 */
@Injectable()
export class FakeFaydaHost implements FaydaHost<{ identityId: string; linkedAccountId: string | null; possibleAccountMatch: boolean }> {
  readonly sessions = new Map<string, FaydaSessionRecord & { errorCode?: string; errorDescription?: string }>();
  readonly identities = new Map<string, { id: string; sub: string; accountId: string | null; identity: FaydaIdentity }>();
  readonly accounts: FakeAccount[] = [];
  readonly events: FaydaEvent[] = [];
  verifiedCalls: Array<{ identity: FaydaIdentity; context: FaydaVerifiedContext }> = [];
  /** Make onVerified throw this. */
  failWith: Error | undefined;

  async createSession(session: FaydaSessionRecord): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async claimSession(state: string): Promise<FaydaSessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.state === state && session.status === "PENDING") {
        session.status = "IN_PROGRESS";
        return { ...session };
      }
    }
    return null;
  }

  async endSession(sessionId: string, end: FaydaSessionEnd): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = end.status;
    session.errorCode = end.errorCode;
    session.errorDescription = end.errorDescription;
    session.nonce = "";
    session.codeVerifier = "";
  }

  async findContactMatches(identity: FaydaIdentity): Promise<string[]> {
    const email = emailKey(identity.email);
    return this.accounts
      .filter((a) => (identity.phoneE164 && a.phone === identity.phoneE164) || (email && emailKey(a.email) === email))
      .map((a) => a.id);
  }

  async onVerified(identity: FaydaIdentity, context: FaydaVerifiedContext) {
    this.verifiedCalls.push({ identity, context });
    if (this.failWith) throw this.failWith;
    const existing = this.identities.get(identity.sub);
    const accountId = context.session.accountId;
    if (existing && accountId && existing.accountId && existing.accountId !== accountId) {
      throw new FaydaHostRefusal("FAYDA_IDENTITY_CONFLICT", "This Fayda ID is already linked to another account");
    }
    const row = existing ?? { id: `identity-${this.identities.size + 1}`, sub: identity.sub, accountId: null, identity };
    if (accountId && !row.accountId) row.accountId = accountId;
    row.identity = identity;
    this.identities.set(identity.sub, row);
    return { identityId: row.id, linkedAccountId: row.accountId, possibleAccountMatch: context.possibleMatches.length > 0 };
  }

  async recordEvent(event: FaydaEvent): Promise<void> {
    this.events.push(event);
  }

  sessionByState(state: string) {
    return [...this.sessions.values()].find((s) => s.state === state);
  }
}
