import { FaydaError } from "./fayda.errors";
import { FaydaJwsAlg, halfHash, safeEqual } from "./fayda.jose";

export interface IdTokenExpectations {
  issuer: string;
  clientId: string;
  /** The nonce stored with the session. */
  nonce: string;
  /** The access token from the same answer, for at_hash when the ID token carries one. */
  accessToken: string;
  /** The alg the token was signed with (for at_hash). */
  alg: FaydaJwsAlg;
  nowSeconds: number;
  clockSkewSeconds: number;
  /** When true, an ID token without a nonce is refused. */
  requireNonce: boolean;
  /** The acr values asked for; with enforceAcr, an acr outside them is refused. */
  acrValues: string[];
  enforceAcr: boolean;
}

export interface IdTokenFacts {
  sub: string;
  acr?: string;
  authTime?: Date;
}

const fail = (code: string, message: string): never => {
  throw new FaydaError("VERIFICATION", message, { code });
};

function audienceList(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud) && aud.every((a) => typeof a === "string")) return aud as string[];
  return [];
}

/**
 * The OIDC Core 3.1.3.7 checks on a verified ID token's claims: iss, aud (and azp when there
 * are several audiences), exp, iat, nbf, nonce, sub, at_hash, and acr when enforced.
 */
export function checkIdTokenClaims(claims: Record<string, unknown>, expect: IdTokenExpectations): IdTokenFacts {
  if (claims.iss !== expect.issuer) fail("ISSUER_MISMATCH", "The ID token was not issued by the configured issuer");
  const audiences = audienceList(claims.aud);
  if (!audiences.includes(expect.clientId)) fail("AUDIENCE_MISMATCH", "The ID token is not for this client");
  if (audiences.length > 1 && claims.azp !== expect.clientId) {
    fail("AZP_MISMATCH", "The ID token has several audiences and its azp is not this client");
  }
  if (claims.azp !== undefined && claims.azp !== expect.clientId) fail("AZP_MISMATCH", "The ID token's azp is not this client");
  const now = expect.nowSeconds;
  const skew = expect.clockSkewSeconds;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) fail("NO_EXP", "The ID token has no expiry");
  if ((claims.exp as number) + skew <= now) fail("EXPIRED", "The ID token has expired");
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) fail("NO_IAT", "The ID token has no issue time");
  if ((claims.iat as number) - skew > now) fail("IAT_IN_FUTURE", "The ID token was issued in the future");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > now)) {
    fail("NOT_YET_VALID", "The ID token is not valid yet");
  }
  if (claims.nonce === undefined) {
    if (expect.requireNonce) fail("NO_NONCE", "The ID token carries no nonce");
  } else if (!safeEqual(claims.nonce, expect.nonce)) {
    fail("NONCE_MISMATCH", "The ID token's nonce is not the one this session sent");
  }
  if (typeof claims.sub !== "string" || !claims.sub.trim()) fail("NO_SUB", "The ID token has no subject");
  if (claims.at_hash !== undefined && !safeEqual(claims.at_hash, halfHash(expect.accessToken, expect.alg))) {
    fail("AT_HASH_MISMATCH", "The ID token does not belong to this access token");
  }
  const acr = typeof claims.acr === "string" ? claims.acr : undefined;
  if (expect.enforceAcr && (!acr || !expect.acrValues.includes(acr))) {
    fail("ACR_NOT_REQUESTED", "The ID token's acr is not one of the requested values");
  }
  const authTime = typeof claims.auth_time === "number" && Number.isFinite(claims.auth_time) ? new Date(claims.auth_time * 1000) : undefined;
  return { sub: claims.sub as string, acr, authTime };
}

export interface UserinfoExpectations {
  /** The ID token's subject: the userinfo must be about the same person. Undefined: no ID token to compare with. */
  sub: string | undefined;
  issuer: string;
  clientId: string;
}

/**
 * Checks a userinfo claim set (from a verified signed JWT, or plain JSON when allowed): sub
 * equals the ID token's, and iss and aud, when present, are ours.
 */
export function checkUserinfoClaims(claims: Record<string, unknown>, expect: UserinfoExpectations): void {
  if (typeof claims.sub !== "string" || !claims.sub.trim()) fail("NO_SUB", "The userinfo has no subject");
  if (expect.sub !== undefined && !safeEqual(claims.sub, expect.sub)) fail("SUB_MISMATCH", "The userinfo is about another subject than the ID token");
  if (claims.iss !== undefined && claims.iss !== expect.issuer) fail("ISSUER_MISMATCH", "The userinfo was not issued by the configured issuer");
  if (claims.aud !== undefined && !audienceList(claims.aud).includes(expect.clientId)) {
    fail("AUDIENCE_MISMATCH", "The userinfo is not for this client");
  }
}
