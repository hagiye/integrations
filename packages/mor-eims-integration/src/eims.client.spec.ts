import { createServer } from "node:net";
import { optionsFor } from "../test/fakes";
import { testPair } from "../test/fixtures";
import { MockMor, mockConfig } from "../test/mock-mor";
import { EimsClient, EimsCredentialService, EimsError, EimsExchangeRecord, resolveEimsOptions } from "./index";

describe("EimsClient against the mock gateway", () => {
  const pair = testPair("client");
  let mock: MockMor;
  let exchanges: EimsExchangeRecord[];

  const make = (overrides = {}) => {
    const options = resolveEimsOptions(optionsFor(mock.url, pair, overrides));
    const keys = new EimsCredentialService(options);
    const client = new EimsClient(options, keys, (r) => {
      exchanges.push(r);
    });
    keys.attachClient(client);
    return client;
  };

  beforeAll(async () => {
    mock = new MockMor(mockConfig(pair.fingerprint256));
    await mock.start();
  });
  afterAll(() => mock.stop());
  beforeEach(() => {
    mock.reset();
    exchanges = [];
  });

  it("logs in with the signed envelope and reads the source system from the token", async () => {
    const client = make();
    const session = await client.session();
    expect(session).toEqual({ systemNumber: "TESTSYS001", systemType: "POS" });
    const login = mock.calls.find((c) => c.path === "/auth/login")!;
    expect(login.request).toEqual({ clientId: "client-test", clientSecret: "secret-test", apikey: "apikey-test", tin: "0099990001" });
    await client.session();
    expect(mock.countCalls("/auth/login")).toBe(1);
  });

  it("shares one login between concurrent callers", async () => {
    const client = make();
    await Promise.all([client.session(), client.session(), client.session()]);
    expect(mock.countCalls("/auth/login")).toBe(1);
  });

  it("names the login error codes", async () => {
    await expect(make({ apiKey: "wrong" }).session()).rejects.toThrow(/4408.*API key/);
    await expect(make({ clientSecret: "wrong" }).session()).rejects.toThrow(/4410/);
    await expect(make({ tin: "0099990002" }).session()).rejects.toThrow(/4400/);
  });

  it("refuses a token whose system number disagrees with the expected one", async () => {
    await expect(make({ expectedSystemNumber: "OTHER" }).session()).rejects.toMatchObject({ kind: "CONFIG", details: { code: "SYSTEM_MISMATCH" } });
  });

  it("re-logs in once on a 401 and retries", async () => {
    const client = make();
    await client.session();
    mock.expireTokens();
    mock.documents.set("test-x", { irn: "test-x", request: { DocumentDetails: { Type: "INV", Date: "x" } }, documentNumber: "7", counter: 7, cancelled: false, cancellationDate: null });
    const response = await client.verify("test-x");
    expect(response.body?.Irn).toBe("test-x");
    expect(mock.countCalls("/auth/login")).toBe(2);
    expect(mock.countCalls("/v1/verify")).toBe(2);
  });

  it("classifies refusals, ambiguity and unreachable MoR", async () => {
    const client = make();
    await expect(client.verify("test-missing")).rejects.toMatchObject({ kind: "UNKNOWN", details: { httpStatus: 404 } });
    mock.failNext("/v1/verify", "429");
    await expect(client.verify("x")).rejects.toMatchObject({ kind: "RATE_LIMITED", details: { sent: true } });
    mock.failNext("/v1/verify", "500");
    await expect(client.verify("x")).rejects.toMatchObject({ kind: "SERVER" });
    mock.failNext("/v1/verify", "timeout");
    await expect(client.verify("x")).rejects.toMatchObject({ kind: "TIMEOUT", details: { sent: true } });

    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const offline = make({ baseUrl: `http://127.0.0.1:${port}` });
    const err = await offline.session().catch((e) => e as EimsError);
    expect(err).toMatchObject({ kind: "NETWORK", details: { sent: false, code: "ECONNREFUSED" } });
  });

  it("reads a 2xx that wraps an error status as that refusal", async () => {
    const client = make();
    mock.failNext("/v1/verify", "wrapped-406");
    const err = await client.verify("x").catch((e) => e as EimsError);
    expect(err).toMatchObject({ kind: "RULE_VALIDATION", details: { httpStatus: 406, rules: ["7004"] } });
  });

  it("refuses insecureTls for mor.gov.et", () => {
    expect(() => make({ baseUrl: "https://core.mor.gov.et", insecureTls: true })).toThrow(/refused for mor.gov.et/);
  });

  it("hands every exchange to the log with credentials and the token masked", async () => {
    const client = make();
    await client.session();
    await client.verify("nope").catch(() => undefined);
    const text = JSON.stringify(exchanges);
    expect(exchanges.map((e) => e.operation)).toEqual(["LOGIN", "VERIFY"]);
    expect(text).not.toContain("secret-test");
    expect(text).not.toContain("apikey-test");
    expect(text).not.toMatch(/"accessToken":"ey/);
    expect(exchanges[1].requestHeaders).toMatchObject({ authorization: "Bearer [REDACTED]", apikey: "[REDACTED]" });
    expect(exchanges[0].requestBody).toMatchObject({ request: { clientId: "client-test", clientSecret: "[REDACTED]" }, certificate: { __certificate: true } });
    expect(exchanges[1]).toMatchObject({ isSuccess: false, statusCode: 404, failureKind: "UNKNOWN" });
  });
});
