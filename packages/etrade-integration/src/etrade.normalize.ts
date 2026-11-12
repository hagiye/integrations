import { EthiopianRegion, normalizeRegion } from "./etrade.regions";
import type {
  CompanyNameSource,
  EtradeBusinessOption,
  EtradeLicence,
  EtradeLicenceManager,
  EtradeLicenceProblem,
  EtradeLicenceState,
  EtradeRawAssociate,
  EtradeRawBusiness,
  EtradeRawBusinessSummary,
  EtradeRawRegistration,
  EtradeRegistration,
  EtradeRegistrationData,
} from "./etrade.types";

/** An Ethiopian TIN: exactly 10 digits. Anything else is refused before a call. */
export const TIN_PATTERN = /^\d{10}$/;

export function isValidTin(tin: unknown): tin is string {
  return typeof tin === "string" && TIN_PATTERN.test(tin);
}

/** "*******036": enough to tell lookups apart in a log, not enough to name the business. */
export function maskTin(tin: string): string {
  return tin.length > 3 ? `${"*".repeat(tin.length - 3)}${tin.slice(-3)}` : "***";
}

/** Licence numbers look like MT/AA/14/670/128936/2007. EDR allowed up to 120 characters. */
export function isValidLicenceNumber(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 120 &&
    // No control characters: it goes into a query string and into your database.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

const clean = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** "(65611)Import trade in ..." -> "Import trade in ...". */
export function stripActivityCode(description: string): string {
  return description.replace(/^\(\d+\)\s*/, "").trim();
}

/**
 * One licence for the picker (EDR's toBusinessOption). A licence without a number is dropped:
 * it could never be attached.
 */
export function toBusinessOption(raw: EtradeRawBusinessSummary | null | undefined): EtradeBusinessOption | null {
  if (!raw || typeof raw !== "object") return null;
  const licenceNumber = clean(raw.LicenceNumber);
  if (!licenceNumber) return null;
  return {
    licenceNumber,
    tradeName: clean(raw.TradesName),
    activity: (Array.isArray(raw.SubGroups) ? raw.SubGroups : [])
      // e-trade puts null entries in this list, and null descriptions in its entries.
      .map((group) => (group && typeof group.Description === "string" ? stripActivityCode(group.Description) : ""))
      .filter(Boolean)
      .join(", "),
    renewedTo: clean(raw.RenewedTo),
  };
}

export function normalizeRegistration(raw: EtradeRawRegistration, tin: string): EtradeRegistration {
  const businesses = (Array.isArray(raw.Businesses) ? raw.Businesses : [])
    .map(toBusinessOption)
    .filter((b): b is EtradeBusinessOption => b !== null);
  return {
    tin: clean(raw.Tin) || tin,
    businessName: clean(raw.BusinessName),
    businessNameAmh: clean(raw.BusinessNameAmh),
    legalCondition: clean(raw.LegalCondtion),
    regNo: clean(raw.RegNo),
    regDate: clean(raw.RegDate),
    businesses,
  };
}

function firstManager(list: Array<EtradeRawAssociate | null> | null | undefined): EtradeLicenceManager | null {
  const first = (Array.isArray(list) ? list : []).find((a): a is EtradeRawAssociate => !!a && typeof a === "object");
  if (!first) return null;
  return {
    name: clean(first.ManagerNameEng),
    nameAmh: clean(first.ManagerName),
    position: clean(first.Position),
    mobilePhone: clean(first.MobilePhone),
    regularPhone: clean(first.RegularPhone),
  };
}

export function normalizeLicence(
  raw: EtradeRawBusiness,
  extraRegionAliases: Readonly<Record<string, EthiopianRegion>> = {},
): EtradeLicence {
  const address = raw.AddressInfo && typeof raw.AddressInfo === "object" ? raw.AddressInfo : {};
  const rawRegion = clean(address.Region);
  const renewedTo = clean(raw.RenewedToDateString) || clean(raw.RenewedTo);
  return {
    licenceNumber: clean(raw.LicenceNumber),
    ownerTin: clean(raw.OwnerTIN),
    tradeName: clean(raw.TradeName),
    status: typeof raw.Status === "number" && Number.isFinite(raw.Status) ? raw.Status : null,
    statusDescription: clean(raw.StatusDescription),
    dateRegistered: clean(raw.DateRegistered),
    renewedFrom: clean(raw.RenewedFrom),
    renewalDate: clean(raw.RenewalDate),
    renewedTo,
    validUntil: parseEtradeDate(raw.RenewedToDateString) ?? parseEtradeDate(raw.RenewedTo),
    cancellationDate: clean(raw.CancellationDate) || null,
    address: {
      rawRegion,
      region: normalizeRegion(rawRegion, extraRegionAliases) ?? "",
      zone: clean(address.Zone),
      woreda: clean(address.Woreda),
      kebele: clean(address.Kebele),
      houseNo: clean(address.HouseNo),
      mobilePhone: clean(address.MobilePhone),
      regularPhone: clean(address.RegularPhone),
    },
    manager: firstManager(raw.AssociateShortInfos),
  };
}

/**
 * e-trade's dates onto YYYY-MM-DD: "7/7/2026" (month first, as RenewedToDateString and the
 * registration list use) and "2026-07-07" or "2026-07-07T00:00:00" (RenewedTo). Anything else,
 * or a date that does not exist, is null. Gregorian calendar assumed (not confirmed by the
 * Ministry; the guide lists it).
 */
export function parseEtradeDate(value: unknown): string | null {
  const text = clean(value);
  if (!text) return null;
  let year: number;
  let month: number;
  let day: number;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Today's date (YYYY-MM-DD) at a fixed offset from UTC. */
export function dateAtOffset(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface LicenceStateContext {
  now: Date;
  dateUtcOffsetMinutes: number;
  statusMap: Readonly<Record<string, EtradeLicenceState>>;
}

/** The state e-trade's status text reads as, before dates are considered. */
export function stateFromStatus(
  status: number | null,
  description: string,
  statusMap: Readonly<Record<string, EtradeLicenceState>>,
): EtradeLicenceState {
  const text = description.trim().toLowerCase();
  if (text && statusMap[text]) return statusMap[text];
  if (status !== null && statusMap[`#${status}`]) return statusMap[`#${status}`];
  if (text === "active") return "ACTIVE";
  if (/cancel|revok|terminat/.test(text)) return "CANCELLED";
  if (/suspend/.test(text)) return "SUSPENDED";
  if (/expir/.test(text)) return "EXPIRED";
  return "UNKNOWN";
}

export interface LicenceStanding {
  state: EtradeLicenceState;
  problems: EtradeLicenceProblem[];
  expiresInDays: number | null;
}

/**
 * Where a licence stands: a cancellation date wins, then the status text, then the expiry.
 * Only ACTIVE with a readable, future (or today's) validUntil has no problems.
 */
export function licenceStanding(licence: EtradeLicence, context: LicenceStateContext): LicenceStanding {
  const today = dateAtOffset(context.now, context.dateUtcOffsetMinutes);
  const expiresInDays = licence.validUntil ? daysBetween(today, licence.validUntil) : null;
  let state: EtradeLicenceState = licence.cancellationDate
    ? "CANCELLED"
    : stateFromStatus(licence.status, licence.statusDescription, context.statusMap);
  if (state === "ACTIVE" && expiresInDays !== null && expiresInDays < 0) state = "EXPIRED";
  const problems: EtradeLicenceProblem[] = [];
  if (state === "EXPIRED") problems.push("LICENCE_EXPIRED");
  if (state === "CANCELLED") problems.push("LICENCE_CANCELLED");
  if (state === "SUSPENDED") problems.push("LICENCE_SUSPENDED");
  if (state === "UNKNOWN") problems.push("LICENCE_STATUS_UNKNOWN");
  if (state === "ACTIVE" && licence.validUntil === null) problems.push("VALID_UNTIL_UNREADABLE");
  return { state, problems, expiresInDays };
}

/**
 * The name a company goes by (EDR's resolveCompanyName): the trade name unless it chose the
 * registered business name, and the other one whenever the chosen one is blank, so a field
 * e-trade drops never blanks the company.
 */
export function resolveCompanyName(
  names: { tradeName: string; businessName: string },
  source?: CompanyNameSource | null,
): string {
  const trade = names.tradeName?.trim() ?? "";
  const business = names.businessName?.trim() ?? "";
  return source === "businessName" ? business || trade : trade || business;
}

/** Narrow an untrusted value (a stored attribute, a request field) to a name source. */
export function asCompanyNameSource(value: unknown): CompanyNameSource | null {
  return value === "tradeName" || value === "businessName" ? value : null;
}

/**
 * An Ethiopian phone number from e-trade's free text, as +251 and nine digits, or null.
 * Mobile numbers start 9 or 7; fixed lines 1 to 5 (011 is Addis Ababa). "09        " and
 * "52543000" are real e-trade answers and come back null.
 */
export function usableEthiopianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.includes("+")) return null;
  let national: string;
  if (digits.startsWith("251")) national = digits.slice(3);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else national = digits;
  if (!/^[1-579]\d{8}$/.test(national)) return null;
  return `+251${national}`;
}

/**
 * The prefill for a company profile (EDR's ETradeService.extractRegistrationData), from a
 * licence (S2) and its registration (S1). The phones stay as e-trade wrote them; contactPhone
 * is the first one that is usable, preferring regular over mobile (e-trade's MobilePhone often
 * holds a fixed line), as EDR's back office does.
 */
export function extractRegistrationData(
  licence: EtradeLicence,
  registration: EtradeRegistration | null,
  standing: LicenceStanding,
  nameSource?: CompanyNameSource | null,
): EtradeRegistrationData {
  const names = { tradeName: licence.tradeName, businessName: registration?.businessName ?? "" };
  const manager = licence.manager;
  const candidates = [manager?.regularPhone, licence.address.regularPhone, manager?.mobilePhone, licence.address.mobilePhone];
  return {
    companyName: resolveCompanyName(names, nameSource),
    ...names,
    licenceNumber: licence.licenceNumber,
    statusDescription: licence.statusDescription,
    dateRegistered: licence.dateRegistered,
    renewedFrom: licence.renewedFrom,
    renewalDate: licence.renewalDate,
    renewedTo: licence.renewedTo,
    validUntil: licence.validUntil,
    licenceState: standing.state,
    region: licence.address.region,
    rawRegion: licence.address.rawRegion,
    zone: licence.address.zone,
    woreda: licence.address.woreda,
    kebele: licence.address.kebele,
    houseNo: licence.address.houseNo,
    mobilePhone: licence.address.mobilePhone,
    regularPhone: licence.address.regularPhone,
    managerName: manager?.name ?? "",
    managerPhone: manager?.regularPhone ?? "",
    contactPhone: candidates.map(usableEthiopianPhone).find((p): p is string => p !== null) ?? null,
    businesses: registration?.businesses ?? [],
  };
}
