/**
 * eSignet's userinfo claims, read into the fields a host stores. Ported from EDR's freight
 * VerifaydaService.normalizeUserInfo (the better of EDR's two copies: it formats the address
 * object, and does not prefix a "+" onto any digits it is given), with two additions:
 * the birthdate is read into ISO yyyy-MM-dd (eSignet sends yyyy/MM/dd, EDR's passenger copy
 * says), and a phone that cannot be read as E.164 stays raw instead of looking canonical.
 */

/** The claims as eSignet names them. Localised values come as separate "#en" / "#am" keys. */
export interface FaydaUserinfoClaims {
  sub: string;
  name?: string;
  "name#en"?: string;
  "name#am"?: string;
  phone_number?: string;
  "phone_number#en"?: string;
  "phone_number#am"?: string;
  phone?: string;
  email?: string;
  gender?: string;
  "gender#en"?: string;
  "gender#am"?: string;
  birthdate?: string;
  picture?: string;
  nationality?: string;
  address?: unknown;
  "address#en"?: unknown;
  "address#am"?: unknown;
  [claim: string]: unknown;
}

/** What the host gets about the person, all from claims whose signature was verified. */
export interface FaydaIdentityFields {
  /** eSignet's subject: pairwise per client_id, stable, never the national ID number. The key to link by. */
  sub: string;
  /** name, else the English name, else the Amharic one. */
  fullName?: string;
  nameEn?: string;
  nameAm?: string;
  /** The English gender, else the Amharic one, else gender. */
  gender?: string;
  genderEn?: string;
  genderAm?: string;
  /** ISO yyyy-MM-dd, when the claim reads as a real date. The raw value stays in claims. */
  birthdate?: string;
  /** E.164 (+2519..., +2517..., +25377...), only when the number reads as one. */
  phoneE164?: string;
  /** The number as eSignet sent it. */
  phoneRaw?: string;
  /** Trimmed, as sent. */
  email?: string;
  /** The address as text, English. Falls back to nothing: see addressAm. */
  addressEn?: string;
  addressAm?: string;
  /** As sent (a data URL or base64). Sensitive: store only where a use case needs it. */
  picture?: string;
  nationality?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The order EDR joins address parts in when eSignet sends no formatted value. */
export const ADDRESS_FIELD_ORDER = [
  "houseNumber",
  "kebele",
  "woreda",
  "city",
  "subCity",
  "zone",
  "region",
  "postalCode",
  "country",
] as const;

/**
 * An address claim as text. eSignet flattens it into "address#en" / "address#am", each an
 * object whose leaf keys carry the locale again ({"zone#en": "..."}). A "formatted#<locale>"
 * key wins; otherwise the parts are joined in ADDRESS_FIELD_ORDER, then any others. A plain
 * string (EDR's passenger copy and its e2e mock assume one) is taken as it is.
 */
export function formatAddress(address: unknown, locale: "en" | "am"): string | undefined {
  if (typeof address === "string") return text(address);
  if (!address || typeof address !== "object" || Array.isArray(address)) return undefined;
  const record = address as Record<string, unknown>;
  const formatted = text(record[`formatted#${locale}`]) ?? text(record.formatted);
  if (formatted) return formatted;
  const suffix = `#${locale}`;
  const byField = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    const value_ = text(value);
    if (!value_) continue;
    if (key.endsWith(suffix)) byField.set(key.slice(0, -suffix.length), value_);
    else if (!key.includes("#")) byField.set(key, value_);
  }
  const ordered = ADDRESS_FIELD_ORDER.filter((f) => byField.has(f)).map((f) => byField.get(f)!);
  const rest = [...byField.entries()]
    .filter(([f]) => !(ADDRESS_FIELD_ORDER as readonly string[]).includes(f))
    .map(([, v]) => v);
  const parts = [...ordered, ...rest];
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * A phone number as E.164 when it plainly is an Ethiopian or Djiboutian one, or already carries
 * a "+" and 8 to 15 digits. Anything else gives undefined, so it is kept raw and never used to
 * reach or match anyone. No libphonenumber: the rules are EDR's fallback rules.
 *
 * - +2519xxxxxxxx, +2517xxxxxxxx, 2519..., 2517..., 09..., 07..., 9xxxxxxxx, 7xxxxxxxx: Ethiopia
 * - +25377xxxxxx, 25377xxxxxx, 77xxxxxx: Djibouti mobile
 */
export function toE164(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, "");
  const plus = trimmed.startsWith("+");
  if (plus && !/^25[13]/.test(digits)) {
    // Another country, already international: kept as given when its length is plausible.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  }
  if (/^25[13]/.test(digits)) {
    if (/^251[79]\d{8}$/.test(digits)) return `+${digits}`;
    if (/^25377\d{6}$/.test(digits)) return `+${digits}`;
    return undefined;
  }
  if (plus) return undefined;
  const bare = digits.replace(/^0+/, "");
  if (/^[79]\d{8}$/.test(bare)) return `+251${bare}`;
  if (/^77\d{6}$/.test(digits)) return `+253${digits}`;
  return undefined;
}

/** yyyy/MM/dd or yyyy-MM-dd, a real calendar date, as yyyy-MM-dd. Anything else: undefined. */
export function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(raw.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return undefined;
  }
  return `${y}-${m}-${d}`;
}

/** The identity fields from verified userinfo claims. */
export function readIdentityFields(claims: FaydaUserinfoClaims): FaydaIdentityFields {
  const nameEn = text(claims["name#en"]);
  const nameAm = text(claims["name#am"]);
  const genderEn = text(claims["gender#en"]);
  const genderAm = text(claims["gender#am"]);
  const phoneRaw =
    text(claims.phone_number) ?? text(claims["phone_number#en"]) ?? text(claims["phone_number#am"]) ?? text(claims.phone);
  const addressEn = formatAddress(claims["address#en"], "en") ?? formatAddress(claims.address, "en");
  const addressAm = formatAddress(claims["address#am"], "am");
  const fields: FaydaIdentityFields = {
    sub: claims.sub,
    fullName: text(claims.name) ?? nameEn ?? nameAm,
    nameEn,
    nameAm,
    gender: genderEn ?? genderAm ?? text(claims.gender),
    genderEn,
    genderAm,
    birthdate: toIsoDate(text(claims.birthdate)),
    phoneE164: toE164(phoneRaw),
    phoneRaw,
    email: text(claims.email),
    addressEn,
    addressAm,
    picture: text(claims.picture),
    nationality: text(claims.nationality),
  };
  for (const key of Object.keys(fields) as (keyof FaydaIdentityFields)[]) {
    if (fields[key] === undefined) delete fields[key];
  }
  return fields;
}

/** The lower-case trimmed email, for comparing contacts. */
export function emailKey(email: string | undefined): string | undefined {
  const value = email?.replace(/\s+/g, "").toLowerCase();
  return value || undefined;
}
