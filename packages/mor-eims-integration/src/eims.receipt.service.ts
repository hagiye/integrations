import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { EimsClient } from "./eims.client";
import { EimsError, definitelyNotStored, toStoredError } from "./eims.errors";
import { EimsEvent, EimsHost } from "./eims.host";
import { ResolvedEimsOptions } from "./eims.options";
import {
  MAX_MANUAL_RECEIPT_NUMBER,
  deriveModeOfPayment,
  keyedPayments,
  receiptFiguresFor,
  receiptNumberFor,
} from "./eims.receipt-figures";
import {
  EIMS_MODES_OF_PAYMENT,
  EIMS_RECEIPT_CURRENCIES,
  EimsModeOfPayment,
  EimsReceiptRecord,
  EimsReceiptSource,
  EimsSalesReceiptRequest,
  EimsStoredError,
} from "./eims.types";

/** What a caller may add to a receipt. Every amount comes from the payment ledger, never from here. */
export interface EimsReceiptInput {
  /** The payment to vouch for. Omitted: the oldest payment without a live receipt. */
  paymentKey?: string;
  /** Required when the payment's method names no MoR mode (mobile money, a bare GATEWAY...). */
  modeOfPayment?: EimsModeOfPayment;
  /** Required by MoR; defaults to options.cashierName. */
  collectorName?: string;
  reason?: string;
  /** Only a confirmation: refused when it differs from the ledger's figure for that payment. */
  collectedAmount?: number;
  exchangeRate?: number | null;
  chequeNumber?: string | null;
  cpoNumber?: string | null;
  documentNumber?: string | null;
  paymentServiceProvider?: string | null;
  otherPaymentServiceProviderName?: string | null;
  accountNumber?: string | null;
  transactionNumber?: string | null;
}

export type EimsReceiptOutcome =
  | "REGISTERED"
  /** Another live attempt already holds this payment's slot. Nothing was sent. */
  | "ALREADY_FILED"
  | "REJECTED"
  /** Sent, no clear answer. The payment's slot stays taken until resolveReceipt(). */
  | "UNKNOWN"
  /** MoR accepted it (RRN known) but saving failed. The slot stays taken; the RRN is in the event. */
  | "PERSIST_FAILED";

export interface EimsReceiptResult {
  outcome: EimsReceiptOutcome;
  receipt: EimsReceiptRecord | null;
  rrn?: string;
  error?: EimsStoredError;
}

const invalid = (code: string, message: string) => new EimsError("INVALID", message, { code, sent: false });

/**
 * POST /v1/receipt/sales: the Cash Receipt Voucher MoR registers against an invoice's IRN, one
 * per payment. Receipts carry no sequence MoR enforces, so there is no system-wide reservation,
 * but every attempt is a row created BEFORE the call (a crash leaves UNKNOWN, not nothing), one
 * live attempt per (invoice, payment) under a lock and your unique index, and an ambiguous
 * attempt is never retried automatically: MoR has no proven guard against duplicate receipts.
 */
export class EimsReceiptService {
  private readonly logger = new Logger("EimsReceiptService");
  private sweeping = false;

  constructor(
    private readonly options: ResolvedEimsOptions,
    private readonly client: EimsClient,
    private readonly host: EimsHost,
  ) {}

  private async loadSource(documentId: string): Promise<EimsReceiptSource> {
    if (!this.host.loadReceiptSource) throw new EimsError("CONFIG", "host.loadReceiptSource is needed for receipts", { sent: false });
    const source = await this.host.loadReceiptSource(documentId);
    if (!source) throw invalid("NOT_FOUND", `Document ${documentId} not found`);
    return source;
  }

  async list(documentId: string): Promise<EimsReceiptRecord[]> {
    return this.host.transaction(async (ledger) => {
      await ledger.lockFiling(documentId);
      return ledger.listReceipts(documentId);
    });
  }

