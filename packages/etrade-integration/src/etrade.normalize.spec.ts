import {
  dateAtOffset,
  daysBetween,
  extractRegistrationData,
  isValidLicenceNumber,
  isValidTin,
  licenceStanding,
  maskTin,
  normalizeLicence,
  normalizeRegistration,
  parseEtradeDate,
  resolveCompanyName,
  stateFromStatus,
  stripActivityCode,
  toBusinessOption,
  usableEthiopianPhone,
} from "./etrade.normalize";
import { normalizeRegion } from "./etrade.regions";
import type { EtradeLicence, EtradeRawBusiness } from "./etrade.types";

const rawLicence = (over: Partial<EtradeRawBusiness> = {}): EtradeRawBusiness => ({
  OwnerTIN: "0000000001",
  TradeName: " Test Freight Forwarding ",
  LicenceNumber: "XX/AA/14/670/0000002/2007",
  Status: 1,
  StatusDescription: "Active",
  Capital: 100000,
  AssociateShortInfos: [
    { ManagerName: "አበበ", ManagerNameEng: "Abebe Bekele", Photo: "PHOTO", MobilePhone: "52543000", RegularPhone: "0911223344" },
  ],
  AddressInfo: { Region: "ADDIS ABABA", Zone: "Zone 1", Woreda: "W1", Kebele: "01", HouseNo: "12", MobilePhone: "09        ", RegularPhone: "" },
  RenewedTo: "2026-07-07T00:00:00",
  RenewedToDateString: "7/7/2026",
  RenewalDate: "7/8/2025",
  RenewedFrom: "7/8/2025",
  CancellationDate: null,
  ...over,
});

describe("TIN and licence number checks", () => {
  it("accepts only 10 digits as a TIN", () => {
    expect(isValidTin("0045014036")).toBe(true);
    for (const bad of ["004501403", "00450140366", "D123456789", "0045 014036", "", null, 45014036]) {
      expect(isValidTin(bad)).toBe(false);
    }
  });

  it("refuses empty, over-long and control-character licence numbers", () => {
    expect(isValidLicenceNumber("MT/AA/14/670/128936/2007")).toBe(true);
    expect(isValidLicenceNumber("  ")).toBe(false);
    expect(isValidLicenceNumber("x".repeat(121))).toBe(false);
    expect(isValidLicenceNumber("MT/AA\n/1")).toBe(false);
  });

  it("masks a TIN down to its last three digits", () => {
    expect(maskTin("0045014036")).toBe("*******036");
  });
});

describe("licence list (registration answer)", () => {
  it("strips the code prefix from activities", () => {
    expect(stripActivityCode("(72131)Freight Forwarders")).toBe("Freight Forwarders");
    expect(stripActivityCode("(65611) Import trade in vehicles")).toBe("Import trade in vehicles");
  });

  it("survives null lists, null entries and null descriptions (EDR's selection spec)", () => {
    const option = toBusinessOption({
      LicenceNumber: "X/1",
      TradesName: " PAVE ",
      SubGroups: [null, { Code: 66331, Description: "Export trade in minerals" }, { Code: 1, Description: null }],
      RenewedTo: "7/7/2026",
    });
    expect(option).toEqual({ licenceNumber: "X/1", tradeName: "PAVE", activity: "Export trade in minerals", renewedTo: "7/7/2026" });
    expect(toBusinessOption({ LicenceNumber: "X/2", SubGroups: null })?.activity).toBe("");
  });

  it("drops entries without a licence number, and null entries", () => {
    const reg = normalizeRegistration(
      { Tin: "0000000001", BusinessName: " ACME ", Businesses: [null, { TradesName: "no number" }, { LicenceNumber: "X/1" }] },
      "0000000001",
    );
    expect(reg.businesses.map((b) => b.licenceNumber)).toEqual(["X/1"]);
    expect(reg.businessName).toBe("ACME");
  });

  it("joins several activities with a comma", () => {
    const option = toBusinessOption({
      LicenceNumber: "X/1",
      SubGroups: [{ Code: 1, Description: "(1)Import" }, { Code: 2, Description: "Export" }],
    });
    expect(option?.activity).toBe("Import, Export");
  });
});

