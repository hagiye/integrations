import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for eSignet with its own crypto (nothing from src/): RSA keys made at start,
 * its own JWS signing, its own check of our client assertion against the public key registered
 * for the client, and its own PKCE check. It answers what the real one is understood to answer:
 * a code on the redirect, a token answer with a signed ID token, a signed JWT userinfo
 * (application/jwt), and a JWKS.
 *
 * `behaviour` breaks one thing at a time (wrong nonce, wrong audience, userinfo signed by a
 * stranger, JSON userinfo, an error status...). No key here is real: every one is generated.
 */
export interface MockPerson {
  sub: string;
  claims: Record<string, unknown>;
}

export interface MockBehaviour {
  /** "echo" (default) puts the authorize nonce in the ID token. */
  idTokenNonce: "echo" | "omit" | string;
  idTokenAud?: string | string[];
  idTokenIss?: string;
  /** Seconds added to now for exp. Default 300. */
  idTokenExpIn: number;
  omitIdToken: boolean;
  /** "none" and "HS256" make an unsigned or HMAC token: both must be refused. */
  idTokenAlg: "RS256" | "none" | "HS256";
  /** Default "jwt". */
  userinfoFormat: "jwt" | "json" | "jwe";
  /** "stranger": signed by a key that is not in the JWKS (but with the published kid). */
  userinfoSignedBy: "current" | "stranger";
  /** A different sub in the userinfo than in the ID token. */
  userinfoSub?: string;
  /** Extra claims put into the userinfo (iss, aud...). */
  userinfoExtra: Record<string, unknown>;
  /** Fields merged into the token answer (token_type: "MAC"...). */
  tokenAnswerExtra: Record<string, unknown>;
  /** Make the token endpoint answer this status with {error}. */
  tokenStatus?: number;
  tokenError: string;
  tokenDelayMs: number;
  userinfoStatus?: number;
  /** Fail userinfo with 503 this many times first. */
  userinfoFailTimes: number;
  jwksStatus?: number;
  /** Sign every token with this kid header instead of the current key's. */
  overrideKid?: string;
}

const defaults = (): MockBehaviour => ({
  idTokenNonce: "echo",
  idTokenExpIn: 300,
  omitIdToken: false,
  idTokenAlg: "RS256",
  userinfoFormat: "jwt",
  userinfoSignedBy: "current",
  userinfoExtra: {},
  tokenAnswerExtra: {},
  tokenError: "invalid_grant",
  tokenDelayMs: 0,
  userinfoFailTimes: 0,
});

interface SigningKey {
  kid: string;
  privateKey: crypto.KeyObject;
  publicJwk: Record<string, unknown>;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce?: string;
  person: MockPerson;
  used: boolean;
}

const b64 = (data: Buffer | string) => (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64url");

function makeKey(): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = crypto.randomBytes(8).toString("hex");
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { kid, privateKey, publicJwk: { ...jwk, kid, use: "sig", alg: "RS256" } };
}

function sign(payload: Record<string, unknown>, key: SigningKey, alg: "RS256" | "none" | "HS256", kid?: string): string {
  const header: Record<string, unknown> = { alg, typ: "JWT", kid: kid ?? key.kid };
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  if (alg === "none") return `${input}.`;
  if (alg === "HS256") {
    // The classic confusion attack: the public key's JSON as an HMAC secret.
    return `${input}.${b64(crypto.createHmac("sha256", JSON.stringify(key.publicJwk)).update(input).digest())}`;
  }
  return `${input}.${b64(crypto.sign("sha256", Buffer.from(input), key.privateKey))}`;
}

export class MockEsignet {
  behaviour: MockBehaviour = defaults();
  /** People who sign in, by the authorize "login_hint" we pass in tests, else `person`. */
  person: MockPerson = { sub: "mock-sub-0001", claims: {} };
  tokenCalls = 0;
  userinfoCalls = 0;
  jwksCalls = 0;
  lastAuthorizeParams: URLSearchParams | undefined;
  lastTokenForm: URLSearchParams | undefined;
  lastAssertion: { header: Record<string, unknown>; payload: Record<string, unknown> } | undefined;

  private server: http.Server | undefined;
  private port = 0;
  private keys: SigningKey[] = [makeKey()];
  private readonly stranger = makeKey();
  private readonly clients = new Map<string, { publicJwk: Record<string, unknown>; redirectUris: string[] }>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, { person: MockPerson; clientId: string }>();
  private readonly seenJti = new Set<string>();

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get issuer(): string {
    return `${this.baseUrl}/v1/esignet`;
  }
  get endpoints() {
    return {
      issuer: this.issuer,
      authorizationEndpoint: `${this.baseUrl}/authorize`,
      tokenEndpoint: `${this.baseUrl}/v1/esignet/oauth/v2/token`,
      userinfoEndpoint: `${this.baseUrl}/v1/esignet/oidc/userinfo`,
      jwksUri: `${this.baseUrl}/v1/esignet/oauth/.well-known/jwks.json`,
    };
  }

