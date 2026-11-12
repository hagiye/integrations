import { invoice } from "../test/fakes";
import {
  EimsError,
  buildEimsDocument,
  eimsLineFigures,
  eimsUnitPrice,
  formatEimsDate,
  morVatNumber,
  prepareDocument,
  resolveEimsOptions,
} from "./index";

const options = resolveEimsOptions({
  clientId: "c",
  clientSecret: "s",
  apiKey: "k",
  tin: "0099990001",
  seller: { legalName: "Test Seller PLC", vatNumber: "12345678", phone: "+251911223344", email: "f@s.et", region: "13", wereda: "1100" },
  tax: { code: "VATEX", ratePercent: 0, byChargeType: { STORAGE: { code: "VAT15", ratePercent: 15 } } },
});
const seq = { documentNumber: "41", invoiceCounter: 41, previousIrn: "test-prev", systemNumber: "SYS", systemType: "POS" };

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof EimsError ? (err.details.code ?? err.kind) : "NOT_EIMS_ERROR";
  }
  return undefined;
};

describe("line figures (MoR checks Quantity x UnitPrice at four decimals)", () => {
  it("keeps a stored rate that multiplies out", () => {
    expect(eimsLineFigures({ chargeType: "X", quantity: 2, unitPrice: 42500, amount: 85000 })).toEqual({
      quantity: 2,
      unitPrice: 42500,
      description: "X",
      collapsed: false,
    });
  });

  it("derives a 4-decimal price when the stored rate does not multiply out (rate 0, amount 100, live)", () => {
    expect(eimsUnitPrice(100, 1, 0)).toBe(100);
    expect(eimsUnitPrice(2451.25 * 4, 4, 0)).toBe(2451.25);
  });

  it("collapses 583.94 t billed 5,153,568.04 to 1 x amount and names the quantity (live 2026-10-09)", () => {
    const f = eimsLineFigures({ chargeType: "BULK", description: "Bulk rail freight", quantity: 583.94, unitPrice: 8825.57, amount: 5153568.04, basis: "PER_TON" });
    expect(f).toEqual({ quantity: 1, unitPrice: 5153568.04, description: "Bulk rail freight (583.94 t)", collapsed: true });
  });

  it("collapses 1,000 over 3 containers, and a memo keeps its description bare", () => {
    const line = { chargeType: "C", description: "Credit", quantity: 3, unitPrice: 333.33, amount: 1000, basis: "PER_CONTAINER" };
    expect(eimsLineFigures(line).description).toBe("Credit (3 containers)");
    expect(eimsLineFigures(line, "CRE")).toMatchObject({ quantity: 1, unitPrice: 1000, description: "Credit" });
  });
});

describe("small rules", () => {
  it("VAT numbers: digits 3-25, else null, never repaired", () => {
    expect(morVatNumber(" 1234567 ")).toBe("1234567");
    expect(morVatNumber("VAT0099887766")).toBeNull();
    expect(morVatNumber("NA")).toBeNull();
  });

  it("dates are Ethiopian local time, dd-MM-yyyyTHH:mm:ss, whatever the server zone", () => {
    expect(formatEimsDate(new Date("2026-11-03T06:15:00Z"))).toBe("03-11-2026T09:15:00");
    expect(formatEimsDate(new Date("2026-12-31T22:30:05Z"))).toBe("01-01-2027T01:30:05");
  });
});

describe("prepareDocument refuses before a number is taken", () => {
  it.each([
    ["no TIN", { buyer: { ...invoice("a").buyer, tin: null } }, "BUYER_TIN_REQUIRED"],
    ["a minted placeholder TIN", { buyer: { ...invoice("a").buyer, tin: "I000000123" } }, "BUYER_TIN_REQUIRED"],
    ["an individual without a Fayda number", { buyer: { ...invoice("a").buyer, kind: "individual" as const, tin: null } }, "BUYER_ID_REQUIRED"],
    ["an individual filed as B2B", { buyer: { ...invoice("a").buyer, kind: "individual" as const, idNumber: "123456789012" }, transactionType: "B2B" as const }, "TRANSACTION_TYPE_MISMATCH"],
    ["a date older than 3 days (7026)", { issuedAt: new Date(Date.now() - 4 * 86_400_000) }, "DOCUMENT_TOO_OLD"],
    ["a future date", { issuedAt: new Date(Date.now() + 86_400_000) }, "DOCUMENT_IN_FUTURE"],
    ["USD without a rate", { currency: "USD" }, "EXCHANGE_RATE_REQUIRED"],
    ["lines that do not add up", { totalAmount: 90000 }, "LINES_TOTAL_MISMATCH"],
    ["a credit note without a reason", { type: "CRE" as const, relatedIrn: "test-1" }, "MEMO_REASON_REQUIRED"],
    ["a credit note whose original has no IRN", { type: "CRE" as const, reason: "Overcharge" }, "RELATED_NOT_REGISTERED"],
    ["an address MoR does not list", { buyer: { ...invoice("a").buyer, woreda: "Nowhere" } }, "GEO_MAPPING_FAILED"],
    ["a voided document", { voided: true }, "DOCUMENT_VOIDED"],
    ["an unknown IdType", { buyer: { ...invoice("a").buyer, idType: "XYZ" as never } }, "BUYER_ID_TYPE"],
  ])("%s", (_name, overrides, expected) => {
    expect(code(() => prepareDocument(invoice("a", overrides), options))).toBe(expected);
  });
});

