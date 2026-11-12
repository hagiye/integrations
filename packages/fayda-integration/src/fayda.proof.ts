import * as crypto from "node:crypto";

/**
 * A short-lived receipt, signed by the host app itself, that a verification just completed for
 * `sub`. Ported from EDR passenger's fayda-proof.util.ts, plus a rotation list of secrets.
 *
 * A sub alone proves nothing: it is stable and leaks through other answers. A business step that
 * needs a fresh verification takes the proof with the sub and checks both.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA-256). Not a JWT on purpose: nothing
 * else reads it, and a two-part HMAC token has no algorithm field to get wrong.
 */
export interface FaydaProofPayload {
  /** eSignet subject. */
  sub: string;
  /** client_id the sub is pairwise to. */
  cid: string;
  /** The verification session id, so a step can record which proof it used. */
  sid: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

function mac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueFaydaProof(
  input: { sub: string; clientId: string; sessionId: string; ttlMs: number; now?: Date },
  secret: string,
): string {
  const nowMs = (input.now ?? new Date()).getTime();
  const payload: FaydaProofPayload = {
    sub: input.sub,
    cid: input.clientId,
    sid: input.sessionId,
    exp: Math.floor((nowMs + input.ttlMs) / 1000),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/**
 * The payload when the proof is well formed, signed with one of `secrets` (the current one
 * first, then older ones during a rotation), unexpired, and names expected.sub under
 * expected.clientId. Otherwise null. Never throws.
 */
export function verifyFaydaProof(
  token: unknown,
  expected: { sub: string; clientId: string; now?: Date },
  secrets: readonly string[],
): FaydaProofPayload | null {
  if (typeof token !== "string" || token.length > 4096 || secrets.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const given = Buffer.from(signature, "utf8");
  const signedByUs = secrets.some((secret) => {
    const wanted = Buffer.from(mac(body, secret), "utf8");
    return wanted.length === given.length && crypto.timingSafeEqual(wanted, given);
  });
  if (!signedByUs) return null;
  let payload: FaydaProofPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FaydaProofPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const nowSeconds = Math.floor((expected.now ?? new Date()).getTime() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds) return null;
  if (typeof payload.sub !== "string" || payload.sub !== expected.sub.trim()) return null;
  if (payload.cid !== expected.clientId) return null;
  if (typeof payload.sid !== "string") return null;
  return payload;
}