describe("licence detail", () => {
  it("normalises the detail, keeps the raw region and drops the photo and capital", () => {
    const licence = normalizeLicence(rawLicence());
    expect(licence.tradeName).toBe("Test Freight Forwarding");
    expect(licence.renewedTo).toBe("7/7/2026");
    expect(licence.validUntil).toBe("2026-07-07");
    expect(licence.address).toMatchObject({ rawRegion: "ADDIS ABABA", region: "Addis Ababa", zone: "Zone 1" });
    expect(licence.manager).toEqual({
      name: "Abebe Bekele",
      nameAmh: "አበበ",
      position: "",
      mobilePhone: "52543000",
      regularPhone: "0911223344",
    });
    expect(JSON.stringify(licence)).not.toContain("PHOTO");
    expect(JSON.stringify(licence)).not.toContain("100000");
  });

  it("falls back to RenewedTo when RenewedToDateString is missing", () => {
    const licence = normalizeLicence(rawLicence({ RenewedToDateString: null }));
    expect(licence.renewedTo).toBe("2026-07-07T00:00:00");
    expect(licence.validUntil).toBe("2026-07-07");
  });

  it("leaves an unknown region empty, never a guess, and uses extra aliases", () => {
    expect(normalizeLicence(rawLicence({ AddressInfo: { Region: "SNNPR" } })).address.region).toBe("");
    expect(normalizeLicence(rawLicence({ AddressInfo: { Region: "SNNPR" } }), { snnpr: "Central Ethiopia" }).address.region).toBe(
      "Central Ethiopia",
    );
  });

  it("has no manager when e-trade lists no associate", () => {
    expect(normalizeLicence(rawLicence({ AssociateShortInfos: [null] })).manager).toBeNull();
  });
});

describe("regions (EDR's catalogue)", () => {
  it.each([
    ["ADDIS ABABA", "Addis Ababa"],
    ["  oromiya ", "Oromia"],
    ["EAST SHEWA", "Oromia"],
    ["North  Wollo", "Amhara"],
    ["Benishangul Gumuz", "Benishangul-Gumuz"],
    ["", null],
    ["Atlantis", null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRegion(input)).toBe(expected);
  });
});

describe("dates", () => {
  it.each([
    ["7/7/2026", "2026-07-07"],
    ["12/31/2026", "2026-12-31"],
    ["2026-07-07T00:00:00", "2026-07-07"],
    ["2026-07-07", "2026-07-07"],
    ["2/30/2026", null],
    ["31/12/2026", null],
    ["July 7, 2026", null],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(parseEtradeDate(input)).toBe(expected);
  });

  it("takes today in Ethiopian time", () => {
    // 22:30 UTC is already the next day in Addis Ababa.
    expect(dateAtOffset(new Date("2026-07-07T22:30:00Z"), 180)).toBe("2026-07-08");
    expect(daysBetween("2026-07-08", "2026-07-07")).toBe(-1);
  });
});

