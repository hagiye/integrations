import { EimsError } from "./eims.errors";
import { EIMS_MODES_OF_PAYMENT, EimsModeOfPayment, EimsPayment, EimsReceiptSource } from "./eims.types";

/** The key a receipt names its payment by: the entry's own key, or its position (#0, #1...). */
export function paymentKey(payment: EimsPayment, index: number): string {
  return payment.key?.trim() || `#${index}`;
}

export function keyedPayments(source: EimsReceiptSource): Array<{ key: string; payment: EimsPayment }> {
  return (source.payments ?? []).map((payment, index) => ({ key: paymentKey(payment, index), payment }));
}

export interface ReceiptFigures {
  key: string;
  payment: EimsPayment;
  /** The invoice total. */
  expected: number;
  /** This payment alone (CollectedAmount and InvoicePaidAmount). */
  collected: number;
  /** Everything paid up to and including this payment. */
  paidToDate: number;
  /** Still owed once this payment landed (RemainingAmount). Never below zero. */
  remaining: number;
  coverage: "FULL" | "PARTIAL";
}

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The figures one sales receipt carries, AS OF the payment it vouches for, never today's state: a
 * receipt for the first of three payments filed after all three landed would otherwise tell MoR
 * the first payment settled the invoice. One receipt per payment.
 */
export function receiptFiguresFor(source: EimsReceiptSource, key?: string): ReceiptFigures {
  const ledger = keyedPayments(source);
  if (ledger.length === 0) {
    throw new EimsError("INVALID", `Invoice ${source.number} has no recorded payment to vouch for`, { code: "NO_PAYMENT", sent: false });
  }
  const at = key === undefined ? ledger.length - 1 : ledger.findIndex((p) => p.key === key);
  if (at < 0) throw new EimsError("INVALID", `Invoice ${source.number} has no payment ${key}`, { code: "UNKNOWN_PAYMENT", sent: false });
  const expected = cents(Number(source.totalAmount));
  const collected = cents(Number(ledger[at].payment.amount));
  if (!(collected > 0)) throw new EimsError("INVALID", `Payment ${ledger[at].key} has no amount`, { code: "NO_PAYMENT", sent: false });
  const paidToDate = cents(ledger.slice(0, at + 1).reduce((sum, p) => sum + Number(p.payment.amount), 0));
  const remaining = Math.max(0, cents(expected - paidToDate));
  return { key: ledger[at].key, payment: ledger[at].payment, expected, collected, paidToDate, remaining, coverage: remaining <= 0 ? "FULL" : "PARTIAL" };
}

const METHOD_TO_MODE: Record<string, EimsModeOfPayment> = { BANK_TRANSFER: "BANK", WIRE_TRANSFER: "WIRE", LETTER_OF_CREDIT: "LC" };
/** Channels that name a MoR mode without guessing. Mobile money has no MoR slot and is absent on purpose. */
const CHANNEL_TO_MODE: Record<string, EimsModeOfPayment> = { CBE_BILL: "BANK", CAC_BANK: "BANK", CARD: "CARD" };
const normalize = (value: string): string => value.trim().toUpperCase().replace(/[\s-]+/g, "_");

/**
 * A payment's MoR ModeOfPayment where it is unambiguous: an explicit mode, then a gateway channel,
 * then the method. Anything else (GATEWAY with no channel, MANUAL, telebirr...) is undefined and
 * the caller must name the mode: guessing a tax field is worse than asking.
 */
export function deriveModeOfPayment(payment: EimsPayment | null | undefined): EimsModeOfPayment | undefined {
  if (!payment) return undefined;
  if (payment.modeOfPayment) {
    const mode = EIMS_MODES_OF_PAYMENT.find((m) => m === normalize(payment.modeOfPayment!));
    if (mode) return mode;
  }
  if (payment.channel) {
    const mode = CHANNEL_TO_MODE[normalize(payment.channel)];
    if (mode) return mode;
  }
  if (!payment.method) return undefined;
  const method = normalize(payment.method);
  return EIMS_MODES_OF_PAYMENT.find((m) => m === method) ?? METHOD_TO_MODE[method];
}

/** ReceiptNumber cap and ManualReceiptNumber cap, from a live SCHEMA ERROR (2026-09-09). */
export const MAX_RECEIPT_NUMBER = 20;
export const MAX_MANUAL_RECEIPT_NUMBER = 15;

/**
 * R + the invoice number without an INV- prefix + -attempt, cut to 20 characters keeping the
 * attempt suffix: R20260908-00020-3. A re-file after a rejection is a new number.
 */
export function receiptNumberFor(invoiceNumber: string, attempt: number): string {
  const suffix = `-${attempt}`;
  const base = `R${invoiceNumber.replace(/^INV-/i, "")}`.replace(/\s+/g, "");
  return `${base.slice(0, MAX_RECEIPT_NUMBER - suffix.length)}${suffix}`;
}
