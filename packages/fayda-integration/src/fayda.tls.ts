import * as https from "node:https";
import * as tls from "node:tls";

/** Host names insecureTls is refused for: fayda.et and every sub-domain (esignet.ida.fayda.et...). */
export function isFaydaProductionHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "fayda.et" || host.endsWith(".fayda.et");
}

export interface FaydaTlsSettings {
  ca?: string | Buffer | Array<string | Buffer>;
  insecureTls: boolean;
}

/**
 * Node's own roots plus options.ca. Passing `ca` to Node replaces its root list instead of
 * adding to it, so the roots are put back explicitly. NODE_EXTRA_CA_CERTS is not part of
 * tls.rootCertificates: a deployment behind a corporate proxy passes those certificates in ca.
 */
export function faydaCaList(settings: FaydaTlsSettings): Array<string | Buffer> | undefined {
  if (settings.ca === undefined) return undefined;
  const extra = Array.isArray(settings.ca) ? settings.ca : [settings.ca];
  return [...tls.rootCertificates, ...extra];
}

export function createFaydaAgent(settings: FaydaTlsSettings): https.Agent {
  const ca = faydaCaList(settings);
  return new https.Agent({
    keepAlive: true,
    rejectUnauthorized: !settings.insecureTls,
    ...(ca ? { ca } : {}),
  });
}
