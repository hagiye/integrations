import * as crypto from "node:crypto";
import { FaydaError } from "./fayda.errors";

/**
 * The little JOSE this package needs, on node:crypto only: compact JWS signing (the client
 * assertion) and verification (the ID token and the signed userinfo).
 *
 * Asymmetric algorithms only. "none" and every HMAC algorithm are refused outright, so a token
 * can never be "verified" with a public key used as an HMAC secret. Every verify call also
 * takes an allow-list, by default RS256 alone (what eSignet signs with).
 */
export type FaydaJwsAlg = "RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512" | "ES256" | "ES384" | "ES512";

export const SUPPORTED_JWS_ALGS: readonly FaydaJwsAlg[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];

/** Smallest RSA modulus accepted, for verifying and for our own signing key. */
export const MIN_RSA_BITS = 2048;

export interface JwsHeader {
  alg: string;
  kid?: string;
  typ?: string;
  crit?: unknown;
  [name: string]: unknown;
}

export interface DecodedJws {
  header: JwsHeader;
  payload: Record<string, unknown>;
  /** header.payload, the bytes the signature covers. */
  signingInput: string;
  signature: Buffer;
}

/** A public key from a JWKS, as published. */
export interface PublicJwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  key_ops?: string[];
  [name: string]: unknown;
}

export function base64UrlEncode(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64url");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function base64UrlDecode(input: string): Buffer {
  if (!BASE64URL.test(input)) throw new FaydaError("VERIFICATION", "Not base64url", { code: "NOT_BASE64URL" });
  return Buffer.from(input, "base64url");
}

function digestFor(alg: FaydaJwsAlg): "sha256" | "sha384" | "sha512" {
  if (alg.endsWith("256")) return "sha256";
  if (alg.endsWith("384")) return "sha384";
  return "sha512";
}

const EC_CURVE: Record<string, string> = { ES256: "prime256v1", ES384: "secp384r1", ES512: "secp521r1" };

function isSupportedAlg(alg: unknown): alg is FaydaJwsAlg {
  return typeof alg === "string" && (SUPPORTED_JWS_ALGS as readonly string[]).includes(alg);
}

/** Compact parts of a token, telling a JWE (5 parts) from a JWS (3 parts). */
export function compactParts(token: string): "JWS" | "JWE" | "OTHER" {
  const trimmed = token.trim();
  const count = trimmed.split(".").length;
  if (count === 3) return "JWS";
  if (count === 5) return "JWE";
  return "OTHER";
}

