/**
 * Wire types for MoR EIMS, as EDR sends and reads them (field names and casing exactly as the
 * gateway accepted them live), plus the model this package works on.
 */

// ── wire: envelope and login ─────────────────────────────────────────────────────────────────────

/** Every endpoint, login included, takes this envelope; only `request` is signed. */
export interface EimsSignedRequest<T> {
  request: T;
  signature: string;
  certificate: string;
}

/** Inner request of POST /auth/login. `apikey` is lowercase on the wire. */
export interface EimsLoginRequest {
  clientId: string;
  clientSecret: string;
  apikey: string;
  tin: string;
}

export interface EimsLoginResponse {
  data?: { accessToken?: string; refreshToken?: string; encryptionKey?: string | null; expiresIn?: number };
  status?: string;
}

/** Source-system identity, read from MoR's access token (the authority, not configuration). */
export interface EimsSession {
  systemNumber: string;
  systemType: string;
}

// ── wire: the registration document ──────────────────────────────────────────────────────────────

export const EIMS_DOCUMENT_TYPES = ["INV", "DEB", "CRE"] as const;
export type EimsDocumentType = (typeof EIMS_DOCUMENT_TYPES)[number];

export const EIMS_TRANSACTION_TYPES = ["B2B", "B2C", "B2G"] as const;
export type EimsTransactionType = (typeof EIMS_TRANSACTION_TYPES)[number];

/** Rule 7004: the only IdType values MoR takes. */
export const EIMS_ID_TYPES = ["NID", "KID", "SID", "WID", "PST", "DLS", "MRS"] as const;
export type EimsIdType = (typeof EIMS_ID_TYPES)[number];

/** MoR's unit list; anything else (PER_CONTAINER...) fails the enum, the 8-char cap and the pattern. */
export const EIMS_UNITS = ["LTR", "MTR", "101", "PCS", "ROL", "MTS", "PKG", "SET", "KLG"] as const;

export interface EimsBuyerDetails {
  City: string | null;
  Email: string | null;
  HouseNumber: string | null;
  IdNumber?: string;
  IdType?: string;
  /** Omitted for a B2C buyer (an individual has no TIN; NID + IdNumber identify them). */
  Tin?: string;
  LegalName: string;
  Phone: string | null;
  Region: string | null;
  Country: string | null;
  Zone: string | null;
  Kebele: string | null;
  VatNumber: string | null;
  Wereda: string | null;
}

export interface EimsSellerDetails {
  City: string | null;
  Email: string | null;
  HouseNumber: string | null;
  LegalName: string;
  Locality: string | null;
  Phone: string | null;
  /** MoR region code ("13"), not a name. */
  Region: string | null;
  SubCity: string | null;
  Tin: string;
  VatNumber: string | null;
  /** MoR wereda code ("574"). */
  Wereda: string | null;
}

export interface EimsDocumentDetails {
  DocumentNumber: string;
  /** dd-MM-yyyyTHH:mm:ss, Ethiopian local time, no zone. Rule 7026: at most 3 days old. */
  Date: string;
  Type: EimsDocumentType;
  /** Only on DEB/CRE. */
  Reason?: string;
}

export interface EimsInvoiceItem {
  Discount: number;
  ExciseTaxValue: number;
  HarmonizationCode: string | null;
  NatureOfSupplies: string;
  ItemCode: string;
  ProductDescription: string;
  PreTaxValue: number;
  Quantity: number;
  LineNumber: number;
  TaxAmount: number;
  TaxCode: string;
  TotalLineAmount: number;
  Unit: string;
  UnitPrice: number;
}

export interface EimsInvoiceRequest {
  BuyerDetails: EimsBuyerDetails;
  DocumentDetails: EimsDocumentDetails;
  ItemList: EimsInvoiceItem[];
  PaymentDetails: { Mode: string; PaymentTerm: string };
  ReferenceDetails: { PreviousIrn: string | null; RelatedDocument: string | null };
  SellerDetails: EimsSellerDetails;
  SourceSystem: {
    CashierName: string | null;
    InvoiceCounter: number;
    SalesPersonName: string | null;
    SystemNumber: string;
    SystemType: string;
  };
  TransactionType: string;
  ValueDetails: {
    Discount: number | null;
    ExciseValue: number;
    IncomeWithholdValue: number;
    TaxValue: number;
    TotalValue: number;
    TransactionWithholdValue: number;
    InvoiceCurrency: string;
    ExchangeRate?: number;
  };
  Version: string;
}

