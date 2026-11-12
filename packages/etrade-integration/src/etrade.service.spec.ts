import { BudgetedFakeEtradeHost, FakeEtradeHost } from "../test/fakes";
import { MockEtrade, twoLicenceCompany } from "../test/mock-etrade";
import { EtradeClient } from "./etrade.client";
import { EtradeError } from "./etrade.errors";
import type { EtradeHost } from "./etrade.host";
import { EtradeModuleOptions, resolveEtradeOptions } from "./etrade.options";
import { EtradeService } from "./etrade.service";
import type { EtradeLicenceSnapshot } from "./etrade.types";

const TIN = "0000000001";
const FORWARDING = "XX/AA/14/670/0000002/2007";
const MINERALS = "XX/AA/14/670/0000001/2017";

describe("EtradeService", () => {
  const etrade = new MockEtrade();
  beforeAll(() => etrade.start());
  afterAll(() => etrade.stop());
  beforeEach(() => {
    etrade.reset();
    etrade.addCompany(twoLicenceCompany(TIN));
  });

  function build(host?: EtradeHost, over: Partial<EtradeModuleOptions> = {}) {
    const options = resolveEtradeOptions({ baseUrl: etrade.baseUrl, retryDelayMs: 0, httpTimeoutMs: 500, circuitFailures: 0, ...over });
    return new EtradeService(new EtradeClient(options), options, host);
  }

  async function failure(promise: Promise<unknown>): Promise<EtradeError> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(EtradeError);
      return err as EtradeError;
    }
    throw new Error("expected an EtradeError");
  }

  describe("lookup", () => {
    it("resolves the first licence when none is chosen (EDR's default)", async () => {
      const result = await build().lookup({ tin: TIN, actor: "user-1" });
      if (!result.found) throw new Error("expected found");
      expect(result).toMatchObject({ selectedLicence: MINERALS, licenceDetail: "RESOLVED", chosenLicenceMissing: false });
      expect(result.businesses).toHaveLength(2);
      expect(result.data).toMatchObject({
        companyName: "Test Minerals Export",
        businessName: "TEST LOGISTICS AND TRADING P L C",
        licenceNumber: MINERALS,
        licenceState: "ACTIVE",
        region: "Addis Ababa",
        managerName: "Abebe Bekele",
        contactPhone: "+251911223344",
      });
    });

    it("resolves the chosen licence and the chosen name", async () => {
      const result = await build().lookup({ tin: TIN, licenceNumber: FORWARDING, nameSource: "businessName", actor: "user-1" });
      if (!result.found) throw new Error("expected found");
      expect(result.data).toMatchObject({ licenceNumber: FORWARDING, companyName: "TEST LOGISTICS AND TRADING P L C" });
    });

    it("does not swap onto another licence when the chosen one is gone", async () => {
      const result = await build().lookup({ tin: TIN, licenceNumber: "GONE/1", actor: "user-1" });
      expect(result).toMatchObject({ found: true, licenceDetail: "NOT_SELECTED", chosenLicenceMissing: true, data: null });
      expect(etrade.count("licence")).toBe(0);
    });

    it("takes the first one instead with onMissingChosenLicence first (EDR's behaviour), and says so", async () => {
      const result = await build(undefined, { onMissingChosenLicence: "first" }).lookup({ tin: TIN, licenceNumber: "GONE/1", actor: "u" });
      expect(result).toMatchObject({ selectedLicence: MINERALS, chosenLicenceMissing: true, licenceDetail: "RESOLVED" });
    });

    it("says found false for a TIN e-trade does not know", async () => {
      await expect(build().lookup({ tin: "0000000009", actor: "u" })).resolves.toEqual({ found: false, tin: "0000000009" });
    });

    it("says NO_LICENCES for a registered TIN with no trade licence (a co-operative)", async () => {
      etrade.addCompany({ tin: "0000000003", businessName: "Farmers Union", licences: [] });
      await expect(build().lookup({ tin: "0000000003", actor: "u" })).resolves.toMatchObject({
        found: true,
        businessName: "Farmers Union",
        licenceDetail: "NO_LICENCES",
        data: null,
      });
    });

    it("still returns the names and the licence list when the detail call fails", async () => {
      etrade.behaviour.hang.add("licence");
      const result = await build(undefined, { httpTimeoutMs: 100, maxRetries: 0 }).lookup({ tin: TIN, actor: "u" });
      expect(result).toMatchObject({
        found: true,
        businessName: "TEST LOGISTICS AND TRADING P L C",
        licenceDetail: "UNAVAILABLE",
        licenceDetailError: "TIMEOUT",
        data: null,
      });
    });

    it("says NOT_FOUND when e-trade lists the licence but has no detail for it", async () => {
      etrade.companies.get(TIN)!.licences[0].noDetail = true;
      await expect(build().lookup({ tin: TIN, actor: "u" })).resolves.toMatchObject({ licenceDetail: "NOT_FOUND", selectedLicence: MINERALS });
    });

    it("throws when the registration call itself fails", async () => {
      etrade.behaviour.failNext = { status: 503, count: 5 };
      expect((await failure(build().lookup({ tin: TIN, actor: "u" }))).kind).toBe("HTTP");
    });

    it("refuses a bad TIN before charging or sending anything", async () => {
      const host = new BudgetedFakeEtradeHost();
      expect((await failure(build(host).lookup({ tin: "12345", actor: "u" }))).kind).toBe("INVALID");
      expect(host.charges).toHaveLength(0);
      expect(etrade.calls).toHaveLength(0);
    });
  });

  describe("the TIN lookup budget", () => {
    it("counts different TINs per actor in process memory by default (10 per day), repeats free", async () => {
      const service = build();
      for (let i = 0; i < 10; i++) await service.lookup({ tin: `00000001${String(i).padStart(2, "0")}`, actor: "user-1" });
      await service.lookup({ tin: "0000000100", actor: "user-1" });
      const err = await failure(service.lookup({ tin: "0000000999", actor: "user-1" }));
      expect(err.kind).toBe("BUDGET");
      await expect(service.lookup({ tin: "0000000999", actor: "user-2" })).resolves.toBeDefined();
    });

    it("charges before the call, so a TIN e-trade does not know still counts", async () => {
      const service = build(undefined, { lookupBudget: { limit: 1, windowMs: 60_000 } });
      await service.lookup({ tin: "0000000009", actor: "u" });
      expect((await failure(service.lookup({ tin: TIN, actor: "u" }))).kind).toBe("BUDGET");
      expect(etrade.count("registration")).toBe(1);
    });

    it("needs an actor while a budget applies", async () => {
      expect((await failure(build().lookup({ tin: TIN }))).details.code).toBe("ACTOR_REQUIRED");
      await expect(build(undefined, { lookupBudget: false }).lookup({ tin: TIN })).resolves.toMatchObject({ found: true });
    });

    it("uses the host's shared budget when it has one, and sends nothing when it says no", async () => {
      const host = new BudgetedFakeEtradeHost();
      await build(host).lookup({ tin: TIN, actor: "user-1" });
      expect(host.charges).toEqual([{ actor: "user-1", tin: TIN }]);
      host.allow = false;
      expect((await failure(build(host).lookup({ tin: TIN, actor: "user-1" }))).kind).toBe("BUDGET");
      expect(etrade.count("registration")).toBe(1);
    });
  });

  describe("cache and lookup log", () => {
    it("serves a repeat lookup from the host's cache, and logs it as cached", async () => {
      const host = new FakeEtradeHost();
      const service = build(host);
      await service.lookup({ tin: TIN, actor: "u" });
      await service.lookup({ tin: TIN, licenceNumber: MINERALS, actor: "u" });
      expect(etrade.count("registration")).toBe(1);
      expect(etrade.count("licence")).toBe(1);
      expect(host.records.map((r) => [r.call, r.outcome, r.cached])).toEqual([
        ["REGISTRATION", "FOUND", false],
        ["LICENCE", "FOUND", false],
        ["REGISTRATION", "FOUND", true],
        ["LICENCE", "FOUND", true],
      ]);
      expect([...host.cache.values()].every((entry) => entry.ttlMs === 600_000)).toBe(true);
    });

    it("asks afresh with fresh, and caches nothing when cacheTtlMs is 0", async () => {
      const host = new FakeEtradeHost();
      await build(host).lookup({ tin: TIN, actor: "u" });
      await build(host).lookup({ tin: TIN, actor: "u", fresh: true });
      expect(etrade.count("registration")).toBe(2);
      const noCache = new FakeEtradeHost();
      await build(noCache, { cacheTtlMs: 0 }).lookup({ tin: TIN, actor: "u" });
      expect(noCache.cache.size).toBe(0);
    });

    it("never caches a not-found answer", async () => {
      const host = new FakeEtradeHost();
      await build(host).lookup({ tin: "0000000009", actor: "u" });
      expect(host.cache.size).toBe(0);
    });

    it("logs failures with their kind and status, and never the body", async () => {
      const host = new FakeEtradeHost();
      etrade.behaviour.failNext = { status: 503, count: 5 };
      await failure(build(host).lookup({ tin: TIN, actor: "u" }));
      expect(host.records).toEqual([
        expect.objectContaining({ call: "REGISTRATION", tin: TIN, outcome: "HTTP", httpStatus: 503, cached: false, actor: "u" }),
      ]);
    });

    it("keeps going when the lookup log fails", async () => {
      const host = new FakeEtradeHost();
      host.failRecord = true;
      await expect(build(host).lookup({ tin: TIN, actor: "u" })).resolves.toMatchObject({ found: true });
    });
  });

  describe("attach", () => {
    function hostWith(holder: Partial<{ tin: string; manualRegistration: boolean; snapshot: EtradeLicenceSnapshot | null }> = {}) {
      const host = new FakeEtradeHost();
      host.add({ id: "profile-1", tin: TIN, ...holder });
      return host;
    }

    it("stores e-trade's own record for the chosen licence under the holder's TIN", async () => {
      const host = hostWith();
      const result = await build(host).attach({ holderId: "profile-1", licenceNumber: FORWARDING, actor: "user-1" });
      expect(result.outcome).toBe("ATTACHED");
      expect(host.holders.get("profile-1")?.snapshot).toMatchObject({
        licenceNumber: FORWARDING,
        tradeName: "Test Freight Forwarding",
        activity: "Freight Forwarders",
        tin: TIN,
        state: "ACTIVE",
        needsReview: false,
        source: "etrade:registration+licence",
        checkedBy: "user-1",
      });
      expect(etrade.calls.map((c) => c.query.Tin ?? c.path)).toEqual([
        `/api/Registration/GetRegistrationInfoByTin/${TIN}/en`,
        TIN,
      ]);
    });

    it("refuses a licence e-trade does not list under the holder's TIN", async () => {
      etrade.addCompany({ tin: "0000000002", businessName: "Other", licences: [{ licenceNumber: "OTHER/1" }] });
      const host = hostWith();
      await expect(build(host).attach({ holderId: "profile-1", licenceNumber: "OTHER/1" })).resolves.toEqual({
        outcome: "REFUSED",
        reason: "LICENCE_NOT_LISTED",
      });
      expect(host.saved).toHaveLength(0);
    });

    it("refuses an unknown holder, a manual registration and a placeholder TIN without calling e-trade", async () => {
      const host = new FakeEtradeHost();
      host.add({ id: "coop", tin: TIN, manualRegistration: true });
      host.add({ id: "draft", tin: "D123456789" });
      const service = build(host);
      await expect(service.attach({ holderId: "nobody", licenceNumber: FORWARDING })).resolves.toMatchObject({ reason: "UNKNOWN_HOLDER" });
      await expect(service.attach({ holderId: "coop", licenceNumber: FORWARDING })).resolves.toMatchObject({ reason: "MANUAL_REGISTRATION" });
      await expect(service.attach({ holderId: "draft", licenceNumber: FORWARDING })).resolves.toMatchObject({ reason: "HOLDER_TIN_INVALID" });
      expect(etrade.calls).toHaveLength(0);
    });

    it("refuses when the client believes it is attaching under another TIN", async () => {
      await expect(
        build(hostWith()).attach({ holderId: "profile-1", licenceNumber: FORWARDING, expectedTin: "0000000002" }),
      ).resolves.toMatchObject({ outcome: "REFUSED", reason: "TIN_MISMATCH" });
      expect(etrade.calls).toHaveLength(0);
    });

    it("refuses when e-trade no longer knows the holder's TIN", async () => {
      etrade.companies.clear();
      await expect(build(hostWith()).attach({ holderId: "profile-1", licenceNumber: FORWARDING })).resolves.toMatchObject({
        reason: "NOT_REGISTERED",
      });
    });

    it.each([
      [{ renewedTo: "7/7/2020" }, "LICENCE_EXPIRED", "EXPIRED"],
      [{ cancellationDate: "1/1/2026" }, "LICENCE_CANCELLED", "CANCELLED"],
      [{ statusDescription: "Suspended" }, "LICENCE_SUSPENDED", "SUSPENDED"],
      [{ statusDescription: "Pending" }, "LICENCE_STATUS_UNKNOWN", "UNKNOWN"],
      [{ noDetail: true }, "LICENCE_DETAIL_NOT_FOUND", "UNKNOWN"],
    ])("refuses %j by default (%s) and stores nothing", async (licence, reason, state) => {
      Object.assign(etrade.companies.get(TIN)!.licences[1], licence);
      const host = hostWith();
      const result = await build(host).attach({ holderId: "profile-1", licenceNumber: FORWARDING });
      expect(result).toMatchObject({ outcome: "REFUSED", reason, snapshot: { state, needsReview: true } });
      expect(host.saved).toHaveLength(0);
    });

    it("stores a licence with problems flagged for review when licenceProblems is flag", async () => {
      Object.assign(etrade.companies.get(TIN)!.licences[1], { renewedTo: "7/7/2020" });
      const host = hostWith();
      const result = await build(host, { licenceProblems: "flag" }).attach({ holderId: "profile-1", licenceNumber: FORWARDING });
      expect(result).toMatchObject({ outcome: "FLAGGED", problems: ["LICENCE_EXPIRED"] });
      expect(host.holders.get("profile-1")?.snapshot).toMatchObject({ state: "EXPIRED", needsReview: true });
    });

    it("never reads the cache: a stale cached licence cannot be attached", async () => {
      const host = hostWith();
      host.cache.set(`etrade:registration:en:${TIN}`, {
        value: { tin: TIN, businessName: "x", businesses: [{ licenceNumber: "CACHED/ONLY", tradeName: "", activity: "", renewedTo: "" }] },
        ttlMs: 1,
      });
      await expect(build(host).attach({ holderId: "profile-1", licenceNumber: "CACHED/ONLY" })).resolves.toMatchObject({
        reason: "LICENCE_NOT_LISTED",
      });
    });

    it("stores nothing when e-trade is down", async () => {
      const host = hostWith();
      etrade.behaviour.failNext = { status: 500, count: 10 };
      expect((await failure(build(host).attach({ holderId: "profile-1", licenceNumber: FORWARDING }))).kind).toBe("HTTP");
      expect(host.saved).toHaveLength(0);
    });

    it("reports a TIN changed during the attach, and a newer snapshot already stored", async () => {
      const host = hostWith();
      host.changeTinOnSave = "0000000002";
      await expect(build(host).attach({ holderId: "profile-1", licenceNumber: FORWARDING })).resolves.toMatchObject({ reason: "TIN_CHANGED" });

      const later = hostWith({
        snapshot: { checkedAt: "2999-01-01T00:00:00.000Z", licenceNumber: MINERALS } as EtradeLicenceSnapshot,
      });
      await expect(build(later).attach({ holderId: "profile-1", licenceNumber: FORWARDING })).resolves.toMatchObject({ reason: "STALE" });
    });

    it("refuses a bad licence number, and needs a host", async () => {
      expect((await failure(build(hostWith()).attach({ holderId: "profile-1", licenceNumber: "" }))).kind).toBe("INVALID");
      expect((await failure(build().attach({ holderId: "profile-1", licenceNumber: FORWARDING }))).kind).toBe("CONFIG");
    });

    it("lists the licences a holder can attach, empty for a manual registration", async () => {
      const host = hostWith();
      host.add({ id: "coop", tin: TIN, manualRegistration: true });
      const service = build(host);
      await expect(service.licencesFor("profile-1")).resolves.toHaveLength(2);
      await expect(service.licencesFor("coop")).resolves.toEqual([]);
      expect((await failure(service.licencesFor("nobody"))).kind).toBe("INVALID");
    });
  });

  describe("recheck", () => {
    async function attached(over: Partial<EtradeModuleOptions> = {}) {
      const host = new FakeEtradeHost();
      host.add({ id: "profile-1", tin: TIN });
      const service = build(host, over);
      await service.attach({ holderId: "profile-1", licenceNumber: FORWARDING });
      etrade.calls.length = 0;
      return { host, service };
    }

    it("stores a new check time even when nothing changed", async () => {
      const { host, service } = await attached();
      const first = host.holders.get("profile-1")!.snapshot!;
      await new Promise((r) => setTimeout(r, 5));
      const result = await service.recheck("profile-1");
      expect(result).toMatchObject({ outcome: "UNCHANGED", changes: [] });
      expect(host.holders.get("profile-1")!.snapshot!.checkedAt > first.checkedAt).toBe(true);
      expect(host.holders.get("profile-1")!.snapshot!.checkedBy).toBe("recheck");
    });

    it("picks up a renamed licence and a new expiry", async () => {
      const { host, service } = await attached();
      Object.assign(etrade.companies.get(TIN)!.licences[1], { tradeName: "Renamed Forwarding", listTradeName: "Renamed", renewedTo: "7/7/2100" });
      const result = await service.recheck("profile-1");
      expect(result).toMatchObject({ outcome: "UPDATED", changes: ["tradeName", "renewedTo", "validUntil"] });
      expect(host.holders.get("profile-1")!.snapshot).toMatchObject({ tradeName: "Renamed Forwarding", validUntil: "2100-07-07" });
    });

    it("flags a licence e-trade no longer lists, keeping its last known data", async () => {
      const { host, service } = await attached();
      etrade.companies.get(TIN)!.licences.splice(1, 1);
      const result = await service.recheck("profile-1");
      expect(result).toMatchObject({ outcome: "LICENCE_GONE", changes: ["state"] });
      expect(host.holders.get("profile-1")!.snapshot).toMatchObject({
        tradeName: "Test Freight Forwarding",
        state: "NOT_LISTED",
        problems: ["LICENCE_NOT_LISTED"],
      });
    });

    it("stores a licence that went bad, flagged, whatever licenceProblems says", async () => {
      const { host, service } = await attached();
      Object.assign(etrade.companies.get(TIN)!.licences[1], { cancellationDate: "1/1/2026" });
      await expect(service.recheck("profile-1")).resolves.toMatchObject({ outcome: "UPDATED" });
      expect(host.holders.get("profile-1")!.snapshot).toMatchObject({ state: "CANCELLED", needsReview: true });
    });

    it("leaves the snapshot alone when e-trade is down", async () => {
      const { host, service } = await attached();
      const before = host.holders.get("profile-1")!.snapshot;
      etrade.behaviour.failNext = { status: 503, count: 10 };
      expect((await failure(service.recheck("profile-1"))).kind).toBe("HTTP");
      expect(host.holders.get("profile-1")!.snapshot).toBe(before);
    });

    it("skips holders it cannot recheck, without calling e-trade", async () => {
      const host = new FakeEtradeHost();
      host.add({ id: "bare", tin: TIN });
      host.add({ id: "coop", tin: TIN, manualRegistration: true });
      const service = build(host);
      await expect(service.recheck("nobody")).resolves.toEqual({ outcome: "SKIPPED", reason: "UNKNOWN_HOLDER" });
      await expect(service.recheck("bare")).resolves.toEqual({ outcome: "SKIPPED", reason: "NO_SNAPSHOT" });
      await expect(service.recheck("coop")).resolves.toEqual({ outcome: "SKIPPED", reason: "MANUAL_REGISTRATION" });
      expect(etrade.calls).toHaveLength(0);
    });
  });
});
