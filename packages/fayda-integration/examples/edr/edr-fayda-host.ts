/**
 * NOT COMPILED. How EDR's freight API (apps/edr-freight-api, at 4e43da58b) would sit on this
 * package instead of modules/verifayda/verifayda.service.ts. It names EDR's tables, env and
 * helpers; it type-checks only inside EDR. See docs/INTEGRATION-GUIDE.md, section 12.
 *
 * What changes for EDR:
 * 1. The ID token and the userinfo JWT are verified (EDR decoded the userinfo payload unverified
 *    and never read the ID token). New env: FAYDA_ISSUER, FAYDA_JWKS_URI.
 * 2. A nonce goes out and must come back; prompt=login goes out on every channel.
 * 3. The session is claimed by one conditional UPDATE, so two completions cannot both run.
 * 4. Step 2 of upsertIamUser is gone: no account is found, merged into, or handed a session
 *    token because its phone or email equals the Fayda record's. A match is only reported.
 * 5. Web sessions are bound to the browser that started them (cookie), so a code+state link
 *    sent to someone else completes nothing.
 * 6. DEV_BYPASS stays out of the package: keep it in EDR's controller, behind isBypassEnv(), if
 *    it is still wanted, and never in a production build.
 */
import { Body, Controller, Get, HttpCode, Injectable, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  FaydaEvent,
  FaydaHost,
  FaydaHostRefusal,
  FaydaIdentity,
  FaydaModule,
  FaydaService,
  FaydaSessionEnd,
  FaydaSessionRecord,
  FaydaVerifiedContext,
  emailKey,
  readCookie,
} from "@edr/fayda-integration";
import { phoneLookupVariants } from "../../common/phone.util"; // EDR
import { OptionalJwtGuard } from "./optional-jwt.guard"; // EDR
import { generateRefreshToken, generateToken } from "@tria-plc/api-common/utils/token"; // EDR
import { createFaydaSessionRow } from "./fayda-session.sql"; // EDR: createFaydaSession's INSERT, moved out

/**
 * Migration to add before switching (freight schema):
 *
 *   ALTER TABLE freight.fayda_verification_sessions
 *     ADD COLUMN IF NOT EXISTS nonce varchar(64) NOT NULL DEFAULT '',
 *     ADD COLUMN IF NOT EXISTS redirect_uri text,
 *     ADD COLUMN IF NOT EXISTS browser_binding_hash char(64),
 *     ADD COLUMN IF NOT EXISTS metadata jsonb;
 *   -- status gains IN_PROGRESS and EXPIRED; platform keeps WEB | PORTAL | MOBILE (the channel).
 *   CREATE UNIQUE INDEX IF NOT EXISTS iam_users_fayda_sub_uq ON iam.users ((metadata->>'sub'))
 *     WHERE metadata->>'sub' IS NOT NULL;   -- one account per Fayda subject
 */

export interface EdrVerifyResult {
  sub: string;
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  birthdate?: string;
  gender?: string;
  address?: string;
  iamUserId: string | null;
  /** Only for an account found by sub, or created now: never for a contact match. */
  token?: string;
  refreshToken?: string;
  requiresPassword?: boolean;
  possibleAccountMatch: boolean;
}

@Injectable()
export class EdrFreightFaydaHost implements FaydaHost<EdrVerifyResult> {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async createSession(s: FaydaSessionRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO freight.fayda_verification_sessions
         (id, state, code_verifier, nonce, purpose, platform, redirect_uri, browser_binding_hash, save_to_account,
          status, iam_user_id, metadata, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
      [s.id, s.state, s.codeVerifier, s.nonce, s.purpose, s.channel, s.redirectUri, s.browserBindingHash,
        s.metadata?.wantsPasswordSetup === true, s.status, s.accountId, JSON.stringify(s.metadata ?? {}), s.expiresAt, s.createdAt],
    );
  }

  async claimSession(state: string): Promise<FaydaSessionRecord | null> {
    const [rows] = await this.db.query(
      `UPDATE freight.fayda_verification_sessions SET status = 'IN_PROGRESS', updated_at = now()
        WHERE state = $1 AND status = 'PENDING' RETURNING *`,
      [state],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, state: r.state, nonce: r.nonce, codeVerifier: r.code_verifier, browserBindingHash: r.browser_binding_hash,
      purpose: r.purpose, channel: r.platform, redirectUri: r.redirect_uri, accountId: r.iam_user_id, status: r.status,
      createdAt: r.created_at, expiresAt: r.expires_at, metadata: r.metadata,
    };
  }

