import * as crypto from "node:crypto";
import { FaydaModuleOptions, missingFaydaOptions, resolveFaydaOptions } from "./fayda.options";

const jwk = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
const complete = (over: Partial<FaydaModuleOptions> = {}): FaydaModuleOptions => ({
  clientId: " client-1 ",
  issuer: "https://esignet.example/v1/esignet",
  authorizationEndpoint: "https://esignet.example/authorize",
  tokenEndpoint: "https://esignet.example/v1/esignet/oauth/v2/token",
  userinfoEndpoint: "https://esignet.example/v1/esignet/oidc/userinfo",
  jwksUri: "https://esignet.example/v1/esignet/oauth/.well-known/jwks.json",
  privateKey: Buffer.from(JSON.stringify(jwk)).toString("base64"),
  redirectUris: { WEB: "https://office.example/fayda/callback", MOBILE: "https://api.example/fayda/callback" },
  ...over,
});

describe("resolveFaydaOptions", () => {
  it("fills EDR's defaults", () => {
    const resolved = resolveFaydaOptions(complete());
    expect(resolved).toMatchObject({
      enabled: true,
      clientId: "client-1",
      scope: "openid profile email phone address",
      acrValues: "mosip:idp:acr:generated-code",
      claimsLocales: "en am",
      prompt: "login",
      sessionTtlMs: 600_000,
      clockSkewSeconds: 60,
      idTokenAlgs: ["RS256"],
      requireIdToken: true,
      requireNonce: true,
      acceptJsonUserinfo: false,
      defaultChannel: "WEB",
      clientAssertion: { alg: "RS256", typ: false, jti: true, lifetimeSeconds: 120 },
      httpTimeoutMs: 10_000,
      browserBinding: { unboundChannels: ["MOBILE"], cookiePrefix: "fayda_b_", secureCookie: true, sameSite: "Lax" },
      proof: undefined,
    });
    expect(resolved.userinfoClaims).toEqual(["name", "phone_number", "email", "birthdate", "gender", "address", "nationality", "picture"]);
    expect(resolved.privateKey?.asymmetricKeyType).toBe("rsa");
    expect(missingFaydaOptions(resolved)).toEqual([]);
  });

  it("drops prompt with false, and clamps the assertion lifetime", () => {
    const resolved = resolveFaydaOptions(complete({ prompt: false, clientAssertion: { lifetimeSeconds: 3600 } }));
    expect(resolved.prompt).toBeUndefined();
    expect(resolved.clientAssertion.lifetimeSeconds).toBe(300);
  });

  it("takes the first channel as default when there is no WEB", () => {
    expect(resolveFaydaOptions(complete({ redirectUris: { PORTAL: "https://p.example/cb" } })).defaultChannel).toBe("PORTAL");
  });
});

describe("missingFaydaOptions", () => {
  it("names what is missing, never with values", () => {
    const problems = missingFaydaOptions(
      resolveFaydaOptions({ clientId: "", issuer: "", authorizationEndpoint: "", tokenEndpoint: "", userinfoEndpoint: "", jwksUri: "", privateKey: undefined, redirectUris: {} }),
    );
    expect(problems).toEqual([
      "clientId",
      "issuer",
      "authorizationEndpoint",
      "tokenEndpoint",
      "userinfoEndpoint",
      "jwksUri",
      "privateKey",
      "redirectUris",
    ]);
  });

  it("refuses plain http except on loopback, a bad key, a fragment, an unknown default channel", () => {
    const problems = missingFaydaOptions(
      resolveFaydaOptions(
        complete({
          tokenEndpoint: "http://esignet.example/token",
          jwksUri: "http://127.0.0.1:9/jwks",
          privateKey: "NOT-A-KEY-but-secret-looking",
          redirectUris: { WEB: "https://office.example/cb#frag" },
          defaultChannel: "PORTAL",
        }),
      ),
    );
    expect(problems).toContain("tokenEndpoint (must be https)");
    expect(problems.join()).not.toContain("jwksUri");
    expect(problems.some((p) => p.startsWith("privateKey ("))).toBe(true);
    expect(problems.join()).not.toContain("NOT-A-KEY");
    expect(problems).toContain("redirectUris.WEB (no fragment allowed)");
    expect(problems).toContain("defaultChannel (not in redirectUris)");
  });

  it("refuses insecureTls for fayda.et hosts, and short proof secrets", () => {
    const problems = missingFaydaOptions(
      resolveFaydaOptions(
        complete({
          tokenEndpoint: "https://esignet.ida.fayda.et/v1/esignet/oauth/v2/token",
          insecureTls: true,
          proof: { secret: "short" },
        }),
      ),
    );
    expect(problems).toContain("insecureTls (refused for esignet.ida.fayda.et)");
    expect(problems).toContain("proof.secret (at least 32 characters)");
  });
});
