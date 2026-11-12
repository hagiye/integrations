import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import {
  EimsBuyer,
  EimsCredentialRecord,
  EimsDocument,
  EimsDocumentType,
  EimsEvent,
  EimsExchangeRecord,
  EimsFiling,
  EimsHost,
  EimsLedger,
  EimsReceiptRecord,
  EimsReceiptSource,
  EimsSystemState,
} from "@edr/mor-eims-integration";

type Row = Record<string, any>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown): Date | null => (v ? new Date(v as string) : null);

const FILING_COLUMNS = `"id", "eims_status", "eims_irn", "eims_document_number", "eims_invoice_counter", "eims_ack_date",
  "eims_signed_qr", "eims_submitted_at", "eims_last_error", "eims_retry_count", "eims_bulk_conversation_id",
  "eims_cancelled_at", "eims_cancellation_date", "eims_cancellation_reason_code", "eims_cancellation_remark"`;

const toFiling = (r: Row): EimsFiling => ({
  documentId: r.id,
  status: r.eims_status,
  irn: r.eims_irn,
  documentNumber: r.eims_document_number,
  invoiceCounter: num(r.eims_invoice_counter),
  ackDate: r.eims_ack_date,
  signedQr: r.eims_signed_qr,
  submittedAt: date(r.eims_submitted_at),
  lastError: r.eims_last_error,
  retryCount: Number(r.eims_retry_count ?? 0),
  bulkConversationId: r.eims_bulk_conversation_id,
  cancelledAt: date(r.eims_cancelled_at),
  cancellationDate: r.eims_cancellation_date,
  cancellationReasonCode: r.eims_cancellation_reason_code,
  cancellationRemark: r.eims_cancellation_remark,
});

const toState = (r: Row): EimsSystemState => ({
  systemNumber: r.system_number,
  nextInvoiceCounter: Number(r.next_invoice_counter),
  nextDocumentNumber: Number(r.next_document_number),
  previousIrn: r.previous_irn,
  inFlightDocumentId: r.in_flight_document_id,
  inFlightCounter: num(r.in_flight_counter),
  inFlightDocumentNumber: num(r.in_flight_document_number),
  inFlightConversationId: r.in_flight_conversation_id,
  blockedReason: r.blocked_reason,
});

const toReceipt = (r: Row): EimsReceiptRecord => ({
  id: r.id,
  documentId: r.invoice_id,
  paymentKey: r.payment_key,
  status: r.status,
  receiptNumber: r.receipt_number,
  rrn: r.rrn,
  qr: r.qr,
  ackStatus: r.ack_status,
  submittedAt: date(r.submitted_at),
  request: r.request,
  lastError: r.last_error,
});

const toCredential = (r: Row): EimsCredentialRecord => ({
  id: r.id,
  status: r.status,
  label: r.label,
  privateKeyEnc: r.private_key_enc,
  certificateBase64: r.certificate_base64,
  certFingerprintSha256: r.cert_fingerprint_sha256,
  keyFingerprintSha256: r.key_fingerprint_sha256,
  certSubject: r.cert_subject,
  certIssuer: r.cert_issuer,
  certNotBefore: date(r.cert_not_before),
  certNotAfter: date(r.cert_not_after),
  keyBits: num(r.key_bits),
  activationSystemNumber: r.activation_system_number,
  lastActivationError: r.last_activation_error,
  expiryReminderStage: Number(r.expiry_reminder_stage ?? 0),
  createdAt: new Date(r.created_at),
  activatedAt: date(r.activated_at),
  retiredAt: date(r.retired_at),
  replacedById: r.replaced_by_id,
});

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

/**
 * The EimsHost on Postgres through TypeORM: every lock is SELECT ... FOR UPDATE inside the one
 * transaction the package asked for, so two API instances on one database serialize on the
 * system-state row exactly as two requests in one process do.
 */
@Injectable()
export class TypeOrmEimsHost implements EimsHost {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** A schema-qualified table name. */
  t(name: string): string {
    const schema = (this.db.options as { schema?: string }).schema;
    return schema ? `"${schema}"."${name}"` : `"${name}"`;
  }