  async endSession(id: string, end: FaydaSessionEnd): Promise<void> {
    await this.db.query(
      `UPDATE freight.fayda_verification_sessions
          SET status = $2, error_code = $3, error_description = $4, completed_at = $5, code_verifier = '', nonce = '', updated_at = now()
        WHERE id = $1`,
      [id, end.status, end.errorCode ?? null, end.errorDescription ?? null, end.at],
    );
  }

  async findContactMatches(identity: FaydaIdentity): Promise<string[]> {
    const phones = identity.phoneE164 ? phoneLookupVariants(identity.phoneE164) : [];
    const email = emailKey(identity.email);
    if (phones.length === 0 && !email) return [];
    const rows: { id: string }[] = await this.db.query(
      `SELECT id FROM iam.users WHERE phone_number = ANY($1::text[]) OR ($2::text IS NOT NULL AND lower(email) = $2)`,
      [phones, email ?? null],
    );
    return rows.map((r) => r.id);
  }

  async onVerified(identity: FaydaIdentity, { session, possibleMatches }: FaydaVerifiedContext): Promise<EdrVerifyResult> {
    return this.db.transaction(async (tx) => {
      const metadata = {
        sub: identity.sub,
        address: { am: identity.addressAm ?? "", en: identity.addressEn ?? "" },
        email: identity.email ?? "",
        gender: { am: identity.genderAm ?? "", en: identity.genderEn ?? "" },
        name: { am: identity.nameAm ?? "", en: identity.nameEn ?? "" },
        phoneNumber: identity.phoneRaw ?? "",
        dateOfBirth: identity.birthdate ?? "",
      };
      // Step 1: already linked by sub (locked).
      const bySub: { id: string }[] = await tx.query(`SELECT id FROM iam.users WHERE metadata->>'sub' = $1 FOR UPDATE`, [identity.sub]);
      let iamUserId: string | null = bySub[0]?.id ?? null;
      let mayIssueToken = iamUserId !== null;

      if (session.accountId) {
        // A signed-in user verifies: the proven owner attaches the sub to their own account.
        if (iamUserId && iamUserId !== session.accountId) {
          throw new FaydaHostRefusal("FAYDA_IDENTITY_CONFLICT", "This Fayda identity is already linked to another account");
        }
        iamUserId = session.accountId;
        mayIssueToken = false; // they are signed in already
      } else if (!iamUserId) {
        // Step 3: a new individual user. The old step 2 (match by phone or email, merge, and
        // hand out a token for that account) is gone.
        const [row] = await tx.query(
          `INSERT INTO iam.users (id, name, username, email, phone_number, metadata, user_type, status, is_active,
                                  has_set_password, is_phone_number_verified, verified_by, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::jsonb, $2, $3, $4, $5::jsonb, 'individual', 'submitted', true, false, false, 'fayda', now(), now())
           RETURNING id`,
          [JSON.stringify(metadata.name), identity.sub, identity.email ?? null, identity.phoneE164 ?? null, JSON.stringify(metadata)],
        );
        iamUserId = row.id;
        mayIssueToken = true;
      }
      await tx.query(
        `UPDATE iam.users SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, verified_by = 'fayda', updated_at = now() WHERE id = $2`,
        [JSON.stringify(metadata), iamUserId],
      );
      const token = mayIssueToken && iamUserId ? await this.issueSession(tx, iamUserId) : undefined;
      return {
        sub: identity.sub,
        fullName: identity.fullName,
        email: identity.email,
        phoneNumber: identity.phoneE164,
        birthdate: identity.birthdate,
        gender: identity.gender,
        address: identity.addressEn ?? identity.addressAm,
        iamUserId,
        ...(token ?? {}),
        possibleAccountMatch: possibleMatches.some((id) => id !== iamUserId),
      };
    });
  }

  async recordEvent(event: FaydaEvent): Promise<void> {
    // EDR's audit log (or the new audit_log_details layer): event.type, sessionId, code only.
    void event;
  }

