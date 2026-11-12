import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { createHash } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import {
  FaydaEvent,
  FaydaHost,
  FaydaHostRefusal,
  FaydaIdentity,
  FaydaSessionEnd,
  FaydaSessionRecord,
  FaydaVerifiedContext,
  emailKey,
} from "@edr/fayda-integration";

/** What the starting browser may read after a verification: fields to prefill, nothing more. */
export interface ExampleResultView {
  identityId: string;
  /** The account the identity is linked to now, or null (a guest, or a possible match left alone). */
  accountId: string | null;
  /** True when LOGIN created a new account for this person. */
  accountCreated: boolean;
  fullName: string | null;
  birthdate: string | null;
  /** An account holds the same verified phone or email; it was NOT linked. Ask the person to sign in to it first. */
  possibleAccountMatch: boolean;
}

interface SessionRow {
  id: string;
  state: string;
  nonce: string;
  code_verifier: string;
  browser_binding_hash: string | null;
  purpose: string;
  channel: string;
  redirect_uri: string;
  account_id: string | null;
  status: FaydaSessionRecord["status"];
  metadata: Record<string, unknown> | null;
  created_at: Date;
  expires_at: Date;
}

const toRecord = (row: SessionRow): FaydaSessionRecord => ({
  id: row.id,
  state: row.state,
  nonce: row.nonce,
  codeVerifier: row.code_verifier,
  browserBindingHash: row.browser_binding_hash,
  purpose: row.purpose,
  channel: row.channel,
  redirectUri: row.redirect_uri,
  accountId: row.account_id,
  status: row.status,
  metadata: row.metadata,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
});

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "23505";

/**
 * The FaydaHost on Postgres through TypeORM. Sessions are claimed with one conditional UPDATE,
 * identities are keyed by fayda_sub (unique) and upserted under the row lock that
 * INSERT ... ON CONFLICT DO UPDATE takes, so two completions for one person make one row.
 */
@Injectable()
export class TypeOrmFaydaHost implements FaydaHost<ExampleResultView> {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private table(name: string): string {
    const schema = (this.db.options as { schema?: string }).schema;
    return schema ? `"${schema}"."${name}"` : `"${name}"`;
  }

