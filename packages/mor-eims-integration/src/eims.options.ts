import { EimsTransactionType, EimsSellerDetails } from "./eims.types";

export const EIMS_OPTIONS = Symbol("EIMS_OPTIONS");

/** MoR's gateway. The test credentials EDR used file here too; their IRNs start with "test-". */
export const EIMS_DEFAULT_BASE_URL = "https://core.mor.gov.et";

/** Your registration with MoR. Rule 7017 checks these against MoR's taxpayer registry, character for character. */
export interface EimsSellerOptions {
  legalName: string;
  /** Digits, as MoR holds it. */
  vatNumber: string;
  phone: string;
  email: string;
  /** A MoR region code ("13" is Addis Ababa), not a name. */
  region: string;
  /** A MoR wereda code ("574"). */
  wereda: string;
  city?: string | null;
  subCity?: string | null;
  houseNumber?: string | null;
  locality?: string | null;
}

export interface EimsLineTaxOptions {
  code: string;
  ratePercent: number;
  exciseTaxValue?: number;
  discount?: number;
}

/** Tax treatment. Not defaulted on purpose: finance signs off the code and rate for each charge type. */
export interface EimsTaxOptions extends EimsLineTaxOptions {
  /** Per chargeType (ItemCode) overrides, e.g. { RAIL_FREIGHT: { code: "VATEX", ratePercent: 0 } }. */
  byChargeType?: Record<string, EimsLineTaxOptions>;
}

export interface EimsModuleOptions {
  /** Default https://core.mor.gov.et. */
  baseUrl?: string;
  clientId: string;
  clientSecret: string;
  /** Trimmed: a trailing space gave login error 4408 live. */
  apiKey: string;
  /** Your 10-digit TIN: the login's tin and SellerDetails.Tin. */
  tin: string;

  /**
   * A fixed signing pair (PEM text), for a deployment that does not rotate through stored
   * credentials. Ignored once an ACTIVE stored credential exists.
   */
  privateKey?: string;
  /** The INSA certificate file, as PEM text or its exact bytes. Sent as base64 of those bytes, never re-encoded. */
  certificate?: string | Buffer;
  /**
   * 32 random bytes, base64 (openssl rand -base64 32). Enables stored credentials: uploaded
   * private keys are kept encrypted under it with AES-256-GCM. One key per environment.
   */
  encryptionKey?: string;

  /** Checks against the token's systemNumber / systemType claims. A mismatch is a hard error. */
  expectedSystemNumber?: string;
  expectedSystemType?: string;

  seller: EimsSellerOptions;
  tax: EimsTaxOptions;

  /** Default sale type for company buyers. Default B2B. Individuals file B2C, government buyers B2G. */
  transactionType?: EimsTransactionType;
  /** "goods" or "service", lowercase. Default "service". */
  natureOfSupplies?: string;
  /** PaymentDetails.Mode. Default CASH (a document can override it, e.g. CREDIT). */
  paymentMode?: string;
  /** PaymentDetails.PaymentTerm. Default IMMIDIATE, spelled as in MoR's examples. */
  paymentTerm?: string;
  /** The MoR unit on every line. Default PCS. */
  unitDefault?: string;
  /** SourceSystem.CashierName, and a receipt's CollectorName when none is given. */
  cashierName?: string;
  salesPersonName?: string;

  /** Rule 7026: a document date at most this many days old. Checked before a number is taken. Default 3. */
  maxDocumentAgeDays?: number;
  /** DocumentDetails.Date is local Ethiopian time with no zone. Default 180 (UTC+3). */
  documentUtcOffsetMinutes?: number;
  /**
   * A document with no issue date is issued now when it is filed (filing is issuing, and 7026
   * wants a recent date), through host.markIssued. Default true. False: refuse it.
   */
  stampIssueDate?: boolean;
  /** What a buyer TIN must look like. Default 10 digits, which also keeps minted placeholders out. */
  buyerTinPattern?: RegExp;

