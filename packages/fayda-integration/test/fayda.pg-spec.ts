import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { ExampleAppModule } from "../examples/standalone/app.module";
import { CreateExampleFayda1790000000400 } from "../examples/standalone/create-fayda.migration";
import { PROOF_SECRET, codeAndState, optionsFor, startMock } from "./fixtures";
import { MockEsignet, abebe } from "./mock-esignet";

/**
 * The standalone example against a real Postgres and the mock eSignet, over HTTP, with two app
 * instances on one database (as behind a load balancer): the full flow, replay, a race on one
 * state, expiry, forged or mismatched tokens, the browser binding, no merge by phone, linking and
 * conflicts, and proofs.
 *
 * Needs a throwaway database: FAYDA_TEST_DATABASE_URL=postgres://user:pass@host:5432/db.
 * Everything lives in its own schema, dropped and re-created on each run.
 */
const DATABASE_URL = process.env.FAYDA_TEST_DATABASE_URL;
const SCHEMA = "fayda_pg_spec";
const RETURN = "https://office.example.test/fayda/done";

describe("Fayda on Postgres (standalone example)", () => {
  let mock: MockEsignet;
  let privateJwk: Record<string, unknown>;
  let admin: DataSource;
  let appA: INestApplication;
  let appB: INestApplication;
  let subs = 0;

  async function startApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ExampleAppModule.forRoot({
          databaseUrl: DATABASE_URL!,
          schema: SCHEMA,
          fayda: optionsFor(mock, privateJwk, {
            returnUrls: { PORTAL: { success: RETURN, failure: RETURN } },
            proof: { secret: PROOF_SECRET },
          }),
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix("api");
    await app.init();
    return app;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error("Set FAYDA_TEST_DATABASE_URL to a throwaway Postgres database");
    ({ mock, privateJwk } = await startMock());
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
    await mock?.stop();
  });

  beforeEach(() => {
    mock.reset();
    mock.person = abebe(`psut-pg-${++subs}`);
  });

  const a = () => request(appA.getHttpServer());
  const b = () => request(appB.getHttpServer());
  const rows = <T>(sql: string, params: unknown[] = []): Promise<T[]> => admin.query(sql, params);
  const t = (name: string) => `"${SCHEMA}"."${name}"`;

  /** POST /api/fayda/start, the trip through the mock, and what the browser holds afterwards. */
  async function begin(over: { accountId?: string; channel?: string; purpose?: string } = {}) {
    const req = a().post("/api/fayda/start").send({ channel: over.channel, purpose: over.purpose });
    if (over.accountId) req.set("x-account-id", over.accountId);
    const res = await req.expect(200);
    const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
    const cookie = setCookie?.[0]?.split(";")[0] ?? "";
    const redirect = mock.approve(res.body.authorizationUrl);
    return { sessionId: res.body.sessionId as string, cookie, authorizationUrl: res.body.authorizationUrl as string, ...codeAndState(redirect) };
  }

  const complete = (flow: { code: string; state: string; cookie: string }, agent = a) =>
    agent().post("/api/fayda/complete").set("Cookie", flow.cookie).send({ code: flow.code, state: flow.state });

  const session = async (id: string) =>
    (await rows<Record<string, unknown>>(`SELECT * FROM ${t("fayda_sessions")} WHERE id = $1`, [id]))[0];
  const identity = async (sub: string) =>
    (await rows<Record<string, unknown>>(`SELECT * FROM ${t("fayda_identities")} WHERE fayda_sub = $1`, [sub]))[0];
  const newAccount = async (phone: string | null = null, email: string | null = null) =>
    (await rows<{ id: string }>(`INSERT INTO ${t("accounts")} (display_name, phone, email) VALUES ('Existing', $1, $2) RETURNING id`, [phone, email]))[0].id;

  it("creates its tables in the configured schema only, and re-running the migration changes nothing", async () => {
    const tables = await rows<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_name IN ('accounts', 'fayda_sessions', 'fayda_identities', 'fayda_results', 'fayda_audit', 'public_requests')
        ORDER BY table_name`,
    );
    expect(tables.map((r) => r.table_schema)).toEqual(Array(6).fill(SCHEMA));
    const runner = appA.get(DataSource).createQueryRunner();
    try {
      await new CreateExampleFayda1790000000400().up(runner);
    } finally {
      await runner.release();
    }
  });

  it("verifies a guest end to end, shows the result only to the starting browser, and stores no secrets", async () => {
    const flow = await begin();
    const res = await complete(flow).expect(200);
    expect(res.body).toMatchObject({ outcome: "VERIFIED", sessionId: flow.sessionId, purpose: "VERIFY", proof: expect.any(String) });
    expect(res.body.result).toMatchObject({ accountId: null, fullName: "Abebe Bekele Tesfaye", birthdate: "1990-05-01" });

    await a().get(`/api/fayda/results/${flow.sessionId}`).expect(404);
    const view = await b().get(`/api/fayda/results/${flow.sessionId}`).set("Cookie", flow.cookie).expect(200);
    expect(view.body.fullName).toBe("Abebe Bekele Tesfaye");

    expect(await session(flow.sessionId)).toMatchObject({ status: "COMPLETED", nonce: "", code_verifier: "", error_code: null });
    const stored = await identity(mock.person.sub);
    expect(stored).toMatchObject({ account_id: null, phone_e164: "+251911223344", phone_raw: "0911223344", gender: "Male" });
    expect((stored.birthdate as Date).toISOString().slice(0, 10)).toBe("1990-05-01");
    const audit = await rows<{ type: string }>(`SELECT type FROM ${t("fayda_audit")} WHERE session_id = $1 ORDER BY id`, [flow.sessionId]);
    expect(audit.map((r) => r.type)).toEqual(["START", "COMPLETE_OK"]);
    const dump = JSON.stringify(await rows(`SELECT * FROM ${t("fayda_audit")}`)) + JSON.stringify(await rows(`SELECT error_code, error_description FROM ${t("fayda_sessions")}`));
    expect(dump).not.toContain("Abebe");
    expect(dump).not.toContain(flow.code);
  });

  it("completes through GET /fayda/callback and sends the browser on with only the session id", async () => {
    const flow = await begin({ channel: "PORTAL" });
    const res = await a().get("/api/fayda/callback").query({ code: flow.code, state: flow.state }).set("Cookie", flow.cookie).expect(303);
    expect(res.headers.location).toBe(`${RETURN}?result=${flow.sessionId}`);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("refuses a replay on the other instance without calling eSignet again", async () => {
    const flow = await begin();
    await complete(flow).expect(200);
    const replay = await complete(flow, b).expect(400);
    expect(replay.body.code).toBe("FAYDA_INVALID_STATE");
    expect(mock.tokenCalls).toBe(1);
    const invalid = await rows(`SELECT 1 FROM ${t("fayda_audit")} WHERE type = 'INVALID_STATE'`);
    expect(invalid.length).toBeGreaterThan(0);
  });

  it("lets one of two completions racing on one state through, across two instances", async () => {
    const flow = await begin();
    const [first, second] = await Promise.all([complete(flow, a), complete(flow, b)]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    expect(mock.tokenCalls).toBe(1);
    expect(await rows(`SELECT 1 FROM ${t("fayda_identities")} WHERE fayda_sub = $1`, [mock.person.sub])).toHaveLength(1);
  });

  it("makes one identity row when the same person completes two sessions at once", async () => {
    const one = await begin();
    const two = await begin();
    const results = await Promise.all([complete(one, a), complete(two, b)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await rows(`SELECT 1 FROM ${t("fayda_identities")} WHERE fayda_sub = $1`, [mock.person.sub])).toHaveLength(1);
  });

  it("ends an expired session without calling eSignet", async () => {
    const flow = await begin();
    await admin.query(`UPDATE ${t("fayda_sessions")} SET expires_at = now() - interval '1 minute' WHERE id = $1`, [flow.sessionId]);
    expect((await complete(flow).expect(400)).body.code).toBe("FAYDA_SESSION_EXPIRED");
    expect(await session(flow.sessionId)).toMatchObject({ status: "EXPIRED", nonce: "", code_verifier: "" });
    expect(mock.tokenCalls).toBe(0);
  });

  it.each([
    ["a userinfo signed by the wrong key", { userinfoSignedBy: "stranger" as const }, "FAYDA_USERINFO_FAILED", "userinfo:BAD_SIGNATURE"],
    ["an ID token with another nonce", { idTokenNonce: "replayed-nonce" }, "FAYDA_TOKEN_INVALID", "id_token:NONCE_MISMATCH"],
    ["an ID token for another client", { idTokenAud: "another-client" }, "FAYDA_TOKEN_INVALID", "id_token:AUDIENCE_MISMATCH"],
    ["an unsigned ID token", { idTokenAlg: "none" as const }, "FAYDA_TOKEN_INVALID", "id_token:ALG_NOT_ALLOWED"],
    ["a userinfo about someone else", { userinfoSub: "psut-somebody-else" }, "FAYDA_USERINFO_FAILED", "userinfo:SUB_MISMATCH"],
  ])("refuses %s, links nobody, and closes the session", async (_label, behaviour, code, reason) => {
    const flow = await begin();
    Object.assign(mock.behaviour, behaviour);
    expect((await complete(flow).expect(502)).body.code).toBe(code);
    expect(await identity(mock.person.sub)).toBeUndefined();
    expect(await session(flow.sessionId)).toMatchObject({ status: "FAILED", error_code: code, error_description: reason, nonce: "" });
  });

  it("refuses a completion from another browser (login CSRF) and burns the session", async () => {
    const flow = await begin();
    const res = await a().post("/api/fayda/complete").send({ code: flow.code, state: flow.state }).expect(400);
    expect(res.body.code).toBe("FAYDA_BINDING_MISMATCH");
    expect(await session(flow.sessionId)).toMatchObject({ status: "FAILED", error_description: "binding_missing" });
    expect(mock.tokenCalls).toBe(0);
    await complete(flow).expect(400);
  });

  it("closes the session when the person cancels at eSignet", async () => {
    const start = await a().post("/api/fayda/start").send({}).expect(200);
    const back = new URL(mock.cancel(start.body.authorizationUrl)).searchParams;
    const res = await a()
      .post("/api/fayda/complete")
      .send({ error: back.get("error"), error_description: back.get("error_description"), state: back.get("state") })
      .expect(400);
    expect(res.body.code).toBe("FAYDA_AUTH_ERROR");
    expect(await session(start.body.sessionId)).toMatchObject({ status: "FAILED", error_description: "esignet:access_denied" });
  });

  it("does not merge into an account with the same phone and email, for VERIFY or LOGIN", async () => {
    const existing = await newAccount("+251911223344", "abebe.bekele@example.com");
    const verify = await complete(await begin()).expect(200);
    expect(verify.body.result).toMatchObject({ accountId: null, possibleAccountMatch: true });
    expect((await identity(mock.person.sub)).account_id).toBeNull();

    const login = await complete(await begin({ purpose: "LOGIN" })).expect(200);
    expect(login.body.result).toMatchObject({ accountCreated: true, possibleAccountMatch: true });
    expect(login.body.result.accountId).not.toBe(existing);
    expect((await identity(mock.person.sub)).account_id).toBe(login.body.result.accountId);
    expect(await rows(`SELECT 1 FROM ${t("accounts")} WHERE id = $1 AND display_name = 'Existing'`, [existing])).toHaveLength(1);

    const again = await complete(await begin({ purpose: "LOGIN" })).expect(200);
    expect(again.body.result).toMatchObject({ accountId: login.body.result.accountId, accountCreated: false });
  });

  it("links a signed-in account, and refuses a second account or a second Fayda ID", async () => {
    const owner = await newAccount();
    const ok = await complete(await begin({ accountId: owner })).expect(200);
    expect(ok.body.result.accountId).toBe(owner);

    const other = await newAccount();
    const conflict = await complete(await begin({ accountId: other })).expect(409);
    expect(conflict.body.code).toBe("FAYDA_IDENTITY_CONFLICT");

    mock.person = abebe(`psut-pg-${++subs}`);
    const second = await complete(await begin({ accountId: owner })).expect(409);
    expect(second.body.code).toBe("FAYDA_ACCOUNT_ALREADY_VERIFIED");
    expect(await identity(mock.person.sub)).toBeUndefined();
  });

  it("accepts a request with a fresh proof once, and never with a sub alone", async () => {
    const res = await complete(await begin()).expect(200);
    const proof = res.body.proof as string;
    await a().post("/api/requests").send({ sub: mock.person.sub, proof, text: "Lost luggage" }).expect(201);
    await b().post("/api/requests").send({ sub: mock.person.sub, proof, text: "Again" }).expect(403);
    await a().post("/api/requests").send({ sub: mock.person.sub, text: "No proof" }).expect(403);
    await a().post("/api/requests").send({ sub: "psut-someone-else", proof, text: "Wrong sub" }).expect(403);
  });
});
