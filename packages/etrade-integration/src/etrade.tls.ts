import * as https from "node:https";
import * as tls from "node:tls";

/**
 * GlobalSign GCC R3 EV TLS CA 2025: the CA that issued etrade.gov.et's certificate
 * (valid 2025-11-07 to 2026-12-09, checked 2026-11-12).
 *
 * e-trade's server sends its own certificate plus a different GlobalSign intermediate
 * ("Extended Validation CA - SHA256 - G3"), not this one, so Node cannot build a chain and
 * fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. EDR answered that by turning verification off.
 * Adding this public CA certificate, which GlobalSign Root R3 (in Node's own list) signed,
 * makes the chain complete with verification on. Checked against the live host on 2026-11-12.
 *
 * Downloaded from the leaf's Authority Information Access URL,
 * http://secure.globalsign.com/cacert/gsgccr3evtlsca2025.crt (DER, converted to PEM).
 * Valid until 2027-07-16. SHA-256 fingerprint
 * 1B:29:28:02:1A:4B:89:CF:0F:57:2A:24:36:E9:14:E2:54:12:AD:58:ED:EE:22:1E:6C:7C:3C:54:37:17:9A:26.
 *
 * When e-trade renews its certificate it may come from another CA. If the TLS error comes back,
 * read the new leaf's issuer and AIA URL (guide, section TLS) and pass that CA in options.ca.
 */
export const ETRADE_ISSUING_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIElzCCA3+gAwIBAgIRAIPahmyfUtUakxi40OfAMWkwDQYJKoZIhvcNAQELBQAw
TDEgMB4GA1UECxMXR2xvYmFsU2lnbiBSb290IENBIC0gUjMxEzARBgNVBAoTCkds
b2JhbFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMjUwNzE2MDMwNTQ2WhcN
MjcwNzE2MDAwMDAwWjBTMQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xvYmFsU2ln
biBudi1zYTEpMCcGA1UEAxMgR2xvYmFsU2lnbiBHQ0MgUjMgRVYgVExTIENBIDIw
MjUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDEG4l4CpUk556CyXIA
B3ihV2b8sWMNGwnW0wCpuaHHA5rlXpSWE1AD6r9hyGhQOrc45nPOj6Fvsqw8dFZw
FpAJzlk6FxhYP1ve8KPJvIpt6f5v28jOlzfs8c7dJ8ZmqKHB0Zj6RbAvA9vAl2A3
j0mu+ooXN3/QaFvVihDV/SRyOfFBlhPAsRk8y97tLPWx7/4YzfE6NSLKsU1yF+tf
BTttbaXTH/cWY/KQE3ZHTFRo6XouemjPBP9CDXeTR11tm37Bgn3QOj93FHdi1JJp
eNBGEOGvM8qhTV/77kDiUyOvsp4jZOhas6kIRn8nWK7fCPNdFJYi1Ctvd7gnQ1gB
lW71AgMBAAGjggFrMIIBZzAOBgNVHQ8BAf8EBAMCAYYwHQYDVR0lBBYwFAYIKwYB
BQUHAwEGCCsGAQUFBwMCMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFGMQ
f+QoM5r4R2BZUn5XEMdN+BcWMB8GA1UdIwQYMBaAFI/wS3+oLkUkrk1Q+mOai97i
3Ru8MHsGCCsGAQUFBwEBBG8wbTAuBggrBgEFBQcwAYYiaHR0cDovL29jc3AyLmds
b2JhbHNpZ24uY29tL3Jvb3RyMzA7BggrBgEFBQcwAoYvaHR0cDovL3NlY3VyZS5n
bG9iYWxzaWduLmNvbS9jYWNlcnQvcm9vdC1yMy5jcnQwNgYDVR0fBC8wLTAroCmg
J4YlaHR0cDovL2NybC5nbG9iYWxzaWduLmNvbS9yb290LXIzLmNybDAtBgNVHSAE
JjAkMAcGBWeBDAEBMAwGCisGAQQBoDIKAQEwCwYJKwYBBAGgMgEBMA0GCSqGSIb3
DQEBCwUAA4IBAQCtcTjIgw+tiW7E+sCTJ36nrC0IOxMpwE+nTaUG1xQJb+QE18vF
cPvEiqv8OonEBkQJFQ1N5YdDu9kydDYXBmIheYD9Z//TlUBnLL7HBje1ugplB0xE
jpU52q0XLxe6nHfeEKnslZ/Q/eDEsjZKxwF51SlGO6ap+09hfdbfMXDkTsfa+yXg
dIxZRCud0QEBTZAow0iCs3rf5wVALhhh2ePEwqxEm1LkUhvkJMLSCobYcJ+vXprK
JijbpPM602H1kqxNcD/nE7aCNm7g5GTaT04SCGYiQJ32r9mhx34peuYz05pY+AA3
aVB22PDvfoNyGZyClRtNt4KKg8dGJlYEhc3D
-----END CERTIFICATE-----
`;

/** Host names insecureTls is refused for: e-trade itself and its sub-domains. */
export function isEtradeProductionHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "etrade.gov.et" || host.endsWith(".etrade.gov.et");
}

export interface EtradeTlsSettings {
  ca?: string | Buffer | Array<string | Buffer>;
  trustBundledIssuingCa: boolean;
  insecureTls: boolean;
}

/**
 * The CA list for e-trade calls: Node's own roots, plus the bundled issuing CA, plus options.ca.
 *
 * Passing `ca` to Node replaces its root list rather than adding to it, so the roots are put
 * back explicitly. NODE_EXTRA_CA_CERTS is not part of tls.rootCertificates: a deployment that
 * relies on it (a corporate proxy) passes those certificates in options.ca too.
 */
export function etradeCaList(settings: EtradeTlsSettings): Array<string | Buffer> {
  const extra = settings.ca === undefined ? [] : Array.isArray(settings.ca) ? settings.ca : [settings.ca];
  return [...tls.rootCertificates, ...(settings.trustBundledIssuingCa ? [ETRADE_ISSUING_CA_PEM] : []), ...extra];
}

export function createEtradeAgent(settings: EtradeTlsSettings): https.Agent {
  return new https.Agent({
    rejectUnauthorized: !settings.insecureTls,
    ca: etradeCaList(settings),
  });
}
