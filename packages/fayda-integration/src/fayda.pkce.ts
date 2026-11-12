import * as crypto from "node:crypto";

/** 64 random bytes, base64url (86 characters), as EDR makes it. RFC 7636 allows 43 to 128. */
export function createCodeVerifier(): string {
  return crypto.randomBytes(64).toString("base64url");
}

/** S256: base64url(SHA-256(verifier)). The only method this package sends. */
export function codeChallengeS256(codeVerifier: string): string {
  return crypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** 32 random bytes, base64url: state, nonce and the browser binding are all this. */
export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 hex, for storing the browser binding without storing the secret itself. */
export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** What a state, code or binding value may look like before anything is looked up with it. */
export const STATE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
export const CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;
