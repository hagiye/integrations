import { buildSnapshot, diffSnapshots, findLicence, isNewer, notListedSnapshot, selectLicence } from "./etrade.selection";
import type { EtradeBusinessOption, EtradeLicence } from "./etrade.types";

/**
 * A TIN routinely holds several licences under one trade name (EDR's
 * etrade-business-selection.spec.ts). The customer picks one, and every later lookup must
 * resolve that same licence.
 */
const BUSINESSES: EtradeBusinessOption[] = [
  { licenceNumber: "MT/AA/14/670/11551235/2017", tradeName: "PAVE", activity: "Export trade in minerals", renewedTo: "7/7/2026" },
  { licenceNumber: "MT/AA/14/670/128936/2007", tradeName: "PAVE", activity: "Freight Forwarders", renewedTo: "7/7/2026" },
];

describe("choosing which licence a lookup resolves", () => {
  it("defaults to the first licence when none is chosen", () => {
    expect(selectLicence(BUSINESSES, undefined)).toEqual({ selected: BUSINESSES[0], chosenMissing: false, fellBack: false });
  });

  it("resolves the chosen licence", () => {
    expect(selectLicence(BUSINESSES, " MT/AA/14/670/128936/2007 ").selected).toBe(BUSINESSES[1]);
  });

  it("resolves nothing when the chosen licence is gone, so the customer chooses again", () => {
    expect(selectLicence(BUSINESSES, "NO/SUCH/LICENCE")).toEqual({ selected: null, chosenMissing: true, fellBack: false });
  });

  it("keeps EDR's fallback to the first licence when asked to", () => {
    expect(selectLicence(BUSINESSES, "NO/SUCH/LICENCE", "first")).toEqual({
      selected: BUSINESSES[0],
      chosenMissing: true,
      fellBack: true,
    });
  });

  it("has nothing to resolve for a TIN without licences", () => {
    expect(selectLicence([], undefined)).toEqual({ selected: null, chosenMissing: false, fellBack: false });
    expect(selectLicence([], "X")).toEqual({ selected: null, chosenMissing: true, fellBack: false });
  });

  it("matches licence numbers exactly: another TIN's licence is simply not in the list", () => {
    expect(findLicence(BUSINESSES, "MT/AA/14/670/128936/2007")).toBe(BUSINESSES[1]);
    expect(findLicence(BUSINESSES, "mt/aa/14/670/128936/2007")).toBeNull();
    expect(findLicence(BUSINESSES, "SOMEONE/ELSES/LICENCE")).toBeNull();
  });
});

describe("snapshots", () => {
  const licence: EtradeLicence = {
    licenceNumber: BUSINESSES[1].licenceNumber,
    ownerTin: "0045014036",
    tradeName: "Pave Freight Forwarding",
    status: 1,
    statusDescription: "Active",
    dateRegistered: "1/1/2020",
    renewedFrom: "7/8/2025",
    renewalDate: "7/8/2025",
    renewedTo: "7/7/2026",
    validUntil: "2026-07-07",
    cancellationDate: null,
    address: { rawRegion: "ADDIS ABABA", region: "Addis Ababa", zone: "", woreda: "", kebele: "", houseNo: "", mobilePhone: "", regularPhone: "" },
    manager: null,
  };
  const at = new Date("2026-01-01T09:00:00Z");

  it("is built from e-trade's answers: the list entry and the licence detail", () => {
    const snapshot = buildSnapshot({
      tin: "0045014036",
      option: BUSINESSES[1],
      licence,
      standing: { state: "ACTIVE", problems: [], expiresInDays: 187 },
      checkedAt: at,
      checkedBy: "user-1",
    });
    expect(snapshot).toEqual({
      licenceNumber: "MT/AA/14/670/128936/2007",
      tradeName: "Pave Freight Forwarding",
      activity: "Freight Forwarders",
      renewedTo: "7/7/2026",
      tin: "0045014036",
      validUntil: "2026-07-07",
      expiresInDays: 187,
      state: "ACTIVE",
      statusCode: 1,
      statusDescription: "Active",
      cancellationDate: null,
      rawRegion: "ADDIS ABABA",
      region: "Addis Ababa",
      needsReview: false,
      problems: [],
      checkedAt: "2026-01-01T09:00:00.000Z",
      source: "etrade:registration+licence",
      checkedBy: "user-1",
    });
  });

  it("is flagged when e-trade lists the licence but has no detail for it", () => {
    const snapshot = buildSnapshot({ tin: "0045014036", option: BUSINESSES[0], licence: null, standing: null, checkedAt: at, checkedBy: null });
    expect(snapshot).toMatchObject({ state: "UNKNOWN", needsReview: true, problems: ["LICENCE_DETAIL_NOT_FOUND"], tradeName: "PAVE" });
  });

  it("keeps the last known data of a licence that is no longer listed, flagged", () => {
    const before = buildSnapshot({ tin: "0045014036", option: BUSINESSES[1], licence, standing: { state: "ACTIVE", problems: [], expiresInDays: 1 }, checkedAt: at, checkedBy: null });
    const gone = notListedSnapshot(before, new Date("2026-02-01T00:00:00Z"), "recheck");
    expect(gone).toMatchObject({ tradeName: "Pave Freight Forwarding", state: "NOT_LISTED", problems: ["LICENCE_NOT_LISTED"], needsReview: true, checkedBy: "recheck" });
    expect(diffSnapshots(before, gone)).toEqual(["state"]);
  });

  it("diffs the fields that matter, not the check time", () => {
    const before = buildSnapshot({ tin: "0045014036", option: BUSINESSES[1], licence, standing: { state: "ACTIVE", problems: [], expiresInDays: 1 }, checkedAt: at, checkedBy: null });
    const same = { ...before, checkedAt: new Date().toISOString() };
    expect(diffSnapshots(before, same)).toEqual([]);
    expect(diffSnapshots(before, { ...before, tradeName: "New Name", renewedTo: "7/7/2027" })).toEqual(["tradeName", "renewedTo"]);
    expect(diffSnapshots(null, before)).toEqual(["licenceNumber"]);
  });

  it("never lets an older answer replace a newer one", () => {
    const newer = buildSnapshot({ tin: "1", option: BUSINESSES[0], licence: null, standing: null, checkedAt: new Date("2026-02-01T00:00:00Z"), checkedBy: null });
    const older = { ...newer, checkedAt: "2026-01-01T00:00:00.000Z" };
    expect(isNewer(older, newer)).toBe(false);
    expect(isNewer(newer, older)).toBe(true);
    expect(isNewer(newer, null)).toBe(true);
  });
});
