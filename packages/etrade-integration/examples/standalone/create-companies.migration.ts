import { MigrationInterface, QueryRunner } from "typeorm";

export const qualified = (queryRunner: QueryRunner, name: string): string => {
  const schema = (queryRunner.connection.options as { schema?: string }).schema;
  return schema ? `"${schema}"."${name}"` : `"${name}"`;
};

/**
 * The example's own tables. The package has no tables: in your system, add a jsonb snapshot
 * column to whatever carries the licence (EDR: company_profiles.etrade_business).
 *
 * - companies: the TIN lives here, unique. manual_registration marks a co-operative or an
 *   investment-licence company that has no e-trade licence.
 * - company_profiles: the operational roles; each carries the licence it trades under. Not
 *   unique: one licence may back several profiles.
 * - etrade_lookups: one row per e-trade call, with a hash of the TIN, never the TIN or a body.
 * - etrade_tin_budget: the TIN lookup budget, shared by every instance of the app.
 */
export class CreateExampleCompanies1790000000300 implements MigrationInterface {
  name = "CreateExampleCompanies1790000000300";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${qualified(queryRunner, "companies")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tin" varchar(10) NOT NULL UNIQUE,
        "name" varchar(200) NOT NULL DEFAULT '',
        "manual_registration" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${qualified(queryRunner, "company_profiles")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "company_id" uuid NOT NULL REFERENCES ${qualified(queryRunner, "companies")} ("id"),
        "type" varchar(32) NOT NULL,
        "etrade_licence" jsonb,
        "etrade_checked_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "company_profiles_recheck_idx"
        ON ${qualified(queryRunner, "company_profiles")} ("etrade_checked_at") WHERE "etrade_licence" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${qualified(queryRunner, "etrade_lookups")} (
        "id" bigserial PRIMARY KEY,
        "at" timestamptz NOT NULL,
        "actor" varchar(100),
        "call" varchar(16) NOT NULL,
        "tin_hash" char(64) NOT NULL,
        "licence_number" varchar(120),
        "outcome" varchar(16) NOT NULL,
        "code" varchar(64),
        "cached" boolean NOT NULL,
        "duration_ms" integer NOT NULL,
        "http_status" integer
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${qualified(queryRunner, "etrade_tin_budget")} (
        "actor" varchar(100) NOT NULL,
        "tin_hash" char(64) NOT NULL,
        "charged_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("actor", "tin_hash")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ["etrade_tin_budget", "etrade_lookups", "company_profiles", "companies"]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${qualified(queryRunner, table)}`);
    }
  }
}