  /**
   * File the receipt for one payment on a registered invoice. Throws INVALID (nothing sent) for
   * an unregistered or cancelled invoice, an unknown payment, a mode or collector that cannot be
   * determined, a currency MoR does not take.
   */
  async fileSalesReceipt(documentId: string, input: EimsReceiptInput = {}, opts: { trigger?: string } = {}): Promise<EimsReceiptResult> {
    const source = await this.loadSource(documentId);
    const filing = await this.host.transaction((ledger) => ledger.lockFiling(documentId));
    if (!filing) throw invalid("NOT_FOUND", `Document ${documentId} not found`);
    if (filing.status === "CANCELLED") throw invalid("CANCELLED", `Invoice ${source.number} was cancelled at MoR; no receipt can be filed against it`);
    if (filing.status !== "REGISTERED" || !filing.irn) {
      throw invalid("NOT_REGISTERED", `Invoice ${source.number} is not registered with MoR (status ${filing.status}); there is no IRN to receipt against`);
    }
    const irn = filing.irn;

    const key = input.paymentKey ?? (await this.oldestUnreceiptedPayment(source));
    if (!key) throw invalid("ALL_PAYMENTS_RECEIPTED", `Every payment on invoice ${source.number} already has a receipt`);
    const figures = receiptFiguresFor(source, key);

    const currency = source.currency;
    if (!(EIMS_RECEIPT_CURRENCIES as readonly string[]).includes(currency)) {
      throw invalid("RECEIPT_CURRENCY", `MoR takes receipts in ${EIMS_RECEIPT_CURRENCIES.join(", ")} only, not ${currency}`);
    }
    if (currency !== "ETB" && !(Number(input.exchangeRate) > 0)) {
      throw invalid("EXCHANGE_RATE_REQUIRED", `A ${currency} receipt needs an exchange rate`);
    }
    const mode = input.modeOfPayment ?? deriveModeOfPayment(figures.payment);
    if (!mode || !(EIMS_MODES_OF_PAYMENT as readonly string[]).includes(mode)) {
      throw invalid(
        "MODE_OF_PAYMENT_REQUIRED",
        `Payment ${figures.key} (method ${figures.payment.method ?? "none"}) names no MoR mode of payment; give one of ${EIMS_MODES_OF_PAYMENT.join(", ")}`,
      );
    }
    if (input.collectedAmount !== undefined && Math.abs(Number(input.collectedAmount) - figures.collected) > 0.01) {
      throw invalid("RECEIPT_AMOUNT_MISMATCH", `Payment ${figures.key} on ${source.number} is ${figures.collected}, not ${input.collectedAmount}`);
    }
    const collectorName = (input.collectorName ?? this.options.cashierName ?? "").trim();
    if (!collectorName) {
      throw invalid("COLLECTOR_NAME_REQUIRED", "MoR requires the name of whoever collected the payment: give collectorName or set options.cashierName");
    }
    const isGateway = (figures.payment.method ?? "").toUpperCase() === "GATEWAY";
    const manual = (!isGateway && figures.payment.reference?.trim()) || null;
    // Finance's own voucher number, and only when it fits: a half-quoted number matches nothing in their books.
    const manualReceiptNumber = manual && manual.length <= MAX_MANUAL_RECEIPT_NUMBER ? manual : null;
    const paidAt = figures.payment.paidAt ? new Date(figures.payment.paidAt) : new Date();

    const context = { documentIds: [documentId], trigger: opts.trigger ?? null };
    const session = await this.client.session(context);

    const build = (receiptNumber: string): EimsSalesReceiptRequest => ({
      ReceiptNumber: receiptNumber,
      ReceiptType: "Sales Receipts",
      Reason: input.reason?.trim() || "Payment received",
      ReceiptDate: Number.isNaN(paidAt.getTime()) ? new Date().toISOString() : paidAt.toISOString(),
      ReceiptCounter: String(Date.now()),
      ManualReceiptNumber: manualReceiptNumber,
      SourceSystemType: session.systemType,
      SourceSystemNumber: session.systemNumber,
      ReceiptCurrency: currency,
      ExchangeRate: currency === "ETB" ? null : Number(input.exchangeRate),
      CollectedAmount: figures.collected,
      SellerTIN: this.options.tin,
      Invoices: [
        {
          InvoiceIRN: irn,
          PaymentCoverage: figures.coverage,
          InvoicePaidAmount: figures.collected,
          DiscountAmount: null,
          RemainingAmount: figures.remaining,
          TotalAmount: figures.expected,
        },
      ],
      TransactionDetails: {
        ModeOfPayment: mode as EimsModeOfPayment,
        ChequeNumber: input.chequeNumber ?? null,
        CPONumber: input.cpoNumber ?? null,
        DocumentNumber: input.documentNumber ?? null,
        CollectorName: collectorName,
        PaymentServiceProvider: input.paymentServiceProvider ?? null,
        OtherPaymentServiceProviderName: input.otherPaymentServiceProviderName ?? null,
        AccountNumber: input.accountNumber ?? null,
        TransactionNumber: input.transactionNumber ?? (isGateway ? (figures.payment.reference ?? null) : null),
      },
    });

    // Claim the slot: under the filing lock, one live attempt per payment, the receipt number
    // allocated inside the same lock (EDR counted attempts outside it, so two payments filed at
    // once could share a ReceiptNumber).
    const claimed = await this.host.transaction(async (ledger) => {
      const locked = await ledger.lockFiling(documentId);
      if (!locked || locked.status !== "REGISTERED") return null;
      const existing = await ledger.listReceipts(documentId);
      if (existing.some((r) => r.paymentKey === figures.key && r.status !== "FAILED")) return null;
      const receiptNumber = receiptNumberFor(source.number, existing.length + 1);
      const draft: EimsReceiptRecord = {
        id: randomUUID(),
        documentId,
        paymentKey: figures.key,
        status: "SUBMITTING",
        receiptNumber,
        rrn: null,
        qr: null,
        ackStatus: null,
        submittedAt: new Date(),
        request: build(receiptNumber),
        lastError: null,
      };
      return (await ledger.insertReceipt(draft)) ? draft : null;
    });
    if (!claimed) return { outcome: "ALREADY_FILED", receipt: null };

    let answer: { rrn: string; qr: string | null; status: string | null };
    try {
      answer = await this.client.salesReceipt(claimed.request!, { ...context, receiptId: claimed.id });
    } catch (err) {
      const stored = toStoredError(err);
      const notStored = definitelyNotStored(err);
      const settled: EimsReceiptRecord = { ...claimed, status: notStored ? "FAILED" : "UNKNOWN", lastError: stored };
      try {
        await this.host.transaction(async (ledger) => {
          await ledger.lockFiling(documentId);
          await ledger.saveReceipt(settled);
        });
      } catch (saveErr) {
        this.logger.error(`Could not record the receipt failure for ${source.number}: ${(saveErr as Error).message}`);
      }
      await this.emit({
        type: notStored ? "RECEIPT_FAILED" : "RECEIPT_UNKNOWN",
        priority: notStored ? "NORMAL" : "HIGH",
        documentId,
        documentNumber: source.number,
        receiptId: claimed.id,
        error: stored,
        message: notStored
          ? `MoR refused receipt ${claimed.receiptNumber} for ${source.number}: ${stored.message}`
          : `Receipt ${claimed.receiptNumber} for ${source.number} was sent and never acknowledged; check the MoR portal, then resolve it`,
      });
      return { outcome: notStored ? "REJECTED" : "UNKNOWN", receipt: settled, error: stored };
    }

    const registered: EimsReceiptRecord = { ...claimed, status: "REGISTERED", rrn: answer.rrn, qr: answer.qr, ackStatus: answer.status?.slice(0, 8) ?? null };
    try {
      await this.host.transaction(async (ledger) => {
        await ledger.lockFiling(documentId);
        await ledger.saveReceipt(registered);
      });
    } catch (err) {
      // The row stays SUBMITTING (live), so nothing files this payment again; the RRN must not be lost.
      const message = `MoR ACCEPTED receipt ${claimed.receiptNumber} for ${source.number} (RRN ${answer.rrn}) but saving it failed: ${(err as Error).message}. Record the RRN with resolveReceipt.`;
      this.logger.error(message);
      const error: EimsStoredError = { kind: "PERSIST", message, at: new Date().toISOString() };
      await this.emit({ type: "PERSIST_FAILED", priority: "HIGH", documentId, receiptId: claimed.id, rrn: answer.rrn, error, message });
      return { outcome: "PERSIST_FAILED", receipt: claimed, rrn: answer.rrn, error };
    }
    this.logger.log(`Receipt ${claimed.receiptNumber} registered for ${source.number} (RRN ${answer.rrn})`);
    await this.emit({
      type: "RECEIPT_REGISTERED",
      priority: "NORMAL",
      documentId,
      documentNumber: source.number,
      receiptId: claimed.id,
      rrn: answer.rrn,
      message: `Cash receipt voucher ${claimed.receiptNumber} was registered with MoR EIMS for ${source.number}`,
    });
    return { outcome: "REGISTERED", receipt: registered, rrn: answer.rrn };
  }