  async createSession(s: FaydaSessionRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table("fayda_sessions")}
         ("id", "state", "nonce", "code_verifier", "browser_binding_hash", "purpose", "channel", "redirect_uri",
          "account_id", "status", "metadata", "created_at", "expires_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [s.id, s.state, s.nonce, s.codeVerifier, s.browserBindingHash, s.purpose, s.channel, s.redirectUri, s.accountId, s.status,
        s.metadata ? JSON.stringify(s.metadata) : null, s.createdAt, s.expiresAt],
    );
  }

  async claimSession(state: string): Promise<FaydaSessionRecord | null> {
    const [rows] = (await this.db.query(
      `UPDATE ${this.table("fayda_sessions")} SET "status" = 'IN_PROGRESS'
        WHERE "state" = $1 AND "status" = 'PENDING' RETURNING *`,
      [state],
    )) as [SessionRow[], number];
    return rows.length > 0 ? toRecord(rows[0]) : null;
  }

  async endSession(sessionId: string, end: FaydaSessionEnd): Promise<void> {
    await this.db.query(
      `UPDATE ${this.table("fayda_sessions")}
          SET "status" = $2, "error_code" = $3, "error_description" = $4, "completed_at" = $5,
              "nonce" = '', "code_verifier" = ''
        WHERE "id" = $1`,
      [sessionId, end.status, end.errorCode ?? null, end.errorDescription?.slice(0, 200) ?? null, end.at],
    );
  }

  async findContactMatches(identity: FaydaIdentity): Promise<string[]> {
    const email = emailKey(identity.email);
    if (!identity.phoneE164 && !email) return [];
    const rows: { id: string }[] = await this.db.query(
      `SELECT "id" FROM ${this.table("accounts")}
        WHERE ($1::text IS NOT NULL AND "phone" = $1) OR ($2::text IS NOT NULL AND lower("email") = $2)`,
      [identity.phoneE164 ?? null, email ?? null],
    );
    return rows.map((r) => r.id);
  }

  async onVerified(identity: FaydaIdentity, context: FaydaVerifiedContext): Promise<ExampleResultView> {
    const { session } = context;
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.upsertIdentity(tx, identity, session.id);
        let accountId = row.account_id;
        let accountCreated = false;

        if (session.accountId) {
          // A signed-in account verifies itself: the proven owner attaches the sub.
          if (accountId && accountId !== session.accountId) {
            throw new FaydaHostRefusal("FAYDA_IDENTITY_CONFLICT", "This Fayda ID is already linked to another account");
          }
          if (!accountId) {
            await tx.query(`UPDATE ${this.table("fayda_identities")} SET "account_id" = $2 WHERE "id" = $1`, [row.id, session.accountId]);
            accountId = session.accountId;
          }
        } else if (session.purpose === "LOGIN" && !accountId) {
          // Sign-in with no link yet: a NEW account, never one found by phone or email.
          const [created] = await tx.query(
            `INSERT INTO ${this.table("accounts")} ("display_name", "phone", "email") VALUES ($1, $2, $3) RETURNING "id"`,
            [identity.fullName ?? "", identity.phoneE164 ?? null, emailKey(identity.email) ?? null],
          );
          await tx.query(`UPDATE ${this.table("fayda_identities")} SET "account_id" = $2 WHERE "id" = $1`, [row.id, created.id]);
          accountId = created.id;
          accountCreated = true;
        }

        const view: ExampleResultView = {
          identityId: row.id,
          accountId,
          accountCreated,
          fullName: identity.fullName ?? null,
          birthdate: identity.birthdate ?? null,
          possibleAccountMatch: context.possibleMatches.some((id) => id !== accountId),
        };
        await tx.query(
          `INSERT INTO ${this.table("fayda_results")} ("session_id", "identity_id", "view") VALUES ($1, $2, $3)`,
          [session.id, row.id, JSON.stringify(view)],
        );
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err) && session.accountId) {
        // The account already carries another Fayda subject (account_id is unique).
        throw new FaydaHostRefusal("FAYDA_ACCOUNT_ALREADY_VERIFIED", "This account is already verified with another Fayda ID");
      }
      throw err;
    }
  }

  async recordEvent(event: FaydaEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table("fayda_audit")} ("at", "type", "session_id", "account_id", "purpose", "channel", "code", "reason")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [event.at, event.type, event.sessionId ?? null, event.accountId ?? null, event.purpose ?? null, event.channel ?? null,
        event.code ?? null, event.reason?.slice(0, 200) ?? null],
    );
  }

  /**
   * The result of a verified session, for the browser that started it: the binding cookie's
   * hash must match the session's. An unbound session (a native app) needs none.
   */
  async readResult(sessionId: string, bindingFor: (state: string) => string | undefined): Promise<ExampleResultView | null> {
    const rows: Array<{ state: string; browser_binding_hash: string | null; view: ExampleResultView }> = await this.db.query(
      `SELECT s."state", s."browser_binding_hash", r."view"
         FROM ${this.table("fayda_results")} r JOIN ${this.table("fayda_sessions")} s ON s."id" = r."session_id"
        WHERE r."session_id" = $1 AND r."created_at" > now() - interval '15 minutes'`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.browser_binding_hash) {
      const given = bindingFor(row.state);
      if (!given || createHash("sha256").update(given).digest("hex") !== row.browser_binding_hash) return null;
    }
    return row.view;
  }

  async stateOf(sessionId: string): Promise<string | null> {
    const rows: { state: string }[] = await this.db.query(`SELECT "state" FROM ${this.table("fayda_sessions")} WHERE "id" = $1`, [sessionId]);
    return rows[0]?.state ?? null;
  }

  /** Daily clean-up: closed or expired sessions older than `days` (results go with them). */
  async purgeSessions(days: number): Promise<number> {
    await this.db.query(
      `DELETE FROM ${this.table("fayda_results")} WHERE "session_id" IN
         (SELECT "id" FROM ${this.table("fayda_sessions")} WHERE "created_at" < now() - make_interval(days => $1))`,
      [days],
    );
    const [, count] = (await this.db.query(
      `DELETE FROM ${this.table("fayda_sessions")} WHERE "created_at" < now() - make_interval(days => $1)`,
      [days],
    )) as [unknown, number];
    return count;
  }

  private async upsertIdentity(tx: EntityManager, identity: FaydaIdentity, sessionId: string): Promise<{ id: string; account_id: string | null }> {
    const [row] = await tx.query(
      `INSERT INTO ${this.table("fayda_identities")}
         ("fayda_sub", "client_id", "full_name_en", "full_name_am", "birthdate", "gender", "phone_e164", "phone_raw",
          "email", "address_en", "address_am", "acr", "verified_at", "last_session_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT ("fayda_sub") DO UPDATE SET
         "full_name_en" = EXCLUDED."full_name_en", "full_name_am" = EXCLUDED."full_name_am",
         "birthdate" = EXCLUDED."birthdate", "gender" = EXCLUDED."gender",
         "phone_e164" = EXCLUDED."phone_e164", "phone_raw" = EXCLUDED."phone_raw", "email" = EXCLUDED."email",
         "address_en" = EXCLUDED."address_en", "address_am" = EXCLUDED."address_am", "acr" = EXCLUDED."acr",
         "verified_at" = EXCLUDED."verified_at", "last_session_id" = EXCLUDED."last_session_id"
       RETURNING "id", "account_id"`,
      [identity.sub, identity.clientId, identity.nameEn ?? identity.fullName ?? null, identity.nameAm ?? null, identity.birthdate ?? null,
        identity.gender ?? null, identity.phoneE164 ?? null, identity.phoneRaw ?? null, identity.email ?? null,
        identity.addressEn ?? null, identity.addressAm ?? null, identity.acr ?? null, identity.verifiedAt, sessionId],
    );
    return row;
  }
}
