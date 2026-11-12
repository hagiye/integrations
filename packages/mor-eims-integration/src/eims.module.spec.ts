import { INestApplication, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { FakeEimsHost, invoice, optionsFor } from "../test/fakes";
import { testPair } from "../test/fixtures";
import { MockMor, mockConfig } from "../test/mock-mor";
import {
  EIMS_HOST,
  EimsCancellationService,
  EimsClient,
  EimsCredentialService,
  EimsFilingService,
  EimsModule,
  EimsReceiptService,
} from "./index";

@Injectable()
class TestHost extends FakeEimsHost {}

describe("EimsModule", () => {
  const pair = testPair("module");
  let mock: MockMor;

  beforeAll(async () => {
    mock = new MockMor(mockConfig(pair.fingerprint256));
    await mock.start();
  });
  afterAll(() => mock.stop());

  it("without a host: only the client and the static signing pair, no route", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EimsModule.forRoot({ options: optionsFor(mock.url, pair) })] }).compile();
    const client = moduleRef.get(EimsClient);
    expect(await client.session()).toMatchObject({ systemNumber: "TESTSYS001" });
    expect(() => moduleRef.get(EimsFilingService)).toThrow();
    await moduleRef.close();
  });

  it("refuses a route without a host, and an empty route", () => {
    expect(() => EimsModule.forRoot({ options: optionsFor(mock.url, pair), route: "eims/hook" })).toThrow(/needs a host/);
    expect(() => EimsModule.forRoot({ options: optionsFor(mock.url, pair), host: TestHost, route: " " })).toThrow(/must be a path/);
  });

  describe("with a host (forRootAsync) and the bulk callback route", () => {
    let app: INestApplication;
    let host: TestHost;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          EimsModule.forRootAsync({
            useFactory: async () => optionsFor(mock.url, pair, { bulkWebhookToken: "tok-123" }),
            host: TestHost,
          }),
        ],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      app.setGlobalPrefix("api");
      await app.init();
      host = app.get(EIMS_HOST);
    });
    afterAll(() => app.close());

    it("provides every service", () => {
      for (const token of [EimsClient, EimsCredentialService, EimsFilingService, EimsReceiptService, EimsCancellationService]) {
        expect(app.get(token)).toBeDefined();
      }
    });

    it("answers MoR's callback with 200 on both routes and applies a rejection only with the token", async () => {
      mock.ledger = { nextCounter: 1, nextDocumentNumber: 1, previousIrn: "" };
      host.documents.set("m1", invoice("m1"));
      mock.buyerLookupDown.add("0089238373");
      const submission = await app.get(EimsFilingService).registerBulk(["m1"]);
      mock.buyerLookupDown.clear();
      const items = mock.bulkCallbacks.get(submission.conversationId!)!;

      const open = await request(app.getHttpServer()).post("/api/eims/webhook/bulk-register").send(items).expect(200);
      expect(open.body).toEqual([expect.objectContaining({ applied: false })]);
      const withToken = await request(app.getHttpServer()).post("/api/eims/webhook/bulk-register/tok-123").send(items).expect(200);
      expect(withToken.body).toEqual([expect.objectContaining({ applied: true, documentId: "m1" })]);
      expect(host.filing("m1").status).toBe("FAILED");
      expect(host.exchanges.filter((e) => e.direction === "INBOUND").map((e) => e.trigger)).toEqual(["NO_TOKEN", "TOKEN"]);

      const junk = await request(app.getHttpServer()).post("/api/eims/webhook/bulk-register").send({ not: "an array" }).expect(200);
      expect(junk.body).toEqual([]);
    });
  });
});
