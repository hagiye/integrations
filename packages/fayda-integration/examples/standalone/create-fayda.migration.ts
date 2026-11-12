import { MigrationInterface, QueryRunner } from "typeorm";

export const qualified = (queryRunner: QueryRunner, name: string): string => {
  const schema = (queryRunner.connection.options as { schema?: string }).schema;
  return schema ? `"${schema}"."${name}"` : `"${name}"`;
};

/**
 * The example's own tables. The package has none: in your system the sessions and identities
 * live wherever your accounts do (EDR: freight.fayda_verification_sessions and iam.users).
 *
 * - accounts: the app's own user accounts. Phone and email are NOT unique and never link a
 *   Fayda identity on their own.
 * - fayda_sessions: one row per started verification. state is unique; nonce and code_verifier
 *   are wiped when the session ends; browser_binding_hash is the SHA-256 of the cookie secret.
 * - fayda_identities: one row per Fayda subject (unique), linked to at most one account, and an
 *   account to at most one subject.
 * - fayda_results: what the browser that started a session may read once it is verified.
 * - fayda_audit: starts, outcomes and invalid states. No claim values.
 * - public_requests: a step that takes a proof (UC-3); proof_session_id is unique so one proof
 *   cannot be used twice.
 */
export class CreateExampleFayda1790000000400 implements MigrationInterface {
  name = "CreateExampleFayda1790000000400";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = (name: string) => qualified(queryRunner, name);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("accounts")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "display_name" varchar(200) NOT NULL DEFAULT '',
        "phone" varchar(20),
        "email" varchar(200),
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("fayda_sessions")} (
        "id" uuid PRIMARY KEY,
        "state" varchar(256) NOT NULL UNIQUE,
        "nonce" varchar(64) NOT NULL DEFAULT '',
        "code_verifier" varchar(128) NOT NULL DEFAULT '',
        "browser_binding_hash" char(64),
        "purpose" varchar(32) NOT NULL,
        "channel" varchar(32) NOT NULL,
        "redirect_uri" text NOT NULL,
        "account_id" uuid,
        "status" varchar(16) NOT NULL,
        "error_code" varchar(64),
        "error_description" varchar(200),
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "completed_at" timestamptz
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "fayda_sessions_expires_idx" ON ${t("fayda_sessions")} ("expires_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "fayda_sessions_account_idx" ON ${t("fayda_sessions")} ("account_id")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("fayda_identities")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "fayda_sub" varchar(255) NOT NULL UNIQUE,
        "client_id" varchar(200) NOT NULL,
        "account_id" uuid UNIQUE REFERENCES ${t("accounts")} ("id"),
        "full_name_en" varchar(300),
        "full_name_am" varchar(300),
        "birthdate" date,
        "gender" varchar(40),
        "phone_e164" varchar(20),
        "phone_raw" varchar(40),
        "email" varchar(200),
        "address_en" text,
        "address_am" text,
        "acr" varchar(100),
        "verified_at" timestamptz NOT NULL,
        "last_session_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("fayda_results")} (
        "session_id" uuid PRIMARY KEY REFERENCES ${t("fayda_sessions")} ("id"),
        "identity_id" uuid NOT NULL REFERENCES ${t("fayda_identities")} ("id"),
        "view" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("fayda_audit")} (
        "id" bigserial PRIMARY KEY,
        "at" timestamptz NOT NULL,
        "type" varchar(20) NOT NULL,
        "session_id" uuid,
        "account_id" uuid,
        "purpose" varchar(32),
        "channel" varchar(32),
        "code" varchar(64),
        "reason" varchar(200)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("public_requests")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "fayda_sub" varchar(255) NOT NULL,
        "proof_session_id" uuid NOT NULL UNIQUE,
        "text" varchar(2000) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ["public_requests", "fayda_audit", "fayda_results", "fayda_identities", "fayda_sessions", "accounts"]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${qualified(queryRunner, table)}`);
    }
  }
}