/** Splits and decodes a compact JWS without checking its signature. */
export function decodeJws(token: string): DecodedJws {
  const trimmed = token.trim();
  const parts = trimmed.split(".");
  if (parts.length === 5) {
    throw new FaydaError("VERIFICATION", "This is an encrypted JWT (JWE); only signed JWTs are read", { code: "JWE_NOT_SUPPORTED" });
  }
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new FaydaError("VERIFICATION", "Not a compact JWT", { code: "NOT_JWT" });
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
  } catch (err) {
    if (err instanceof FaydaError) throw err;
    throw new FaydaError("VERIFICATION", "The JWT header or payload is not JSON", { code: "NOT_JWT", cause: err });
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new FaydaError("VERIFICATION", "The JWT header is not an object", { code: "NOT_JWT" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new FaydaError("VERIFICATION", "The JWT payload is not an object", { code: "NOT_JWT" });
  }
  return {
    header: header as JwsHeader,
    payload: payload as Record<string, unknown>,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64UrlDecode(parts[2]),
  };
}

/** A JWK (public half) as a KeyObject, refused if it is not usable for signatures. */
export function importPublicJwk(jwk: PublicJwk): crypto.KeyObject {
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new FaydaError("VERIFICATION", "The key is not a signing key", { code: "KEY_NOT_FOR_SIGNING" });
  }
  if (jwk.kty !== "RSA" && jwk.kty !== "EC") {
    throw new FaydaError("VERIFICATION", `Key type ${String(jwk.kty)} is not supported`, { code: "KEY_TYPE" });
  }
  // Only the public members, so a JWKS that leaked a private key still imports as public.
  const members =
    jwk.kty === "RSA" ? { kty: "RSA", n: jwk.n, e: jwk.e } : { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
  try {
    return crypto.createPublicKey({ key: members as crypto.JsonWebKey, format: "jwk" });
  } catch (err) {
    throw new FaydaError("VERIFICATION", "The key does not import", { code: "KEY_IMPORT", cause: err });
  }
}

/** Whether `key` fits `alg`: RSA of at least MIN_RSA_BITS for RS and PS, the right curve for ES. */
export function keyFitsAlg(key: crypto.KeyObject, alg: FaydaJwsAlg): boolean {
  const details = key.asymmetricKeyDetails ?? {};
  if (alg.startsWith("RS") || alg.startsWith("PS")) {
    return (key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss") && (details.modulusLength ?? 0) >= MIN_RSA_BITS;
  }
  return key.asymmetricKeyType === "ec" && details.namedCurve === EC_CURVE[alg];
}

function verifyRaw(alg: FaydaJwsAlg, key: crypto.KeyObject, data: Buffer, signature: Buffer): boolean {
  const digest = digestFor(alg);
  if (alg.startsWith("RS")) {
    return crypto.verify(digest, data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  }
  if (alg.startsWith("PS")) {
    return crypto.verify(
      digest,
      data,
      { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
      signature,
    );
  }
  return crypto.verify(digest, data, { key, dsaEncoding: "ieee-p1363" }, signature);
}

export interface VerifyJwsOptions {
  /** The algorithms accepted. Must not be empty. */
  allowedAlgs: readonly FaydaJwsAlg[];
  /**
   * The candidate keys, already chosen for this token (by kid where it has one). The signature
   * must verify under one of them.
   */
  keys: readonly PublicJwk[];
}

/**
 * Checks a compact JWS: header alg on the allow-list (never none, never HMAC), no crit header,
 * the signature valid under one of the candidate keys. Returns the decoded token. Throws
 * FaydaError VERIFICATION with a code: NOT_JWT, JWE_NOT_SUPPORTED, ALG_NOT_ALLOWED, CRIT,
 * NO_KEY, BAD_SIGNATURE.
 */
export function verifyJws(token: string, options: VerifyJwsOptions): DecodedJws {
  const decoded = decodeJws(token);
  const alg = decoded.header.alg;
  if (!isSupportedAlg(alg) || !options.allowedAlgs.includes(alg)) {
    throw new FaydaError("VERIFICATION", `Signature algorithm ${String(alg)} is not accepted`, { code: "ALG_NOT_ALLOWED" });
  }
  if (decoded.header.crit !== undefined) {
    throw new FaydaError("VERIFICATION", "The JWT names critical extensions this package does not understand", { code: "CRIT" });
  }
  const data = Buffer.from(decoded.signingInput, "ascii");
  let usable = 0;
  for (const jwk of options.keys) {
    if (jwk.alg !== undefined && jwk.alg !== alg) continue;
    let key: crypto.KeyObject;
    try {
      key = importPublicJwk(jwk);
    } catch {
      continue;
    }
    if (!keyFitsAlg(key, alg)) continue;
    usable += 1;
    let ok = false;
    try {
      ok = verifyRaw(alg, key, data, decoded.signature);
    } catch {
      ok = false;
    }
    if (ok) return decoded;
  }
  if (usable === 0) {
    throw new FaydaError("VERIFICATION", "No published key fits this token", { code: "NO_KEY" });
  }
  throw new FaydaError("VERIFICATION", "The JWT signature does not verify", { code: "BAD_SIGNATURE" });
}

/** Signs a compact JWS with our private key. */
export function signJws(
  payload: Record<string, unknown>,
  key: crypto.KeyObject,
  header: { alg: FaydaJwsAlg; kid?: string; typ?: string },
): string {
  const protectedHeader: Record<string, unknown> = { alg: header.alg };
  if (header.typ) protectedHeader.typ = header.typ;
  if (header.kid) protectedHeader.kid = header.kid;
  const signingInput = `${base64UrlEncode(JSON.stringify(protectedHeader))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const data = Buffer.from(signingInput, "ascii");
  const digest = digestFor(header.alg);
  let signature: Buffer;
  if (header.alg.startsWith("RS")) {
    signature = crypto.sign(digest, data, { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  } else if (header.alg.startsWith("PS")) {
    signature = crypto.sign(digest, data, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else {
    signature = crypto.sign(digest, data, { key, dsaEncoding: "ieee-p1363" });
  }
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Our signing key from what a deployment has: a JWK object, a JWK as JSON text, the JWK as
 * base64 of its JSON (EDR's FAYDA_PRIVATE_KEY_BASE64), or a PEM private key. Must be an RSA
 * private key of at least MIN_RSA_BITS. Throws FaydaError CONFIG with a message that never
 * holds key material.
 */
export function importPrivateKey(input: unknown): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    if (input && typeof input === "object" && !Buffer.isBuffer(input)) {
      key = crypto.createPrivateKey({ key: input as crypto.JsonWebKey, format: "jwk" });
    } else if (typeof input === "string" || Buffer.isBuffer(input)) {
      const text = (Buffer.isBuffer(input) ? input.toString("utf8") : input).trim();
      if (text.startsWith("-----BEGIN")) {
        key = crypto.createPrivateKey({ key: text, format: "pem" });
      } else if (text.startsWith("{")) {
        key = crypto.createPrivateKey({ key: JSON.parse(text) as crypto.JsonWebKey, format: "jwk" });
      } else {
        const decoded = Buffer.from(text, "base64").toString("utf8").trim();
        if (!decoded.startsWith("{")) throw new Error("not base64 of a JSON JWK");
        key = crypto.createPrivateKey({ key: JSON.parse(decoded) as crypto.JsonWebKey, format: "jwk" });
      }
    } else {
      throw new Error("no key");
    }
  } catch {
    // No cause on purpose: JSON.parse messages quote the text they failed on, which is the key.
    throw new FaydaError(
      "CONFIG",
      "privateKey is not an RSA private key (JWK object, JWK JSON, base64 of a JWK, or PEM)",
      { code: "PRIVATE_KEY" },
    );
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
    throw new FaydaError("CONFIG", "privateKey must be an RSA private key", { code: "PRIVATE_KEY" });
  }
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) {
    throw new FaydaError("CONFIG", `privateKey must be at least ${MIN_RSA_BITS} bits`, { code: "PRIVATE_KEY" });
  }
  return key;
}

/** Constant-time string comparison; false for different lengths or non-strings. */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** OIDC at_hash / c_hash: base64url of the left half of the hash of the ASCII value. */
export function halfHash(value: string, alg: FaydaJwsAlg): string {
  const digest = crypto.createHash(digestFor(alg)).update(value, "ascii").digest();
  return base64UrlEncode(digest.subarray(0, digest.length / 2));
}
