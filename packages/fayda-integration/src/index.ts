/** Fayda (Ethiopian national ID, eSignet OpenID Connect) verification for NestJS. */
export * from "./fayda.module";
export * from "./fayda.options";
export * from "./fayda.client";
export * from "./fayda.service";
export * from "./fayda.host";
export * from "./fayda.controller";
export * from "./fayda.errors";
export * from "./fayda.types";
export * from "./fayda.proof";
export { ADDRESS_FIELD_ORDER, emailKey, formatAddress, readIdentityFields, toE164, toIsoDate } from "./fayda.claims";
export type { FaydaIdentityFields, FaydaUserinfoClaims } from "./fayda.claims";
export {
  MIN_RSA_BITS,
  SUPPORTED_JWS_ALGS,
  base64UrlDecode,
  base64UrlEncode,
  decodeJws,
  importPrivateKey,
  importPublicJwk,
  safeEqual,
  signJws,
  verifyJws,
} from "./fayda.jose";
export type { DecodedJws, FaydaJwsAlg, JwsHeader, PublicJwk } from "./fayda.jose";
export { JwksCache, parseJwks } from "./fayda.jwks";
export { checkIdTokenClaims, checkUserinfoClaims } from "./fayda.tokens";
export { codeChallengeS256, createCodeVerifier, randomToken } from "./fayda.pkce";
export { createFaydaAgent, faydaCaList, isFaydaProductionHost } from "./fayda.tls";
