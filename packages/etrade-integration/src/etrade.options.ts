import type { EtradeLanguage, EtradeLicenceState } from "./etrade.types";
import type { EthiopianRegion } from "./etrade.regions";

export const ETRADE_OPTIONS = Symbol("ETRADE_OPTIONS");

/**
 * The address EDR calls: the back end of the Ministry of Trade's public business-licence
 * checker page. It is not a published API, and there is no known agreement behind it (guide,
 * section 1). It is exported so that choosing it is a decision in your code, not a default.
 */
export const ETRADE_PUBLIC_API_URL = "https://etrade.gov.et/api";

/**
 * The Referer EDR sends. e-trade answers 417 without it (EDR's back office logs that case as
 * "Referer rejected by eTrade"). Set options.referer to false once the Ministry gives you a
 * formal access method.
 */
export const ETRADE_CHECKER_REFERER = "https://etrade.gov.et/business-license-checker";

export interface EtradeLookupBudgetOptions {
  /** Different TINs one actor may look up in a window. EDR: 10. */
  limit: number;
  /** EDR: 24 hours. */
  windowMs: number;
}

export interface EtradeModuleOptions {
  /** ETRADE_PUBLIC_API_URL, or the address the Ministry gives you (ETRADE_BASE_URL). Required. */
  baseUrl: string;
  /** Default ETRADE_CHECKER_REFERER, as EDR sends it. false: no Referer header. */
  referer?: string | false;
  /**
   * Extra request headers, for a credential once the Ministry issues one (ETRADE_API_KEY...).
   * Never logged. Accept and Referer are set by the package.
   */
  headers?: Record<string, string>;
  /** Default "en" (EDR always asks in English). */
  language?: EtradeLanguage;
  /** For the whole of one call, connection included. Default 8000. EDR had no timeout. */
  httpTimeoutMs?: number;
  /** Retries after a timeout, a broken connection or a 5xx. Never after a 4xx or 429. Default 1. */
  maxRetries?: number;
  /** Wait before a retry. Default 300. */
  retryDelayMs?: number;
  /**
   * Consecutive failed calls after which calls fail at once (NETWORK, CIRCUIT_OPEN) for
   * circuitOpenMs, instead of each waiting for its timeout. Default 5; 0 turns it off.
   */
  circuitFailures?: number;
  /** Default 60000. */
  circuitOpenMs?: number;
  /** Extra CA certificates (PEM), added to Node's roots and the bundled e-trade issuing CA. */
  ca?: string | Buffer | Array<string | Buffer>;
  /**
   * Default true: trust ETRADE_ISSUING_CA_PEM, the GlobalSign CA that e-trade's server leaves
   * out of its chain. With it, TLS is verified against etrade.gov.et (checked 2026-11-12).
   */
  trustBundledIssuingCa?: boolean;
  /**
   * Turns TLS verification off (ETRADE_INSECURE_TLS). For a local test server only: refused when
   * baseUrl is etrade.gov.et or one of its sub-domains. EDR ran every e-trade call this way.
   */
  insecureTls?: boolean;
  /**
   * How long a found answer stays in the host's cache (host.readCache/writeCache), for repeat
   * reads in one onboarding session. Default 600000 (10 minutes); 0 turns caching off.
   * attach and recheck always ask e-trade afresh. Empty answers and errors are never cached.
   */
  cacheTtlMs?: number;
  /**
   * The TIN lookup budget used when your host has no chargeLookup: in-process memory, like EDR's
   * TinLookupBudget (lost on restart, not shared between instances). Default 10 different TINs
   * per actor per 24 hours. false: no budget at all (lookups are then not limited).
   */
  lookupBudget?: EtradeLookupBudgetOptions | false;
  /**
   * What attach does with a licence that is not plainly active (expired, cancelled, suspended,
   * status unknown, detail missing). "refuse" (default): nothing is stored. "flag": the snapshot
   * is stored with needsReview and its problems. recheck always stores and flags.
   */
  licenceProblems?: "refuse" | "flag";
  /**
   * lookup() with a licence number e-trade no longer lists under the TIN. "refuse" (default):
   * no licence is resolved and chosenLicenceMissing is true, so the customer chooses again.
   * "first": EDR's behaviour, the first licence is resolved instead.
   */
  onMissingChosenLicence?: "refuse" | "first";
  /**
   * Extra status mappings, merged over the built-in reading of StatusDescription. Keys are a
   * lower-case StatusDescription ("active") or a status code as "#1". e-trade never published
   * its codes, so anything not mapped and not plainly active is UNKNOWN.
   */
  statusMap?: Record<string, EtradeLicenceState>;
  /** Extra region spellings (lower case) mapped onto ETHIOPIAN_REGIONS, merged over EDR's aliases. */
  regionAliases?: Record<string, EthiopianRegion>;
  /**
   * "Today", for the expiry check, is taken at this offset from UTC. Default 180 (Ethiopia,
   * UTC+3). e-trade's dates carry no zone.
   */
  dateUtcOffsetMinutes?: number;
}

