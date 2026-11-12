import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as crypto from "node:crypto";
import request from "supertest";
import { DataSource } from "typeorm";
import { ExampleAppModule } from "../examples/standalone/app.module";
import { EtradeRechecker } from "../examples/standalone/companies.service";
import { CreateExampleCompanies1790000000300 } from "../examples/standalone/create-companies.migration";
import { MockEtrade, twoLicenceCompany } from "./mock-etrade";

/**
 * The standalone example against a real Postgres and the mock e-trade, over HTTP: migrations,
 * the guarded lookup with its log and cache, the TIN budget shared by two instances, attach and
 * its refusals, e-trade down or slow, attaches racing, and recheck.
 *
 * Needs a throwaway database: ETRADE_TEST_DATABASE_URL=postgres://user:pass@host:5432/db.
 * Everything lives in its own schema, dropped and re-created on each run.
 */
const DATABASE_URL = process.env.ETRADE_TEST_DATABASE_URL;
const SCHEMA = "etrade_pg_spec";
const HASH_KEY = "pg-spec-tin-hash-key";
const FORWARDING = "XX/AA/14/670/0000002/2007";
const MINERALS = "XX/AA/14/670/0000001/2017";

describe("e-trade on Postgres (standalone example)", () => {
  const etrade = new MockEtrade();
  let admin: DataSource;
  /** Two instances of the same app on one database, as behind a load balancer. */
  let appA: INestApplication;
  let appB: INestApplication;
  let tinCounter = 0;

  /** A fresh fictitious TIN per company: the companies table holds each TIN once. */
  const nextTin = () => `77${String(++tinCounter).padStart(8, "0")}`;
  const hash = (tin: string) => crypto.createHmac("sha256", HASH_KEY).update(tin).digest("hex");

  async function startApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ExampleAppModule.forRoot({
          databaseUrl: DATABASE_URL!,
          schema: SCHEMA,
          tinHashKey: HASH_KEY,
          budget: { limit: 3, windowMs: 60 * 60 * 1000 },
          etrade: { baseUrl: etrade.baseUrl, retryDelayMs: 0, maxRetries: 0, httpTimeoutMs: 400, circuitFailures: 0 },
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix("api");
    await app.init();
    return app;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error("Set ETRADE_TEST_DATABASE_URL to a throwaway Postgres database");
    await etrade.start();
    admin = new DataSource({ type: "postgres", url: DATABASE_URL });
    await admin.initialize();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    appA = await startApp();
    appB = await startApp();
  });

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.destroy();
    }
    await etrade.stop();
  });

  beforeEach(() => etrade.reset());

  const a = () => request(appA.getHttpServer());
  const b = () => request(appB.getHttpServer());
  const rows = <T>(sql: string, params: unknown[] = []): Promise<T[]> => admin.query(sql, params);

  /** A company known to e-trade (two licences) with two profiles, created over the API. */
  async function company(over: { manualRegistration?: boolean } = {}): Promise<{ tin: string; profiles: string[] }> {
    const tin = nextTin();
    etrade.addCompany(twoLicenceCompany(tin));
    const res = await a()
      .post("/api/companies")
      .send({ tin, name: "Test", profiles: ["exporter", "importer"], ...over })
      .expect(201);
    return { tin, profiles: res.body.profiles.map((p: { id: string }) => p.id) };
  }

  const storedLicence = async (profileId: string) => {
    const [row] = await rows<{ etrade_licence: Record<string, unknown> | null; etrade_checked_at: Date | null }>(
      `SELECT etrade_licence, etrade_checked_at FROM "${SCHEMA}".company_profiles WHERE id = $1`,
      [profileId],
    );
    return row;
  };

  const attach = (profileId: string, licenceNumber: string, extra: Record<string, unknown> = {}) =>
    a().patch(`/api/profiles/${profileId}/etrade-licence`).set("x-user-id", "user-1").send({ licenceNumber, ...extra });

  it("creates its tables in the configured schema only, and re-running the migration changes nothing", async () => {
    const tables = await rows<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_name IN ('companies', 'company_profiles', 'etrade_lookups', 'etrade_tin_budget') ORDER BY table_name`,
    );
    expect(tables).toEqual([
      { table_schema: SCHEMA, table_name: "companies" },
      { table_schema: SCHEMA, table_name: "company_profiles" },
      { table_schema: SCHEMA, table_name: "etrade_lookups" },
      { table_schema: SCHEMA, table_name: "etrade_tin_budget" },
    ]);
    const runner = appA.get(DataSource).createQueryRunner();
    try {
      await new CreateExampleCompanies1790000000300().up(runner);
    } finally {
      await runner.release();
    }
    await expect(appA.get(DataSource).runMigrations()).resolves.toEqual([]);
  });

  describe("the guarded lookup", () => {
    it("refuses a caller who is not signed in, and sends nothing", async () => {
      await a().post("/api/etrade/lookup").send({ tin: "7700000000" }).expect(403);
      expect(etrade.calls).toHaveLength(0);
    });

    it("answers, logs each call with a keyed TIN hash, and serves the repeat from the cache", async () => {
      const tin = nextTin();
      etrade.addCompany(twoLicenceCompany(tin));
      const first = await a().post("/api/etrade/lookup").set("x-user-id", "user-a").send({ tin }).expect(200);
      expect(first.body).toMatchObject({ found: true, selectedLicence: MINERALS, licenceDetail: "RESOLVED" });
      const second = await a()
        .post("/api/etrade/lookup")
        .set("x-user-id", "user-a")
        .send({ tin, licenceNumber: FORWARDING })
        .expect(200);
      expect(second.body.data).toMatchObject({ licenceNumber: FORWARDING, companyName: "Test Freight Forwarding" });
      expect(etrade.count("registration")).toBe(1);
      expect(etrade.count("licence")).toBe(2);

      const log = await rows<Record<string, unknown>>(
        `SELECT call, tin_hash, licence_number, outcome, cached, actor FROM "${SCHEMA}".etrade_lookups WHERE tin_hash = $1 ORDER BY id`,
        [hash(tin)],
      );
      expect(log.map((r) => [r.call, r.outcome, r.cached])).toEqual([
        ["REGISTRATION", "FOUND", false],
        ["LICENCE", "FOUND", false],
        ["REGISTRATION", "FOUND", true],
        ["LICENCE", "FOUND", false],
      ]);
      expect(JSON.stringify(log)).not.toContain(tin);
      expect(log.every((r) => r.actor === "user-a")).toBe(true);
    });

    it("still answers with the licence list when e-trade's licence call hangs", async () => {
      const tin = nextTin();
      etrade.addCompany(twoLicenceCompany(tin));
      etrade.behaviour.hang.add("licence");
      const res = await a().post("/api/etrade/lookup").set("x-user-id", "user-slow").send({ tin }).expect(200);
      expect(res.body).toMatchObject({ found: true, licenceDetail: "UNAVAILABLE", licenceDetailError: "TIMEOUT", data: null });
      expect(res.body.businesses).toHaveLength(2);
      const [logged] = await rows<{ outcome: string }>(
        `SELECT outcome FROM "${SCHEMA}".etrade_lookups WHERE tin_hash = $1 AND call = 'LICENCE'`,
        [hash(tin)],
      );
      expect(logged.outcome).toBe("TIMEOUT");
    });
  });

  describe("the TIN budget in Postgres", () => {
    it("is shared by both instances: three different TINs, then 429 on the other instance, repeats free", async () => {
      const tins = [nextTin(), nextTin(), nextTin(), nextTin()];
      for (const tin of tins.slice(0, 3)) {
        await a().post("/api/etrade/lookup").set("x-user-id", "user-b").send({ tin }).expect(200);
      }
      const refused = await b().post("/api/etrade/lookup").set("x-user-id", "user-b").send({ tin: tins[3] }).expect(429);
      expect(refused.body.message).toMatch(/enter your details by hand/);
      await b().post("/api/etrade/lookup").set("x-user-id", "user-b").send({ tin: tins[0] }).expect(200);
      await b().post("/api/etrade/lookup").set("x-user-id", "user-c").send({ tin: tins[3] }).expect(200);
      // The refused TIN never reached e-trade.
      expect(etrade.calls.filter((c) => c.path.includes(tins[3]))).toHaveLength(1);
      const stored = await rows<{ tin_hash: string }>(`SELECT tin_hash FROM "${SCHEMA}".etrade_tin_budget WHERE actor = 'user-b'`);
      expect(stored).toHaveLength(3);
      expect(JSON.stringify(stored)).not.toContain(tins[0]);
    });

    it("lets no more than the limit through when six different TINs race across both instances", async () => {
      const tins = Array.from({ length: 6 }, () => nextTin());
      const results = await Promise.all(
        tins.map((tin, i) => (i % 2 ? b() : a()).post("/api/etrade/lookup").set("x-user-id", "racer").send({ tin })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429, 429]);
      const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "${SCHEMA}".etrade_tin_budget WHERE actor = 'racer'`);
      expect(n).toBe(3);
    });
  });

  describe("attach", () => {
    it("stores e-trade's own record, whatever else the client sends, and one licence may back two profiles", async () => {
      const { tin, profiles } = await company();
      const res = await attach(profiles[0], FORWARDING, { tradeName: "Hacked", state: "ACTIVE", tin: "0000000000" }).expect(200);
      expect(res.body).toMatchObject({ outcome: "ATTACHED" });
      const row = await storedLicence(profiles[0]);
      expect(row.etrade_licence).toMatchObject({
        licenceNumber: FORWARDING,
        tradeName: "Test Freight Forwarding",
        activity: "Freight Forwarders",
        tin,
        state: "ACTIVE",
        needsReview: false,
        checkedBy: "user-1",
        source: "etrade:registration+licence",
      });
      expect(row.etrade_checked_at).toBeInstanceOf(Date);
      await attach(profiles[1], FORWARDING).expect(200);
      expect((await storedLicence(profiles[1])).etrade_licence).toMatchObject({ licenceNumber: FORWARDING });
      await a().get(`/api/profiles/${profiles[0]}`).expect(200).expect((r) => expect(r.body.etradeLicence.licenceNumber).toBe(FORWARDING));
    });

    it("refuses another company's licence, an expired one, a manual registration and an unknown profile, storing nothing", async () => {
      const { profiles } = await company();
      const other = nextTin();
      etrade.addCompany({ tin: other, businessName: "Someone Else", licences: [{ licenceNumber: "XX/AA/OTHER/1" }] });
      expect((await attach(profiles[0], "XX/AA/OTHER/1").expect(422)).body).toMatchObject({ reason: "LICENCE_NOT_LISTED" });

      const { tin: expiredTin, profiles: expiredProfiles } = await company();
      etrade.companies.get(expiredTin)!.licences[1].renewedTo = "7/7/2020";
      const expired = await attach(expiredProfiles[0], FORWARDING).expect(422);
      expect(expired.body).toMatchObject({ outcome: "REFUSED", reason: "LICENCE_EXPIRED", snapshot: { state: "EXPIRED" } });

      const coop = await company({ manualRegistration: true });
      const callsBefore = etrade.calls.length;
      expect((await attach(coop.profiles[0], FORWARDING).expect(422)).body).toMatchObject({ reason: "MANUAL_REGISTRATION" });
      expect(etrade.calls.length).toBe(callsBefore);

      expect((await attach("00000000-0000-4000-8000-000000000000", FORWARDING).expect(422)).body).toMatchObject({
        reason: "UNKNOWN_HOLDER",
      });
      await a().patch(`/api/profiles/${profiles[0]}/etrade-licence`).send({ licenceNumber: FORWARDING }).expect(403);

      for (const id of [profiles[0], expiredProfiles[0], coop.profiles[0]]) {
        expect((await storedLicence(id)).etrade_licence).toBeNull();
      }
    });

    it("answers 503 and stores nothing when e-trade is down or slow, and logs why", async () => {
      const { tin, profiles } = await company();
      etrade.behaviour.failNext = { status: 503, count: 1 };
      const down = await attach(profiles[0], FORWARDING).expect(503);
      expect(down.body.message).toBe("The business registry did not answer. Try again, or enter your details by hand.");
      etrade.behaviour.hang.add("licence");
      await attach(profiles[0], FORWARDING).expect(503);
      expect((await storedLicence(profiles[0])).etrade_licence).toBeNull();
      const log = await rows<{ call: string; outcome: string; http_status: number | null }>(
        `SELECT call, outcome, http_status FROM "${SCHEMA}".etrade_lookups WHERE tin_hash = $1 ORDER BY id`,
        [hash(tin)],
      );
      expect(log).toEqual([
        { call: "REGISTRATION", outcome: "HTTP", http_status: 503 },
        { call: "REGISTRATION", outcome: "FOUND", http_status: 200 },
        { call: "LICENCE", outcome: "TIMEOUT", http_status: null },
      ]);
    });

    it("keeps the later answer when two attaches race for one profile: the slower, earlier one is STALE", async () => {
      const { profiles } = await company();
      etrade.behaviour.licenceDelayMs[MINERALS] = 300;
      const slow = attach(profiles[0], MINERALS);
      const slowDone = slow.then((r) => r);
      await new Promise((r) => setTimeout(r, 60));
      const fast = await attach(profiles[0], FORWARDING);
      const late = await slowDone;
      expect(fast.status).toBe(200);
      expect(late.status).toBe(422);
      expect(late.body).toMatchObject({ reason: "STALE" });
      expect((await storedLicence(profiles[0])).etrade_licence).toMatchObject({
        licenceNumber: FORWARDING,
        tradeName: "Test Freight Forwarding",
      });
    });

    it("serialises five attaches of one licence on the row lock: one consistent snapshot, no errors", async () => {
      const { profiles } = await company();
      const results = await Promise.all(Array.from({ length: 5 }, () => attach(profiles[0], FORWARDING)));
      for (const r of results) {
        expect([200, 422]).toContain(r.status);
        if (r.status === 422) expect(r.body.reason).toBe("STALE");
      }
      expect(results.some((r) => r.status === 200)).toBe(true);
      const stored = (await storedLicence(profiles[0])).etrade_licence as { checkedAt: string };
      const latest = results
        .filter((r) => r.status === 200)
        .map((r) => r.body.snapshot.checkedAt as string)
        .sort()
        .pop();
      expect(stored.checkedAt).toBe(latest);
    });

    it("stores nothing when the company's TIN changes while the attach is running", async () => {
      const { tin, profiles } = await company();
      etrade.behaviour.licenceDelayMs[FORWARDING] = 300;
      const pending = attach(profiles[0], FORWARDING).then((r) => r);
      await new Promise((r) => setTimeout(r, 100));
      await admin.query(`UPDATE "${SCHEMA}".companies SET tin = $1 WHERE tin = $2`, [nextTin(), tin]);
      const res = await pending;
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ reason: "TIN_CHANGED" });
      expect((await storedLicence(profiles[0])).etrade_licence).toBeNull();
    });
  });

  describe("recheck", () => {
    it("refreshes a renamed licence, runs from the scheduled job, and keeps a vanished licence flagged", async () => {
      const { tin, profiles } = await company();
      await attach(profiles[0], FORWARDING).expect(200);
      const before = await storedLicence(profiles[0]);

      Object.assign(etrade.companies.get(tin)!.licences[1], { tradeName: "Renamed Forwarding", renewedTo: "7/7/2100" });
      const res = await a().post(`/api/profiles/${profiles[0]}/etrade-recheck`).set("x-user-id", "staff-1").expect(200);
      expect(res.body).toMatchObject({ outcome: "UPDATED", changes: ["tradeName", "renewedTo", "validUntil"] });
      const after = await storedLicence(profiles[0]);
      expect(after.etrade_licence).toMatchObject({ tradeName: "Renamed Forwarding", validUntil: "2100-07-07", checkedBy: "staff-1" });
      expect(after.etrade_checked_at!.getTime()).toBeGreaterThan(before.etrade_checked_at!.getTime());

      // The job picks up licences not checked for 30 days.
      await admin.query(`UPDATE "${SCHEMA}".company_profiles SET etrade_checked_at = now() - interval '40 days' WHERE id = $1`, [
        profiles[0],
      ]);
      etrade.companies.get(tin)!.licences.splice(1, 1);
      const job = await appA.get(EtradeRechecker).runOnce();
      expect(job.failed).toBe(0);
      expect(job.checked).toBeGreaterThanOrEqual(1);
      expect((await storedLicence(profiles[0])).etrade_licence).toMatchObject({
        tradeName: "Renamed Forwarding",
        state: "NOT_LISTED",
        needsReview: true,
        problems: ["LICENCE_NOT_LISTED"],
        checkedBy: "recheck",
      });
    });
  });
});
