import type { LicenceStanding } from "./etrade.normalize";
import type {
  EtradeBusinessOption,
  EtradeLicence,
  EtradeLicenceProblem,
  EtradeLicenceSnapshot,
} from "./etrade.types";

export interface LicenceSelection {
  /** The licence to resolve, or null. */
  selected: EtradeBusinessOption | null;
  /** A licence number was given and e-trade does not list it (any more) under this TIN. */
  chosenMissing: boolean;
  /** EDR's fallback was used: the chosen licence was missing and the first one was taken instead. */
  fellBack: boolean;
}

/**
 * Which of a TIN's licences a lookup resolves (EDR's ETradeService.resolveCompanyData):
 *
 * - nothing chosen: the first one, which the customer then confirms or changes;
 * - a chosen one e-trade lists: that one;
 * - a chosen one e-trade no longer lists: none, so the customer chooses again. EDR took the
 *   first licence instead, which silently swaps a company onto another business's record;
 *   `fallback: "first"` keeps that behaviour.
 */
export function selectLicence(
  businesses: readonly EtradeBusinessOption[],
  chosen: string | undefined | null,
  fallback: "refuse" | "first" = "refuse",
): LicenceSelection {
  const wanted = typeof chosen === "string" ? chosen.trim() : "";
  if (!businesses.length) return { selected: null, chosenMissing: wanted.length > 0, fellBack: false };
  if (!wanted) return { selected: businesses[0], chosenMissing: false, fellBack: false };
  const match = findLicence(businesses, wanted);
  if (match) return { selected: match, chosenMissing: false, fellBack: false };
  return fallback === "first"
    ? { selected: businesses[0], chosenMissing: true, fellBack: true }
    : { selected: null, chosenMissing: true, fellBack: false };
}

/**
 * The licence with exactly this number, or null. The trust boundary for a licence number a
 * client sends: only a licence e-trade lists under the holder's own TIN can be attached.
 */
export function findLicence(businesses: readonly EtradeBusinessOption[], licenceNumber: string): EtradeBusinessOption | null {
  const wanted = licenceNumber.trim();
  return businesses.find((b) => b.licenceNumber === wanted) ?? null;
}

/**
 * A snapshot built only from e-trade's own answers: the registration list entry (S1) and the
 * licence detail (S2, null when e-trade has none).
 */
export function buildSnapshot(input: {
  tin: string;
  option: EtradeBusinessOption;
  licence: EtradeLicence | null;
  standing: LicenceStanding | null;
  checkedAt: Date;
  checkedBy: string | null;
}): EtradeLicenceSnapshot {
  const { option, licence, standing } = input;
  const problems: EtradeLicenceProblem[] = licence && standing ? [...standing.problems] : ["LICENCE_DETAIL_NOT_FOUND"];
  return {
    licenceNumber: option.licenceNumber,
    // The trade name of the licence itself when e-trade gives one, else the list's.
    tradeName: licence?.tradeName || option.tradeName,
    activity: option.activity,
    renewedTo: option.renewedTo,
    tin: input.tin,
    validUntil: licence?.validUntil ?? null,
    expiresInDays: standing?.expiresInDays ?? null,
    state: standing?.state ?? "UNKNOWN",
    statusCode: licence?.status ?? null,
    statusDescription: licence?.statusDescription ?? "",
    cancellationDate: licence?.cancellationDate ?? null,
    rawRegion: licence?.address.rawRegion ?? "",
    region: licence?.address.region ?? "",
    needsReview: problems.length > 0,
    problems,
    checkedAt: input.checkedAt.toISOString(),
    source: "etrade:registration+licence",
    checkedBy: input.checkedBy,
  };
}

/** A stored snapshot whose licence e-trade no longer lists: its last known data, flagged. */
export function notListedSnapshot(previous: EtradeLicenceSnapshot, checkedAt: Date, checkedBy: string | null): EtradeLicenceSnapshot {
  return {
    ...previous,
    state: "NOT_LISTED",
    needsReview: true,
    problems: ["LICENCE_NOT_LISTED"],
    checkedAt: checkedAt.toISOString(),
    checkedBy,
  };
}

const COMPARED: Array<keyof EtradeLicenceSnapshot> = [
  "tradeName",
  "activity",
  "renewedTo",
  "validUntil",
  "state",
  "statusCode",
  "statusDescription",
  "cancellationDate",
  "rawRegion",
  "region",
];

/** The fields that changed between two snapshots of the same licence (check times ignored). */
export function diffSnapshots(before: EtradeLicenceSnapshot | null | undefined, after: EtradeLicenceSnapshot): string[] {
  if (!before) return ["licenceNumber"];
  if (before.licenceNumber !== after.licenceNumber) return ["licenceNumber"];
  return COMPARED.filter((key) => (before[key] ?? null) !== (after[key] ?? null)) as string[];
}

/** Snapshots are compared by when e-trade was asked: an older answer never replaces a newer one. */
export function isNewer(candidate: EtradeLicenceSnapshot, stored: EtradeLicenceSnapshot | null | undefined): boolean {
  if (!stored?.checkedAt) return true;
  return Date.parse(candidate.checkedAt) >= Date.parse(stored.checkedAt);
}
