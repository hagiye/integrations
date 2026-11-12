import { EimsError } from "./eims.errors";
import { MorGeoCodes } from "./eims.types";
import { MOR_LOCATIONS, MorLocationTuple } from "./mor-locations.data";

/**
 * A buyer address to MoR's own location codes, against MoR's location master
 * (EIMS_COUNTRY_REGION_VW, mor-locations.data.ts). Ported from EDR's mor-location.resolver.ts.
 *
 *   country -> COUNTRY_NAME  -> COUNTRY_NO  -> BuyerDetails.Country
 *   region  -> PARISH_NAME   -> PARISH_NO   -> BuyerDetails.Region
 *   zone    -> CITY_NAME     -> CITY_NO     -> BuyerDetails.City   (MoR calls the zone "City")
 *   woreda  -> LOCALITY_DESC -> LOCALITY_NO -> BuyerDetails.Wereda
 *
 * Strictly hierarchical: each level is searched only within the rows its parent picked. KERSA,
 * GORO, BABILE and BURE each occur in several zones with different codes, and a global lookup
 * files the invoice in the wrong tax jurisdiction. No fuzzy matching: a near miss fails loudly.
 */

export interface MorAddressInput {
  country?: string | null;
  region?: string | null;
  zone?: string | null;
  woreda?: string | null;
  /** Only read for the city-region shift (Addis Ababa addresses that put the woreda here). */
  kebele?: string | null;
}

type Level = "country" | "region" | "zone" | "woreda";

const SLOTS: Record<Level, { name: 1 | 3 | 5 | 7; no: 0 | 2 | 4 | 6; column: string }> = {
  country: { name: 1, no: 0, column: "COUNTRY_NAME" },
  region: { name: 3, no: 2, column: "PARISH_NAME" },
  zone: { name: 5, no: 4, column: "CITY_NAME" },
  woreda: { name: 7, no: 6, column: "LOCALITY_DESC" },
};

const normalizeCache = new Map<string, string>();

/**
 * One normalized form for both sides of every comparison: case, stray whitespace, punctuation and
 * accents removed, nothing else ("  FAAFAN   ZONE " -> "FAAFAN ZONE", "Wal-Mera" -> "WAL MERA").
 */