describe("licence standing", () => {
  const context = (now: string) => ({ now: new Date(now), dateUtcOffsetMinutes: 180, statusMap: {} });
  const licence = (over: Partial<EtradeRawBusiness> = {}): EtradeLicence => normalizeLicence(rawLicence(over));

  it("is ACTIVE before the expiry, on the last day too", () => {
    expect(licenceStanding(licence(), context("2026-07-07T12:00:00Z"))).toEqual({ state: "ACTIVE", problems: [], expiresInDays: 0 });
  });

  it("is EXPIRED the day after, in Ethiopian time", () => {
    expect(licenceStanding(licence(), context("2026-07-07T22:00:00Z"))).toMatchObject({
      state: "EXPIRED",
      problems: ["LICENCE_EXPIRED"],
      expiresInDays: -1,
    });
  });

  it("is CANCELLED when e-trade gives a cancellation date, whatever the status says", () => {
    expect(licenceStanding(licence({ CancellationDate: "3/1/2026" }), context("2026-01-01T00:00:00Z")).state).toBe("CANCELLED");
  });

  it("reads suspended and cancelled status texts, and treats any other text as UNKNOWN", () => {
    expect(stateFromStatus(3, "Suspended", {})).toBe("SUSPENDED");
    expect(stateFromStatus(4, "Cancelled", {})).toBe("CANCELLED");
    expect(stateFromStatus(5, "Under Review", {})).toBe("UNKNOWN");
    expect(stateFromStatus(1, "", {})).toBe("UNKNOWN");
    expect(licenceStanding(licence({ StatusDescription: "Pending" }), context("2026-01-01T00:00:00Z")).problems).toEqual([
      "LICENCE_STATUS_UNKNOWN",
    ]);
  });

  it("lets statusMap name a description or a code", () => {
    expect(stateFromStatus(7, "Renewed", { renewed: "ACTIVE" })).toBe("ACTIVE");
    expect(stateFromStatus(7, "", { "#7": "SUSPENDED" })).toBe("SUSPENDED");
  });

  it("flags an active licence whose expiry cannot be read", () => {
    const standing = licenceStanding(licence({ RenewedToDateString: "soon", RenewedTo: null }), context("2026-01-01T00:00:00Z"));
    expect(standing).toEqual({ state: "ACTIVE", problems: ["VALID_UNTIL_UNREADABLE"], expiresInDays: null });
  });
});

describe("company name (EDR's resolveCompanyName)", () => {
  const names = { tradeName: "Pave Freight Forwarding", businessName: "PAVE LOGISTICS AND TRADING P L C" };
  it("is the trade name by default", () => expect(resolveCompanyName(names)).toBe("Pave Freight Forwarding"));
  it("is the business name when chosen", () => expect(resolveCompanyName(names, "businessName")).toBe(names.businessName));
  it("falls back to the other one when the chosen one is blank", () => {
    expect(resolveCompanyName({ ...names, businessName: " " }, "businessName")).toBe("Pave Freight Forwarding");
    expect(resolveCompanyName({ ...names, tradeName: "" })).toBe(names.businessName);
  });
});

describe("phones", () => {
  it.each([
    ["0911223344", "+251911223344"],
    ["+251 911 22 33 44", "+251911223344"],
    ["251711223344", "+251711223344"],
    ["911223344", "+251911223344"],
    ["0111234567", "+251111234567"],
    ["09        ", null],
    ["52543000", null],
    ["0811223344", null],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(usableEthiopianPhone(input)).toBe(expected);
  });
});

describe("registration data (EDR's extractRegistrationData)", () => {
  const licence = normalizeLicence(rawLicence());
  const registration = normalizeRegistration(
    { Tin: "0000000001", BusinessName: "PAVE LOGISTICS AND TRADING P L C", Businesses: [{ LicenceNumber: "XX/AA/14/670/0000002/2007" }] },
    "0000000001",
  );
  const standing = { state: "ACTIVE" as const, problems: [], expiresInDays: 100 };

  it("takes the licence's trade name as the company name, never the manager's", () => {
    const data = extractRegistrationData(licence, registration, standing);
    expect(data.companyName).toBe("Test Freight Forwarding");
    expect(data.managerName).toBe("Abebe Bekele");
    expect(data.businessName).toBe("PAVE LOGISTICS AND TRADING P L C");
    expect(data.businesses).toHaveLength(1);
  });

  it("keeps e-trade's phones as written (trimmed) and picks the first usable one as contactPhone", () => {
    const data = extractRegistrationData(licence, registration, standing);
    expect(data.mobilePhone).toBe("09");
    expect(data.managerPhone).toBe("0911223344");
    expect(data.contactPhone).toBe("+251911223344");
    const none = extractRegistrationData(
      normalizeLicence(rawLicence({ AssociateShortInfos: [{ MobilePhone: "52543000", RegularPhone: null }] })),
      registration,
      standing,
    );
    expect(none.contactPhone).toBeNull();
  });

  it("carries the licence state and the parsed expiry", () => {
    const data = extractRegistrationData(licence, registration, { state: "EXPIRED", problems: ["LICENCE_EXPIRED"], expiresInDays: -3 });
    expect(data).toMatchObject({ licenceState: "EXPIRED", validUntil: "2026-07-07", renewedTo: "7/7/2026" });
  });
});