export interface EimsRegisterResponse {
  statusCode?: number;
  message?: string;
  body?: {
    irn?: string;
    ackDate?: string;
    signedQR?: string;
    signedInvoice?: string;
    status?: string;
    documentNumber?: string;
    errorMessage?: string | null;
  };
}

/** Inner request of POST /v1/verify. Lowercase `irn` (the response spells it `Irn`). */
export interface EimsVerifyRequest {
  irn: string;
}

export interface EimsVerifyResponse {
  statusCode?: number;
  message?: string;
  body?: {
    Irn?: string;
    TransactionType?: string;
    DocumentDetails?: { Type?: string; DocumentNumber?: string; Date?: string };
    [section: string]: unknown;
  };
}

/** Inner request of POST /v1/cancel. Capital `Irn` here, unlike verify. */
export interface EimsCancelRequest {
  Irn: string;
  /** Numeric string: "1" duplicate, "6" calculation error (from the collection). */
  ReasonCode: string;
  Remark: string;
}

export interface EimsCancelResponse {
  statusCode?: number;
  message?: string;
  /** cancellationDate is Java's Date#toString ("Sun Dec 22 21:55:03 EAT 2024"); kept as given. */
  body?: { cancellationDate?: string };
}

/** One entry of a /v1/bulkCancel answer: success has lowercase `status` ("C"), failure capital `Status` + `msg`. */
export type EimsBulkCancelResponseItem =
  | { status: string; Irn: string; id?: number; tin?: string; mode?: string }
  | { Status: string; msg: string; Irn: string };

export interface EimsBulkCancelResponse {
  statusCode?: number;
  message?: string;
  body?: EimsBulkCancelResponseItem[];
}

/** Immediate answer to /v1/bulkRegister: an acknowledgement, the results come by webhook. */
export interface EimsBulkRegisterAccepted {
  conversationId?: string;
  status?: number;
}

/** A callback item: accepted (irn), rejected (ruleError + docNo) or the batch marker. */
export type EimsBulkCallbackItem =
  | { irn: string; status?: string; documentNumber: string; signedQR?: string; signedInvoice?: string }
  | { ruleError: Array<{ portion?: string; errorMessage?: string[] }>; status?: string; docNo: string }
  | { conversationId?: string; conversionId?: string };

// ── wire: sales receipt ──────────────────────────────────────────────────────────────────────────

/** The only ModeOfPayment values MoR's schema takes (live schema error, 2026-09-09). */
export const EIMS_MODES_OF_PAYMENT = ["CASH", "ADVANCE", "CREDIT", "CHEQUE", "CPO", "SWIFT", "CARD", "WIRE", "BANK", "LC"] as const;
export type EimsModeOfPayment = (typeof EIMS_MODES_OF_PAYMENT)[number];

/** "Currency should be ETB, USD, CAD" (live rule error). */
export const EIMS_RECEIPT_CURRENCIES = ["ETB", "USD", "CAD"] as const;

export interface EimsSalesReceiptRequest {
  ReceiptNumber: string;
  ReceiptType: string;
  Reason: string;
  ReceiptDate: string;
  ReceiptCounter: string;
  ManualReceiptNumber: string | null;
  SourceSystemType: string;
  SourceSystemNumber: string;
  ReceiptCurrency: string;
  ExchangeRate: number | null;
  CollectedAmount: number;
  SellerTIN: string;
  Invoices: Array<{
    InvoiceIRN: string;
    PaymentCoverage: string;
    InvoicePaidAmount: number;
    DiscountAmount: number | null;
    RemainingAmount: number | null;
    TotalAmount: number;
  }>;
  TransactionDetails: {
    ModeOfPayment: EimsModeOfPayment;
    ChequeNumber: string | null;
    CPONumber: string | null;
    DocumentNumber: string | null;
    /** Required; MoR reads a null as absent. */
    CollectorName: string;
    PaymentServiceProvider: string | null;
    OtherPaymentServiceProviderName: string | null;
    AccountNumber: string | null;
    TransactionNumber: string | null;
  };
}

