import { FakeFaydaHost } from "../test/fakes";
import { CLIENT_ID, MOBILE_REDIRECT, PROOF_SECRET, WEB_REDIRECT, codeAndState, optionsFor, startMock } from "../test/fixtures";
import { MockEsignet, abebe } from "../test/mock-esignet";
import { FaydaClient } from "./fayda.client";
import { FaydaError } from "./fayda.errors";
import { FaydaHostRefusal } from "./fayda.host";
import { FaydaModuleOptions, resolveFaydaOptions } from "./fayda.options";
import { codeChallengeS256, sha256Hex } from "./fayda.pkce";
import { FaydaService } from "./fayda.service";
import type { FaydaCompleteResult, FaydaFailed, FaydaVerified } from "./fayda.types";

type HostResult = Awaited<ReturnType<FakeFaydaHost["onVerified"]>>;

describe("FaydaService", () => {
  let mock: MockEsignet;
  let privateJwk: Record<string, unknown>;
  let host: FakeFaydaHost;

  const service = (over: Partial<FaydaModuleOptions> = {}, withHost = true) => {
    const resolved = resolveFaydaOptions(optionsFor(mock, privateJwk, over));
    return new FaydaService<HostResult>(resolved, new FaydaClient(resolved), withHost ? host : undefined);
  };

  beforeAll(async () => {
    ({ mock, privateJwk } = await startMock());
    mock.person = abebe();
  });
  afterAll(() => mock.stop());
  beforeEach(() => {
    mock.reset();
    host = new FakeFaydaHost();
  });

  /** start, the browser trip through the mock, and the redirect's code and state with the cookie value. */
  async function begin(fayda: FaydaService<HostResult>, start: Parameters<FaydaService["start"]>[0] = {}) {
    const started = await fayda.start(start);
    const { code, state } = codeAndState(mock.approve(started.authorizationUrl));
    return { started, code, state, browserBinding: started.browserBinding?.value };
  }

  const verified = (r: FaydaCompleteResult<HostResult>) => {
    if (r.outcome !== "VERIFIED") throw new Error(`expected VERIFIED, got ${r.code} (${r.reason})`);
    return r as FaydaVerified<HostResult>;
  };
  const failed = (r: FaydaCompleteResult<HostResult>) => {
    if (r.outcome !== "FAILED") throw new Error("expected FAILED");
    return r as FaydaFailed;
  };

  describe("start", () => {
    it("stores a PENDING session with nonce, verifier, binding hash and the channel's exact redirect_uri", async () => {
      const started = await service().start({ purpose: "VERIFY", channel: "WEB", accountId: "acc-1", metadata: { step: "owner" } });
      const session = host.sessions.get(started.sessionId)!;
      expect(session).toMatchObject({
        state: started.state,
        status: "PENDING",
        purpose: "VERIFY",
        channel: "WEB",
        redirectUri: WEB_REDIRECT,
        accountId: "acc-1",
        metadata: { step: "owner" },
      });
      expect(session.nonce).toHaveLength(43);
      expect(session.codeVerifier).toHaveLength(86);
      expect(session.browserBindingHash).toBe(sha256Hex(started.browserBinding!.value));
      expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(600_000);
      const url = new URL(started.authorizationUrl);
      expect(url.searchParams.get("state")).toBe(started.state);
      expect(url.searchParams.get("nonce")).toBe(session.nonce);
      expect(url.searchParams.get("code_challenge")).toBe(codeChallengeS256(session.codeVerifier));
      expect(url.searchParams.get("prompt")).toBe("login");
      expect(started.authorizationUrl).not.toContain(session.codeVerifier);
      expect(host.events.map((e) => e.type)).toEqual(["START"]);
    });

    it("hands back a binding cookie that is HttpOnly, SameSite=Lax, Max-Age the session's life", async () => {
      const started = await service({ browserBinding: {} }).start();
      expect(started.browserBinding!.setCookie).toBe(
        `${started.browserBinding!.cookieName}=${started.browserBinding!.value}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
      );
      expect(started.browserBinding!.cookieName).toMatch(/^fayda_b_[0-9a-f]{16}$/);
    });

    it("does not bind MOBILE sessions, nor any session started with bindBrowser false", async () => {
      const mobile = await service().start({ channel: "MOBILE" });
      expect(mobile.browserBinding).toBeUndefined();
      expect(host.sessions.get(mobile.sessionId)!.browserBindingHash).toBeNull();
      expect(host.sessions.get(mobile.sessionId)!.redirectUri).toBe(MOBILE_REDIRECT);
      expect((await service().start({ bindBrowser: false })).browserBinding).toBeUndefined();
    });

    it("refuses an unknown channel, a bad purpose, no host, and a switched-off integration", async () => {
      await expect(service().start({ channel: "FAX" })).rejects.toMatchObject({ kind: "INVALID" });
      await expect(service().start({ purpose: "drop table" })).rejects.toMatchObject({ kind: "INVALID" });
      await expect(service({}, false).start()).rejects.toMatchObject({ kind: "CONFIG" });
      await expect(service({ enabled: false }).start()).rejects.toMatchObject({ details: { code: "FAYDA_DISABLED" } });
    });
  });

  describe("complete", () => {
    it("verifies, hands the identity to the host, closes the session and wipes the secrets", async () => {
      const fayda = service({ proof: { secret: PROOF_SECRET } });
      const { started, code, state, browserBinding } = await begin(fayda, { accountId: "acc-1" });
      const result = verified(await fayda.complete({ code, state, browserBinding }));
      expect(result).toMatchObject({ sessionId: started.sessionId, purpose: "VERIFY", channel: "WEB", accountId: "acc-1" });
      expect(result.identity).toMatchObject({
        sub: mock.person.sub,
        clientId: CLIENT_ID,
        fullName: "Abebe Bekele Tesfaye",
        nameAm: "አበበ በቀለ ተስፋዬ",
        gender: "Male",
        birthdate: "1990-05-01",
        phoneE164: "+251911223344",
        phoneRaw: "0911223344",
        email: "Abebe.Bekele@Example.com",
        addressEn: "Woreda 03, Bole, Addis Ababa",
        addressAm: "አዲስ አበባ",
        acr: "mosip:idp:acr:generated-code",
        userinfoSigned: true,
      });
      expect(result.result).toEqual({ identityId: "identity-1", linkedAccountId: "acc-1", possibleAccountMatch: false });
      const session = host.sessions.get(started.sessionId)!;
      expect(session.status).toBe("COMPLETED");
      expect(session.nonce).toBe("");
      expect(session.codeVerifier).toBe("");
      expect(fayda.verifyProof(result.proof, mock.person.sub)).toMatchObject({ sub: mock.person.sub, cid: CLIENT_ID, sid: started.sessionId });
      expect(fayda.verifyProof(result.proof, "someone-else")).toBeNull();
      expect(host.events.map((e) => e.type)).toEqual(["START", "COMPLETE_OK"]);
    });

    it("refuses a replayed state without calling eSignet again", async () => {
      const fayda = service();
      const { code, state, browserBinding } = await begin(fayda);
      verified(await fayda.complete({ code, state, browserBinding }));
      const again = failed(await fayda.complete({ code, state, browserBinding }));
      expect(again).toMatchObject({ code: "FAYDA_INVALID_STATE", httpStatus: 400 });
      expect(mock.tokenCalls).toBe(1);
      expect(host.events.at(-1)).toMatchObject({ type: "INVALID_STATE" });
    });

    it("lets only one of two racing completions through", async () => {
      const fayda = service();
      const { code, state, browserBinding } = await begin(fayda);
      const results = await Promise.all([fayda.complete({ code, state, browserBinding }), fayda.complete({ code, state, browserBinding })]);
      expect(results.map((r) => (r.outcome === "VERIFIED" ? "VERIFIED" : r.code)).sort()).toEqual(["FAYDA_INVALID_STATE", "VERIFIED"]);
      expect(mock.tokenCalls).toBe(1);
      expect(host.identities.size).toBe(1);
    });

    it("ends an expired session as EXPIRED without calling eSignet", async () => {
      const fayda = service();
      const { started, code, state, browserBinding } = await begin(fayda);
      host.sessions.get(started.sessionId)!.expiresAt = new Date(Date.now() - 1000);
      expect(failed(await fayda.complete({ code, state, browserBinding })).code).toBe("FAYDA_SESSION_EXPIRED");
      expect(host.sessions.get(started.sessionId)!.status).toBe("EXPIRED");
      expect(mock.tokenCalls).toBe(0);
    });

    it("refuses a completion from another browser (no or wrong binding) and burns the session", async () => {
      const fayda = service();
      let attempt = await begin(fayda);
      expect(failed(await fayda.complete({ code: attempt.code, state: attempt.state })).reason).toBe("binding_missing");
      expect(host.sessionByState(attempt.state)!.status).toBe("FAILED");
      attempt = await begin(fayda);
      const wrong = failed(await fayda.complete({ code: attempt.code, state: attempt.state, browserBinding: "x".repeat(43) }));
      expect(wrong).toMatchObject({ code: "FAYDA_BINDING_MISMATCH", reason: "binding_mismatch" });
      expect(mock.tokenCalls).toBe(0);
    });

    it("completes an unbound MOBILE session without a cookie", async () => {
      const fayda = service();
      const { code, state } = await begin(fayda, { channel: "MOBILE" });
      verified(await fayda.complete({ code, state }));
    });

    it("closes the session on eSignet's error redirect", async () => {
      const fayda = service();
      const started = await fayda.start();
      const params = new URL(mock.cancel(started.authorizationUrl)).searchParams;
      const result = failed(await fayda.complete({ error: params.get("error"), errorDescription: params.get("error_description"), state: params.get("state") }));
      expect(result).toMatchObject({ code: "FAYDA_AUTH_ERROR", reason: "esignet:access_denied", sessionId: started.sessionId });
      expect(host.sessions.get(started.sessionId)).toMatchObject({ status: "FAILED", errorCode: "FAYDA_AUTH_ERROR", errorDescription: "esignet:access_denied" });
    });

    it("refuses missing and malformed parameters before looking anything up", async () => {
      const fayda = service();
      expect(failed(await fayda.complete({ code: "c" })).code).toBe("FAYDA_MISSING_PARAMETERS");
      expect(failed(await fayda.complete({ code: "c", state: "short" })).code).toBe("FAYDA_INVALID_STATE");
      expect(failed(await fayda.complete({ code: "c d", state: "s".repeat(43) })).code).toBe("FAYDA_MISSING_PARAMETERS");
      expect(failed(await fayda.complete({ code: "c", state: "s".repeat(43) })).code).toBe("FAYDA_INVALID_STATE");
      expect(failed(await service({ enabled: false }).complete({ code: "c", state: "s".repeat(43) })).code).toBe("FAYDA_DISABLED");
    });

    it.each([
      [{ tokenStatus: 400 }, "FAYDA_TOKEN_EXCHANGE_FAILED", "token:invalid_grant"],
      [{ idTokenNonce: "a-different-nonce" }, "FAYDA_TOKEN_INVALID", "id_token:NONCE_MISMATCH"],
      [{ idTokenAud: "another-client" }, "FAYDA_TOKEN_INVALID", "id_token:AUDIENCE_MISMATCH"],
      [{ idTokenAlg: "none" as const }, "FAYDA_TOKEN_INVALID", "id_token:ALG_NOT_ALLOWED"],
      [{ omitIdToken: true }, "FAYDA_TOKEN_INVALID", "id_token:missing"],
      [{ userinfoSignedBy: "stranger" as const }, "FAYDA_USERINFO_FAILED", "userinfo:BAD_SIGNATURE"],
      [{ userinfoFormat: "json" as const }, "FAYDA_USERINFO_FAILED", "userinfo:UNSIGNED_USERINFO"],
      [{ userinfoSub: "someone-else" }, "FAYDA_USERINFO_FAILED", "userinfo:SUB_MISMATCH"],
      [{ userinfoStatus: 500 }, "FAYDA_USERINFO_FAILED", "userinfo:HTTP_500"],
    ])("fails %j as %s, closes the session, and links nobody", async (behaviour, code, reason) => {
      const fayda = service();
      const { started, ...redirect } = await begin(fayda);
      Object.assign(mock.behaviour, behaviour);
      const result = failed(await fayda.complete(redirect));
      expect(result).toMatchObject({ code, reason, httpStatus: 502 });
      expect(result.message).not.toContain("invalid_grant");
      expect(host.sessions.get(started.sessionId)).toMatchObject({ status: "FAILED", errorCode: code, errorDescription: reason });
      expect(host.verifiedCalls).toHaveLength(0);
    });

    it("takes the userinfo's own sub when requireIdToken is off and no ID token came", async () => {
      const fayda = service({ requireIdToken: false });
      const redirect = await begin(fayda);
      mock.behaviour.omitIdToken = true;
      expect(verified(await fayda.complete(redirect)).identity.sub).toBe(mock.person.sub);
    });

    it("accepts JSON userinfo only with acceptJsonUserinfo, marked unsigned", async () => {
      const fayda = service({ acceptJsonUserinfo: true });
      const redirect = await begin(fayda);
      mock.behaviour.userinfoFormat = "json";
      expect(verified(await fayda.complete(redirect)).identity.userinfoSigned).toBe(false);
    });

    it("reports an account with the same phone as a possible match, and links nothing to it", async () => {
      host.accounts.push({ id: "acc-existing", phone: "+251911223344" });
      const fayda = service();
      const result = verified(await fayda.complete(await begin(fayda)));
      expect(host.verifiedCalls[0].context.possibleMatches).toEqual(["acc-existing"]);
      expect(result.result).toEqual({ identityId: "identity-1", linkedAccountId: null, possibleAccountMatch: true });
    });

    it("passes the host's refusal on with its code and status", async () => {
      const fayda = service();
      verified(await fayda.complete(await begin(fayda, { accountId: "acc-1" })));
      const second = await begin(fayda, { accountId: "acc-2" });
      const result = failed(await fayda.complete(second));
      expect(result).toMatchObject({ code: "FAYDA_IDENTITY_CONFLICT", httpStatus: 409, message: "This Fayda ID is already linked to another account" });
      expect(host.sessionByState(second.state)).toMatchObject({ status: "FAILED", errorCode: "FAYDA_IDENTITY_CONFLICT" });
    });

    it("answers FAYDA_INTERNAL_ERROR when the host fails unexpectedly", async () => {
      host.failWith = new Error("database down");
      const fayda = service();
      const result = failed(await fayda.complete(await begin(fayda)));
      expect(result).toMatchObject({ code: "FAYDA_INTERNAL_ERROR", httpStatus: 500, reason: "host_error" });
      expect(result.message).not.toContain("database");
    });

    it("keeps verifying across an eSignet key rotation", async () => {
      const fayda = service();
      verified(await fayda.complete(await begin(fayda)));
      mock.rotateKey(true);
      await new Promise((r) => setTimeout(r, 5));
      verified(await fayda.complete(await begin(fayda)));
    });

    it("keeps no claim or token in what it stores about a failure", async () => {
      const fayda = service();
      const redirect = await begin(fayda);
      mock.behaviour.userinfoSub = "someone-else";
      await fayda.complete(redirect);
      const stored = JSON.stringify([...host.sessions.values()].map((s) => [s.errorCode, s.errorDescription])) + JSON.stringify(host.events);
      expect(stored).not.toContain("Abebe");
      expect(stored).not.toContain(redirect.code);
    });
  });

  describe("return URLs and proofs", () => {
    it("builds ?result= and ?error= return URLs per channel", async () => {
      const fayda = service({ returnUrls: { WEB: { success: "https://office.example.test/done?x=1", failure: "https://office.example.test/failed" } } });
      const ok = verified(await fayda.complete(await begin(fayda)));
      expect(fayda.returnUrlFor(ok)).toBe(`https://office.example.test/done?x=1&result=${ok.sessionId}`);
      const bad = failed(await fayda.complete({ code: "c", state: "s".repeat(43) }));
      expect(fayda.returnUrlFor(bad)).toBe("https://office.example.test/failed?error=FAYDA_INVALID_STATE");
      expect(service().returnUrlFor(bad)).toBeUndefined();
    });

    it("issues no proof without a secret, and refuses to verify one", async () => {
      const fayda = service();
      expect(verified(await fayda.complete(await begin(fayda))).proof).toBeUndefined();
      expect(() => fayda.issueProof("s", "x")).toThrow(FaydaError);
      expect(fayda.verifyProof("a.b", "s")).toBeNull();
    });
  });

  it("is usable for a FaydaHostRefusal-based business rule", () => {
    expect(new FaydaHostRefusal("WRONG_PERSON", "Verify as the owner", 422)).toMatchObject({ code: "WRONG_PERSON", httpStatus: 422 });
  });
});