  registerClient(clientId: string, publicJwk: Record<string, unknown>, redirectUris: string[]): void {
    this.clients.set(clientId, { publicJwk, redirectUris });
  }

  /** A new current signing key; the old one stays published unless dropOld. */
  rotateKey(dropOld = false): void {
    const next = makeKey();
    this.keys = dropOld ? [next] : [next, ...this.keys];
  }

  reset(): void {
    this.behaviour = defaults();
    this.tokenCalls = 0;
    this.userinfoCalls = 0;
    this.jwksCalls = 0;
    this.lastAuthorizeParams = undefined;
    this.lastTokenForm = undefined;
    this.lastAssertion = undefined;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void this.route(req, Buffer.concat(chunks).toString("utf8"), res).catch(() => {
          res.writeHead(500).end();
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /**
   * What the browser trip through eSignet ends with: checks the authorize URL as eSignet would,
   * "signs the person in" and returns the redirect back (redirect_uri?code&state).
   */
  approve(authorizationUrl: string, person: MockPerson = this.person): string {
    const answer = this.authorize(new URL(authorizationUrl).searchParams, person);
    if (answer.status !== 302) throw new Error(`mock authorize refused: ${answer.error}`);
    return answer.location!;
  }

  /** The redirect eSignet sends when the person cancels. */
  cancel(authorizationUrl: string): string {
    const params = new URL(authorizationUrl).searchParams;
    const back = new URL(params.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "User cancelled");
    back.searchParams.set("state", params.get("state")!);
    return back.toString();
  }

  private authorize(params: URLSearchParams, person: MockPerson): { status: number; location?: string; error?: string } {
    this.lastAuthorizeParams = params;
    const clientId = params.get("client_id") ?? "";
    const client = this.clients.get(clientId);
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!client) return { status: 400, error: "unknown client" };
    if (!client.redirectUris.includes(redirectUri)) return { status: 400, error: "redirect_uri not registered" };
    if (params.get("response_type") !== "code") return { status: 400, error: "response_type" };
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) return { status: 400, error: "pkce" };
    if (!params.get("state")) return { status: 400, error: "state" };
    try {
      JSON.parse(params.get("claims") ?? "");
    } catch {
      return { status: 400, error: "claims" };
    }
    const code = crypto.randomBytes(24).toString("base64url");
    this.codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: params.get("code_challenge")!,
      nonce: params.get("nonce") ?? undefined,
      person,
      used: false,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state")!);
    return { status: 302, location: back.toString() };
  }

  private async route(req: http.IncomingMessage, body: string, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const send = (status: number, payload: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (req.method === "GET" && url.pathname === "/authorize") {
      const answer = this.authorize(url.searchParams, this.person);
      if (answer.status === 302) {
        res.writeHead(302, { location: answer.location! });
        res.end();
      } else send(answer.status, { error: answer.error });
      return;
    }
    if (req.method === "GET" && url.pathname === new URL(this.endpoints.jwksUri).pathname) {
      this.jwksCalls += 1;
      if (this.behaviour.jwksStatus) return send(this.behaviour.jwksStatus, { error: "unavailable" });
      return send(200, { keys: this.keys.map((k) => k.publicJwk) });
    }
    if (req.method === "POST" && url.pathname === new URL(this.endpoints.tokenEndpoint).pathname) {
      this.tokenCalls += 1;
      if (this.behaviour.tokenDelayMs) await new Promise((r) => setTimeout(r, this.behaviour.tokenDelayMs));
      return this.token(req, body, send);
    }
    if (req.method === "GET" && url.pathname === new URL(this.endpoints.userinfoEndpoint).pathname) {
      this.userinfoCalls += 1;
      return this.userinfo(req, send);
    }
    send(404, { error: "not_found" });
  }

  private token(req: http.IncomingMessage, body: string, send: (status: number, payload: unknown, type?: string) => void): void {
    if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
      return send(400, { error: "invalid_request" });
    }
    const form = new URLSearchParams(body);
    this.lastTokenForm = form;
    if (this.behaviour.tokenStatus) return send(this.behaviour.tokenStatus, { error: this.behaviour.tokenError, error_description: "x" });
    if (form.get("grant_type") !== "authorization_code") return send(400, { error: "unsupported_grant_type" });
    const issued = this.codes.get(form.get("code") ?? "");
    if (!issued || issued.used) return send(400, { error: "invalid_grant" });
    issued.used = true;
    if (form.get("redirect_uri") !== issued.redirectUri) return send(400, { error: "invalid_grant" });
    if (form.get("client_id") !== issued.clientId) return send(400, { error: "invalid_client" });
    if (form.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
      return send(400, { error: "invalid_client" });
    }
    if (!this.assertionOk(form.get("client_assertion") ?? "", issued.clientId)) return send(401, { error: "invalid_client" });
    const verifier = form.get("code_verifier") ?? "";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== issued.codeChallenge) return send(400, { error: "invalid_grant" });

    const accessToken = crypto.randomBytes(24).toString("base64url");
    this.accessTokens.set(accessToken, { person: issued.person, clientId: issued.clientId });
    const now = Math.floor(Date.now() / 1000);
    const atHash = b64(crypto.createHash("sha256").update(accessToken).digest().subarray(0, 16));
    const idClaims: Record<string, unknown> = {
      iss: this.behaviour.idTokenIss ?? this.issuer,
      sub: issued.person.sub,
      aud: this.behaviour.idTokenAud ?? issued.clientId,
      exp: now + this.behaviour.idTokenExpIn,
      iat: now,
      auth_time: now - 5,
      acr: "mosip:idp:acr:generated-code",
      at_hash: atHash,
    };
    const nonce = this.behaviour.idTokenNonce;
    if (nonce === "echo") {
      if (issued.nonce) idClaims.nonce = issued.nonce;
    } else if (nonce !== "omit") idClaims.nonce = nonce;
    const answer: Record<string, unknown> = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 300,
      ...this.behaviour.tokenAnswerExtra,
    };
    if (!this.behaviour.omitIdToken) {
      answer.id_token = sign(idClaims, this.keys[0], this.behaviour.idTokenAlg, this.behaviour.overrideKid);
    }
    send(200, answer);
  }

  private assertionOk(assertion: string, clientId: string): boolean {
    const client = this.clients.get(clientId);
    const parts = assertion.split(".");
    if (!client || parts.length !== 3) return false;
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return false;
    }
    this.lastAssertion = { header, payload };
    if (header.alg !== "RS256" && header.alg !== "PS256") return false;
    const key = crypto.createPublicKey({ key: client.publicJwk as crypto.JsonWebKey, format: "jwk" });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], "base64url");
    const ok =
      header.alg === "RS256"
        ? crypto.verify("sha256", data, key, signature)
        : crypto.verify("sha256", data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
    if (!ok) return false;
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== clientId || payload.sub !== clientId) return false;
    if (payload.aud !== this.endpoints.tokenEndpoint) return false;
    if (typeof payload.exp !== "number" || payload.exp < now) return false;
    if (typeof payload.iat !== "number" || payload.exp - payload.iat > 300) return false;
    if (typeof payload.jti === "string") {
      if (this.seenJti.has(payload.jti)) return false;
      this.seenJti.add(payload.jti);
    }
    return true;
  }

  private userinfo(req: http.IncomingMessage, send: (status: number, payload: unknown, type?: string) => void): void {
    if (this.behaviour.userinfoFailTimes > 0) {
      this.behaviour.userinfoFailTimes -= 1;
      return send(503, { error: "unavailable" });
    }
    if (this.behaviour.userinfoStatus) return send(this.behaviour.userinfoStatus, { error: "x" });
    const auth = req.headers.authorization ?? "";
    const holder = this.accessTokens.get(auth.replace(/^Bearer\s+/i, ""));
    if (!holder) return send(401, { error: "invalid_token" });
    const claims = { ...holder.person.claims, sub: this.behaviour.userinfoSub ?? holder.person.sub, ...this.behaviour.userinfoExtra };
    if (this.behaviour.userinfoFormat === "json") return send(200, claims);
    if (this.behaviour.userinfoFormat === "jwe") return send(200, "a.b.c.d.e", "application/jwt");
    const key = this.behaviour.userinfoSignedBy === "stranger" ? { ...this.stranger, kid: this.keys[0].kid } : this.keys[0];
    send(200, sign(claims, key, "RS256", this.behaviour.overrideKid), "application/jwt");
  }
}

/** A throwaway RSA key pair for our client, as JWKs. */
export function makeClientKey(): { privateJwk: Record<string, unknown>; publicJwk: Record<string, unknown> } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
    publicJwk: publicKey.export({ format: "jwk" }) as Record<string, unknown>,
  };
}

/** A person shaped like eSignet's userinfo for a Fayda holder (fictitious). */
export function abebe(sub = "esignet-psut-abebe-0001"): MockPerson {
  return {
    sub,
    claims: {
      name: "Abebe Bekele Tesfaye",
      "name#en": "Abebe Bekele Tesfaye",
      "name#am": "አበበ በቀለ ተስፋዬ",
      "gender#en": "Male",
      "gender#am": "ወንድ",
      birthdate: "1990/05/01",
      phone_number: "0911223344",
      email: "Abebe.Bekele@Example.com",
      "address#en": { "region#en": "Addis Ababa", "woreda#en": "Woreda 03", "subCity#en": "Bole" },
      "address#am": { "region#am": "አዲስ አበባ" },
      nationality: "ETH",
      picture: "data:image/jpeg;base64,AAAA",
    },
  };
}
