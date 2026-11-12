import { EimsError } from "./eims.errors";
import { checkGeoCodes, resolveMorGeo } from "./eims.geo";
import { EimsLineTaxOptions, ResolvedEimsOptions, sellerDetails } from "./eims.options";
import {
  EIMS_DOCUMENT_TYPES,
  EIMS_ID_TYPES,
  EimsBuyer,
  EimsDocument,
  EimsDocumentLine,
  EimsDocumentType,
  EimsInvoiceItem,
  EimsInvoiceRequest,
  EimsTransactionType,
  MorGeoCodes,
} from "./eims.types";

/** The only proven-required constant: a payload without it fails schema validation. */
const EIMS_VERSION = "1";

const invalid = (code: string, message: string): never => {
  throw new EimsError("INVALID", message, { code, sent: false });
};

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
/** Quantity x UnitPrice the way MoR evaluates it: the product kept to four decimals. */
export const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

export function num(value: number | string, what: string): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) invalid("NOT_A_NUMBER", `${what} is not a number (${String(value)})`);
  return n;
}

/**
 * The UnitPrice MoR is sent: the stored rate when it multiplies out to the billed amount,
 * otherwise the amount spread over the quantity, to 4 decimals. MoR recomputes Quantity x
 * UnitPrice; "expected 0.00 received 100" came back live on a charge stored with rate 0.
 */
export function eimsUnitPrice(amount: number | string, quantity: number | string, unitPrice: number | string): number {
  const lineAmount = round2(num(amount, "line amount"));
  const units = round2(num(quantity, "line quantity"));
  const stored = round2(num(unitPrice, "line unit price"));
  if (!(units > 0) || round2(stored * units) === lineAmount) return stored;
  return round4(lineAmount / units);
}

const QUANTITY_UNITS: Record<string, string> = {
  PER_TON: "t",
  PER_TON_KM: "t-km",
  PER_KM: "km",
  PER_CONTAINER: "containers",
  PER_WAGON: "wagons",
  NUMBER_OF_WAGONS: "wagons",
  PER_ITEM: "items",
};

/** ProductDescription cap (EDR's description column is varchar(255)). */
export const DESCRIPTION_MAX = 255;

export interface EimsLineFigures {
  quantity: number;
  unitPrice: number;
  description: string;
  /** True when no four-decimal unit price reproduces the amount, so the line is filed as 1 x amount. */
  collapsed: boolean;
}

/**
 * Quantity, UnitPrice and ProductDescription a line is filed with, decided in one place so the
 * filing, the printed document and a later memo agree.
 *
 * MoR checks Quantity x UnitPrice against the line at FOUR decimals: 583.94 t billed 5,153,568.04
 * gave "expected 5153568.0174 received 5153568.04" live on 2026-10-09. A four-decimal price only
 * reproduces the cent when the split is exact, so an inexact line is filed as ONE unit priced at
 * the amount, and on an invoice its description names the billed quantity ("Bulk rail freight
 * (583.94 t)"). A memo's description is left alone: rule 7020 compares it word for word with the
 * original's filed wording.
 */
export function eimsLineFigures(line: EimsDocumentLine, documentType: EimsDocumentType = "INV"): EimsLineFigures {
  const lineAmount = round2(num(line.amount, "line amount"));
  const units = round2(num(line.quantity, "line quantity"));
  const unitPrice = eimsUnitPrice(line.amount, line.quantity, line.unitPrice);
  const description = line.description?.trim() || line.chargeType;
  if (Math.abs(round4(units * unitPrice) - lineAmount) < 1e-9) {
    return { quantity: units, unitPrice, description, collapsed: false };
  }
  return {
    quantity: 1,
    unitPrice: lineAmount,
    description: documentType === "INV" && units > 0 ? withBilledQuantity(description, units, line.basis) : description,
    collapsed: true,
  };
}

function withBilledQuantity(description: string, units: number, basis: string | null | undefined): string {
  const suffix = ` (${units} ${QUANTITY_UNITS[basis ?? ""] ?? "units"})`;
  const room = DESCRIPTION_MAX - suffix.length;
  const base = description.length > room ? `${description.slice(0, room - 1)}…` : description;
  return `${base}${suffix}`;
}

/**
 * A VAT number in the only shape MoR takes (^[0-9]{3,25}$, error 1023 live), or null. Values like
 * "VAT0099887766" or "NA" are dropped, not repaired: digits stripped out of a licence number would
 * invent a VAT number. Surrounding spaces are the one thing corrected.
 */