export interface EimsReceiptResponse {
  statusCode?: number;
  message?: string;
  body?: { status?: string; rrn?: string; qr?: string };
}

// ── the package's model of what the host supplies ────────────────────────────────────────────────

/** MoR location codes for a buyer: Country / Region / City (the zone level) / Wereda. */
export interface MorGeoCodes {
  Country: string;
  Region: string;
  City: string;
  Wereda: string;
}

export interface EimsBuyer {
  /**
   * company: B2B with a real TIN. individual: B2C, identified by a national ID (Fayda) number, no
   * TIN. government: B2G (EDR files shipping-line credit invoices this way).
   */
  kind: "company" | "individual" | "government";
  legalName: string;
  /** Required for company and government. Placeholder TINs must never reach here (see buyerTinPattern). */
  tin?: string | null;
  /** Rule 7004. Default NID, with the TIN (company) or the national ID number (individual). */
  idType?: EimsIdType | null;
  /** For an individual: their Fayda number. For a company: defaults to its TIN. */
  idNumber?: string | null;
  vatNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Names, resolved to MoR codes against the location master unless geo is given. */
  country?: string | null;
  region?: string | null;
  zone?: string | null;
  woreda?: string | null;
  kebele?: string | null;
  houseNumber?: string | null;
  /** Already-resolved MoR codes; checked for shape, not looked up again. */
  geo?: MorGeoCodes | null;
}

export interface EimsDocumentLine {
  /** Sent as ItemCode, and the key for per-charge-type tax overrides. */
  chargeType: string;
  description?: string | null;
  quantity: number | string;
  /** The stored rate; the filed UnitPrice is derived (see eimsLineFigures). */
  unitPrice: number | string;
  /** The money actually billed on this line. It always wins over quantity x unitPrice. */
  amount: number | string;
  /** Your own basis tag (PER_TON, PER_CONTAINER...), only used to word a collapsed line's description. */
  basis?: string | null;
}

/** One invoice, credit note or debit note, as the host loads it. */
export interface EimsDocument {
  id: string;
  /** Your own number (INV-20260907-00003), for messages and receipt numbers. Never sent as DocumentNumber. */
  number: string;
  type: EimsDocumentType;
  /** Required for CRE/DEB. */
  reason?: string | null;
  /** Required for CRE/DEB: the original's IRN. */
  relatedIrn?: string | null;
  /** Null until issued. Filing stamps it now when the host supports markIssued (filing is issuing). */
  issuedAt: Date | string | null;
  currency: string;
  /** Required when currency is not ETB. */
  exchangeRate?: number | null;
  totalAmount: number | string;
  buyer: EimsBuyer;
  lines: EimsDocumentLine[];
  /** Overrides PaymentDetails.Mode for this document (EDR: CREDIT for a credit sale). */
  paymentMode?: string | null;
  /** Overrides the sale type derived from the buyer. */
  transactionType?: EimsTransactionType | null;
  /** Income and transaction withholding for this document. Default 0; always 0 for B2C. */
  withholding?: { income: number; transaction: number } | null;
  /** True when your own system cancelled it before it was filed: nothing to file. */
  voided?: boolean;
}

/** Filing state of one document. */
export type EimsFilingStatus = "NOT_SUBMITTED" | "SUBMITTING" | "REGISTERED" | "FAILED" | "UNKNOWN" | "CANCELLED";

export interface EimsStoredError {
  kind: string;
  message: string;
  httpStatus?: number;
  rules?: string[];
  code?: string;
  details?: unknown;
  at: string;
}