  transaction<T>(work: (ledger: EimsLedger) => Promise<T>): Promise<T> {
    return this.db.transaction((manager) => work(this.ledger(manager)));
  }

  private ledger(m: EntityManager): EimsLedger {
    const t = (n: string) => this.t(n);
    return {
      lockSystemState: async (systemNumber) => {
        await m.query(`INSERT INTO ${t("eims_system_state")} ("system_number") VALUES ($1) ON CONFLICT DO NOTHING`, [systemNumber]);
        const [row] = await m.query(`SELECT * FROM ${t("eims_system_state")} WHERE "system_number" = $1 FOR UPDATE`, [systemNumber]);
        return toState(row);
      },
      saveSystemState: async (s) => {
        await m.query(
          `UPDATE ${t("eims_system_state")} SET "next_invoice_counter" = $2, "next_document_number" = $3, "previous_irn" = $4,
             "in_flight_document_id" = $5, "in_flight_counter" = $6, "in_flight_document_number" = $7,
             "in_flight_conversation_id" = $8, "blocked_reason" = $9
           WHERE "system_number" = $1`,
          [s.systemNumber, s.nextInvoiceCounter, s.nextDocumentNumber, s.previousIrn, s.inFlightDocumentId, s.inFlightCounter, s.inFlightDocumentNumber, s.inFlightConversationId, s.blockedReason],
        );
      },
      lockFiling: async (documentId) => {
        const rows = await m.query(`SELECT ${FILING_COLUMNS} FROM ${t("invoices")} WHERE "id" = $1 FOR UPDATE`, [documentId]);
        return rows[0] ? toFiling(rows[0]) : null;
      },
      saveFiling: async (f) => {
        await m.query(
          `UPDATE ${t("invoices")} SET "eims_status" = $2, "eims_irn" = $3, "eims_document_number" = $4, "eims_invoice_counter" = $5,
             "eims_ack_date" = $6, "eims_signed_qr" = $7, "eims_submitted_at" = $8, "eims_last_error" = $9, "eims_retry_count" = $10,
             "eims_bulk_conversation_id" = $11, "eims_cancelled_at" = $12, "eims_cancellation_date" = $13,
             "eims_cancellation_reason_code" = $14, "eims_cancellation_remark" = $15
           WHERE "id" = $1`,
          [
            f.documentId, f.status, f.irn, f.documentNumber, f.invoiceCounter, f.ackDate, f.signedQr, f.submittedAt, json(f.lastError),
            f.retryCount, f.bulkConversationId, f.cancelledAt, f.cancellationDate, f.cancellationReasonCode, f.cancellationRemark,
          ],
        );
      },
      lockFilingsByConversation: async (conversationId) => {
        const rows = await m.query(
          `SELECT ${FILING_COLUMNS} FROM ${t("invoices")} WHERE "eims_bulk_conversation_id" = $1 ORDER BY "eims_invoice_counter" FOR UPDATE`,
          [conversationId],
        );
        return rows.map(toFiling);
      },
      listReceipts: async (documentId) => {
        const rows = await m.query(`SELECT * FROM ${t("eims_receipts")} WHERE "invoice_id" = $1 ORDER BY "created_at", "id"`, [documentId]);
        return rows.map(toReceipt);
      },
      insertReceipt: async (r) => {
        // ON CONFLICT on the partial index, so a duplicate does not abort the transaction.
        const rows = await m.query(
          `INSERT INTO ${t("eims_receipts")} ("id", "invoice_id", "payment_key", "status", "receipt_number", "rrn", "qr", "ack_status", "submitted_at", "request", "last_error")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT ("invoice_id", "payment_key") WHERE "status" IN ('SUBMITTING', 'REGISTERED', 'UNKNOWN') DO NOTHING
           RETURNING "id"`,
          [r.id, r.documentId, r.paymentKey, r.status, r.receiptNumber, r.rrn, r.qr, r.ackStatus, r.submittedAt, json(r.request), json(r.lastError)],
        );
        return rows.length === 1;
      },
      saveReceipt: async (r) => {
        await m.query(
          `UPDATE ${t("eims_receipts")} SET "status" = $2, "rrn" = $3, "qr" = $4, "ack_status" = $5, "last_error" = $6 WHERE "id" = $1`,
          [r.id, r.status, r.rrn, r.qr, r.ackStatus, json(r.lastError)],
        );
      },
      lockCredentials: async () => {
        // An empty table has no rows to lock: serialize credential changes on an advisory lock too.
        await m.query(`SELECT pg_advisory_xact_lock(hashtext('eims_credentials:' || $1))`, [this.t("eims_credentials")]);
        const rows = await m.query(`SELECT * FROM ${t("eims_credentials")} ORDER BY "created_at" FOR UPDATE`);
        return rows.map(toCredential);
      },
      insertCredential: async (c) => {
        await m.query(
          `INSERT INTO ${t("eims_credentials")} ("id", "status", "label", "private_key_enc", "certificate_base64", "cert_fingerprint_sha256",
             "key_fingerprint_sha256", "cert_subject", "cert_issuer", "cert_not_before", "cert_not_after", "key_bits", "activation_system_number",
             "last_activation_error", "expiry_reminder_stage", "created_at", "activated_at", "retired_at", "replaced_by_id")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            c.id, c.status, c.label, c.privateKeyEnc, c.certificateBase64, c.certFingerprintSha256, c.keyFingerprintSha256, c.certSubject,
            c.certIssuer, c.certNotBefore, c.certNotAfter, c.keyBits, c.activationSystemNumber, c.lastActivationError, c.expiryReminderStage,
            c.createdAt, c.activatedAt, c.retiredAt, c.replacedById,
          ],
        );
      },
      saveCredential: async (c) => {
        await m.query(
          `UPDATE ${t("eims_credentials")} SET "status" = $2, "label" = $3, "private_key_enc" = $4, "activation_system_number" = $5,
             "last_activation_error" = $6, "expiry_reminder_stage" = $7, "activated_at" = $8, "retired_at" = $9, "replaced_by_id" = $10
           WHERE "id" = $1`,
          [c.id, c.status, c.label, c.privateKeyEnc, c.activationSystemNumber, c.lastActivationError, c.expiryReminderStage, c.activatedAt, c.retiredAt, c.replacedById],
        );
      },
    };
  }

  async loadDocument(documentId: string): Promise<EimsDocument | null> {
    const [row] = await this.db.query(
      `SELECT i.*, r."eims_irn" AS "related_irn" FROM ${this.t("invoices")} i
         LEFT JOIN ${this.t("invoices")} r ON r."id" = i."related_invoice_id"
        WHERE i."id" = $1`,
      [documentId],
    );
    if (!row) return null;
    const lines = await this.db.query(`SELECT * FROM ${this.t("invoice_lines")} WHERE "invoice_id" = $1 ORDER BY "line_no"`, [documentId]);
    return {
      id: row.id,
      number: row.invoice_number,
      type: row.document_type as EimsDocumentType,
      reason: row.reason,
      relatedIrn: row.related_irn,
      issuedAt: row.issued_at,
      currency: row.currency,
      exchangeRate: num(row.exchange_rate),
      totalAmount: row.total_amount,
      buyer: row.buyer as EimsBuyer,
      paymentMode: row.payment_mode,
      voided: row.voided,
      lines: lines.map((l: Row) => ({
        chargeType: l.charge_type,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        amount: l.amount,
        basis: l.basis,
      })),
    };
  }

  async markIssued(documentId: string, issuedAt: Date): Promise<void> {
    await this.db.query(`UPDATE ${this.t("invoices")} SET "issued_at" = $2 WHERE "id" = $1 AND "issued_at" IS NULL`, [documentId, issuedAt]);
  }

  async loadReceiptSource(documentId: string): Promise<EimsReceiptSource | null> {
    const [row] = await this.db.query(`SELECT * FROM ${this.t("invoices")} WHERE "id" = $1`, [documentId]);
    if (!row) return null;
    const payments = await this.db.query(`SELECT * FROM ${this.t("invoice_payments")} WHERE "invoice_id" = $1 ORDER BY "paid_at", "id"`, [documentId]);
    return {
      documentId,
      number: row.invoice_number,
      currency: row.currency,
      totalAmount: row.total_amount,
      payments: payments.map((p: Row) => ({
        key: p.payment_key,
        amount: p.amount,
        paidAt: p.paid_at,
        method: p.method,
        modeOfPayment: p.mode_of_payment,
        channel: p.channel,
        reference: p.reference,
      })),
    };
  }

  async nextUnfiledDocument(query: { maxAgeDays: number; now: Date }): Promise<string | null> {
    const [row] = await this.db.query(
      `SELECT i."id" FROM ${this.t("invoices")} i
        WHERE i."eims_status" = 'NOT_SUBMITTED' AND i."issued_at" IS NOT NULL AND NOT i."voided"
          AND i."issued_at" > $1::timestamptz - make_interval(days => $2)
          AND EXISTS (SELECT 1 FROM ${this.t("invoice_lines")} l WHERE l."invoice_id" = i."id")
        ORDER BY i."issued_at" LIMIT 1`,
      [query.now, query.maxAgeDays],
    );
    return row?.id ?? null;
  }

  async nextUnreceiptedPayment(): Promise<{ documentId: string; paymentKey: string } | null> {
    const [row] = await this.db.query(
      `SELECT p."invoice_id", p."payment_key" FROM ${this.t("invoice_payments")} p
         JOIN ${this.t("invoices")} i ON i."id" = p."invoice_id"
        WHERE i."eims_status" = 'REGISTERED'
          AND NOT EXISTS (SELECT 1 FROM ${this.t("eims_receipts")} r WHERE r."invoice_id" = p."invoice_id" AND r."payment_key" = p."payment_key")
        ORDER BY p."paid_at" LIMIT 1`,
    );
    return row ? { documentId: row.invoice_id, paymentKey: row.payment_key } : null;
  }

  async listCredentials(): Promise<EimsCredentialRecord[]> {
    const rows = await this.db.query(`SELECT * FROM ${this.t("eims_credentials")} ORDER BY "created_at"`);
    return rows.map(toCredential);
  }

  async anyRegisteredIrn(): Promise<string | null> {
    const [row] = await this.db.query(
      `SELECT "eims_irn" FROM ${this.t("invoices")} WHERE "eims_irn" IS NOT NULL AND "eims_status" = 'REGISTERED' ORDER BY "eims_submitted_at" DESC LIMIT 1`,
    );
    return row?.eims_irn ?? null;
  }

  async onEvent(event: EimsEvent): Promise<void> {
    const { type, priority, message, documentId, ...detail } = event;
    await this.db.query(`INSERT INTO ${this.t("eims_events")} ("type", "priority", "message", "document_id", "detail") VALUES ($1, $2, $3, $4, $5)`, [
      type,
      priority,
      message,
      documentId ?? null,
      JSON.stringify(detail),
    ]);
  }

  async recordExchange(r: EimsExchangeRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t("eims_exchanges")} ("direction", "operation", "path", "attempt", "document_ids", "receipt_id", "trigger", "system_number",
         "status_code", "is_success", "failure_kind", "error_message", "request_headers", "request_body", "response_body", "source_ip", "duration_ms", "at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        r.direction, r.operation, r.path.slice(0, 128), r.attempt, JSON.stringify(r.documentIds), r.receiptId, r.trigger, r.systemNumber,
        r.statusCode, r.isSuccess, r.failureKind, r.errorMessage, json(r.requestHeaders), json(r.requestBody), json(r.responseBody),
        r.sourceIp ?? null, r.durationMs, r.at,
      ],
    );
  }
}
