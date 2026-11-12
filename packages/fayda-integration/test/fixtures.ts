import type { FaydaModuleOptions } from "../src";
import { MockEsignet, makeClientKey } from "./mock-esignet";

export const CLIENT_ID = "fayda-test-client";
export const WEB_REDIRECT = "https://office.example.test/fayda/callback";
export const PORTAL_REDIRECT = "https://portal.example.test/fayda/callback";
export const MOBILE_REDIRECT = "https://api.example.test/fayda/callback";
export const PROOF_SECRET = "pg-and-unit-test-proof-secret-32-chars-min";

/** A mock eSignet with our client registered, and our throwaway key. */
export async function startMock(): Promise<{ mock: MockEsignet; privateJwk: Record<string, unknown> }> {
  const mock = new MockEsignet();
  await mock.start();
  const key = makeClientKey();
  mock.registerClient(CLIENT_ID, key.publicJwk, [WEB_REDIRECT, PORTAL_REDIRECT, MOBILE_REDIRECT]);
  return { mock, privateJwk: key.privateJwk };
}

export function optionsFor(mock: MockEsignet, privateJwk: Record<string, unknown>, over: Partial<FaydaModuleOptions> = {}): FaydaModuleOptions {
  return {
    clientId: CLIENT_ID,
    ...mock.endpoints,
    privateKey: privateJwk,
    redirectUris: { WEB: WEB_REDIRECT, PORTAL: PORTAL_REDIRECT, MOBILE: MOBILE_REDIRECT },
    httpTimeoutMs: 2000,
    jwksMinRefreshSeconds: 0.001,
    browserBinding: { secureCookie: false },
    ...over,
  };
}

/** code and state from a redirect back. */
export function codeAndState(redirect: string): { code: string; state: string } {
  const params = new URL(redirect).searchParams;
  return { code: params.get("code") ?? "", state: params.get("state") ?? "" };
}