  /** Per HTTP call. A timeout after sending is an ambiguous outcome. Default 30000. */
  httpTimeoutMs?: number;
  /** Stop using a token this long before it expires. Default 45. */
  tokenSkewSeconds?: number;
  /** Extra CA certificates, PEM. Added to Node's trusted CAs, not in place of them. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Turns TLS verification off. Development only; refused for mor.gov.et. */
  insecureTls?: boolean;

  /**
   * A secret you put in the bulk-register webhook URL you give MoR (route/<token>). MoR sends no
   * credential on its callback; with a token, rejections in a callback are applied. Without one,
   * only acceptances whose IRN /v1/verify confirms are applied, and rejections wait for a person.
   */
  bulkWebhookToken?: string;
}

export interface ResolvedEimsOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  tin: string;
  privateKey: string | null;
  certificateBase64: string | null;
  encryptionKey: string | null;
  expectedSystemNumber: string | null;
  expectedSystemType: string | null;
  seller: EimsSellerOptions;
  tax: EimsTaxOptions;
  transactionType: EimsTransactionType;
  natureOfSupplies: string;
  paymentMode: string;
  paymentTerm: string;
  unitDefault: string;
  cashierName: string | null;
  salesPersonName: string | null;
  maxDocumentAgeDays: number;
  documentUtcOffsetMinutes: number;
  stampIssueDate: boolean;
  buyerTinPattern: RegExp;
  httpTimeoutMs: number;
  tokenSkewMs: number;
  ca: string | Buffer | Array<string | Buffer> | undefined;
  insecureTls: boolean;
  bulkWebhookToken: string | null;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const orNull = (value: unknown): string | null => text(value) || null;
const positive = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function certificateBase64Of(certificate: string | Buffer | undefined): string | null {
  if (certificate === undefined || certificate === null) return null;
  if (Buffer.isBuffer(certificate)) return certificate.length ? certificate.toString("base64") : null;
  const pem = certificate.replace(/\\n/g, "\n");
  return pem.trim() ? Buffer.from(pem, "utf8").toString("base64") : null;
}

