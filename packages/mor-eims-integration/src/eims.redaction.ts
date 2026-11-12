import { X509Certificate, createHash } from "node:crypto";

/**
 * Redaction for logged MoR exchanges. Field-exact rather than word rules: the payloads are known,
 * and their value as evidence is in keeping them whole (every invoice line, the signature), so
 * nothing here truncates strings or lists. Ported from EDR's eims-exchange.redaction.ts.
 */

export const REDACTED = "[REDACTED]";

/** Keys (any case) whose values are credentials. */
const SECRET_KEYS = new Set([
  "clientsecret",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "encryptionkey",
  "password",
  "authorization",
  "privatekey",
  "token",
]);

/** Header-name words that mark a credential (apikey, x-api-key, authorization). */
const SECRET_HEADER_WORDS = new Set(["authorization", "apikey", "key", "token", "secret", "credential", "cookie"]);

/** Per-body ceiling. Invoice bodies are about 1 KB; only big bulk batches get near it. */
export const MAX_LOGGED_BODY_BYTES = 512 * 1024;

const MAX_DEPTH = 12;

/** MoR path to an operation name. Unknown paths keep the path. */
export function eimsOperation(path: string): string {
  const known: Record<string, string> = {
    "/auth/login": "LOGIN",
    "/auth/refresh-token": "REFRESH_TOKEN",
    "/v1/register": "REGISTER",
    "/v1/bulkRegister": "BULK_REGISTER",
    "/v1/verify": "VERIFY",
    "/v1/cancel": "CANCEL",
    "/v1/bulkCancel": "BULK_CANCEL",
    "/v1/receipt/sales": "SALES_RECEIPT",
  };
  if (known[path]) return known[path];
  const receipt = /^\/v1\/receipt\/([\w-]+)$/.exec(path);
  if (receipt) return `RECEIPT_${receipt[1].toUpperCase()}`;
  return path.slice(0, 60);
}

/** The signing certificate is the same public PEM chain on every call: kept as what identifies it. */
export function describeCertificate(value: string): Record<string, unknown> {
  const bytes = Buffer.from(value, "base64");
  const description: Record<string, unknown> = {
    __certificate: true,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  try {
    const pem = bytes.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
    const leaf = new X509Certificate(pem ?? bytes);
    description.subject = leaf.subject;
    description.serialNumber = leaf.serialNumber;
    description.validTo = leaf.validTo;
  } catch {
    // Not a parseable certificate: the fingerprint alone still identifies it.
  }
  return description;
}

function walk(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return { __buffer: true, size: value.length };
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower) && nested !== null && nested !== undefined) {
      out[key] = REDACTED;
    } else if (lower === "certificate" && typeof nested === "string" && nested.length > 0) {
      out[key] = describeCertificate(nested);
    } else {
      out[key] = walk(nested, depth + 1);
    }
  }
  return out;
}

/** A body parsed from its wire string, or the string itself when it is not JSON. */
export function parseBody(text: string | null | undefined): unknown {
  if (text === null || text === undefined || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Credentials replaced by [REDACTED], the certificate by its fingerprint. The inner request and
 * the signature are kept whole: they are the evidence of what was filed and that it was signed.
 */
export function redactEimsPayload(value: unknown): unknown {
  const redacted = walk(value, 0);
  const serialized = JSON.stringify(redacted) ?? "";
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_LOGGED_BODY_BYTES) return redacted;
  return { __truncated: true, reason: "Body exceeded the exchange log size limit", bytes, head: serialized.slice(0, 4_000) };
}

/** Headers with credentials masked and cookies dropped. */
export function redactEimsHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string> | null {
  if (!headers) return null;
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined || raw === null) continue;
    const lower = name.toLowerCase();
    if (lower === "cookie" || lower === "set-cookie") continue;
    const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
    const secret = words.some((word) => SECRET_HEADER_WORDS.has(word)) || SECRET_KEYS.has(lower);
    const value = Array.isArray(raw) ? raw.join(", ") : String(raw);
    out[lower] = secret
      ? lower === "authorization" && value.startsWith("Bearer ")
        ? `Bearer ${REDACTED}`
        : REDACTED
      : value.slice(0, 500);
  }
  return Object.keys(out).length > 0 ? out : null;
}
