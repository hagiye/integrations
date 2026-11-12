/**
 * NOT COMPILED. How EDR's freight API (apps/edr-freight-api at 4e43da58b) would sit behind
 * EimsHost, keeping its own tables: the eims_* columns on freight.invoices, freight.eims_system_state,
 * freight.eims_receipts, freight.eims_credentials and audit's integration_exchanges. The rules
 * (reservation, give-back, block, verify-before-resolve) move into the package; this file only
 * reads and writes rows.
 *
 * Differences from EDR's own columns, and what to do about them:
 *  - eims_system_state.in_flight_invoice_id  <-> EimsSystemState.inFlightDocumentId (rename in the mapping only).
 *  - eims_credentials.certificate_bytes (bytea) <-> certificateBase64 (encode/decode here).
 *  - EimsFiling.retryCount has no EDR column: add invoices.eims_retry_count (default 0) or keep 0.
 *  - invoice_lines are read ORDER BY created_at in EDR; lines written in one transaction share it,
 *    so add a tiebreak (line id or a line_no) before memos depend on line positions (rule 7020).
 */
import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import {
  EimsBuyer,
  EimsCredentialRecord,
  EimsDocument,
  EimsEvent,
  EimsExchangeRecord,
  EimsFiling,
  EimsHost,
  EimsLedger,
  EimsReceiptSource,
  MorGeoCodes,
} from "@edr/mor-eims-integration";
import { Freight, NotificationAudience, NotificationPriority, NotificationType } from "@edr/types";
import { Invoice } from "../billing/entities/invoice.entity";
import { attachShippingLineBuyer } from "../eims/eims-buyer.util";
import { isPlaceholderTin } from "../../common/validators/is-tin.validator";
import { CompanyKind } from "../companies/entities/company.entity";
import { NotificationInboxService } from "../notification-inbox/notification-inbox.service";
import { IntegrationExchangeService } from "../audit/integration-exchange.service";
import { FREIGHT_PERMS } from "../../seed/freight-permissions.registry";

