import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as net from "node:net";
import request from "supertest";
import { DataSource } from "typeorm";
import { ExampleAppModule } from "../examples/standalone/app.module";
import { CreateExampleEims1790000000500 } from "../examples/standalone/create-eims.migration";
import { invoice, optionsFor } from "./fakes";
import { SYSTEM_NUMBER, TAXPAYER_A, testEncryptionKey, testPair } from "./fixtures";
import { MockMor, mockConfig } from "./mock-mor";

/**
 * The standalone example against a real Postgres and the mock MoR, over HTTP, with two app
 * instances on one database (as behind a load balancer). MoR sits behind a proxy that can be
 * switched off, to stand for "MoR unreachable".
 *
 * Needs a throwaway database: MOR_TEST_DATABASE_URL=postgres://user:pass@host:5432/db.
 * Everything lives in its own schema, dropped and re-created on each run.
 */
const DATABASE_URL = process.env.MOR_TEST_DATABASE_URL;
const SCHEMA = "mor_eims_pg_spec";
const ADMIN = "admin-token-for-tests";
const TOKEN = "bulk-path-token";

/** A TCP proxy in front of the mock, on a fixed port, that can stop listening (ECONNREFUSED). */
class SwitchableProxy {
  port = 0;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  constructor(private readonly target: () => number) {}
  async start(): Promise<void> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.target(), "127.0.0.1");
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on("close", () => this.sockets.delete(s));
        s.on("error", () => s.destroy());
      }
      client.pipe(upstream).pipe(client);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("MoR EIMS on Postgres (standalone example)", () => {
  const first = testPair("pg-first");
  const renewal = testPair("pg-renewal");
  const encryptionKey = testEncryptionKey();
  let mock: MockMor;
  let proxy: SwitchableProxy;
  let admin: DataSource;
  let appA: INestApplication;
  let appB: INestApplication;
  let seq = 0;

  async function startApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ExampleAppModule.forRoot({
          databaseUrl: DATABASE_URL!,
          schema: SCHEMA,
          adminToken: ADMIN,
          eims: optionsFor(`http://127.0.0.1:${proxy.port}`, first, { encryptionKey, bulkWebhookToken: TOKEN }),
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix("api");
    await app.init();
    return app;
  }

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error("Set MOR_TEST_DATABASE_URL to a throwaway Postgres database");
    mock = new MockMor(mockConfig(first.fingerprint256));
    await mock.start();
    proxy = new SwitchableProxy(() => Number(new URL(mock.url).port));
    await proxy.start();
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
    await proxy?.stop().catch(() => undefined);
    await mock?.stop();
  });

  beforeEach(() => mock.reset());

  const a = () => request(appA.getHttpServer());
  const b = () => request(appB.getHttpServer());
  const rows = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => admin.query(sql, params);
  const t = (name: string) => `"${SCHEMA}"."${name}"`;
  const auth = { "x-admin-token": ADMIN };

  async function create(client = a, overrides: Record<string, unknown> = {}): Promise<string> {
    const base = invoice("x");
    const res = await client()
      .post("/api/invoices")
      .set(auth)
      .send({ number: `INV-PG-${++seq}`, buyer: base.buyer, lines: base.lines, ...overrides })
      .expect(201);
    return res.body.id;
  }
  const register = (id: string, client = a) => client().post(`/api/invoices/${id}/eims/register`).set(auth);
  const state = async () => (await rows(`SELECT * FROM ${t("eims_system_state")} WHERE system_number = $1`, [SYSTEM_NUMBER]))[0];
  const filing = async (id: string) => (await rows(`SELECT * FROM ${t("invoices")} WHERE id = $1`, [id]))[0];

  it("runs its migration twice without harm", async () => {
    const ds = new DataSource({ type: "postgres", url: DATABASE_URL, schema: SCHEMA });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await new CreateExampleEims1790000000500().up(runner);
    await runner.release();
    await ds.destroy();
    const indexes = await rows(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [SCHEMA]);
    expect(indexes.map((i) => i.indexname)).toEqual(expect.arrayContaining(["eims_receipts_live_uq", "eims_credentials_one_active", "invoices_eims_irn_uq"]));
  });

  it("registers once; a second register from the other instance returns the same IRN without calling MoR", async () => {
    const id = await create();
    const first = await register(id).expect(201);
    expect(first.body).toMatchObject({ outcome: "REGISTERED", irn: expect.stringMatching(/^test-/) });
    const again = await register(id, b).expect(201);
    expect(again.body).toMatchObject({ outcome: "ALREADY_REGISTERED", irn: first.body.irn });
    expect(mock.countCalls("/v1/register")).toBe(1);
    expect(await filing(id)).toMatchObject({ eims_status: "REGISTERED", eims_irn: first.body.irn, eims_ack_date: expect.stringMatching(/:00Z/) });
  });

  it("five concurrent registrations of one invoice across two instances make one MoR call", async () => {
    const id = await create();
    const responses = await Promise.all([0, 1, 2, 3, 4].map((i) => register(id, i % 2 ? b : a)));
    const outcomes = responses.map((r) => (r.status === 201 ? r.body.outcome : `${r.status}:${r.body.code}`));
    expect(outcomes.filter((o) => o === "REGISTERED")).toHaveLength(1);
    expect(outcomes.every((o) => ["REGISTERED", "ALREADY_REGISTERED", "409:IN_FLIGHT"].includes(o))).toBe(true);
    expect(mock.countCalls("/v1/register")).toBe(1);
  });

  it("two invoices racing get distinct, gapless numbers", async () => {
    const before = Number((await state()).next_document_number);
    const x = await create();
    const y = await create(b);
    const [rx, ry] = await Promise.all([register(x, a), register(y, b)]);
    for (const [res, id] of [[rx, x], [ry, y]] as const) {
      if (res.status === 409) {
        expect(res.body.code).toBe("IN_FLIGHT");
        await register(id).expect(201);
      }
    }
    const numbers = [Number((await filing(x)).eims_document_number), Number((await filing(y)).eims_document_number)].sort((p, q) => p - q);
    expect(numbers).toEqual([before, before + 1]);
    expect(Number((await state()).next_document_number)).toBe(before + 2);
  });

  it("records a rejection with MoR's rule and gives the numbers back; adopts MoR's expected : N", async () => {
    const before = await state();
    const id = await create();
    mock.config.sellerLegalName = "Someone Else PLC";
    const rejected = await register(id).expect(201);
    mock.config.sellerLegalName = "Test Seller PLC";
    expect(rejected.body).toMatchObject({ outcome: "REJECTED", error: { kind: "RULE_VALIDATION", rules: ["7017"] } });
    expect(await filing(id)).toMatchObject({ eims_status: "FAILED", eims_document_number: null });
    expect(await state()).toMatchObject({ next_invoice_counter: before.next_invoice_counter, next_document_number: before.next_document_number, in_flight_document_id: null });

    // MoR's ledger is ahead (a restored database): the rejection names the numbers to use.
    mock.ledger.nextCounter += 5;
    mock.ledger.nextDocumentNumber += 5;
    const desynced = await register(id).expect(201);
    expect(desynced.body).toMatchObject({ outcome: "REJECTED", error: { rules: expect.arrayContaining(["7015", "7001"]) } });
    expect(Number((await state()).next_document_number)).toBe(mock.ledger.nextDocumentNumber);
    const filed = await register(id, b).expect(201);
    expect(filed.body).toMatchObject({ outcome: "REGISTERED", filing: { documentNumber: String(mock.ledger.nextDocumentNumber - 1) } });
  });

  it("MoR unreachable before anything is sent leaves the invoice queued, and a retry succeeds", async () => {
    const id = await create();
    await a().get(`/api/invoices/${id}/eims`).set(auth).expect(200);
    await proxy.stop();
    try {
      const down = await register(id).expect(201);
      expect(down.body).toMatchObject({ outcome: "RETRY_LATER", filing: { status: "NOT_SUBMITTED", retryCount: 1 }, error: { kind: "NETWORK" } });
      expect((await state()).blocked_reason).toBeNull();
    } finally {
      await proxy.start();
    }
    expect((await register(id).expect(201)).body).toMatchObject({ outcome: "REGISTERED" });
  });

  it("a lost answer blocks the system number; resolving with the IRN MoR holds resumes the chain", async () => {
    const lost = await create();
    const next = await create();
    mock.failNext("/v1/register", "reset-after");
    expect((await register(lost).expect(201)).body).toMatchObject({ outcome: "UNKNOWN", filing: { status: "UNKNOWN" } });
    expect((await state()).blocked_reason).toMatch(/never acknowledged/);
    expect((await register(next, b).expect(409)).body).toMatchObject({ code: "SYSTEM_BLOCKED" });
    const events = await rows(`SELECT * FROM ${t("eims_events")} WHERE document_id = $1 AND type = 'UNKNOWN'`, [lost]);
    expect(events[0]).toMatchObject({ priority: "HIGH" });

    const irn = mock.ledger.previousIrn;
    await b().post(`/api/invoices/${lost}/eims/resolve`).set(auth).send({ irn: `${irn.slice(0, -1)}${irn.endsWith("0") ? "1" : "0"}` }).expect(502);
    const resolved = await b().post(`/api/invoices/${lost}/eims/resolve`).set(auth).send({ irn }).expect(201);
    expect(resolved.body).toMatchObject({ status: "REGISTERED", irn });
    expect(await state()).toMatchObject({ blocked_reason: null, previous_irn: irn });
    expect((await register(next).expect(201)).body).toMatchObject({ outcome: "REGISTERED" });
    const lastRegister = mock.calls.filter((c) => c.path === "/v1/register").pop()!.request as any;
    expect(lastRegister.ReferenceDetails.PreviousIrn).toBe(irn);
  });

  it("MoR's buyer lookup answering 503 keeps the invoice queued; it files once the lookup is back", async () => {
    const id = await create();
    mock.buyerLookupDown.add(TAXPAYER_A);
    expect((await register(id).expect(201)).body).toMatchObject({
      outcome: "RETRY_LATER",
      filing: { status: "NOT_SUBMITTED" },
      error: { code: "BUYER_LOOKUP_UNAVAILABLE" },
    });
    mock.buyerLookupDown.clear();
    expect((await register(id).expect(201)).body).toMatchObject({ outcome: "REGISTERED" });
  });

  it("files one sales receipt per payment, once, then cancels the invoice and refuses receipts after", async () => {
    const id = await create();
    await register(id).expect(201);
    await a().post(`/api/invoices/${id}/payments`).set(auth).send({ key: "p1", amount: 50000, method: "BANK_TRANSFER", reference: "CRV-77", paidAt: new Date(Date.now() - 120_000) }).expect(201);
    await a().post(`/api/invoices/${id}/payments`).set(auth).send({ key: "p2", amount: 35000, method: "CASH", paidAt: new Date(Date.now() - 60_000) }).expect(201);

    const one = await a().post(`/api/invoices/${id}/eims/receipts`).set(auth).send({}).expect(201);
    expect(one.body).toMatchObject({ outcome: "REGISTERED", receipt: { paymentKey: "p1" } });
    expect(one.body.receipt.request).toMatchObject({ ManualReceiptNumber: "CRV-77", Invoices: [{ PaymentCoverage: "PARTIAL", RemainingAmount: 35000 }] });

    const racing = await Promise.all([
      a().post(`/api/invoices/${id}/eims/receipts`).set(auth).send({ paymentKey: "p2" }),
      b().post(`/api/invoices/${id}/eims/receipts`).set(auth).send({ paymentKey: "p2" }),
    ]);
    expect(racing.map((r) => r.body.outcome).sort()).toEqual(["ALREADY_FILED", "REGISTERED"]);
    expect(mock.countCalls("/v1/receipt/sales")).toBe(2);
    const stored = (await a().get(`/api/invoices/${id}/eims/receipts`).set(auth).expect(200)).body;
    expect(stored.map((r: any) => r.receiptNumber)).toHaveLength(2);
    expect(new Set(stored.map((r: any) => r.receiptNumber)).size).toBe(2);

    expect((await b().post(`/api/invoices/${id}/eims/cancel`).set(auth).send({ reasonCode: "1", remark: "Issued twice" }).expect(201)).body).toMatchObject({ status: "CANCELLED" });
    expect((await a().post(`/api/invoices/${id}/eims/cancel`).set(auth).send({ reasonCode: "1" }).expect(400)).body).toMatchObject({ code: "ALREADY_CANCELLED" });
    await a().post(`/api/invoices/${id}/payments`).set(auth).send({ key: "p3", amount: 1, method: "CASH" }).expect(201);
    expect((await a().post(`/api/invoices/${id}/eims/receipts`).set(auth).send({ paymentKey: "p3" }).expect(400)).body).toMatchObject({ code: "CANCELLED" });
  });

  it("files a credit note that restates the original's lines; MoR refuses one that does not (7020)", async () => {
    const original = await create(a, {
      lines: [
        { chargeType: "RAIL_FREIGHT", description: "40FT rail freight", quantity: 2, unitPrice: 42500, amount: 85000 },
        { chargeType: "BULK", description: "Bulk rail freight", quantity: 583.94, unitPrice: 8825.57, amount: 5153568.04, basis: "PER_TON" },
      ],
    });
    await register(original).expect(201);
    const memo = await a().post(`/api/invoices/${original}/memos`).set(auth).send({ type: "CRE", number: `CRE-PG-${++seq}`, reason: "Overcharge", amount: 1000 }).expect(201);
    expect((await register(memo.body.id).expect(201)).body).toMatchObject({ outcome: "REGISTERED" });
    const filedMemo = mock.calls.filter((c) => c.path === "/v1/register").pop()!.request as any;
    expect(filedMemo.ItemList.map((i: any) => [i.ProductDescription, i.Quantity])).toEqual([["40FT rail freight", 2], ["Bulk rail freight (583.94 t)", 1]]);

    const [bad] = await rows(
      `INSERT INTO ${t("invoices")} (invoice_number, document_type, reason, related_invoice_id, currency, total_amount, issued_at, buyer)
       SELECT $1, 'CRE', 'Overcharge', id, 'ETB', 100, now(), buyer FROM ${t("invoices")} WHERE id = $2 RETURNING id`,
      [`CRE-PG-${++seq}`, original],
    );
    await rows(`INSERT INTO ${t("invoice_lines")} (invoice_id, line_no, charge_type, description, quantity, unit_price, amount) VALUES ($1, 1, 'RAIL_FREIGHT', 'Credit memo', 1, 100, 100)`, [bad.id]);
    expect((await register(bad.id).expect(201)).body).toMatchObject({ outcome: "REJECTED", error: { rules: expect.arrayContaining(["7020"]) } });
  });

  it("the sweep drains an unfilable invoice and files the next, oldest first", async () => {
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const older = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const base = invoice("s").buyer;
    const placeholder = await create(a, { issuedAt: older, buyer: { ...base, tin: "I000000042" } });
    const good = await create(a, { issuedAt: old });
    const runs = [];
    for (let i = 0; i < 2; i++) runs.push((await a().post("/api/eims/sweep").set(auth).expect(201)).body.filing);
    expect(runs[0]).toMatchObject({ outcome: "DRAINED", documentId: placeholder, error: { code: "BUYER_TIN_REQUIRED" } });
    expect(runs[1]).toMatchObject({ outcome: "FILED", documentId: good, result: { outcome: "REGISTERED" } });
  });

  it("bulk: acceptances are applied once /v1/verify confirms them, the token path is needed for rejections", async () => {
    const x = await create();
    const y = await create();
    const submission = (await a().post("/api/eims/bulk").set(auth).send({ invoiceIds: [x, y] }).expect(201)).body;
    expect(submission.submitted).toEqual([x, y]);
    const items = mock.bulkCallbacks.get(submission.conversationId)!;
    const forged = items.map((i: any) => (i.irn ? { ...i, irn: `test-${"f".repeat(64)}` } : i));
    const ignored = await b().post("/api/eims/webhook/bulk-register").send(forged).expect(200);
    expect(ignored.body.every((r: any) => !r.applied)).toBe(true);
    const applied = await b().post(`/api/eims/webhook/bulk-register/${TOKEN}`).send(items).expect(200);
    expect(applied.body.filter((r: any) => r.applied)).toHaveLength(2);
    expect((await filing(y)).eims_status).toBe("REGISTERED");
    expect((await state()).in_flight_conversation_id).toBeNull();
  });

  it("keeps the exchange log whole but without a secret, a token or the certificate bytes", async () => {
    const logged = await rows(`SELECT * FROM ${t("eims_exchanges")}`);
    const ops = new Set(logged.map((r) => r.operation));
    for (const op of ["LOGIN", "REGISTER", "VERIFY", "SALES_RECEIPT", "CANCEL", "BULK_REGISTER", "BULK_CALLBACK"]) expect(ops.has(op)).toBe(true);
    const text = JSON.stringify(logged);
    expect(text).not.toContain("secret-test");
    expect(text).not.toContain("apikey-test");
    expect(text).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./);
    expect(text).not.toContain(first.certificateFile.toString("base64").slice(0, 200));
    const login = logged.find((r) => r.operation === "LOGIN");
    expect(login.request_body).toMatchObject({ request: { clientSecret: "[REDACTED]", apikey: "[REDACTED]" }, certificate: { __certificate: true } });
    const register = logged.find((r) => r.operation === "REGISTER" && r.is_success);
    expect(register.request_body.request.ItemList.length).toBeGreaterThan(0);
    expect(register.request_headers).toMatchObject({ authorization: "Bearer [REDACTED]", apikey: "[REDACTED]" });
  });

  it("rotates the INSA pair in one step: never two usable pairs, refused while a submission is in flight", async () => {
    // A registered document to prove the new pair against (a read-only /v1/verify).
    await register(await create()).expect(201);
    expect((await a().post("/api/eims/credentials/import").set(auth).expect(201)).body).toMatchObject({ status: "ACTIVE" });
    mock.issue(renewal.fingerprint256);
    const pending = (
      await b()
        .post("/api/eims/credentials")
        .set(auth)
        .send({ privateKeyBase64: Buffer.from(renewal.keyPem).toString("base64"), certificateBase64: renewal.certificateFile.toString("base64"), label: "2027" })
        .expect(201)
    ).body;
    expect(pending.status).toBe("PENDING");
    await expect(
      rows(`INSERT INTO ${t("eims_credentials")} (id, status, certificate_base64, cert_fingerprint_sha256, key_fingerprint_sha256, created_at) VALUES (gen_random_uuid(), 'ACTIVE', 'x', 'x', 'x', now())`),
    ).rejects.toMatchObject({ code: "23505" });

    await rows(
      `INSERT INTO ${t("eims_system_state")} (system_number, in_flight_document_id) VALUES ($1, gen_random_uuid())
       ON CONFLICT (system_number) DO UPDATE SET in_flight_document_id = EXCLUDED.in_flight_document_id`,
      [SYSTEM_NUMBER],
    );
    expect((await a().post(`/api/eims/credentials/${pending.id}/activate`).set(auth).expect(409)).body).toMatchObject({ code: "ACTIVATION_BLOCKED" });
    await rows(`UPDATE ${t("eims_system_state")} SET in_flight_document_id = NULL WHERE system_number = $1`, [SYSTEM_NUMBER]);
    expect(mock.currentCertificate).toBe(first.fingerprint256);

    const both = await Promise.all([
      a().post(`/api/eims/credentials/${pending.id}/activate`).set(auth),
      b().post(`/api/eims/credentials/${pending.id}/activate`).set(auth),
    ]);
    expect(both.filter((r) => r.status === 201)).toHaveLength(1);
    const creds = await rows(`SELECT status, private_key_enc IS NULL AS key_destroyed, cert_fingerprint_sha256 FROM ${t("eims_credentials")} ORDER BY created_at`);
    expect(creds.filter((c) => c.status === "ACTIVE")).toEqual([expect.objectContaining({ cert_fingerprint_sha256: renewal.fingerprint256, key_destroyed: false })]);
    expect(creds.find((c) => c.cert_fingerprint_sha256 === first.fingerprint256)).toMatchObject({ status: "RETIRED", key_destroyed: true });
    expect(mock.currentCertificate).toBe(renewal.fingerprint256);

    // Both instances sign with the renewal now (the other one catches up on MoR's 67012).
    for (const client of [a, b]) {
      const id = await create(client);
      expect((await register(id, client).expect(201)).body).toMatchObject({ outcome: "REGISTERED" });
      expect(mock.calls.filter((c) => c.path === "/v1/register").pop()!.certFingerprint).toBe(renewal.fingerprint256);
    }
    const refused = await rows(`SELECT error_message FROM ${t("eims_exchanges")} WHERE operation = 'REGISTER' AND status_code = 400`);
    expect(refused.some((r) => /67012/.test(r.error_message))).toBe(true);
  });
});
