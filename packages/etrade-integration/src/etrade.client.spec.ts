import { MockEtrade, twoLicenceCompany } from "../test/mock-etrade";
import { makeChainWithoutIntermediate } from "../test/tls-fixtures";
import { EtradeClient } from "./etrade.client";
import { EtradeError } from "./etrade.errors";
import { EtradeModuleOptions, ETRADE_CHECKER_REFERER, resolveEtradeOptions } from "./etrade.options";

const TIN = "0000000001";

describe("EtradeClient against a mock e-trade", () => {
  const etrade = new MockEtrade();
  beforeAll(() => etrade.start());
  afterAll(() => etrade.stop());
  beforeEach(() => {
    etrade.reset();
    etrade.addCompany(twoLicenceCompany(TIN));
  });

  const client = (over: Partial<EtradeModuleOptions> = {}) =>
    new EtradeClient(resolveEtradeOptions({ baseUrl: etrade.baseUrl, retryDelayMs: 0, httpTimeoutMs: 1000, ...over }));

  async function failure(promise: Promise<unknown>): Promise<EtradeError> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(EtradeError);
      return err as EtradeError;
    }
    throw new Error("expected an EtradeError");
  }

  describe("the registration call", () => {
    it("asks GET /Registration/GetRegistrationInfoByTin/{tin}/en with the checker Referer, as EDR does", async () => {
      const result = await client().getRegistrationByTin(TIN);
      expect(etrade.calls).toHaveLength(1);
      expect(etrade.calls[0]).toMatchObject({
        method: "GET",
        path: `/api/Registration/GetRegistrationInfoByTin/${TIN}/en`,
        query: {},
      });
      expect(etrade.calls[0].headers.referer).toBe(ETRADE_CHECKER_REFERER);
      expect(etrade.calls[0].headers.accept).toBe("application/json");
      expect(result).toMatchObject({ found: true, httpStatus: 200, attempts: 1 });
      if (!result.found) throw new Error("unreachable");
      expect(result.registration.businessName).toBe("TEST LOGISTICS AND TRADING P L C");
      expect(result.registration.businesses).toEqual([
        { licenceNumber: "XX/AA/14/670/0000001/2017", tradeName: "Test Minerals Export", activity: "Export trade in minerals", renewedTo: "7/7/2099" },
        { licenceNumber: "XX/AA/14/670/0000002/2007", tradeName: "Test Freight Forwarding", activity: "Freight Forwarders", renewedTo: "7/7/2099" },
      ]);
    });

    it("asks in Amharic when told to", async () => {
      await client({ language: "am" }).getRegistrationByTin(TIN);
      expect(etrade.calls[0].path).toBe(`/api/Registration/GetRegistrationInfoByTin/${TIN}/am`);
    });

    it.each(["404", "empty", "empty-object", "null"] as const)("reads an unknown TIN answered as %s as not found", async (how) => {
      etrade.behaviour.unknownTin = how;
      await expect(client().getRegistrationByTin("0000000009")).resolves.toMatchObject({ found: false });
    });

    it("refuses an answer for another TIN", async () => {
      etrade.behaviour.tinOverride = "0000000002";
      const err = await failure(client().getRegistrationByTin(TIN));
      expect(err).toMatchObject({ kind: "API", details: { code: "TIN_MISMATCH" } });
    });

    it("sends nothing for a TIN that is not 10 digits", async () => {
      for (const tin of ["123", "D123456789", "0000000001/../x", ""]) {
        const err = await failure(client().getRegistrationByTin(tin));
        expect(err.kind).toBe("INVALID");
      }
      expect(etrade.calls).toHaveLength(0);
    });

    it("is a CONFIG error without a baseUrl, and sends nothing", async () => {
      const unconfigured = new EtradeClient(resolveEtradeOptions({ baseUrl: "" }));
      expect(unconfigured.isConfigured()).toBe(false);
      expect((await failure(unconfigured.getRegistrationByTin(TIN))).kind).toBe("CONFIG");
    });
  });

  describe("the licence call", () => {
    it("asks GET /BusinessMain/GetBusinessByLicenseNo with LicenseNo, Tin and Lang", async () => {
      const result = await client().getBusinessByLicence("XX/AA/14/670/0000002/2007", TIN);
      expect(etrade.calls[0]).toMatchObject({
        path: "/api/BusinessMain/GetBusinessByLicenseNo",
        query: { LicenseNo: "XX/AA/14/670/0000002/2007", Tin: TIN, Lang: "en" },
      });
      if (!result.found) throw new Error("expected found");
      expect(result.licence).toMatchObject({
        licenceNumber: "XX/AA/14/670/0000002/2007",
        tradeName: "Test Freight Forwarding",
        statusDescription: "Active",
        validUntil: "2099-07-07",
        address: { region: "Addis Ababa", rawRegion: "ADDIS ABABA" },
      });
      expect(JSON.stringify(result)).not.toContain("BASE64-PHOTO-MUST-NOT-LEAK");
    });

    it("reads a licence e-trade has no detail for as not found", async () => {
      await expect(client().getBusinessByLicence("NOT/LISTED", TIN)).resolves.toMatchObject({ found: false });
    });

    it("refuses a licence held under another TIN, and an answer for another licence", async () => {
      etrade.behaviour.ownerTinOverride = "0000000002";
      expect((await failure(client().getBusinessByLicence("XX/AA/14/670/0000002/2007", TIN))).details.code).toBe("TIN_MISMATCH");
      etrade.behaviour.ownerTinOverride = undefined;
      etrade.behaviour.licenceOverride = "XX/AA/14/670/0000001/2017";
      expect((await failure(client().getBusinessByLicence("XX/AA/14/670/0000002/2007", TIN))).details.code).toBe("LICENCE_MISMATCH");
    });

    it("refuses an empty licence number before sending", async () => {
      expect((await failure(client().getBusinessByLicence("  ", TIN))).kind).toBe("INVALID");
      expect(etrade.calls).toHaveLength(0);
    });
  });

  describe("headers", () => {
    it("is refused with 417 without the checker Referer, as e-trade does", async () => {
      const err = await failure(client({ referer: false }).getRegistrationByTin(TIN));
      expect(err).toMatchObject({ kind: "API", details: { status: 417, code: "REFERER_REJECTED" } });
      expect(etrade.calls[0].headers.referer).toBeUndefined();
    });

    it("sends extra headers, for a credential once the Ministry issues one", async () => {
      etrade.behaviour.requireReferer = false;
      await client({ referer: false, headers: { "X-Api-Key": "issued-by-ministry" } }).getRegistrationByTin(TIN);
      expect(etrade.calls[0].headers["x-api-key"]).toBe("issued-by-ministry");
    });
  });

  describe("failures", () => {
    it("retries a 5xx once, then succeeds", async () => {
      etrade.behaviour.failNext = { status: 503, count: 1 };
      await expect(client().getRegistrationByTin(TIN)).resolves.toMatchObject({ found: true, attempts: 2 });
      expect(etrade.count("registration")).toBe(2);
    });

    it("gives up after the retries with HTTP", async () => {
      etrade.behaviour.failNext = { status: 502, count: 5 };
      const err = await failure(client({ maxRetries: 2 }).getRegistrationByTin(TIN));
      expect(err).toMatchObject({ kind: "HTTP", details: { status: 502 } });
      expect(etrade.count("registration")).toBe(3);
    });

    it("times out, retries, and says TIMEOUT", async () => {
      etrade.behaviour.hang.add("registration");
      const err = await failure(client({ httpTimeoutMs: 150 }).getRegistrationByTin(TIN));
      expect(err).toMatchObject({ kind: "TIMEOUT", details: { attempts: 2 } });
      expect(etrade.count("registration")).toBe(2);
    });

    it("does not retry a 429, and passes Retry-After on", async () => {
      etrade.behaviour.failNext = { status: 429, count: 1, headers: { "retry-after": "30" } };
      const err = await failure(client().getRegistrationByTin(TIN));
      expect(err).toMatchObject({ kind: "HTTP", details: { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 30 } });
      expect(etrade.count("registration")).toBe(1);
    });

    it("does not retry another 4xx", async () => {
      etrade.behaviour.failNext = { status: 400, count: 1 };
      expect((await failure(client().getRegistrationByTin(TIN))).details.status).toBe(400);
      expect(etrade.count("registration")).toBe(1);
    });

    it("says HTTP NOT_JSON for an HTML maintenance page, without the body", async () => {
      etrade.behaviour.notJson = true;
      const err = await failure(client().getRegistrationByTin(TIN));
      expect(err).toMatchObject({ kind: "HTTP", details: { code: "NOT_JSON" } });
      expect(err.message).not.toContain("maintenance");
    });

    it("stops reading after 1 MB", async () => {
      etrade.behaviour.hugeBody = 1024 * 1024 + 10;
      expect((await failure(client().getRegistrationByTin(TIN))).details.code).toBe("TOO_LARGE");
    });

    it("is NETWORK when nothing listens", async () => {
      const closed = new EtradeClient(resolveEtradeOptions({ baseUrl: "http://127.0.0.1:1/api", retryDelayMs: 0, maxRetries: 0 }));
      expect((await failure(closed.getRegistrationByTin(TIN))).kind).toBe("NETWORK");
    });

    it("opens the circuit after repeated failures, then lets calls through again", async () => {
      etrade.behaviour.failNext = { status: 500, count: 100 };
      const c = client({ maxRetries: 0, circuitFailures: 3, circuitOpenMs: 200 });
      for (let i = 0; i < 3; i++) await failure(c.getRegistrationByTin(TIN));
      expect(etrade.count("registration")).toBe(3);
      const open = await failure(c.getRegistrationByTin(TIN));
      expect(open).toMatchObject({ kind: "NETWORK", details: { code: "CIRCUIT_OPEN" } });
      expect(etrade.count("registration")).toBe(3);
      await new Promise((r) => setTimeout(r, 250));
      etrade.behaviour.failNext = null;
      await expect(c.getRegistrationByTin(TIN)).resolves.toMatchObject({ found: true });
    });

    it("does not count a 404 as a failure", async () => {
      const c = client({ maxRetries: 0, circuitFailures: 2 });
      for (let i = 0; i < 4; i++) await c.getRegistrationByTin("0000000009");
      expect(c.isCircuitOpen()).toBe(false);
    });
  });

  describe("TLS settings", () => {
    it("refuses insecureTls for etrade.gov.et and its sub-domains", () => {
      for (const baseUrl of ["https://etrade.gov.et/api", "https://api.etrade.gov.et/v1", "https://ETRADE.GOV.ET./api"]) {
        expect(() => new EtradeClient(resolveEtradeOptions({ baseUrl, insecureTls: true }))).toThrow(/insecureTls is refused/);
      }
    });

    it("allows insecureTls for a local test server", () => {
      expect(() => new EtradeClient(resolveEtradeOptions({ baseUrl: "https://127.0.0.1:8443/api", insecureTls: true }))).not.toThrow();
    });
  });
});