@Injectable()
export class EdrEimsHost implements EimsHost {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly inbox: NotificationInboxService,
    private readonly exchanges: IntegrationExchangeService,
  ) {}

  transaction<T>(work: (ledger: EimsLedger) => Promise<T>): Promise<T> {
    return this.db.transaction((m) => work(this.ledger(m)));
  }

  private ledger(m: EntityManager): EimsLedger {
    return {
      lockSystemState: async (systemNumber) => {
        await m.query(`INSERT INTO freight.eims_system_state (system_number) VALUES ($1) ON CONFLICT (system_number) DO NOTHING`, [systemNumber]);
        const [r] = await m.query(`SELECT * FROM freight.eims_system_state WHERE system_number = $1 AND deleted_at IS NULL FOR UPDATE`, [systemNumber]);
        return {
          systemNumber: r.system_number,
          nextInvoiceCounter: Number(r.next_invoice_counter),
          nextDocumentNumber: Number(r.next_document_number),
          previousIrn: r.previous_irn,
          inFlightDocumentId: r.in_flight_invoice_id,
          inFlightCounter: r.in_flight_counter === null ? null : Number(r.in_flight_counter),
          inFlightDocumentNumber: r.in_flight_document_number === null ? null : Number(r.in_flight_document_number),
          inFlightConversationId: r.in_flight_conversation_id,
          blockedReason: r.blocked_reason,
        };
      },
      saveSystemState: async (s) => {
        await m.query(
          `UPDATE freight.eims_system_state SET next_invoice_counter = $2, next_document_number = $3, previous_irn = $4,
             in_flight_invoice_id = $5, in_flight_counter = $6, in_flight_document_number = $7, in_flight_conversation_id = $8,
             blocked_reason = $9, updated_at = now() WHERE system_number = $1`,
          [s.systemNumber, s.nextInvoiceCounter, s.nextDocumentNumber, s.previousIrn, s.inFlightDocumentId, s.inFlightCounter, s.inFlightDocumentNumber, s.inFlightConversationId, s.blockedReason],
        );
      },
      lockFiling: async (invoiceId) => {
        const invoice = await m.createQueryBuilder(Invoice, "i").setLock("pessimistic_write").where("i.id = :invoiceId", { invoiceId }).getOne();
        return invoice ? toFiling(invoice) : null;
      },
      saveFiling: async (f) => {
        await m.update(Invoice, f.documentId, {
          eimsStatus: f.status as never,
          eimsIrn: f.irn,
          eimsDocumentNumber: f.documentNumber,
          eimsInvoiceCounter: f.invoiceCounter,
          eimsAckDate: f.ackDate,
          eimsSignedQr: f.signedQr,
          eimsSubmittedAt: f.submittedAt,
          eimsLastError: f.lastError as never,
          eimsBulkConversationId: f.bulkConversationId,
          eimsCancelledAt: f.cancelledAt,
          eimsCancellationDate: f.cancellationDate,
          eimsCancellationReasonCode: f.cancellationReasonCode,
          eimsCancellationRemark: f.cancellationRemark,
        });
      },
      lockFilingsByConversation: async (conversationId) => {
        const rows = await m
          .createQueryBuilder(Invoice, "i")
          .setLock("pessimistic_write")
          .where("i.eims_bulk_conversation_id = :conversationId", { conversationId })
          .orderBy("i.eims_invoice_counter", "ASC")
          .getMany();
        return rows.map(toFiling);
      },
      listReceipts: async (invoiceId) => {
        const rows = await m.query(`SELECT * FROM freight.eims_receipts WHERE invoice_id = $1 AND kind = 'SALES' AND deleted_at IS NULL ORDER BY created_at, id`, [invoiceId]);
        return rows.map((r: any) => ({
          id: r.id,
          documentId: r.invoice_id,
          paymentKey: r.payment_key,
          status: r.status,
          receiptNumber: r.receipt_number,
          rrn: r.rrn,
          qr: r.qr,
          ackStatus: r.ack_status,
          submittedAt: r.submitted_at,
          request: r.request,
          lastError: r.last_error,
        }));
      },
      insertReceipt: async (r) => {
        // UQ_eims_receipts_live_sales_per_payment (migration 4190) is the partial index this targets.
        const rows = await m.query(
          `INSERT INTO freight.eims_receipts (id, invoice_id, kind, payment_key, status, receipt_number, rrn, qr, ack_status, submitted_at, request, last_error)
           VALUES ($1, $2, 'SALES', $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT DO NOTHING RETURNING id`,
          [r.id, r.documentId, r.paymentKey, r.status, r.receiptNumber, r.rrn, r.qr, r.ackStatus, r.submittedAt, JSON.stringify(r.request), JSON.stringify(r.lastError)],
        );
        return rows.length === 1;
      },
      saveReceipt: async (r) => {
        await m.query(`UPDATE freight.eims_receipts SET status = $2, rrn = $3, qr = $4, ack_status = $5, last_error = $6, updated_at = now() WHERE id = $1`, [
          r.id, r.status, r.rrn, r.qr, r.ackStatus, JSON.stringify(r.lastError),
        ]);
      },
      lockCredentials: async () => {
        await m.query(`SELECT pg_advisory_xact_lock(hashtext('freight.eims_credentials'))`);
        const rows = await m.query(`SELECT * FROM freight.eims_credentials WHERE deleted_at IS NULL ORDER BY created_at FOR UPDATE`);
        return rows.map(toCredential);
      },
      insertCredential: async (c) => {
        await m.query(
          `INSERT INTO freight.eims_credentials (id, status, label, private_key_enc, certificate_bytes, cert_fingerprint_sha256, key_fingerprint_sha256,
             cert_subject, cert_issuer, cert_not_before, cert_not_after, key_bits, activation_system_number, activated_at)
           VALUES ($1, $2, $3, $4, decode($5, 'base64'), $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [c.id, c.status, c.label, c.privateKeyEnc, c.certificateBase64, c.certFingerprintSha256, c.keyFingerprintSha256, c.certSubject, c.certIssuer, c.certNotBefore, c.certNotAfter, c.keyBits, c.activationSystemNumber, c.activatedAt],
        );
      },
      saveCredential: async (c) => {
        await m.query(
          `UPDATE freight.eims_credentials SET status = $2, private_key_enc = $3, activation_system_number = $4, last_activation_error = $5,
             expiry_reminder_stage = $6, activated_at = $7, retired_at = $8, replaced_by_id = $9, updated_at = now() WHERE id = $1`,
          [c.id, c.status, c.privateKeyEnc, c.activationSystemNumber, c.lastActivationError, c.expiryReminderStage, c.activatedAt, c.retiredAt, c.replacedById],
        );
      },
    };
  }

  /**
   * EDR's invoice as an EimsDocument. The buyer is the customer company or the shipping line;
   * an individual (kind individual) files B2C under companies.fan_number; a shipping-line credit
   * invoice files B2G with PaymentDetails.Mode CREDIT, as resolveEimsTransactionType does today.
   */
  async loadDocument(invoiceId: string): Promise<EimsDocument | null> {
    const invoice = await this.db.getRepository(Invoice).findOne({ where: { id: invoiceId }, relations: { company: true, relatedInvoice: true } });
    if (!invoice) return null;
    await attachShippingLineBuyer(this.db, invoice);
    const lines = await this.db.query(
      `SELECT charge_type, description, quantity, unit_rate, amount, metadata FROM freight.invoice_lines
        WHERE invoice_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
      [invoiceId],
    );
    const payer = invoice.company ?? invoice.shippingLineCompany;
    const isCredit = invoice.source === Freight.InvoiceSource.ShippingLineCredit;
    const kind: EimsBuyer["kind"] = invoice.company?.kind === CompanyKind.Individual ? "individual" : isCredit ? "government" : "company";
    return {
      id: invoice.id,
      number: invoice.invoiceNumber,
      type: (invoice.eimsDocumentType as "INV" | "CRE" | "DEB") ?? "INV",
      reason: invoice.eimsReason,
      relatedIrn: invoice.relatedInvoice?.eimsIrn ?? null,
      issuedAt: invoice.issuedAt,
      currency: invoice.currency,
      exchangeRate: null, // EDR has no exchange-rate column on invoices; a non-ETB invoice is refused locally
      totalAmount: invoice.totalAmount,
      voided: String(invoice.status) === "CANCELLED",
      paymentMode: isCredit ? "CREDIT" : null,
      buyer: {
        kind,
        legalName: payer?.name ?? "",
        // A minted placeholder must never reach MoR; the package's 10-digit pattern refuses it too.
        tin: payer?.tin && !isPlaceholderTin(payer.tin) ? payer.tin : null,
        idNumber: kind === "individual" ? (invoice.company?.fanNumber ?? null) : null,
        vatNumber: payer?.vatNumber ?? null,
        phone: payer?.phone ?? null,
        email: payer?.email ?? null,
        country: payer?.country ?? null,
        region: payer?.region ?? null,
        zone: payer?.zone ?? null,
        woreda: payer?.woreda ?? null,
        kebele: payer?.kebele ?? null,
        houseNumber: payer?.houseNo ?? null,
      },
      // EDR sends 0 withholding (the user's decision: no withholding ever).
      withholding: { income: 0, transaction: 0 },
      lines: lines.map((l: any) => ({
        chargeType: l.charge_type,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_rate,
        amount: l.amount,
        basis: typeof l.metadata?.unit === "string" ? l.metadata.unit : null,
      })),
    };
  }

  async markIssued(invoiceId: string, issuedAt: Date): Promise<void> {
    await this.db.query(`UPDATE freight.invoices SET issued_at = $2 WHERE id = $1 AND issued_at IS NULL`, [invoiceId, issuedAt]);
  }

  /** invoices.payments is EDR's jsonb ledger; keys are the entry id or #index (eims-receipt-defaults.util). */
  async loadReceiptSource(invoiceId: string): Promise<EimsReceiptSource | null> {
    const invoice = await this.db.getRepository(Invoice).findOne({ where: { id: invoiceId } });
    if (!invoice) return null;
    return {
      documentId: invoice.id,
      number: invoice.invoiceNumber,
      currency: invoice.currency,
      totalAmount: invoice.totalAmount,
      payments: (invoice.payments ?? []).map((p) => ({
        key: p.id ?? null,
        amount: p.amount,
        paidAt: p.paidAt ?? null,
        method: p.method ?? null,
        modeOfPayment: typeof p.metadata?.modeOfPayment === "string" ? p.metadata.modeOfPayment : null,
        channel: typeof p.metadata?.channel === "string" ? p.metadata.channel : null,
        reference: p.reference ?? null,
      })),
    };
  }

  /** EimsAutoSubmitService.nextCandidate, minus the TIN clauses: the package refuses those (and drains them). */
  async nextUnfiledDocument(query: { maxAgeDays: number; now: Date }): Promise<string | null> {
    const [row] = await this.db.query(
      `SELECT i.id FROM freight.invoices i
        WHERE i.eims_status = 'NOT_SUBMITTED' AND i.issued_at IS NOT NULL AND i.deleted_at IS NULL
          AND i.status::text <> 'CANCELLED' AND i.issued_at > $1::timestamptz - make_interval(days => $2)
          AND EXISTS (SELECT 1 FROM freight.invoice_lines l WHERE l.invoice_id = i.id AND l.deleted_at IS NULL)
        ORDER BY i.issued_at ASC LIMIT 1`,
      [query.now, query.maxAgeDays],
    );
    return row?.id ?? null;
  }

  async listCredentials(): Promise<EimsCredentialRecord[]> {
    const rows = await this.db.query(`SELECT * FROM freight.eims_credentials WHERE deleted_at IS NULL ORDER BY created_at`);
    return rows.map(toCredential);
  }

  async anyRegisteredIrn(): Promise<string | null> {
    const [row] = await this.db.query(`SELECT eims_irn FROM freight.invoices WHERE eims_irn IS NOT NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`);
    return row?.eims_irn ?? null;
  }

  /** EDR's staff alerts (permission invoices.eimsResolve) and buyer notifications go here. */
  async onEvent(event: EimsEvent): Promise<void> {
    if (["UNKNOWN", "PERSIST_FAILED", "REJECTED", "RETRY_LATER", "BULK_CALLBACK_UNTRUSTED"].includes(event.type)) {
      await this.inbox.notify({
        recipients: { permissionKeys: [FREIGHT_PERMS.invoices.eimsResolve] },
        audience: NotificationAudience.BACKOFFICE,
        type: NotificationType.GENERIC,
        priority: event.priority === "HIGH" ? NotificationPriority.HIGH : NotificationPriority.NORMAL,
        title: event.type === "UNKNOWN" ? "EIMS filing unresolved: all further filing is blocked" : `EIMS ${event.type.toLowerCase().replace("_", " ")}`,
        body: event.message,
        link: event.documentId ? `/dashboard/invoices/${event.documentId}` : undefined,
        data: { invoiceId: event.documentId, irn: event.irn, action: `EIMS_${event.type}` },
      });
    }
    // REGISTERED / RECEIPT_REGISTERED / CANCELLED: sendCompanyChannels or sendShippingLineChannels to the buyer (MoR checklist ADD-N001).
  }

  async recordExchange(r: EimsExchangeRecord): Promise<void> {
    await this.exchanges.record({
      integration: "MOR_EIMS",
      direction: r.direction,
      operation: r.operation,
      method: "POST",
      url: r.path,
      attempt: r.attempt,
      isSuccess: r.isSuccess,
      statusCode: r.statusCode,
      failureKind: r.failureKind,
      errorMessage: r.errorMessage,
      invoiceIds: r.documentIds,
      receiptId: r.receiptId,
      reference: "",
      correlationId: null,
      systemNumber: r.systemNumber,
      trigger: r.trigger,
      requestId: null,
      sourceIp: r.sourceIp ?? null,
      requestHeaders: r.requestHeaders,
      requestBody: r.requestBody,
      responseHeaders: null,
      responseBody: r.responseBody,
      durationMs: r.durationMs,
    });
  }
}

function toFiling(i: Invoice): EimsFiling {
  return {
    documentId: i.id,
    status: i.eimsStatus as EimsFiling["status"],
    irn: i.eimsIrn ?? null,
    documentNumber: i.eimsDocumentNumber ?? null,
    invoiceCounter: i.eimsInvoiceCounter ?? null,
    ackDate: i.eimsAckDate ?? null,
    signedQr: i.eimsSignedQr ?? null,
    submittedAt: i.eimsSubmittedAt ?? null,
    lastError: (i.eimsLastError as never) ?? null,
    retryCount: 0,
    bulkConversationId: i.eimsBulkConversationId ?? null,
    cancelledAt: i.eimsCancelledAt ?? null,
    cancellationDate: i.eimsCancellationDate ?? null,
    cancellationReasonCode: i.eimsCancellationReasonCode ?? null,
    cancellationRemark: i.eimsCancellationRemark ?? null,
  };
}

function toCredential(r: any): EimsCredentialRecord {
  return {
    id: r.id,
    status: r.status,
    label: r.label,
    privateKeyEnc: r.private_key_enc,
    certificateBase64: Buffer.from(r.certificate_bytes).toString("base64"),
    certFingerprintSha256: r.cert_fingerprint_sha256,
    keyFingerprintSha256: r.key_fingerprint_sha256,
    certSubject: r.cert_subject,
    certIssuer: r.cert_issuer,
    certNotBefore: r.cert_not_before,
    certNotAfter: r.cert_not_after,
    keyBits: r.key_bits,
    activationSystemNumber: r.activation_system_number,
    lastActivationError: r.last_activation_error,
    expiryReminderStage: r.expiry_reminder_stage,
    createdAt: r.created_at,
    activatedAt: r.activated_at,
    retiredAt: r.retired_at,
    replacedById: r.replaced_by_id,
  };
}

/**
 * Wiring, replacing EimsModule + EimsSettingsModule's filing parts in EDR:
 *
 *   EimsModule.forRootAsync({
 *     imports: [EimsSettingsModule, NotificationInboxModule, AuditModule],
 *     inject: [EimsSettingsService],
 *     useFactory: (settings: EimsSettingsService) => {
 *       const cfg = settings.snapshot();   // EDR's DB-backed settings with env fallback
 *       return {
 *         baseUrl: cfg.baseUrl, clientId: cfg.clientId, clientSecret: cfg.clientSecret, apiKey: cfg.apiKey, tin: cfg.tin,
 *         encryptionKey: process.env.EIMS_SETTINGS_ENCRYPTION_KEY,      // same key, same v1.<iv>.<tag>.<ct> format
 *         expectedSystemNumber: cfg.systemNumber || undefined,
 *         seller: { legalName: cfg.invoice.sellerLegalName, vatNumber: cfg.invoice.sellerVatNumber, ... },
 *         tax: { code: cfg.invoice.taxCode, ratePercent: cfg.invoice.taxRatePercent!, byChargeType: ... },
 *         cashierName: cfg.invoice.cashierName ?? undefined,
 *         httpTimeoutMs: cfg.httpTimeoutMs,
 *       };
 *     },
 *     host: EdrEimsHost,
 *     route: "eims/webhook/bulk-register",   // EDR's existing path; give MoR route/<token> to use the token
 *   })
 *
 * The @Cron jobs stay in EDR and call autoSubmitNext(), autoFileNext() and checkCertificateExpiry().
 * EDR's mor-locations.data.ts is the same file as the package's.
 */
export type { MorGeoCodes };
