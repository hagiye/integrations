import {
  EimsError,
  deriveModeOfPayment,
  definitelyNotStored,
  describeEimsErrorBody,
  isBuyerLookupUnavailable,
  memoLines,
  morExpectedSequence,
  normalizeAckDate,
  receiptFiguresFor,
  receiptNumberFor,
  redactEimsHeaders,
  redactEimsPayload,
  resolveMorGeo,
  retryableNotStored,
  rulesIn,
} from "./index";

describe("MoR location codes", () => {
  it("resolves Addis Ababa / Bole / Woreda 1 hierarchically", () => {
    expect(resolveMorGeo({ region: "Addis Ababa", zone: "Bole", woreda: "Woreda 1" })).toEqual({ Country: "70", Region: "13", City: "78", Wereda: "1100" });
  });

  it("reads e-Trade's Addis shape (zone repeats the region, woreda in kebele) one level down", () => {
    expect(resolveMorGeo({ region: "Addis Ababa", zone: "Addis Ababa", woreda: "Bole", kebele: "03" })).toMatchObject({ City: "78", Wereda: "1102" });
  });

  it("applies reviewed aliases only within their region", () => {
    expect(resolveMorGeo({ region: "Addis Ababa", zone: "Kolfe Keraniyo", woreda: "1" }).City).toBe("81");
    expect(resolveMorGeo({ region: "Somali", zone: "Fafen", woreda: "Jigjiga" })).toMatchObject({ City: "31", Wereda: "190" });
  });

  it("keeps a name that exists in several zones inside its own zone, and fails loudly on a near miss", () => {
    expect(resolveMorGeo({ region: "Oromia", zone: "Misrak Hararge", woreda: "Kersa" }).Wereda).toBe("482");
    expect(resolveMorGeo({ region: "Oromia", zone: "Jimma", woreda: "Kersa" }).Wereda).toBe("503");
    expect(() => resolveMorGeo({ region: "Oromia", zone: "Jimma", woreda: "Kersaa" })).toThrow(/no LOCALITY_DESC match/);
  });
});

describe("failure classification", () => {
  const err = (kind: ConstructorParameters<typeof EimsError>[0], details = {}) => new EimsError(kind, "x", details);

  it("only refusals, and connections that never came up, are 'not stored'", () => {
    expect(definitelyNotStored(err("RULE_VALIDATION"))).toBe(true);
    expect(definitelyNotStored(err("RATE_LIMITED"))).toBe(true);
    expect(definitelyNotStored(err("NETWORK", { sent: false }))).toBe(true);
    expect(definitelyNotStored(err("NETWORK", { sent: true }))).toBe(false);
    expect(definitelyNotStored(err("TIMEOUT", { sent: true }))).toBe(false);
    expect(definitelyNotStored(err("SERVER"))).toBe(false);
    expect(definitelyNotStored(err("UNKNOWN"))).toBe(false);
  });

  it("429, unreachable and MoR's buyer lookup being down are retried later; a data refusal is not", () => {
    expect(retryableNotStored(err("RATE_LIMITED"))).toBe(true);
    expect(retryableNotStored(err("NETWORK", { sent: false }))).toBe(true);
    expect(retryableNotStored(err("RULE_VALIDATION", { code: "BUYER_LOOKUP_UNAVAILABLE" }))).toBe(true);
    expect(retryableNotStored(err("RULE_VALIDATION"))).toBe(false);
  });

  it("reads rule numbers and both error shapes, field names included", () => {
    const body = { message: "GATEWAY ERROR", code: "4001", details: [{ field: "signature", errorMessage: "must not be null" }] };
    expect(describeEimsErrorBody(body)).toBe("GATEWAY ERROR code=4001 signature: must not be null");
    expect(describeEimsErrorBody({ status: "VALIDATION_ERROR", errors: [{ field: "request", message: "must not be null" }] })).toBe(
      "VALIDATION_ERROR request: must not be null",
    );
    expect(rulesIn({ body: [{ errorMessage: ["7015: x expected : 10", "7001: y expected : 10"] }] })).toEqual(["7015", "7001"]);
    expect(isBuyerLookupUnavailable({ body: [{ errorMessage: ["BUYER_TIN 0000018932 buyer not found 503"] }] })).toBe(true);
  });

  it("adopts MoR's expected counter and document number, plain integers only", () => {
    const body = {
      body: [
        {
          errorMessage: [
            "7015: (id) Invoice Counter is not correct. : Invoice counter is not correct expected : 10",
            "7001: (id) Document number error. : Document number is not in correct sequence expected : 12",
            "7099: something expected : -4",
          ],
        },
      ],
    };
    expect(morExpectedSequence(body)).toEqual({ invoiceCounter: 10, documentNumber: 12 });
    expect(morExpectedSequence({ message: "7015 expected : abc" })).toEqual({});
  });

  it("writes back the seconds Java dropped from ackDate", () => {
    expect(normalizeAckDate("2026-08-07T09:05Z[Etc/UTC]")).toBe("2026-08-07T09:05:00Z[Etc/UTC]");
    expect(normalizeAckDate("2026-08-07T09:05:07Z[Etc/UTC]")).toBe("2026-08-07T09:05:07Z[Etc/UTC]");
    expect(normalizeAckDate("Sun Dec 22 21:55:03 EAT 2024")).toBe("Sun Dec 22 21:55:03 EAT 2024");
  });
});

