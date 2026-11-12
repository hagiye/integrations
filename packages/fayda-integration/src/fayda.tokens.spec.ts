import { FaydaError } from "./fayda.errors";
import { halfHash } from "./fayda.jose";
import { IdTokenExpectations, checkIdTokenClaims, checkUserinfoClaims } from "./fayda.tokens";

const now = 1_800_000_000;
const expect_: IdTokenExpectations = {
  issuer: "https://esignet.example/v1/esignet",
  clientId: "client-1",
  nonce: "nonce-abc",
  accessToken: "access-xyz",
  alg: "RS256",
  nowSeconds: now,
  clockSkewSeconds: 60,
  requireNonce: true,
  acrValues: ["mosip:idp:acr:generated-code"],
  enforceAcr: false,
};
const good = () => ({
  iss: expect_.issuer,
  aud: "client-1",
  sub: "psut-1",
  exp: now + 300,
  iat: now - 5,
  nonce: "nonce-abc",
  at_hash: halfHash("access-xyz", "RS256"),
  acr: "mosip:idp:acr:generated-code",
  auth_time: now - 10,
});

const codeOf = (claims: Record<string, unknown>, over: Partial<IdTokenExpectations> = {}) => {
  try {
    checkIdTokenClaims(claims, { ...expect_, ...over });
    return "OK";
  } catch (err) {
    return (err as FaydaError).details.code;
  }
};

describe("checkIdTokenClaims", () => {
  it("accepts a good token and returns sub, acr and auth_time", () => {
    const facts = checkIdTokenClaims(good(), expect_);
    expect(facts).toEqual({ sub: "psut-1", acr: "mosip:idp:acr:generated-code", authTime: new Date((now - 10) * 1000) });
  });

  it("checks the issuer, the audience and azp", () => {
    expect(codeOf({ ...good(), iss: "https://evil" })).toBe("ISSUER_MISMATCH");
    expect(codeOf({ ...good(), aud: "client-2" })).toBe("AUDIENCE_MISMATCH");
    expect(codeOf({ ...good(), aud: ["client-1", "client-2"] })).toBe("AZP_MISMATCH");
    expect(codeOf({ ...good(), aud: ["client-1", "client-2"], azp: "client-1" })).toBe("OK");
    expect(codeOf({ ...good(), aud: ["client-1"] })).toBe("OK");
    expect(codeOf({ ...good(), azp: "client-2" })).toBe("AZP_MISMATCH");
    expect(codeOf({ ...good(), aud: 5 })).toBe("AUDIENCE_MISMATCH");
  });

  it("checks exp, iat and nbf with the clock skew", () => {
    expect(codeOf({ ...good(), exp: now - 61 })).toBe("EXPIRED");
    expect(codeOf({ ...good(), exp: now - 30 })).toBe("OK");
    expect(codeOf({ ...good(), exp: undefined })).toBe("NO_EXP");
    expect(codeOf({ ...good(), iat: now + 120 })).toBe("IAT_IN_FUTURE");
    expect(codeOf({ ...good(), iat: undefined })).toBe("NO_IAT");
    expect(codeOf({ ...good(), nbf: now + 120 })).toBe("NOT_YET_VALID");
  });

  it("checks the nonce, and refuses a token without one unless requireNonce is off", () => {
    expect(codeOf({ ...good(), nonce: "other" })).toBe("NONCE_MISMATCH");
    expect(codeOf({ ...good(), nonce: undefined })).toBe("NO_NONCE");
    expect(codeOf({ ...good(), nonce: undefined }, { requireNonce: false })).toBe("OK");
    expect(codeOf({ ...good(), nonce: 12 })).toBe("NONCE_MISMATCH");
  });

  it("checks sub, at_hash, and acr when enforced", () => {
    expect(codeOf({ ...good(), sub: "" })).toBe("NO_SUB");
    expect(codeOf({ ...good(), at_hash: halfHash("other", "RS256") })).toBe("AT_HASH_MISMATCH");
    expect(codeOf({ ...good(), at_hash: undefined })).toBe("OK");
    expect(codeOf({ ...good(), acr: "mosip:idp:acr:password" }, { enforceAcr: true })).toBe("ACR_NOT_REQUESTED");
    expect(codeOf({ ...good(), acr: "mosip:idp:acr:password" })).toBe("OK");
  });
});

describe("checkUserinfoClaims", () => {
  const base = { sub: "psut-1", issuer: expect_.issuer, clientId: "client-1" };
  const run = (claims: Record<string, unknown>, ...rest: [string | undefined] | []) => {
    const sub = rest.length === 0 ? "psut-1" : rest[0];
    try {
      checkUserinfoClaims(claims, { ...base, sub });
      return "OK";
    } catch (err) {
      return (err as FaydaError).details.code;
    }
  };

  it("needs the ID token's sub, and checks iss and aud only when present", () => {
    expect(run({ sub: "psut-1" })).toBe("OK");
    expect(run({ sub: "psut-2" })).toBe("SUB_MISMATCH");
    expect(run({})).toBe("NO_SUB");
    expect(run({ sub: "psut-1", iss: "https://evil" })).toBe("ISSUER_MISMATCH");
    expect(run({ sub: "psut-1", aud: "client-2" })).toBe("AUDIENCE_MISMATCH");
    expect(run({ sub: "psut-1", iss: expect_.issuer, aud: ["client-1"] })).toBe("OK");
    expect(run({ sub: "anything" }, undefined)).toBe("OK");
  });
});