/**
 * e-trade serves its certificate without the CA that issued it. This reproduces that with a
 * throwaway chain: verification fails by default, passes once the missing CA is supplied, and
 * never needs verification turned off.
 */
const chain = makeChainWithoutIntermediate();
(chain ? describe : describe.skip)("TLS with an incomplete chain (needs openssl)", () => {
  const etrade = new MockEtrade(chain ? { key: chain.leafKey, cert: chain.leafPem } : undefined);
  beforeAll(async () => {
    await etrade.start();
    etrade.addCompany(twoLicenceCompany(TIN));
  });
  afterAll(() => etrade.stop());

  const client = (over: Partial<EtradeModuleOptions>) =>
    new EtradeClient(resolveEtradeOptions({ baseUrl: etrade.baseUrl, maxRetries: 0, circuitFailures: 0, ...over }));

  it("fails verification with Node's roots alone, and is not retried", async () => {
    const before = etrade.calls.length;
    await expect(client({}).getRegistrationByTin(TIN)).rejects.toMatchObject({
      kind: "NETWORK",
      message: expect.stringContaining("TLS verification of 127.0.0.1 failed"),
    });
    await expect(client({ maxRetries: 3 }).getRegistrationByTin(TIN)).rejects.toMatchObject({ details: { attempts: 1 } });
    expect(etrade.calls.length).toBe(before);
  });

  it("still fails with only the root: the issuing CA is what is missing", async () => {
    await expect(client({ ca: chain!.rootPem }).getRegistrationByTin(TIN)).rejects.toMatchObject({ kind: "NETWORK" });
  });

  it("verifies once the missing CA is supplied with ca", async () => {
    await expect(client({ ca: [chain!.rootPem, chain!.intermediatePem] }).getRegistrationByTin(TIN)).resolves.toMatchObject({
      found: true,
    });
  });
});