export function morVatNumber(vatNumber: string | null | undefined): string | null {
  const trimmed = vatNumber?.trim();
  return trimmed && /^[0-9]{3,25}$/.test(trimmed) ? trimmed : null;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * dd-MM-yyyyTHH:mm:ss in Ethiopian local time (UTC+3 by default), no zone marker. EDR formats in
 * the server's own time zone, which on a UTC server stamps every document three hours early.
 */
export function formatEimsDate(at: Date, utcOffsetMinutes = 180): string {
  const local = new Date(at.getTime() + utcOffsetMinutes * 60_000);
  return (
    `${pad(local.getUTCDate())}-${pad(local.getUTCMonth() + 1)}-${local.getUTCFullYear()}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  );
}

/** The tax treatment of one charge type: its override, else the default. */
export function lineTax(options: ResolvedEimsOptions, chargeType: string): Required<EimsLineTaxOptions> {
  const override = options.tax.byChargeType?.[chargeType];
  const base = override ?? options.tax;
  return {
    code: base.code,
    ratePercent: base.ratePercent,
    exciseTaxValue: base.exciseTaxValue ?? 0,
    discount: base.discount ?? 0,
  };
}

/** The sale type a document files under. An individual is always B2C, a government buyer B2G by default. */
export function resolveTransactionType(document: EimsDocument, options: ResolvedEimsOptions): EimsTransactionType {
  const kind = document.buyer?.kind;
  const derived: EimsTransactionType = kind === "individual" ? "B2C" : kind === "government" ? "B2G" : options.transactionType;
  const chosen = document.transactionType ?? derived;
  if (kind === "individual" && chosen !== "B2C") {
    invalid("TRANSACTION_TYPE_MISMATCH", `Document ${document.number} bills an individual and must file as B2C, not ${chosen}`);
  }
  if (kind !== "individual" && chosen === "B2C") {
    invalid("TRANSACTION_TYPE_MISMATCH", `Document ${document.number} files as B2C but its buyer is not an individual`);
  }
  return chosen;
}

export interface PreparedDocument {
  documentType: EimsDocumentType;
  transactionType: EimsTransactionType;
  buyerGeo: MorGeoCodes;
  issuedAt: Date;
  withholding: { income: number; transaction: number };
}

function buyerIdentity(buyer: EimsBuyer, number: string, options: ResolvedEimsOptions): { idType: string; idNumber: string; tin?: string } {
  const idType = (buyer.idType ?? "NID").trim().toUpperCase();
  if (!(EIMS_ID_TYPES as readonly string[]).includes(idType)) {
    invalid("BUYER_ID_TYPE", `Document ${number}: buyer IdType "${idType}" is not one of ${EIMS_ID_TYPES.join(", ")} (rule 7004)`);
  }
  if (buyer.kind === "individual") {
    const idNumber = buyer.idNumber?.trim();
    if (!idNumber) {
      invalid("BUYER_ID_REQUIRED", `Document ${number} bills an individual with no national ID (Fayda) number on record`);
    }
    return { idType, idNumber: idNumber! };
  }
  const tin = buyer.tin?.trim();
  if (!tin || !options.buyerTinPattern.test(tin)) {
    invalid(
      "BUYER_TIN_REQUIRED",
      `Document ${number} bills ${buyer.legalName || "a buyer"} with no usable TIN` +
        (tin ? ` ("${tin}" does not match ${options.buyerTinPattern.source})` : "") +
        ". Filing a placeholder under your own seller credentials is worse than not filing.",
    );
  }
  return { idType, idNumber: buyer.idNumber?.trim() || tin!, tin };
}

/**
 * Every check that can fail on local data, run BEFORE a number is reserved so a bad address or a
 * stale date never uses one up. Throws INVALID with a code; returns what the build needs.
 * `issuedAt` must already be set (the filing service stamps it first when allowed).
 */
export function prepareDocument(document: EimsDocument, options: ResolvedEimsOptions, now = new Date()): PreparedDocument {
  if (document.voided) invalid("DOCUMENT_VOIDED", `Document ${document.number} was cancelled before filing; there is nothing to file`);
  const documentType = document.type ?? "INV";
  if (!(EIMS_DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    invalid("DOCUMENT_TYPE", `Document ${document.number} has type "${documentType}"; it must be INV, CRE or DEB`);
  }
  if (documentType !== "INV") {
    if (!document.reason?.trim()) invalid("MEMO_REASON_REQUIRED", `Document ${document.number} is a ${documentType} and needs a reason`);
    if (!document.relatedIrn?.trim()) {
      invalid("RELATED_NOT_REGISTERED", `Document ${document.number} is a ${documentType} whose original has no IRN: nothing to reference`);
    }
  }
  if (!document.lines?.length) invalid("NO_LINES", `Document ${document.number} has no lines`);
  if (!document.buyer) invalid("NO_BUYER", `Document ${document.number} has no buyer`);
  if (!document.currency?.trim()) invalid("NO_CURRENCY", `Document ${document.number} has no currency`);
  if (document.currency !== "ETB" && !(Number(document.exchangeRate) > 0)) {
    invalid("EXCHANGE_RATE_REQUIRED", `Document ${document.number} is in ${document.currency} and needs an exchange rate`);
  }
  if (!document.issuedAt) invalid("NOT_ISSUED", `Document ${document.number} has no issue date`);
  const issuedAt = document.issuedAt instanceof Date ? document.issuedAt : new Date(document.issuedAt!);
  if (Number.isNaN(issuedAt.getTime())) invalid("BAD_DATE", `Document ${document.number} has an unparseable issue date`);
  const ageMs = now.getTime() - issuedAt.getTime();
  if (ageMs > options.maxDocumentAgeDays * 86_400_000) {
    invalid(
      "DOCUMENT_TOO_OLD",
      `Document ${document.number} was issued ${issuedAt.toISOString()}, more than ${options.maxDocumentAgeDays} days ago; MoR refuses it (rule 7026)`,
    );
  }
  if (ageMs < -10 * 60_000) invalid("DOCUMENT_IN_FUTURE", `Document ${document.number} is dated in the future (${issuedAt.toISOString()})`);

  const transactionType = resolveTransactionType(document, options);
  buyerIdentity(document.buyer, document.number, options);
  const buyerGeo = document.buyer.geo
    ? checkGeoCodes(document.buyer.geo)
    : resolveMorGeo({
        country: document.buyer.country,
        region: document.buyer.region,
        zone: document.buyer.zone,
        woreda: document.buyer.woreda,
        kebele: document.buyer.kebele,
      });
  const withholding =
    document.buyer.kind === "individual"
      ? { income: 0, transaction: 0 }
      : { income: round2(document.withholding?.income ?? 0), transaction: round2(document.withholding?.transaction ?? 0) };
  if (withholding.income < 0 || withholding.transaction < 0) invalid("WITHHOLDING", `Document ${document.number}: withholding cannot be negative`);

  // Build once with placeholder numbers: the line and total checks are the same at any counter.
  buildEimsDocument(
    document,
    { documentNumber: "1", invoiceCounter: 1, previousIrn: "", systemNumber: "CHECK", systemType: "CHECK" },
    { documentType, transactionType, buyerGeo, issuedAt, withholding },
    options,
  );
  return { documentType, transactionType, buyerGeo, issuedAt, withholding };
}

export interface EimsSequenceContext {
  documentNumber: string;
  invoiceCounter: number;
  previousIrn: string | null;
  systemNumber: string;
  systemType: string;
}

/**
 * The MoR registration document for one prepared document. Pure: no I/O, no counters taken.
 * Throws INVALID when the lines and the total disagree or a tax treatment is missing.
 */
export function buildEimsDocument(
  document: EimsDocument,
  sequence: EimsSequenceContext,
  prepared: PreparedDocument,
  options: ResolvedEimsOptions,
): EimsInvoiceRequest {
  const { documentType } = prepared;
  const identity = buyerIdentity(document.buyer, document.number, options);

  const ItemList: EimsInvoiceItem[] = document.lines.map((line, index) => {
    const lineNumber = index + 1;
    if (!line.chargeType?.trim()) invalid("LINE_CODE", `Document ${document.number} line ${lineNumber} has no charge type (ItemCode)`);
    const tax = lineTax(options, line.chargeType);
    if (!tax.code || !Number.isFinite(tax.ratePercent) || !Number.isFinite(tax.exciseTaxValue) || !Number.isFinite(tax.discount)) {
      invalid("LINE_TAX", `Document ${document.number} line ${lineNumber} (${line.chargeType}) has no tax treatment`);
    }
    const PreTaxValue = round2(num(line.amount, `line ${lineNumber} amount`));
    if (PreTaxValue < 0) invalid("NEGATIVE_LINE", `Document ${document.number} line ${lineNumber} is negative; file a credit note instead`);
    const figures = eimsLineFigures(line, documentType);
    if (!(figures.quantity > 0)) invalid("LINE_QUANTITY", `Document ${document.number} line ${lineNumber} has no quantity`);
    const TaxAmount = round2((PreTaxValue * tax.ratePercent) / 100);
    const ExciseTaxValue = round2(tax.exciseTaxValue);
    return {
      Discount: round2(tax.discount),
      ExciseTaxValue,
      HarmonizationCode: null,
      NatureOfSupplies: options.natureOfSupplies,
      ItemCode: line.chargeType,
      ProductDescription: figures.description.slice(0, DESCRIPTION_MAX),
      PreTaxValue,
      Quantity: figures.quantity,
      LineNumber: lineNumber,
      TaxAmount,
      TaxCode: tax.code,
      // Discount is not subtracted: its effect on the total was never observed live.
      TotalLineAmount: round2(PreTaxValue + TaxAmount + ExciseTaxValue),
      Unit: options.unitDefault,
      UnitPrice: figures.unitPrice,
    };
  });

  const TotalValue = round2(ItemList.reduce((sum, item) => sum + item.TotalLineAmount, 0));
  const total = round2(num(document.totalAmount, "document total"));
  if (Math.abs(TotalValue - total) > 0.01) {
    invalid(
      "LINES_TOTAL_MISMATCH",
      `Document ${document.number}: the lines add up to ${TotalValue} (tax and excise included) but the total is ${total}`,
    );
  }

  const valueDetails: EimsInvoiceRequest["ValueDetails"] = {
    Discount: null,
    ExciseValue: round2(ItemList.reduce((sum, item) => sum + item.ExciseTaxValue, 0)),
    IncomeWithholdValue: prepared.withholding.income,
    TaxValue: round2(ItemList.reduce((sum, item) => sum + item.TaxAmount, 0)),
    TotalValue,
    TransactionWithholdValue: prepared.withholding.transaction,
    InvoiceCurrency: document.currency,
  };
  if (document.currency !== "ETB") valueDetails.ExchangeRate = Number(document.exchangeRate);

  const buyer = document.buyer;
  const isIndividual = buyer.kind === "individual";
  return {
    BuyerDetails: {
      City: prepared.buyerGeo.City,
      Email: buyer.email?.trim() || null,
      HouseNumber: buyer.houseNumber?.trim() || null,
      // Rule 7004 wants an IdType on EVERY buyer, companies included; NID with the buyer's own
      // TIN was accepted live. An individual's NID carries their Fayda number and no TIN is sent.
      IdType: identity.idType,
      IdNumber: identity.idNumber,
      ...(isIndividual ? {} : { Tin: identity.tin }),
      LegalName: buyer.legalName,
      Phone: buyer.phone?.trim() || null,
      Region: prepared.buyerGeo.Region,
      Country: prepared.buyerGeo.Country,
      Zone: buyer.zone?.trim() || null,
      Kebele: buyer.kebele?.trim() || null,
      VatNumber: isIndividual ? null : morVatNumber(buyer.vatNumber),
      Wereda: prepared.buyerGeo.Wereda,
    },
    DocumentDetails: {
      DocumentNumber: sequence.documentNumber,
      Date: formatEimsDate(prepared.issuedAt, options.documentUtcOffsetMinutes),
      Type: documentType,
      ...(documentType !== "INV" ? { Reason: document.reason!.trim() } : {}),
    },
    ItemList,
    PaymentDetails: { Mode: document.paymentMode?.trim() || options.paymentMode, PaymentTerm: options.paymentTerm },
    ReferenceDetails: {
      PreviousIrn: sequence.previousIrn,
      RelatedDocument: documentType === "INV" ? null : document.relatedIrn!.trim(),
    },
    SellerDetails: sellerDetails(options),
    SourceSystem: {
      CashierName: options.cashierName,
      InvoiceCounter: sequence.invoiceCounter,
      SalesPersonName: options.salesPersonName,
      SystemNumber: sequence.systemNumber,
      SystemType: sequence.systemType,
    },
    TransactionType: prepared.transactionType,
    ValueDetails: valueDetails,
    Version: EIMS_VERSION,
  };
}