describe("exchange-log redaction", () => {
  it("masks credentials, keeps the inner document and signature, reduces the certificate to its fingerprint", () => {
    const out = redactEimsPayload({
      request: { clientId: "c", clientSecret: "s3cret", apikey: "k3y", tin: "1", ItemList: [{ a: 1 }] },
      signature: "SIG",
      certificate: Buffer.from("not a cert").toString("base64"),
      data: { accessToken: "t0ken" },
    }) as Record<string, any>;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/s3cret|k3y|t0ken/);
    expect(out.request.clientId).toBe("c");
    expect(out.request.ItemList).toEqual([{ a: 1 }]);
    expect(out.signature).toBe("SIG");
    expect(out.certificate).toMatchObject({ __certificate: true, bytes: 10 });
  });

  it("masks the bearer token and apikey headers", () => {
    expect(redactEimsHeaders({ Authorization: "Bearer abc", apikey: "k", "Content-Type": "application/json" })).toEqual({
      authorization: "Bearer [REDACTED]",
      apikey: "[REDACTED]",
      "content-type": "application/json",
    });
  });
});

describe("credit and debit notes restate the original's filed lines (rule 7020)", () => {
  const original = {
    lines: [
      { chargeType: "RAIL", description: "40FT rail freight", quantity: 2, unitPrice: 42500, amount: 85000 },
      { chargeType: "BULK", description: "Bulk rail freight", quantity: 583.94, unitPrice: 8825.57, amount: 5153568.04, basis: "PER_TON" },
    ],
  };

  it("spreads an amount in proportion, the remainder on the last line, collapsed lines as 1 x their filed wording", () => {
    const lines = memoLines(original, "CRE", { amount: 1000 });
    expect(lines.map((l) => l.description)).toEqual(["40FT rail freight", "Bulk rail freight (583.94 t)"]);
    expect(lines.map((l) => l.quantity)).toEqual([2, 1]);
    expect(lines.reduce((s, l) => s + Number(l.amount), 0)).toBeCloseTo(1000, 2);
  });

  it("amends only the named lines, and a credit never exceeds what was billed", () => {
    expect(memoLines(original, "CRE", { lines: [{ index: 0, amount: 500, quantity: 1 }] })).toEqual([
      { chargeType: "RAIL", description: "40FT rail freight", quantity: 1, unitPrice: 500, amount: 500, basis: null },
    ]);
    expect(() => memoLines(original, "CRE", { lines: [{ index: 0, amount: 90000 }] })).toThrow(/exceeds/);
    expect(() => memoLines(original, "CRE", { lines: [{ index: 0, amount: 10, quantity: 3 }] })).toThrow(/cannot return 3 units/);
  });
});

describe("sales receipt figures", () => {
  const source = {
    documentId: "inv",
    number: "INV-20260908-00020",
    currency: "ETB",
    totalAmount: 85000,
    payments: [
      { key: "p1", amount: 50000, paidAt: "2026-09-09T07:12:44Z", method: "BANK_TRANSFER" },
      { amount: 35000, paidAt: "2026-09-10T07:12:44Z", method: "GATEWAY", channel: "CBE_BILL", reference: "FT123" },
    ],
  };

  it("reports each payment as of itself, never today's balance", () => {
    expect(receiptFiguresFor(source, "p1")).toMatchObject({ collected: 50000, paidToDate: 50000, remaining: 35000, coverage: "PARTIAL" });
    expect(receiptFiguresFor(source, "#1")).toMatchObject({ collected: 35000, remaining: 0, coverage: "FULL" });
  });

  it("maps only unambiguous modes", () => {
    expect(deriveModeOfPayment(source.payments[0])).toBe("BANK");
    expect(deriveModeOfPayment(source.payments[1])).toBe("BANK");
    expect(deriveModeOfPayment({ amount: 1, paidAt: null, method: "GATEWAY", channel: "TELEBIRR" })).toBeUndefined();
    expect(deriveModeOfPayment({ amount: 1, paidAt: null, modeOfPayment: "cash" })).toBe("CASH");
  });

  it("keeps receipt numbers within MoR's 20 characters", () => {
    expect(receiptNumberFor("INV-20260908-00020", 4)).toBe("R20260908-00020-4");
    expect(receiptNumberFor("A-VERY-LONG-INVOICE-NUMBER-0001", 12)).toHaveLength(20);
  });
});