  /**
   * EDR's VerifaydaService.createFaydaSession moved here unchanged (the iam.sessions INSERT ...
   * ON CONFLICT (user_id, device), then generateToken / generateRefreshToken on its id). Only
   * the caller changed: it is reached for an account found by sub or created just now.
   */
  private async issueSession(
    tx: { query: DataSource["query"] },
    iamUserId: string,
  ): Promise<{ token: string; refreshToken: string; requiresPassword: boolean }> {
    const sessionId: string = await createFaydaSessionRow(tx, iamUserId); // EDR's SQL, as in verifayda.service.ts
    const [user] = await tx.query(`SELECT has_set_password FROM iam.users WHERE id = $1`, [iamUserId]);
    return { token: generateToken({ id: sessionId }), refreshToken: generateRefreshToken({ id: sessionId }), requiresPassword: !user.has_set_password };
  }
}

/** EDR's routes kept as they are (the front ends do not change paths), on top of FaydaService. */
@Controller("fayda/verification")
export class EdrVerifaydaController {
  constructor(private readonly fayda: FaydaService<EdrVerifyResult>) {}

  @Post("start")
  @HttpCode(200)
  @UseGuards(OptionalJwtGuard)
  async start(@Body() dto: { purpose?: "VERIFY" | "LOGIN"; platform?: "WEB" | "PORTAL" | "MOBILE"; wantsPasswordSetup?: boolean }, @Req() req: { user?: { id: string } }, @Res({ passthrough: true }) res: { setHeader(n: string, v: string): void }) {
    const started = await this.fayda.start({
      purpose: dto.purpose ?? "VERIFY",
      channel: dto.platform ?? "WEB",
      accountId: req.user?.id ?? null,
      metadata: { wantsPasswordSetup: dto.wantsPasswordSetup === true },
    });
    // The API is called cross-origin by the SPAs: the cookie needs SameSite=None; Secure and
    // credentials: "include" on the start and complete calls (browserBinding.sameSite option).
    if (started.browserBinding) res.setHeader("Set-Cookie", started.browserBinding.setCookie);
    return { authorizationUrl: started.authorizationUrl };
  }

  @Get("complete")
  async complete(@Query() q: Record<string, string>, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: { status(n: number): { json(b: unknown): void } }) {
    const result = await this.fayda.complete({
      code: q.code,
      state: q.state,
      error: q.error,
      errorDescription: q.error_description,
      browserBinding: readCookie(req, this.fayda.bindingCookieName(q.state ?? "")),
    });
    if (result.outcome === "VERIFIED") return res.status(200).json({ purpose: result.purpose, verified: true, ...result.result });
    return res.status(result.httpStatus).json({ code: result.code, message: result.message });
  }
}

export const edrFaydaModule = FaydaModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  host: EdrFreightFaydaHost,
  route: false,
  useFactory: (c: ConfigService) => ({
    enabled: c.get("FAYDA_ENABLED") === "true",
    clientId: c.get("FAYDA_CLIENT_ID") ?? "",
    issuer: c.get("FAYDA_ISSUER") ?? "",
    authorizationEndpoint: c.get("FAYDA_AUTHORIZATION_ENDPOINT") ?? "",
    tokenEndpoint: c.get("FAYDA_TOKEN_ENDPOINT") ?? "",
    userinfoEndpoint: c.get("FAYDA_USERINFO_ENDPOINT") ?? "",
    jwksUri: c.get("FAYDA_JWKS_URI") ?? "",
    privateKey: c.get("FAYDA_PRIVATE_KEY_BASE64"),
    redirectUris: {
      MOBILE: c.get("FAYDA_REDIRECT_URI") ?? "",
      WEB: c.get("FAYDA_WEB_REDIRECT_URI") || c.get("FAYDA_REDIRECT_URI") || "",
      PORTAL: c.get("FAYDA_PORTAL_REDIRECT_URI") || c.get("FAYDA_WEB_REDIRECT_URI") || c.get("FAYDA_REDIRECT_URI") || "",
    },
    scope: c.get("FAYDA_SCOPE"),
    acrValues: c.get("FAYDA_ACR_VALUES"),
    claimsLocales: c.get("FAYDA_CLAIMS_LOCALES"),
    sessionTtlMinutes: Number(c.get("FAYDA_SESSION_TTL_MINUTES") ?? 10),
    browserBinding: { sameSite: "None" },
  }),
});