describe("the registration document", () => {
  it("files a company as B2B with NID + its own TIN (rule 7004) and MoR location codes", () => {
    const doc = invoice("a");
    const built = buildEimsDocument(doc, seq, prepareDocument(doc, options), options);
    expect(built.TransactionType).toBe("B2B");
    expect(built.BuyerDetails).toMatchObject({ IdType: "NID", IdNumber: "0089238373", Tin: "0089238373", Country: "70", Region: "13", City: "78", Wereda: "1100" });
    expect(built.DocumentDetails).toEqual({ DocumentNumber: "41", Date: expect.stringMatching(/^\d{2}-\d{2}-\d{4}T\d{2}:\d{2}:\d{2}$/), Type: "INV" });
    expect(built.ItemList[0]).toMatchObject({ NatureOfSupplies: "service", Unit: "PCS", Quantity: 2, UnitPrice: 42500, TotalLineAmount: 85000, LineNumber: 1 });
    expect(built.ReferenceDetails).toEqual({ PreviousIrn: "test-prev", RelatedDocument: null });
    expect(built.SourceSystem).toMatchObject({ InvoiceCounter: 41, SystemNumber: "SYS", SystemType: "POS" });
    expect(built.Version).toBe("1");
  });

  it("files an individual as B2C under their Fayda number: no Tin, no VAT, no withholding", () => {
    const doc = invoice("b", {
      buyer: { ...invoice("b").buyer, kind: "individual", tin: null, idNumber: "123456789012", vatNumber: "1234567" },
      withholding: { income: 30, transaction: 10 },
    });
    const built = buildEimsDocument(doc, seq, prepareDocument(doc, options), options);
    expect(built.TransactionType).toBe("B2C");
    expect(built.BuyerDetails).toMatchObject({ IdType: "NID", IdNumber: "123456789012", VatNumber: null });
    expect(built.BuyerDetails).not.toHaveProperty("Tin");
    expect(built.ValueDetails).toMatchObject({ IncomeWithholdValue: 0, TransactionWithholdValue: 0 });
  });

  it("files a government buyer as B2G, and a credit note with its reason and related IRN", () => {
    const doc = invoice("c", { buyer: { ...invoice("c").buyer, kind: "government" }, type: "CRE", reason: "Overcharge", relatedIrn: "test-orig" });
    const built = buildEimsDocument(doc, seq, prepareDocument(doc, options), options);
    expect(built.TransactionType).toBe("B2G");
    expect(built.DocumentDetails).toMatchObject({ Type: "CRE", Reason: "Overcharge" });
    expect(built.ReferenceDetails.RelatedDocument).toBe("test-orig");
  });

  it("applies a per-charge-type tax and sends the exchange rate for a foreign currency", () => {
    const doc = invoice("d", {
      currency: "USD",
      exchangeRate: 162.5,
      totalAmount: 115,
      lines: [{ chargeType: "STORAGE", quantity: 1, unitPrice: 100, amount: 100 }],
    });
    const built = buildEimsDocument(doc, seq, prepareDocument(doc, options), options);
    expect(built.ItemList[0]).toMatchObject({ TaxCode: "VAT15", TaxAmount: 15, TotalLineAmount: 115, PreTaxValue: 100 });
    expect(built.ValueDetails).toMatchObject({ TaxValue: 15, TotalValue: 115, InvoiceCurrency: "USD", ExchangeRate: 162.5 });
  });

  it("uses already-resolved location codes when the host has them", () => {
    const doc = invoice("e", { buyer: { ...invoice("e").buyer, geo: { Country: "70", Region: "6", City: "31", Wereda: "190" } } });
    const built = buildEimsDocument(doc, seq, prepareDocument(doc, options), options);
    expect(built.BuyerDetails).toMatchObject({ Region: "6", City: "31", Wereda: "190" });
  });
});
