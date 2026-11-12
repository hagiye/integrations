import { MigrationInterface, QueryRunner } from "typeorm";

export const qualified = (queryRunner: QueryRunner, name: string): string => {
  const schema = (queryRunner.connection.options as { schema?: string }).schema;
  return schema ? `"${schema}"."${name}"` : `"${name}"`;
};

/**
 * The example's own tables. The package has none: in your system the filing columns live on
 * your invoice table (EDR: freight.invoices eims_* columns) and the rest beside it.
 *
 * - invoices: your documents (INV, CRE, DEB) with their buyer, plus the filing columns. eims_irn
 *   is text (a test IRN is 69 characters; a varchar(64) once lost an accepted one) and unique.
 * - invoice_lines, invoice_payments: lines in filing order; the payment ledger, one key per payment.
 * - eims_system_state: one row per MoR system number, the sequence MoR enforces.
 * - eims_receipts: one row per receipt attempt; at most one live attempt per (invoice, payment).
 * - eims_credentials: INSA pairs; at most one ACTIVE and one PENDING row, enforced here.
 * - eims_exchanges: every MoR exchange, already redacted by the package.
 * - eims_events: what the package asked to be told to people.
 */
export class CreateExampleEims1790000000500 implements MigrationInterface {
  name = "CreateExampleEims1790000000500";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = (name: string) => qualified(queryRunner, name);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("invoices")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoice_number" varchar(40) NOT NULL UNIQUE,
        "document_type" varchar(3) NOT NULL DEFAULT 'INV',
        "reason" text,
        "related_invoice_id" uuid REFERENCES ${t("invoices")} ("id"),
        "currency" varchar(3) NOT NULL,
        "exchange_rate" numeric(18,6),
        "total_amount" numeric(18,2) NOT NULL,
        "issued_at" timestamptz,
        "voided" boolean NOT NULL DEFAULT false,
        "buyer" jsonb NOT NULL,
        "payment_mode" varchar(16),
        "eims_status" varchar(20) NOT NULL DEFAULT 'NOT_SUBMITTED',
        "eims_irn" text,
        "eims_document_number" varchar(12),
        "eims_invoice_counter" bigint,
        "eims_ack_date" varchar(64),
        "eims_signed_qr" text,
        "eims_submitted_at" timestamptz,
        "eims_last_error" jsonb,
        "eims_retry_count" integer NOT NULL DEFAULT 0,
        "eims_bulk_conversation_id" text,
        "eims_cancelled_at" timestamptz,
        "eims_cancellation_date" varchar(64),
        "eims_cancellation_reason_code" varchar(8),
        "eims_cancellation_remark" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "invoices_eims_irn_uq" ON ${t("invoices")} ("eims_irn") WHERE "eims_irn" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "invoices_eims_queue_idx" ON ${t("invoices")} ("eims_status", "issued_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "invoices_eims_bulk_idx" ON ${t("invoices")} ("eims_bulk_conversation_id") WHERE "eims_bulk_conversation_id" IS NOT NULL`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("invoice_lines")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL REFERENCES ${t("invoices")} ("id"),
        "line_no" integer NOT NULL,
        "charge_type" varchar(64) NOT NULL,
        "description" varchar(255),
        "quantity" numeric(18,4) NOT NULL,
        "unit_price" numeric(18,4) NOT NULL,
        "amount" numeric(18,2) NOT NULL,
        "basis" varchar(32),
        UNIQUE ("invoice_id", "line_no")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("invoice_payments")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL REFERENCES ${t("invoices")} ("id"),
        "payment_key" varchar(64) NOT NULL,
        "amount" numeric(18,2) NOT NULL,
        "paid_at" timestamptz NOT NULL DEFAULT now(),
        "method" varchar(32),
        "mode_of_payment" varchar(16),
        "channel" varchar(32),
        "reference" varchar(64),
        UNIQUE ("invoice_id", "payment_key")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("eims_system_state")} (
        "system_number" varchar(32) PRIMARY KEY,
        "next_invoice_counter" bigint NOT NULL DEFAULT 1,
        "next_document_number" bigint NOT NULL DEFAULT 1,
        "previous_irn" text,
        "in_flight_document_id" uuid,
        "in_flight_counter" bigint,
        "in_flight_document_number" bigint,
        "in_flight_conversation_id" text,
        "blocked_reason" text
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("eims_receipts")} (
        "id" uuid PRIMARY KEY,
        "invoice_id" uuid NOT NULL REFERENCES ${t("invoices")} ("id"),
        "payment_key" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL,
        "receipt_number" varchar(20) NOT NULL,
        "rrn" text,
        "qr" text,
        "ack_status" varchar(8),
        "submitted_at" timestamptz,
        "request" jsonb,
        "last_error" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    // One live attempt per payment: two workers can never file the same payment twice.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "eims_receipts_live_uq" ON ${t("eims_receipts")} ("invoice_id", "payment_key") WHERE "status" IN ('SUBMITTING', 'REGISTERED', 'UNKNOWN')`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("eims_credentials")} (
        "id" uuid PRIMARY KEY,
        "status" varchar(16) NOT NULL,
        "label" varchar(128) NOT NULL DEFAULT '',
        "private_key_enc" text,
        "certificate_base64" text NOT NULL,
        "cert_fingerprint_sha256" varchar(95) NOT NULL,
        "key_fingerprint_sha256" varchar(95) NOT NULL,
        "cert_subject" text NOT NULL DEFAULT '',
        "cert_issuer" text NOT NULL DEFAULT '',
        "cert_not_before" timestamptz,
        "cert_not_after" timestamptz,
        "key_bits" integer,
        "activation_system_number" varchar(64),
        "last_activation_error" text,
        "expiry_reminder_stage" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL,
        "activated_at" timestamptz,
        "retired_at" timestamptz,
        "replaced_by_id" uuid
      )
    `);
    // No overlap, enforced by the database too: never two usable pairs.
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "eims_credentials_one_active" ON ${t("eims_credentials")} ((true)) WHERE "status" = 'ACTIVE'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "eims_credentials_one_pending" ON ${t("eims_credentials")} ((true)) WHERE "status" = 'PENDING'`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("eims_exchanges")} (
        "id" bigserial PRIMARY KEY,
        "direction" varchar(8) NOT NULL,
        "operation" varchar(64) NOT NULL,
        "path" varchar(128) NOT NULL,
        "attempt" integer NOT NULL,
        "document_ids" jsonb NOT NULL,
        "receipt_id" uuid,
        "trigger" varchar(32),
        "system_number" varchar(32),
        "status_code" integer,
        "is_success" boolean NOT NULL,
        "failure_kind" varchar(32),
        "error_message" text,
        "request_headers" jsonb,
        "request_body" jsonb,
        "response_body" jsonb,
        "source_ip" varchar(64),
        "duration_ms" integer,
        "at" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("eims_events")} (
        "id" bigserial PRIMARY KEY,
        "type" varchar(32) NOT NULL,
        "priority" varchar(8) NOT NULL,
        "message" text NOT NULL,
        "document_id" uuid,
        "detail" jsonb,
        "at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const t = (name: string) => qualified(queryRunner, name);
    for (const table of ["eims_events", "eims_exchanges", "eims_credentials", "eims_receipts", "eims_system_state", "invoice_payments", "invoice_lines", "invoices"]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${t(table)}`);
    }
  }
}