  /** The oldest payment with no live (SUBMITTING / REGISTERED / UNKNOWN) receipt: the order MoR's RemainingAmount runs down in. */
  private async oldestUnreceiptedPayment(source: EimsReceiptSource): Promise<string | null> {
    const live = (await this.list(source.documentId)).filter((r) => r.status !== "FAILED");
    const taken = new Set(live.map((r) => r.paymentKey));
    return keyedPayments(source).find((p) => !taken.has(p.key))?.key ?? null;
  }

  /**
   * Settle an UNKNOWN (or PERSIST_FAILED) receipt after checking the MoR portal: record the RRN
   * found there, or discard the attempt (MoR has no record) so the payment can be filed again.
   * MoR has no receipt lookup, so this rests on the operator's check.
   */
  async resolveReceipt(documentId: string, receiptId: string, input: { rrn?: string; discard?: boolean }): Promise<EimsReceiptRecord> {
    const rrn = input.rrn?.trim();
    if (!rrn && !input.discard) throw invalid("RESOLVE_INPUT", "Give the RRN found in the MoR portal, or discard: true");
    return this.host.transaction(async (ledger) => {
      await ledger.lockFiling(documentId);
      const receipt = (await ledger.listReceipts(documentId)).find((r) => r.id === receiptId);
      if (!receipt) throw invalid("NOT_FOUND", `Receipt ${receiptId} not found on ${documentId}`);
      if (receipt.status !== "UNKNOWN" && receipt.status !== "SUBMITTING") {
        throw invalid("NOT_UNRESOLVED", `Receipt ${receipt.receiptNumber} is ${receipt.status}; only an unanswered attempt is resolved`);
      }
      const next: EimsReceiptRecord = rrn
        ? { ...receipt, status: "REGISTERED", rrn, lastError: null }
        : { ...receipt, status: "FAILED", lastError: { kind: "DISCARDED", message: "Discarded by an operator: MoR has no record of it", at: new Date().toISOString() } };
      await ledger.saveReceipt(next);
      return next;
    });
  }

