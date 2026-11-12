/**
 * Ethiopia's first-level divisions and the spellings e-trade uses for them. Ported unchanged
 * from EDR's packages/types/src/freight/ethiopian-regions.catalog.ts.
 *
 * The list changed recently (SNNPR was split between 2020 and 2023) and should be confirmed by
 * your product owner. Records from before the splits may still say "SNNPR" or "Southern
 * Nations": those are deliberately left unresolved, because the right successor region cannot
 * be told from the name alone.
 */
export const ETHIOPIAN_REGIONS = [
  "Addis Ababa",
  "Afar",
  "Amhara",
  "Benishangul-Gumuz",
  "Central Ethiopia",
  "Dire Dawa",
  "Gambela",
  "Harari",
  "Oromia",
  "Sidama",
  "Somali",
  "South Ethiopia",
  "South West Ethiopia Peoples'",
  "Tigray",
] as const;

export type EthiopianRegion = (typeof ETHIOPIAN_REGIONS)[number];

/**
 * Spellings seen in e-trade answers and old hand-typed rows. Keys are lower case with single
 * spaces. e-trade also puts a ZONE in the Region field: those map to the zone's region.
 */
export const REGION_ALIASES: Readonly<Record<string, EthiopianRegion>> = Object.freeze({
  oromoia: "Oromia",
  oromiya: "Oromia",
  oromina: "Oromia",
  addisabeba: "Addis Ababa",
  "addis abeba": "Addis Ababa",
  "dire dawa city": "Dire Dawa",
  "benishangul gumuz": "Benishangul-Gumuz",
  "benshangul-gumuz": "Benishangul-Gumuz",
  "beneshangul-gumuz": "Benishangul-Gumuz",
  gambella: "Gambela",
  tigrai: "Tigray",
  tigre: "Tigray",
  "south west ethiopia": "South West Ethiopia Peoples'",
  "south west ethiopia peoples": "South West Ethiopia Peoples'",
  "southwest ethiopia": "South West Ethiopia Peoples'",
  "eastern tigray": "Tigray",
  "western tigray": "Tigray",
  "southern tigray": "Tigray",
  "central tigray": "Tigray",
  "north wollo": "Amhara",
  "south wollo": "Amhara",
  "east gojjam": "Amhara",
  "west gojjam": "Amhara",
  "north shewa": "Amhara",
  "east shewa": "Oromia",
  "west shewa": "Oromia",
  arsi: "Oromia",
  bale: "Oromia",
  borena: "Oromia",
  jimma: "Oromia",
  gamo: "South Ethiopia",
  gofa: "South Ethiopia",
  wolayita: "South Ethiopia",
});

function canonicalKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * e-trade's Region text onto a region in ETHIOPIAN_REGIONS, or null when it cannot be resolved.
 * A null must stay empty and be chosen by a person: a guess is never stored.
 */
export function normalizeRegion(
  value: string | null | undefined,
  extraAliases: Readonly<Record<string, EthiopianRegion>> = {},
): EthiopianRegion | null {
  if (!value) return null;
  const key = canonicalKey(value);
  if (!key) return null;
  const exact = ETHIOPIAN_REGIONS.find((region) => canonicalKey(region) === key);
  if (exact) return exact;
  const alias = extraAliases[key] ?? REGION_ALIASES[key];
  return alias && (ETHIOPIAN_REGIONS as readonly string[]).includes(alias) ? alias : null;
}