export function normalizeName(value: string | null | undefined): string {
  const raw = value ?? "";
  const hit = normalizeCache.get(raw);
  if (hit !== undefined) return hit;
  const normalized = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/['‘’`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (normalizeCache.size < 10_000) normalizeCache.set(raw, normalized);
  return normalized;
}

interface MorAlias {
  level: Exclude<Level, "country">;
  region?: string;
  zone?: string;
  from: string;
  to: string;
}

/**
 * Reviewed spelling differences (EDR, e-Trade) for the same place in MoR's sheet, scoped to their
 * level and parent so an alias cannot reach into another region. Add one only after confirming
 * both names are the same place in the sheet.
 */
const ALIASES: MorAlias[] = [
  { level: "zone", region: "SOMALI", from: "Fafen", to: "FAAFAN ZONE" }, // 31
  { level: "woreda", region: "SOMALI", zone: "FAAFAN ZONE", from: "Jigjiga", to: "JIJIGA" },
  // MoR spells the region AMAHARA (PARISH_NO 11).
  { level: "region", from: "Amhara", to: "AMAHARA" },
  // Addis Ababa sub-cities spelled differently by MoR (CITY_NO under PARISH_NO 13). LEMI KURA is not
  // in MoR's sheet at all and must keep failing rather than be mapped onto a neighbour.
  { level: "zone", region: "ADDIS ABABA", from: "Kolfe Keraniyo", to: "KOLFIE KERANIYO" }, // 81
  { level: "zone", region: "ADDIS ABABA", from: "Kolfe Keranio", to: "KOLFIE KERANIYO" }, // 81
  { level: "zone", region: "ADDIS ABABA", from: "Nifas Silk Lafto", to: "NEFAS SILK LAFTO" }, // 80
  { level: "zone", region: "ADDIS ABABA", from: "Akaki Kality", to: "AKAKI KALITI" }, // 79
  // Oromia zones: MoR keeps the Amharic compass words.
  { level: "zone", region: "OROMIA", from: "East Shewa", to: "MISRAK SHOA" }, // 16
  { level: "zone", region: "OROMIA", from: "West Shewa", to: "MIRAB SHOA" }, // 62
  { level: "zone", region: "OROMIA", from: "West Hararge", to: "MIRAB HARARGE" }, // 7
  { level: "zone", region: "AMAHARA", from: "West Gojjam", to: "WEST GOJAM" }, // 53
];

/** MoR suffixes many zones with " ZONE"; the suffixed spelling is a second exact candidate. */
const zoneSuffixCandidates = (normalized: string): string[] => (normalized.endsWith(" ZONE") ? [] : [`${normalized} ZONE`]);

/** In chartered cities MoR writes "WOREDA 7" where others store "07" or "Woreda 05". */
const woredaNumberCandidates = (normalized: string): string[] => {
  const match = /^(?:WOREDA )?0*([0-9]{1,2})$/.exec(normalized);
  return match ? [`WOREDA ${match[1]}`] : [];
};

const describe = (input: MorAddressInput): string =>
  `country="${input.country ?? ""}", region="${input.region ?? ""}", zone="${input.zone ?? ""}", woreda="${input.woreda ?? ""}"`;

function matchLevel(
  rows: MorLocationTuple[],
  level: Level,
  raw: string | null | undefined,
  parents: { region?: string; zone?: string },
  input: MorAddressInput,
): { no: number; rows: MorLocationTuple[] } {
  const { name: nameSlot, no: noSlot, column } = SLOTS[level];
  const wanted = normalizeName(raw);

  const candidates: string[] = [];
  if (wanted) {
    candidates.push(wanted);
    for (const alias of ALIASES) {
      if (alias.level !== level) continue;
      if (alias.region && normalizeName(alias.region) !== parents.region) continue;
      if (alias.zone && normalizeName(alias.zone) !== parents.zone) continue;
      if (normalizeName(alias.from) === wanted) candidates.push(normalizeName(alias.to));
    }
    if (level === "zone") candidates.push(...zoneSuffixCandidates(wanted));
    if (level === "woreda") candidates.push(...woredaNumberCandidates(wanted));
  }

  let matched: MorLocationTuple[] = [];
  for (const candidate of candidates) {
    matched = rows.filter((row) => normalizeName(row[nameSlot] as string) === candidate);
    if (matched.length > 0) break;
  }

  // An address that already holds the MoR code resolves too, but only when that code exists at
  // this level under this parent.
  if (matched.length === 0 && /^[0-9]{1,6}$/.test((raw ?? "").trim())) {
    const asCode = Number((raw ?? "").trim());
    matched = rows.filter((row) => row[noSlot] === asCode);
  }

  if (matched.length === 0) {
    throw new EimsError("INVALID", `MoR location mapping failed: no ${column} match for ${describe(input)}.`, {
      code: "GEO_MAPPING_FAILED",
      sent: false,
    });
  }

  const distinct = [...new Set(matched.map((row) => row[noSlot] as number))];
  if (distinct.length > 1) {
    throw new EimsError(
      "INVALID",
      `MoR location mapping is ambiguous: ${column} "${(raw ?? "").trim()}" matches ${distinct.length} codes ` +
        `(${distinct.sort((a, b) => a - b).join(", ")}) for ${describe(input)}. Correct the address; an ambiguous ` +
        "location is never filed.",
      { code: "GEO_AMBIGUOUS", sent: false },
    );
  }
  return { no: distinct[0], rows: matched };
}

/**
 * Resolve the whole hierarchy or throw INVALID naming the level that failed. Never guesses and
 * never returns a partial result: an unknown location stops the filing before a number is taken.
 */
export function resolveMorGeo(input: MorAddressInput, rows: MorLocationTuple[] = MOR_LOCATIONS): MorGeoCodes {
  if (rows.length === 0) {
    throw new EimsError("CONFIG", "The MoR location master is empty", { code: "GEO_MAPPING_FAILED", sent: false });
  }
  // Blank means domestic. A named foreign country is resolved like any other and fails if MoR
  // does not list it; it is never quietly filed as Ethiopia.
  const country = (input.country ?? "").trim() || "Ethiopia";
  const inCountry = matchLevel(rows, "country", country, {}, input);
  const inRegion = matchLevel(inCountry.rows, "region", input.region, {}, input);
  const regionScope = normalizeName(inRegion.rows[0][SLOTS.region.name] as string);

  const below = (zone: string | null | undefined, woreda: string | null | undefined): MorGeoCodes => {
    const inZone = matchLevel(inRegion.rows, "zone", zone, { region: regionScope }, input);
    const zoneScope = normalizeName(inZone.rows[0][SLOTS.zone.name] as string);
    const inWoreda = matchLevel(inZone.rows, "woreda", woreda, { region: regionScope, zone: zoneScope }, input);
    return {
      Country: String(inCountry.no),
      Region: String(inRegion.no),
      City: String(inZone.no),
      Wereda: String(inWoreda.no),
    };
  };

  try {
    return below(input.zone, input.woreda);
  } catch (err) {
    // Chartered cities have no zone tier: MoR's CITY level is the sub-city and its LOCALITY the
    // numbered woreda. e-Trade repeats the region in `zone`, which pushes everything one level
    // down. Retry that reading only when `zone` repeats the region, and only if both shifted
    // levels resolve exactly.
    const zone = normalizeName(input.zone);
    if (!zone || (zone !== regionScope && zone !== normalizeName(input.region))) throw err;
    try {
      return below(input.woreda, input.kebele);
    } catch {
      throw err;
    }
  }
}

/** Codes given directly: digits only, all four present. */
export function checkGeoCodes(geo: MorGeoCodes): MorGeoCodes {
  for (const field of ["Country", "Region", "City", "Wereda"] as const) {
    if (!/^[0-9]{1,6}$/.test(String(geo[field] ?? "").trim())) {
      throw new EimsError("INVALID", `Buyer location code ${field} "${geo[field] ?? ""}" is not a MoR code (digits)`, {
        code: "GEO_MAPPING_FAILED",
        sent: false,
      });
    }
  }
  return {
    Country: String(geo.Country).trim(),
    Region: String(geo.Region).trim(),
    City: String(geo.City).trim(),
    Wereda: String(geo.Wereda).trim(),
  };
}
