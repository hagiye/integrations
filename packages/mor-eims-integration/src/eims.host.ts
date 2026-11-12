import {
  EimsCredentialRecord,
  EimsDocument,
  EimsExchangeRecord,
  EimsFiling,
  EimsReceiptRecord,
  EimsReceiptSource,
  EimsStoredError,
  EimsSystemState,
} from "./eims.types";

export const EIMS_HOST = Symbol("EIMS_HOST");

/**
 * The rows the package reads and writes inside ONE host transaction. Every lock* method takes a
 * row lock (SELECT ... FOR UPDATE) held until the transaction ends; save* writes the whole record.
 * Lock order is always: system state, then filings, then receipts or credentials.
 */
export interface EimsLedger {
  /** The sequence row for a MoR system number, locked; created at counter 1 / document 1 when missing. */
  lockSystemState(systemNumber: string): Promise<EimsSystemState>;
  saveSystemState(state: EimsSystemState): Promise<void>;

  /** A document's filing, locked; a NOT_SUBMITTED one when the document has none yet; null when the document does not exist. */
  lockFiling(documentId: string): Promise<EimsFiling | null>;
  saveFiling(filing: EimsFiling): Promise<void>;
  /** Filings holding this bulk conversation id, locked, in counter order. */
  lockFilingsByConversation(conversationId: string): Promise<EimsFiling[]>;

  /** Every receipt attempt for a document (call lockFiling first: that lock serializes receipts). */
  listReceipts(documentId: string): Promise<EimsReceiptRecord[]>;
  /**
   * Insert one attempt. Return false (do not throw) when your unique index on (document,
   * payment key) over SUBMITTING / REGISTERED / UNKNOWN rows refuses it.
   */
  insertReceipt(receipt: EimsReceiptRecord): Promise<boolean>;
  saveReceipt(receipt: EimsReceiptRecord): Promise<void>;

  /** Every stored key/certificate pair, locked. Back it with a unique index allowing one ACTIVE row. */
  lockCredentials(): Promise<EimsCredentialRecord[]>;
  insertCredential(record: EimsCredentialRecord): Promise<void>;
  saveCredential(record: EimsCredentialRecord): Promise<void>;
}

export type EimsEventType =
  /** A document got its IRN. */
  | "REGISTERED"
  /** MoR refused it for a reason in the document: fix it and file again. */
  | "REJECTED"
  /** Not stored, not the document's fault (429, MoR unreachable, its buyer lookup down): it stays queued. */
  | "RETRY_LATER"
  /** Sent, no clear answer: the system number is blocked until someone resolves it. High priority. */
  | "UNKNOWN"
  /** MoR accepted it but saving that failed: the IRN or RRN is in the event. High priority. */
  | "PERSIST_FAILED"
  | "RESOLVED"
  | "CANCELLED"
  | "RECEIPT_REGISTERED"
  | "RECEIPT_FAILED"
  | "RECEIPT_UNKNOWN"
  /** A bulk callback item that could not be trusted (no token, or its IRN did not verify). */
  | "BULK_CALLBACK_UNTRUSTED"
  | "CREDENTIAL_ACTIVATED"
  /** 60, 30, 7 days before the active certificate expires, and once after. */
  | "CERTIFICATE_EXPIRY";

export interface EimsEvent {
  type: EimsEventType;
  /** HIGH when every further filing is stopped or something accepted may be lost. */
  priority: "NORMAL" | "HIGH";
  message: string;
  documentId?: string;
  documentNumber?: string;
  receiptId?: string;
  irn?: string;
  rrn?: string;
  error?: EimsStoredError;
  credentialId?: string;
  daysToExpiry?: number;
}

/**
 * Your side of the integration. The package keeps the rules (reservation, give-back, block,
 * verification, idempotency); you keep the rows.
 */
export interface EimsHost {
  /** Run `work` in one database transaction, so the locks it takes hold until it commits. */
  transaction<T>(work: (ledger: EimsLedger) => Promise<T>): Promise<T>;

  /** The document as MoR should see it, or null when it does not exist. */
  loadDocument(documentId: string): Promise<EimsDocument | null>;

  /**
   * Stamp an unissued document as issued now (filing is issuing). Without this method, an
   * unissued document is refused.
   */
  markIssued?(documentId: string, issuedAt: Date): Promise<void>;

  /** For sales receipts: the invoice's total and payment ledger. */
  loadReceiptSource?(documentId: string): Promise<EimsReceiptSource | null>;

  /** For the auto-submit sweep: the oldest issued document still NOT_SUBMITTED and inside maxAgeDays, or null. */
  nextUnfiledDocument?(query: { maxAgeDays: number; now: Date }): Promise<string | null>;

  /** For the auto-receipt sweep: one registered document with a payment that has no receipt attempt yet. */
  nextUnreceiptedPayment?(): Promise<{ documentId: string; paymentKey?: string } | null>;

  /** Every stored credential row, unlocked (read every 15 s to pick up a rotation made on another instance). */
  listCredentials?(): Promise<EimsCredentialRecord[]>;

  /** Any IRN MoR registered for you, for activation to prove a new pair with a read-only /v1/verify. */
  anyRegisteredIrn?(): Promise<string | null>;

  /** Notify people (staff on UNKNOWN / PERSIST_FAILED, the buyer on REGISTERED...). Errors are logged, never thrown back. */
  onEvent?(event: EimsEvent): Promise<void>;

  /** Every exchange with MoR, already redacted. Errors are logged, never thrown back. */
  recordExchange?(record: EimsExchangeRecord): Promise<void>;
}

/** A fresh filing record for a document that has none. */
export function newFiling(documentId: string): EimsFiling {
  return {
    documentId,
    status: "NOT_SUBMITTED",
    irn: null,
    documentNumber: null,
    invoiceCounter: null,
    ackDate: null,
    signedQr: null,
    submittedAt: null,
    lastError: null,
    retryCount: 0,
    bulkConversationId: null,
    cancelledAt: null,
    cancellationDate: null,
    cancellationReasonCode: null,
    cancellationRemark: null,
  };
}

/** A fresh sequence row. */
export function newSystemState(systemNumber: string): EimsSystemState {
  return {
    systemNumber,
    nextInvoiceCounter: 1,
    nextDocumentNumber: 1,
    previousIrn: null,
    inFlightDocumentId: null,
    inFlightCounter: null,
    inFlightDocumentNumber: null,
    inFlightConversationId: null,
    blockedReason: null,
  };
}
