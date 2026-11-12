import * as crypto from "node:crypto";
import { FaydaError } from "./fayda.errors";
import {
  PublicJwk,
  base64UrlEncode,
  compactParts,
  decodeJws,
  halfHash,
  importPrivateKey,
  safeEqual,
  signJws,
  verifyJws,
} from "./fayda.jose";

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaJwk = { ...(rsa.publicKey.export({ format: "jwk" }) as object), kid: "rsa-1", use: "sig" } as PublicJwk;
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherJwk = { ...(other.publicKey.export({ format: "jwk" }) as object), kid: "rsa-2" } as PublicJwk;
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecJwk = { ...(ec.publicKey.export({ format: "jwk" }) as object), kid: "ec-1" } as PublicJwk;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as FaydaError).details?.code ?? (err as Error).message;
  }
  return undefined;
};

/** A token made by hand, with any header. */
function rawToken(header: Record<string, unknown>, payload: Record<string, unknown>, signer?: (input: string) => Buffer): string {
  const input = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  return `${input}.${signer ? base64UrlEncode(signer(input)) : ""}`;
}

describe("JWS", () => {
  it("signs and verifies RS256, PS256 and ES256 round trips", () => {
    const rs = signJws({ a: 1 }, rsa.privateKey, { alg: "RS256", kid: "rsa-1" });
    expect(verifyJws(rs, { allowedAlgs: ["RS256"], keys: [rsaJwk] }).payload).toEqual({ a: 1 });
    const ps = signJws({ a: 2 }, rsa.privateKey, { alg: "PS256" });
    expect(verifyJws(ps, { allowedAlgs: ["PS256"], keys: [rsaJwk] }).payload).toEqual({ a: 2 });
    const es = signJws({ a: 3 }, ec.privateKey, { alg: "ES256" });
    expect(verifyJws(es, { allowedAlgs: ["ES256"], keys: [ecJwk] }).payload).toEqual({ a: 3 });
  });

  it("puts typ and kid in the header only when asked", () => {
    expect(decodeJws(signJws({}, rsa.privateKey, { alg: "RS256" })).header).toEqual({ alg: "RS256" });
    expect(decodeJws(signJws({}, rsa.privateKey, { alg: "RS256", kid: "k", typ: "JWT" })).header).toEqual({ alg: "RS256", typ: "JWT", kid: "k" });
  });

  it("refuses alg none, HMAC with the public key as secret, and algs off the allow-list", () => {
    const none = rawToken({ alg: "none" }, { sub: "x" });
    expect(codeOf(() => verifyJws(none, { allowedAlgs: ["RS256"], keys: [rsaJwk] }))).toBe("ALG_NOT_ALLOWED");
    const hs = rawToken({ alg: "HS256", kid: "rsa-1" }, { sub: "x" }, (input) =>
      crypto.createHmac("sha256", JSON.stringify(rsaJwk)).update(input).digest(),
    );
    expect(codeOf(() => verifyJws(hs, { allowedAlgs: ["RS256"], keys: [rsaJwk] }))).toBe("ALG_NOT_ALLOWED");
    const ps = signJws({}, rsa.privateKey, { alg: "PS256" });
    expect(codeOf(() => verifyJws(ps, { allowedAlgs: ["RS256"], keys: [rsaJwk] }))).toBe("ALG_NOT_ALLOWED");
  });

  it("refuses a tampered payload, the wrong key, and a key of the wrong type", () => {
    const good = signJws({ sub: "a" }, rsa.privateKey, { alg: "RS256" });
    const [h, , s] = good.split(".");
    const tampered = `${h}.${base64UrlEncode(JSON.stringify({ sub: "b" }))}.${s}`;
    expect(codeOf(() => verifyJws(tampered, { allowedAlgs: ["RS256"], keys: [rsaJwk] }))).toBe("BAD_SIGNATURE");
    expect(codeOf(() => verifyJws(good, { allowedAlgs: ["RS256"], keys: [otherJwk] }))).toBe("BAD_SIGNATURE");
    expect(codeOf(() => verifyJws(good, { allowedAlgs: ["RS256"], keys: [ecJwk] }))).toBe("NO_KEY");
  });

  it("accepts the token when one of several candidate keys verifies it", () => {
    const good = signJws({ sub: "a" }, rsa.privateKey, { alg: "RS256" });
    expect(verifyJws(good, { allowedAlgs: ["RS256"], keys: [otherJwk, rsaJwk] }).payload.sub).toBe("a");
  });

  it("refuses keys meant for encryption, keys under 2048 bits, and a JWK alg that differs", () => {
    const good = signJws({}, rsa.privateKey, { alg: "RS256" });
    expect(codeOf(() => verifyJws(good, { allowedAlgs: ["RS256"], keys: [{ ...rsaJwk, use: "enc" }] }))).toBe("NO_KEY");
    expect(codeOf(() => verifyJws(good, { allowedAlgs: ["RS256"], keys: [{ ...rsaJwk, alg: "PS256" }] }))).toBe("NO_KEY");
    const small = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    const smallJwk = small.publicKey.export({ format: "jwk" }) as PublicJwk;
    const weak = signJws({}, small.privateKey, { alg: "RS256" });
    expect(codeOf(() => verifyJws(weak, { allowedAlgs: ["RS256"], keys: [smallJwk] }))).toBe("NO_KEY");
  });

  it("refuses crit headers, JWE, and things that are not JWTs", () => {
    const crit = rawToken({ alg: "RS256", crit: ["exp"] }, {}, (input) => crypto.sign("sha256", Buffer.from(input), rsa.privateKey));
    expect(codeOf(() => verifyJws(crit, { allowedAlgs: ["RS256"], keys: [rsaJwk] }))).toBe("CRIT");
    expect(codeOf(() => decodeJws("a.b.c.d.e"))).toBe("JWE_NOT_SUPPORTED");
    expect(codeOf(() => decodeJws("not-a-jwt"))).toBe("NOT_JWT");
    expect(codeOf(() => decodeJws(`${base64UrlEncode("[1]")}.${base64UrlEncode("{}")}.x`))).toBe("NOT_JWT");
    expect(codeOf(() => decodeJws("a+b.c.d"))).toBe("NOT_BASE64URL");
    expect(compactParts("a.b.c")).toBe("JWS");
    expect(compactParts("a.b.c.d.e")).toBe("JWE");
  });

  it("computes at_hash as the left half of SHA-256", () => {
    const full = crypto.createHash("sha256").update("token").digest();
    expect(halfHash("token", "RS256")).toBe(full.subarray(0, 16).toString("base64url"));
  });

  it("compares strings in constant time and refuses non-strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual(undefined, "a")).toBe(false);
  });
});

describe("importPrivateKey", () => {
  const jwk = rsa.privateKey.export({ format: "jwk" });
  const pem = rsa.privateKey.export({ format: "pem", type: "pkcs8" }) as string;

  it("reads a JWK object, JWK JSON, base64 of the JWK (EDR's FAYDA_PRIVATE_KEY_BASE64) and PEM", () => {
    for (const input of [jwk, JSON.stringify(jwk), Buffer.from(JSON.stringify(jwk)).toString("base64"), pem]) {
      expect(importPrivateKey(input).asymmetricKeyType).toBe("rsa");
    }
  });

  it("refuses public keys, EC keys, short keys and garbage, never quoting the input", () => {
    const secretish = "SECRET-MATERIAL-123";
    for (const input of [rsa.publicKey.export({ format: "jwk" }), ec.privateKey.export({ format: "jwk" }), secretish, "", 42]) {
      let message = "";
      try {
        importPrivateKey(input);
      } catch (err) {
        message = (err as Error).message;
        expect((err as FaydaError).kind).toBe("CONFIG");
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secretish);
    }
    const small = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => importPrivateKey(small.privateKey.export({ format: "jwk" }))).toThrow(/2048/);
  });
});
