import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { MockEsignet } from "../test/mock-esignet";
import { CLIENT_ID, WEB_REDIRECT, codeAndState, optionsFor, startMock } from "../test/fixtures";
import { FaydaClient } from "./fayda.client";
import { FaydaError } from "./fayda.errors";
import { decodeJws } from "./fayda.jose";
import { FaydaModuleOptions, resolveFaydaOptions } from "./fayda.options";
import { codeChallengeS256, createCodeVerifier, randomToken } from "./fayda.pkce";
import { createFaydaAgent, faydaCaList } from "./fayda.tls";

describe("FaydaClient", () => {
  let mock: MockEsignet;
  let privateJwk: Record<string, unknown>;
  const client = (over: Partial<FaydaModuleOptions> = {}) => new FaydaClient(resolveFaydaOptions(optionsFor(mock, privateJwk, over)));

  beforeAll(async () => ({ mock, privateJwk } = await startMock()));
  afterAll(() => mock.stop());
  beforeEach(() => mock.reset());

  /** One browser trip: authorize URL, the mock signs Abebe in, the code comes back. */
  async function tokensFor(c: FaydaClient) {
    const nonce = randomToken();
    const codeVerifier = createCodeVerifier();
    const url = c.authorizationUrl({ state: randomToken(), nonce, codeChallenge: codeChallengeS256(codeVerifier), redirectUri: WEB_REDIRECT, prompt: "login" });
    const { code } = codeAndState(mock.approve(url));
    const tokens = await c.exchangeCode({ code, codeVerifier, redirectUri: WEB_REDIRECT });
    return { tokens, nonce };
  }

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "OK";
    } catch (err) {
      return (err as FaydaError).details?.code ?? (err as Error).message;
    }
  };

  it("builds the authorize URL with EDR's parameters in EDR's order, plus nonce", () => {
    const url = new URL(
      client().authorizationUrl({ state: "s".repeat(43), nonce: "n".repeat(43), codeChallenge: "c".repeat(43), redirectUri: WEB_REDIRECT, prompt: "login" }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(mock.endpoints.authorizationEndpoint);
    expect([...url.searchParams.keys()]).toEqual([
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "state",
      "nonce",
      "code_challenge",
      "code_challenge_method",
      "acr_values",
      "claims_locales",
      "prompt",
      "claims",
    ]);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("acr_values")).toBe("mosip:idp:acr:generated-code");
    expect(url.searchParams.get("scope")).toBe("openid profile email phone address");
    expect(JSON.parse(url.searchParams.get("claims")!)).toEqual({
      userinfo: {
        name: { essential: true },
        phone_number: { essential: true },
        email: { essential: true },
        birthdate: { essential: true },
        gender: { essential: true },
        address: { essential: true },
        nationality: { essential: true },
        picture: { essential: true },
      },
      id_token: {},
    });
  });

  it("asks for fewer claims when told to", () => {
    const url = new URL(client().authorizationUrl({ state: "s", nonce: "n", codeChallenge: "c", redirectUri: WEB_REDIRECT, userinfoClaims: ["name", "birthdate"] }));
    expect(Object.keys(JSON.parse(url.searchParams.get("claims")!).userinfo)).toEqual(["name", "birthdate"]);
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("signs a client assertion as NIDP's reference does, plus a unique jti", () => {
    const now = new Date("2026-11-12T10:00:00Z");
    const assertion = client().clientAssertion(now);
    const decoded = decodeJws(assertion);
    expect(decoded.header).toEqual({ alg: "RS256" });
    const iat = Math.floor(now.getTime() / 1000);
    expect(decoded.payload).toEqual({ iss: CLIENT_ID, sub: CLIENT_ID, aud: mock.endpoints.tokenEndpoint, iat, exp: iat + 120, jti: expect.any(String) });
    const publicKey = crypto.createPublicKey(crypto.createPrivateKey({ key: privateJwk as crypto.JsonWebKey, format: "jwk" }));
    expect(crypto.verify("sha256", Buffer.from(decoded.signingInput), publicKey, decoded.signature)).toBe(true);
    expect(decodeJws(client().clientAssertion(now)).payload.jti).not.toBe(decoded.payload.jti);
    expect(decodeJws(client({ keyId: "key-2026", clientAssertion: { typ: true, jti: false } }).clientAssertion(now)).header).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "key-2026",
    });
    expect(decodeJws(client({ clientAssertion: { jti: false } }).clientAssertion(now)).payload.jti).toBeUndefined();
  });

  it("exchanges the code with EDR's form fields in EDR's order, and the mock accepts the assertion", async () => {
    const { tokens } = await tokensFor(client());
    expect(tokens.access_token).toEqual(expect.any(String));
    expect(tokens.id_token).toEqual(expect.any(String));
    expect([...mock.lastTokenForm!.keys()]).toEqual([
      "grant_type",
      "code",
      "redirect_uri",
      "client_id",
      "client_assertion_type",
      "client_assertion",
      "code_verifier",
    ]);
    expect(mock.lastAssertion!.payload.aud).toBe(mock.endpoints.tokenEndpoint);
  });

  it("reports eSignet's OAuth error code and never retries a call that was sent", async () => {
    mock.behaviour.tokenStatus = 400;
    expect(await codeOf(client().exchangeCode({ code: "c", codeVerifier: "v", redirectUri: WEB_REDIRECT }))).toBe("invalid_grant");
    expect(mock.tokenCalls).toBe(1);
    mock.reset();
    mock.behaviour.tokenDelayMs = 400;
    const err = await client({ httpTimeoutMs: 150 })
      .exchangeCode({ code: "c", codeVerifier: "v", redirectUri: WEB_REDIRECT })
      .catch((e: FaydaError) => e);
    expect((err as FaydaError).kind).toBe("TIMEOUT");
    expect((err as FaydaError).details.sent).toBe(true);
    expect(mock.tokenCalls).toBe(1);
  });

  it("retries once when the connection never came up, then reports NETWORK with sent false", async () => {
    const err = await client({ tokenEndpoint: "http://127.0.0.1:1/token" })
      .exchangeCode({ code: "c", codeVerifier: "v", redirectUri: WEB_REDIRECT })
      .catch((e: FaydaError) => e);
    expect((err as FaydaError).kind).toBe("NETWORK");
    expect((err as FaydaError).details.sent).toBe(false);
  });

  it("refuses token answers without access_token or with another token_type", async () => {
    mock.behaviour.tokenAnswerExtra = { token_type: "MAC" };
    expect(await codeOf(tokensFor(client()))).toBe("TOKEN_TYPE");
    mock.behaviour.tokenAnswerExtra = { access_token: "" };
    expect(await codeOf(tokensFor(client()))).toBe("NO_ACCESS_TOKEN");
  });

  it("verifies the ID token: signature, issuer, audience, nonce", async () => {
    const c = client();
    const { tokens, nonce } = await tokensFor(c);
    const verified = await c.verifyIdToken(tokens.id_token!, { nonce, accessToken: tokens.access_token });
    expect(verified.facts.sub).toBe(mock.person.sub);
    expect(verified.facts.acr).toBe("mosip:idp:acr:generated-code");
    expect(await codeOf(c.verifyIdToken(tokens.id_token!, { nonce: "other", accessToken: tokens.access_token }))).toBe("NONCE_MISMATCH");
    expect(await codeOf(c.verifyIdToken(tokens.id_token!, { nonce, accessToken: "another-token" }))).toBe("AT_HASH_MISMATCH");
  });

  it.each([
    [{ idTokenAud: "someone-else" }, "AUDIENCE_MISMATCH"],
    [{ idTokenIss: "https://evil.example" }, "ISSUER_MISMATCH"],
    [{ idTokenAlg: "none" as const }, "ALG_NOT_ALLOWED"],
    [{ idTokenAlg: "HS256" as const }, "ALG_NOT_ALLOWED"],
    [{ idTokenExpIn: -120 }, "EXPIRED"],
    [{ idTokenNonce: "omit" }, "NO_NONCE"],
    [{ overrideKid: "not-published" }, "UNKNOWN_KID"],
  ])("refuses an ID token with %j", async (behaviour, code) => {
    Object.assign(mock.behaviour, behaviour);
    const c = client();
    const { tokens, nonce } = await tokensFor(c);
    expect(await codeOf(c.verifyIdToken(tokens.id_token!, { nonce, accessToken: tokens.access_token }))).toBe(code);
  });

  it("follows a key rotation: an unknown kid refetches the key set", async () => {
    const c = client();
    let { tokens, nonce } = await tokensFor(c);
    await c.verifyIdToken(tokens.id_token!, { nonce, accessToken: tokens.access_token });
    const before = mock.jwksCalls;
    mock.rotateKey(true);
    await new Promise((r) => setTimeout(r, 5));
    ({ tokens, nonce } = await tokensFor(c));
    await c.verifyIdToken(tokens.id_token!, { nonce, accessToken: tokens.access_token });
    expect(mock.jwksCalls).toBe(before + 1);
  });

  it("verifies the signed userinfo and checks its sub against the ID token's", async () => {
    const c = client();
    const { tokens } = await tokensFor(c);
    const userinfo = await c.fetchUserinfo(tokens.access_token, mock.person.sub);
    expect(userinfo).toEqual({ claims: expect.objectContaining({ sub: mock.person.sub }), signed: true });
    expect(await codeOf(c.fetchUserinfo(tokens.access_token, "another-sub"))).toBe("SUB_MISMATCH");
  });

  it.each([
    [{ userinfoSignedBy: "stranger" as const }, "BAD_SIGNATURE"],
    [{ userinfoFormat: "json" as const }, "UNSIGNED_USERINFO"],
    [{ userinfoFormat: "jwe" as const }, "JWE_NOT_SUPPORTED"],
    [{ userinfoStatus: 401 }, "HTTP_401"],
    [{ userinfoExtra: { iss: "https://evil.example" } }, "ISSUER_MISMATCH"],
  ])("refuses userinfo with %j", async (behaviour, code) => {
    const c = client();
    const { tokens } = await tokensFor(c);
    Object.assign(mock.behaviour, behaviour);
    expect(await codeOf(c.fetchUserinfo(tokens.access_token, mock.person.sub))).toBe(code);
  });

  it("accepts plain JSON userinfo only when acceptJsonUserinfo is on, and marks it unsigned", async () => {
    const c = client({ acceptJsonUserinfo: true });
    const { tokens } = await tokensFor(c);
    mock.behaviour.userinfoFormat = "json";
    expect((await c.fetchUserinfo(tokens.access_token, mock.person.sub)).signed).toBe(false);
  });

  it("retries userinfo once after a 5xx", async () => {
    const c = client();
    const { tokens } = await tokensFor(c);
    mock.behaviour.userinfoFailTimes = 1;
    expect((await c.fetchUserinfo(tokens.access_token, mock.person.sub)).signed).toBe(true);
    expect(mock.userinfoCalls).toBe(2);
  });

  it("refuses to start with missing options or insecureTls for a fayda.et host", () => {
    expect(() => client({ clientId: "", jwksUri: "" })).toThrow(/clientId, jwksUri/);
    expect(() => client({ tokenEndpoint: "https://esignet.ida.fayda.et/v1/esignet/oauth/v2/token", insecureTls: true })).toThrow(/insecureTls/);
    expect(() => client({ enabled: false, clientId: "" })).not.toThrow();
  });

  it("adds a ca to Node's roots instead of replacing them", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const list = faydaCaList({ ca: pem, insecureTls: false })!;
    expect(list.length).toBe(tls.rootCertificates.length + 1);
    expect(list[list.length - 1]).toBe(pem);
    expect(faydaCaList({ insecureTls: false })).toBeUndefined();
    expect(createFaydaAgent({ insecureTls: false }).options.rejectUnauthorized).toBe(true);
  });
});