/** What the host stores per document. The package reads and writes it inside host transactions. */
export interface EimsFiling {
  documentId: string;
  status: EimsFilingStatus;
  irn: string | null;
  /** The MoR DocumentNumber reserved for it (a plain integer as a string). */
  documentNumber: string | null;
  invoiceCounter: number | null;
  ackDate: string | null;
  signedQr: string | null;
  submittedAt: Date | null;
  lastError: EimsStoredError | null;
  /** Attempts that came back retryable (429, MoR unreachable, its buyer lookup down). */
  retryCount: number;
  bulkConversationId: string | null;
  cancelledAt: Date | null;
  cancellationDate: string | null;
  cancellationReasonCode: string | null;
  cancellationRemark: string | null;
}

/** One row per MoR source system: the sequence MoR enforces. */
export interface EimsSystemState {
  systemNumber: string;
  nextInvoiceCounter: number;
  nextDocumentNumber: number;
  previousIrn: string | null;
  inFlightDocumentId: string | null;
  inFlightCounter: number | null;
  inFlightDocumentNumber: number | null;
  inFlightConversationId: string | null;
  /** While set, nothing is filed on this system number. */
  blockedReason: string | null;
}

/** One sales-receipt attempt. */
export type EimsReceiptStatus = "SUBMITTING" | "REGISTERED" | "FAILED" | "UNKNOWN";

export interface EimsReceiptRecord {
  id: string;
  documentId: string;
  paymentKey: string;
  status: EimsReceiptStatus;
  receiptNumber: string;
  rrn: string | null;
  qr: string | null;
  ackStatus: string | null;
  submittedAt: Date | null;
  /** The exact inner request sent (the printed voucher reads its figures from here). */
  request: EimsSalesReceiptRequest | null;
  lastError: EimsStoredError | null;
}

/** One payment on an invoice's ledger, oldest first. */
export interface EimsPayment {
  /** Stable key; omitted ones are keyed by position (#0, #1...). */
  key?: string | null;
  amount: number | string;
  paidAt: Date | string | null;
  /** Your method word: BANK_TRANSFER, CASH, GATEWAY... */
  method?: string | null;
  /** MoR mode chosen by finance, gateway channel (CBE_BILL, CAC_BANK, CARD...). */
  modeOfPayment?: string | null;
  channel?: string | null;
  /** A gateway's transaction id, or finance's voucher number for a manual payment. */
  reference?: string | null;
}

export interface EimsReceiptSource {
  documentId: string;
  number: string;
  currency: string;
  totalAmount: number | string;
  payments: EimsPayment[];
}

/** Stored INSA key/certificate pair. privateKeyEnc is AES-256-GCM under the encryption key. */
export type EimsCredentialStatus = "PENDING" | "ACTIVE" | "RETIRED";

export interface EimsCredentialRecord {
  id: string;
  status: EimsCredentialStatus;
  label: string;
  /** Null once retired: a retired key is destroyed. */
  privateKeyEnc: string | null;
  /** Base64 of the certificate file's exact bytes (the wire form). */
  certificateBase64: string;
  certFingerprintSha256: string;
  keyFingerprintSha256: string;
  certSubject: string;
  certIssuer: string;
  certNotBefore: Date | null;
  certNotAfter: Date | null;
  keyBits: number | null;
  activationSystemNumber: string | null;
  lastActivationError: string | null;
  /** 0, 60, 30, 7, or 1 for "expired": the last reminder sent. */
  expiryReminderStage: number;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
  replacedById: string | null;
}

/** One logged exchange with MoR, redacted before the host sees it. */
export interface EimsExchangeRecord {
  direction: "OUTBOUND" | "INBOUND";
  operation: string;
  path: string;
  attempt: number;
  documentIds: string[];
  receiptId: string | null;
  trigger: string | null;
  systemNumber: string | null;
  statusCode: number | null;
  isSuccess: boolean;
  failureKind: string | null;
  errorMessage: string | null;
  requestHeaders: Record<string, string> | null;
  requestBody: unknown;
  responseBody: unknown;
  sourceIp?: string | null;
  durationMs: number | null;
  at: Date;
}
