import { CanActivate, ExecutionContext, INestApplication, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { BudgetedFakeEtradeHost, FakeEtradeHost } from "../test/fakes";
import { MockEtrade, twoLicenceCompany } from "../test/mock-etrade";
import { EtradeClient } from "./etrade.client";
import { ETRADE_HOST } from "./etrade.host";
import { EtradeModule } from "./etrade.module";
import { ETRADE_OPTIONS, ResolvedEtradeOptions } from "./etrade.options";
import { EtradeService } from "./etrade.service";

/** Stands in for your auth guard: a request is signed in when it carries x-test-user. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: { id: string } }>();
    const user = req.headers["x-test-user"];
    if (!user) return false;
    req.user = { id: user };
    return true;
  }
}

const TIN = "0000000001";

describe("EtradeModule", () => {
  const etrade = new MockEtrade();
  let app: INestApplication | undefined;
  beforeAll(() => etrade.start());
  afterAll(() => etrade.stop());
  beforeEach(() => {
    etrade.reset();
    etrade.addCompany(twoLicenceCompany(TIN));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const options = () => ({ baseUrl: etrade.baseUrl, retryDelayMs: 0, httpTimeoutMs: 500 });

  async function start(imports: unknown[]): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: imports as never[] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix("api");
    await app.init();
    return app;
  }

  it("gives the client and the service without a host, and mounts no route by default", async () => {
    const nest = await start([EtradeModule.forRoot({ options: options() })]);
    expect(nest.get(EtradeClient)).toBeInstanceOf(EtradeClient);
    await expect(nest.get(EtradeService).lookup({ tin: TIN, actor: "u" })).resolves.toMatchObject({ found: true });
    await request(nest.getHttpServer()).post("/api/etrade/lookup").send({ tin: TIN }).expect(404);
    expect(() => nest.get(ETRADE_HOST)).toThrow();
  });

  it("refuses a lookup route without a guard", () => {
    expect(() => EtradeModule.forRoot({ options: options(), lookupRoute: "etrade/lookup" })).toThrow(/needs lookupGuard/);
    expect(() => EtradeModule.forRoot({ options: options(), lookupRoute: " ", lookupGuard: TestAuthGuard })).toThrow(/must be a path/);
  });

  describe("with a guarded lookup route", () => {
    async function withRoute(host = BudgetedFakeEtradeHost) {
      const nest = await start([
        EtradeModule.forRoot({ options: options(), host, lookupRoute: "etrade/lookup", lookupGuard: TestAuthGuard }),
      ]);
      return { http: () => request(nest.getHttpServer()), host: nest.get(ETRADE_HOST) as BudgetedFakeEtradeHost };
    }

    it("refuses a caller the guard does not let through, and sends nothing", async () => {
      const { http } = await withRoute();
      await http().post("/api/etrade/lookup").send({ tin: TIN }).expect(403);
      expect(etrade.calls).toHaveLength(0);
    });

    it("answers a signed-in caller, charged to them", async () => {
      const { http, host } = await withRoute();
      const res = await http()
        .post("/api/etrade/lookup")
        .set("x-test-user", "user-7")
        .send({ tin: TIN, licenceNumber: "XX/AA/14/670/0000002/2007", nameSource: "businessName" })
        .expect(200);
      expect(res.body).toMatchObject({
        found: true,
        selectedLicence: "XX/AA/14/670/0000002/2007",
        data: { companyName: "TEST LOGISTICS AND TRADING P L C" },
      });
      expect(JSON.stringify(res.body)).not.toContain("BASE64-PHOTO");
      expect(host.charges).toEqual([{ actor: "user-7", tin: TIN }]);
    });

    it("answers 400 for a bad TIN, 429 when the budget is spent, 503 when e-trade fails, with no internals", async () => {
      const { http, host } = await withRoute();
      const bad = await http().post("/api/etrade/lookup").set("x-test-user", "u").send({ tin: "12" }).expect(400);
      expect(bad.body.message).toBe("TIN must be exactly 10 digits");

      host.allow = false;
      const spent = await http().post("/api/etrade/lookup").set("x-test-user", "u").send({ tin: TIN }).expect(429);
      expect(spent.body.message).toMatch(/enter your details by hand/);

      host.allow = true;
      etrade.behaviour.failNext = { status: 503, count: 10 };
      const down = await http().post("/api/etrade/lookup").set("x-test-user", "u").send({ tin: TIN }).expect(503);
      expect(down.body.message).toBe("The business registry did not answer. Try again, or enter your details by hand.");
      expect(Object.keys(down.body).sort()).toEqual(["error", "message", "statusCode"]);
      expect(JSON.stringify(down.body)).not.toMatch(/127\.0\.0\.1|HTTP 503|GetRegistration/);
    });

    it("answers 401 when the guard passes but no actor can be read", async () => {
      const nest = await start([
        EtradeModule.forRoot({
          options: options(),
          lookupRoute: "etrade/lookup",
          lookupGuard: TestAuthGuard,
          actorFrom: () => undefined,
        }),
      ]);
      await request(nest.getHttpServer()).post("/api/etrade/lookup").set("x-test-user", "u").send({ tin: TIN }).expect(401);
    });
  });

  it("builds the options with forRootAsync and exports the host", async () => {
    const nest = await start([
      EtradeModule.forRootAsync({
        useFactory: async () => ({ ...options(), cacheTtlMs: 0, licenceProblems: "flag" as const }),
        host: FakeEtradeHost,
      }),
    ]);
    const resolved = nest.get<ResolvedEtradeOptions>(ETRADE_OPTIONS);
    expect(resolved).toMatchObject({ cacheTtlMs: 0, licenceProblems: "flag", referer: "https://etrade.gov.et/business-license-checker" });
    const host = nest.get(ETRADE_HOST) as FakeEtradeHost;
    host.add({ id: "p1", tin: TIN });
    await expect(nest.get(EtradeService).attach({ holderId: "p1", licenceNumber: "XX/AA/14/670/0000002/2007" })).resolves.toMatchObject({
      outcome: "ATTACHED",
    });
  });
});
