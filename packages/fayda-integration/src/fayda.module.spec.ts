import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { FakeFaydaHost } from "../test/fakes";
import { codeAndState, optionsFor, startMock } from "../test/fixtures";
import { MockEsignet, abebe } from "../test/mock-esignet";
import { FaydaClient } from "./fayda.client";
import { readCookie } from "./fayda.controller";
import { FaydaModule } from "./fayda.module";
import { FaydaModuleOptions } from "./fayda.options";
import { FaydaService } from "./fayda.service";

describe("FaydaModule", () => {
  let mock: MockEsignet;
  let privateJwk: Record<string, unknown>;

  beforeAll(async () => {
    ({ mock, privateJwk } = await startMock());
    mock.person = abebe();
  });
  afterAll(() => mock.stop());
  beforeEach(() => mock.reset());

  async function app(over: Partial<FaydaModuleOptions> = {}, route?: string | false): Promise<{ app: INestApplication; host: FakeFaydaHost }> {
    const moduleRef = await Test.createTestingModule({
      imports: [FaydaModule.forRoot({ options: optionsFor(mock, privateJwk, over), host: FakeFaydaHost, ...(route !== undefined ? { route } : {}) })],
    }).compile();
    const nest = moduleRef.createNestApplication({ logger: false });
    nest.setGlobalPrefix("api");
    await nest.init();
    return { app: nest, host: nest.get(FakeFaydaHost) };
  }

  it("without a host gives FaydaClient and a service that refuses to start", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FaydaModule.forRoot({ options: optionsFor(mock, privateJwk) })] }).compile();
    expect(moduleRef.get(FaydaClient)).toBeInstanceOf(FaydaClient);
    await expect(moduleRef.get(FaydaService).start()).rejects.toMatchObject({ kind: "CONFIG" });
  });

  it("refuses a route without a host, and an empty route", () => {
    expect(() => FaydaModule.forRoot({ options: optionsFor(mock, privateJwk), route: "fayda" })).toThrow(/needs a host/);
    expect(() => FaydaModule.forRoot({ options: optionsFor(mock, privateJwk), host: FakeFaydaHost, route: " " })).toThrow(/must be a path/);
  });

  it("refuses to boot with unusable options, naming them", async () => {
    await expect(
      Test.createTestingModule({ imports: [FaydaModule.forRoot({ options: optionsFor(mock, privateJwk, { issuer: "" }) })] }).compile(),
    ).rejects.toThrow(/issuer/);
  });

  it("builds from forRootAsync", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FaydaModule.forRootAsync({ useFactory: async () => optionsFor(mock, privateJwk), host: FakeFaydaHost })],
    }).compile();
    expect((await moduleRef.get(FaydaService).start()).authorizationUrl).toContain(mock.endpoints.authorizationEndpoint);
  });

  describe("GET /fayda/callback", () => {
    let nest: INestApplication;
    afterEach(() => nest?.close());

    it("completes with the binding cookie and sends the browser on with ?result=", async () => {
      ({ app: nest } = await app({ returnUrls: { WEB: { success: "https://office.example.test/ok", failure: "https://office.example.test/bad" } } }));
      const started = await nest.get(FaydaService).start();
      const { code, state } = codeAndState(mock.approve(started.authorizationUrl));
      const res = await request(nest.getHttpServer())
        .get("/api/fayda/callback")
        .query({ code, state })
        .set("Cookie", `other=1; ${started.browserBinding!.cookieName}=${started.browserBinding!.value}`)
        .expect(303);
      expect(res.headers.location).toBe(`https://office.example.test/ok?result=${started.sessionId}`);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      // The binding cookie stays for the app's result page, which clears it.
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("sends the browser to the failure URL with only the error code", async () => {
      ({ app: nest } = await app({ returnUrls: { WEB: { success: "https://office.example.test/ok", failure: "https://office.example.test/bad" } } }));
      const started = await nest.get(FaydaService).start();
      const { code, state } = codeAndState(mock.approve(started.authorizationUrl));
      const res = await request(nest.getHttpServer()).get("/api/fayda/callback").query({ code, state }).expect(303);
      expect(res.headers.location).toBe("https://office.example.test/bad?error=FAYDA_BINDING_MISMATCH");
    });

    it("answers JSON when the channel has no return URLs", async () => {
      ({ app: nest } = await app());
      const started = await nest.get(FaydaService).start({ channel: "MOBILE" });
      const { code, state } = codeAndState(mock.approve(started.authorizationUrl));
      const res = await request(nest.getHttpServer()).get("/api/fayda/callback").query({ code, state }).expect(200);
      expect(res.body).toEqual({
        outcome: "VERIFIED",
        sessionId: started.sessionId,
        purpose: "VERIFY",
        result: { identityId: "identity-1", linkedAccountId: null, possibleAccountMatch: false },
      });
      expect(JSON.stringify(res.body)).not.toContain("Abebe");
      const replay = await request(nest.getHttpServer()).get("/api/fayda/callback").query({ code, state }).expect(400);
      expect(replay.body).toEqual({ outcome: "FAILED", code: "FAYDA_INVALID_STATE", message: "This verification is no longer valid. Start again." });
    });
  });

  describe("POST /fayda/complete", () => {
    let nest: INestApplication;
    afterEach(() => nest?.close());

    it("completes from a front-end callback page and answers JSON", async () => {
      ({ app: nest } = await app());
      const started = await nest.get(FaydaService).start({ channel: "PORTAL" });
      const { code, state } = codeAndState(mock.approve(started.authorizationUrl));
      const res = await request(nest.getHttpServer())
        .post("/api/fayda/complete")
        .set("Cookie", `${started.browserBinding!.cookieName}=${started.browserBinding!.value}`)
        .send({ code, state })
        .expect(200);
      expect(res.body.outcome).toBe("VERIFIED");
    });

    it("maps failures to their HTTP status", async () => {
      ({ app: nest } = await app());
      const started = await nest.get(FaydaService).start();
      const { code, state } = codeAndState(mock.approve(started.authorizationUrl));
      mock.behaviour.tokenStatus = 400;
      const res = await request(nest.getHttpServer())
        .post("/api/fayda/complete")
        .set("Cookie", `${started.browserBinding!.cookieName}=${started.browserBinding!.value}`)
        .send({ code, state })
        .expect(502);
      expect(res.body).toEqual({ outcome: "FAILED", code: "FAYDA_TOKEN_EXCHANGE_FAILED", message: "Fayda is not answering. Try again later." });
      await request(nest.getHttpServer()).post("/api/fayda/complete").send({}).expect(400);
    });

    it("mounts nothing with route false, and moves with another route", async () => {
      ({ app: nest } = await app({}, false));
      await request(nest.getHttpServer()).post("/api/fayda/complete").send({}).expect(404);
      await nest.close();
      ({ app: nest } = await app({}, "identity/fayda"));
      await request(nest.getHttpServer()).post("/api/identity/fayda/complete").send({}).expect(400);
    });
  });

  it("reads one cookie out of the Cookie header", () => {
    expect(readCookie({ headers: { cookie: "a=1; fayda_b_x=v%20w; b=2" } }, "fayda_b_x")).toBe("v w");
    expect(readCookie({ headers: { cookie: "a=1" } }, "fayda_b_x")).toBeUndefined();
    expect(readCookie({ headers: {} }, "a")).toBeUndefined();
  });
});