export function resolveEimsOptions(options: EimsModuleOptions): ResolvedEimsOptions {
  const seller = options.seller ?? ({} as EimsSellerOptions);
  const tax = options.tax ?? ({} as EimsTaxOptions);
  return {
    baseUrl: (text(options.baseUrl) || EIMS_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    clientId: text(options.clientId),
    clientSecret: text(options.clientSecret),
    apiKey: text(options.apiKey),
    tin: text(options.tin),
    privateKey: options.privateKey?.trim() ? options.privateKey : null,
    certificateBase64: certificateBase64Of(options.certificate),
    encryptionKey: orNull(options.encryptionKey),
    expectedSystemNumber: orNull(options.expectedSystemNumber),
    expectedSystemType: orNull(options.expectedSystemType),
    seller: {
      legalName: text(seller.legalName),
      vatNumber: text(seller.vatNumber),
      phone: text(seller.phone),
      email: text(seller.email),
      region: text(seller.region),
      wereda: text(seller.wereda),
      city: orNull(seller.city),
      subCity: orNull(seller.subCity),
      houseNumber: orNull(seller.houseNumber),
      locality: orNull(seller.locality),
    },
    tax: {
      code: text(tax.code),
      ratePercent: tax.ratePercent as number,
      exciseTaxValue: tax.exciseTaxValue ?? 0,
      discount: tax.discount ?? 0,
      byChargeType: tax.byChargeType ?? {},
    },
    transactionType: options.transactionType ?? "B2B",
    natureOfSupplies: (text(options.natureOfSupplies) || "service").toLowerCase(),
    paymentMode: text(options.paymentMode) || "CASH",
    paymentTerm: text(options.paymentTerm) || "IMMIDIATE",
    unitDefault: text(options.unitDefault) || "PCS",
    cashierName: orNull(options.cashierName),
    salesPersonName: orNull(options.salesPersonName),
    maxDocumentAgeDays: positive(options.maxDocumentAgeDays, 3),
    documentUtcOffsetMinutes: Number.isFinite(options.documentUtcOffsetMinutes) ? Number(options.documentUtcOffsetMinutes) : 180,
    stampIssueDate: options.stampIssueDate ?? true,
    buyerTinPattern: options.buyerTinPattern ?? /^[0-9]{10}$/,
    httpTimeoutMs: positive(options.httpTimeoutMs, 30_000),
    tokenSkewMs: positive(options.tokenSkewSeconds, 45) * 1000,
    ca: options.ca,
    insecureTls: options.insecureTls === true,
    bulkWebhookToken: orNull(options.bulkWebhookToken),
  };
}

/** Names of the settings a filing needs and does not have. Names only, never values. */
export function missingEimsOptions(options: ResolvedEimsOptions): string[] {
  const missing: string[] = [];
  const need = (name: string, value: unknown) => {
    if (value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) {
      missing.push(name);
    }
  };
  need("clientId", options.clientId);
  need("clientSecret", options.clientSecret);
  need("apiKey", options.apiKey);
  need("tin", options.tin);
  need("seller.legalName", options.seller.legalName);
  need("seller.vatNumber", options.seller.vatNumber);
  need("seller.phone", options.seller.phone);
  need("seller.email", options.seller.email);
  need("seller.region", options.seller.region);
  need("seller.wereda", options.seller.wereda);
  need("tax.code", options.tax.code);
  need("tax.ratePercent", typeof options.tax.ratePercent === "number" ? options.tax.ratePercent : null);
  if (!options.encryptionKey && !(options.privateKey && options.certificateBase64)) {
    missing.push("privateKey + certificate (or encryptionKey with an activated stored pair)");
  }
  return missing;
}

/**
 * The patterns MoR's 400 SCHEMA ERROR quoted back for the seller fields, plus internal
 * consistency of the tax overrides: problems found here cost no request and no number.
 */
export function invalidEimsOptions(options: ResolvedEimsOptions): string[] {
  const problems: string[] = [];
  const check = (name: string, value: string, pattern: RegExp) => {
    if (value && !pattern.test(value)) problems.push(`${name} (must match ${pattern.source})`);
  };
  check("seller.phone", options.seller.phone, /^\+?[0-9]{6,}$/);
  check("seller.email", options.seller.email, /^[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+$/);
  check("seller.region", options.seller.region, /^[0-9]{1,3}$/);
  check("seller.wereda", options.seller.wereda, /^[0-9A-Za-z]{1,10}$/);
  check("seller.vatNumber", options.seller.vatNumber, /^[0-9]{3,25}$/);
  check("tin", options.tin, /^[0-9]{10}$/);
  if (!["goods", "service"].includes(options.natureOfSupplies)) problems.push('natureOfSupplies (must be "goods" or "service")');
  if (!/^[A-Z0-9]{1,8}$/.test(options.unitDefault)) problems.push("unitDefault (a MoR unit such as PCS, at most 8 characters)");
  if (!["B2B", "B2C", "B2G"].includes(options.transactionType)) problems.push("transactionType (B2B, B2C or B2G)");
  for (const [chargeType, line] of Object.entries(options.tax.byChargeType ?? {})) {
    if (!line?.code?.trim()) problems.push(`tax.byChargeType.${chargeType}.code`);
    if (!Number.isFinite(line?.ratePercent)) problems.push(`tax.byChargeType.${chargeType}.ratePercent`);
    if (line?.exciseTaxValue !== undefined && !Number.isFinite(line.exciseTaxValue)) {
      problems.push(`tax.byChargeType.${chargeType}.exciseTaxValue`);
    }
    if (line?.discount !== undefined && !Number.isFinite(line.discount)) problems.push(`tax.byChargeType.${chargeType}.discount`);
  }
  return problems;
}

export function sellerDetails(options: ResolvedEimsOptions): EimsSellerDetails {
  const s = options.seller;
  return {
    City: s.city ?? null,
    Email: s.email,
    HouseNumber: s.houseNumber ?? null,
    LegalName: s.legalName,
    Locality: s.locality ?? null,
    Phone: s.phone,
    Region: s.region,
    SubCity: s.subCity ?? null,
    Tin: options.tin,
    VatNumber: s.vatNumber,
    Wereda: s.wereda,
  };
}