  /**
   * One receipt per call, for a timer of your own. host.nextUnreceiptedPayment picks the payment
   * (EDR: only chosen invoice sources, and only payments with no attempt at all, so a FAILED
   * attempt waits for finance). A payment that cannot be receipted unattended (no mode, no
   * collector) gets a FAILED row saying why, so the sweep moves on. Never throws.
   */
  async autoFileNext(): Promise<{ outcome: "IDLE" } | { outcome: "FILED"; result: EimsReceiptResult } | { outcome: "PARKED" | "ERROR"; documentId?: string; error: EimsStoredError }> {
    if (!this.host.nextUnreceiptedPayment) return { outcome: "ERROR", error: toStoredError(new EimsError("CONFIG", "host.nextUnreceiptedPayment is not implemented", { sent: false })) };
    if (this.sweeping) return { outcome: "IDLE" };
    this.sweeping = true;
    let next: { documentId: string; paymentKey?: string } | null = null;
    try {
      next = await this.host.nextUnreceiptedPayment();
      if (!next) return { outcome: "IDLE" };
      return { outcome: "FILED", result: await this.fileSalesReceipt(next.documentId, { paymentKey: next.paymentKey }, { trigger: "AUTO_RECEIPT" }) };
    } catch (err) {
      const error = toStoredError(err);
      if (next && err instanceof EimsError && err.kind === "INVALID") {
        await this.park(next.documentId, next.paymentKey, error);
        return { outcome: "PARKED", documentId: next.documentId, error };
      }
      this.logger.error(`EIMS auto-receipt run failed: ${error.message}`);
      return { outcome: "ERROR", documentId: next?.documentId, error };
    } finally {
      this.sweeping = false;
    }
  }

  private async park(documentId: string, paymentKey: string | undefined, error: EimsStoredError): Promise<void> {
    try {
      const source = await this.loadSource(documentId);
      const key = paymentKey ?? (await this.oldestUnreceiptedPayment(source));
      if (!key) return;
      await this.host.transaction(async (ledger) => {
        await ledger.lockFiling(documentId);
        const existing = await ledger.listReceipts(documentId);
        if (existing.some((r) => r.paymentKey === key)) return;
        await ledger.insertReceipt({
          id: randomUUID(),
          documentId,
          paymentKey: key,
          status: "FAILED",
          receiptNumber: receiptNumberFor(source.number, existing.length + 1),
          rrn: null,
          qr: null,
          ackStatus: null,
          submittedAt: null,
          request: null,
          lastError: error,
        });
      });
      await this.emit({ type: "RECEIPT_FAILED", priority: "NORMAL", documentId, error, message: `No receipt could be filed for ${source.number} unattended: ${error.message}` });
    } catch (err) {
      this.logger.warn(`Could not park the receipt for ${documentId}: ${(err as Error).message}`);
    }
  }

  private async emit(event: EimsEvent): Promise<void> {
    try {
      await this.host.onEvent?.(event);
    } catch (err) {
      this.logger.warn(`EIMS event ${event.type} could not be delivered: ${(err as Error).message}`);
    }
  }
}