export interface ResolvedEtradeOptions {
  baseUrl: string;
  referer: string | undefined;
  headers: Record<string, string>;
  language: EtradeLanguage;
  httpTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  circuitFailures: number;
  circuitOpenMs: number;
  ca: string | Buffer | Array<string | Buffer> | undefined;
  trustBundledIssuingCa: boolean;
  insecureTls: boolean;
  cacheTtlMs: number;
  lookupBudget: EtradeLookupBudgetOptions | false;
  licenceProblems: "refuse" | "flag";
  onMissingChosenLicence: "refuse" | "first";
  statusMap: Record<string, EtradeLicenceState>;
  regionAliases: Record<string, EthiopianRegion>;
  dateUtcOffsetMinutes: number;
}

const positive = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const nonNegative = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;

const STATES: readonly EtradeLicenceState[] = ["ACTIVE", "EXPIRED", "CANCELLED", "SUSPENDED", "NOT_LISTED", "UNKNOWN"];

/** Fills defaults and trims. Never throws. */
export function resolveEtradeOptions(options: EtradeModuleOptions): ResolvedEtradeOptions {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    const key = text(name);
    if (key && typeof value === "string") headers[key] = value;
  }
  const statusMap: Record<string, EtradeLicenceState> = {};
  for (const [key, state] of Object.entries(options.statusMap ?? {})) {
    if (STATES.includes(state)) statusMap[key.trim().toLowerCase()] = state;
  }
  const regionAliases: Record<string, EthiopianRegion> = {};
  for (const [alias, region] of Object.entries(options.regionAliases ?? {})) {
    const key = alias.trim().replace(/\s+/g, " ").toLowerCase();
    if (key) regionAliases[key] = region;
  }
  const budget = options.lookupBudget;
  return {
    baseUrl: text(options.baseUrl).replace(/\/+$/, ""),
    referer: options.referer === false ? undefined : text(options.referer) || ETRADE_CHECKER_REFERER,
    headers,
    language: options.language === "am" ? "am" : "en",
    httpTimeoutMs: positive(options.httpTimeoutMs, 8_000),
    maxRetries: Math.min(nonNegative(options.maxRetries, 1), 5),
    retryDelayMs: nonNegative(options.retryDelayMs, 300),
    circuitFailures: nonNegative(options.circuitFailures, 5),
    circuitOpenMs: positive(options.circuitOpenMs, 60_000),
    ca: options.ca,
    trustBundledIssuingCa: options.trustBundledIssuingCa ?? true,
    insecureTls: options.insecureTls === true,
    cacheTtlMs: nonNegative(options.cacheTtlMs, 600_000),
    lookupBudget:
      budget === false
        ? false
        : { limit: positive(budget?.limit, 10), windowMs: positive(budget?.windowMs, 24 * 60 * 60 * 1000) },
    licenceProblems: options.licenceProblems === "flag" ? "flag" : "refuse",
    onMissingChosenLicence: options.onMissingChosenLicence === "first" ? "first" : "refuse",
    statusMap,
    regionAliases,
    dateUtcOffsetMinutes:
      typeof options.dateUtcOffsetMinutes === "number" && Number.isFinite(options.dateUtcOffsetMinutes)
        ? options.dateUtcOffsetMinutes
        : 180,
  };
}

/** Names (never values) of the options needed to call e-trade that are empty. */
export function missingEtradeOptions(options: ResolvedEtradeOptions): string[] {
  return options.baseUrl ? [] : ["baseUrl"];
}
