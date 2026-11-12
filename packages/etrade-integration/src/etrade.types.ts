/**
 * e-trade's answers as they arrive (EDR's ETradeCompanyInfo and ETradeBusinessInfo, from
 * packages/types/src/freight/etrade.ts), every field optional and nullable: e-trade leaves
 * fields out, sends null entries inside lists, and spells LegalCondtion that way.
 */
export type EtradeLanguage = "en" | "am";

export interface EtradeRawAddressInfo {
  Region?: string | null;
  Zone?: string | null;
  Woreda?: string | null;
  Kebele?: string | null;
  HouseNo?: string | null;
  MobilePhone?: string | null;
  RegularPhone?: string | null;
}

export interface EtradeRawAssociate {
  Position?: string | null;
  ManagerName?: string | null;
  ManagerNameEng?: string | null;
  /** Never read or stored by this package. */
  Photo?: string | null;
  MobilePhone?: string | null;
  RegularPhone?: string | null;
}

export interface EtradeRawSubGroup {
  Code?: number | null;
  Description?: string | null;
}

/** One licence in the registration answer (S1 `Businesses[]`). */
export interface EtradeRawBusinessSummary {
  MainGuid?: string | null;
  OwnerTIN?: string | null;
  DateRegistered?: string | null;
  TradeNameAmh?: string | null;
  TradesName?: string | null;
  LicenceNumber?: string | null;
  RenewalDate?: string | null;
  RenewedFrom?: string | null;
  RenewedTo?: string | null;
  BusinessLicensingGroupMain?: string | null;
  /** e-trade sends null, a list, or a list with null entries. */
  SubGroups?: Array<EtradeRawSubGroup | null> | null;
}

/** S1: GET /Registration/GetRegistrationInfoByTin/{tin}/{lang}. */
export interface EtradeRawRegistration {
  Tin?: string | null;
  LegalCondtion?: string | null;
  RegNo?: string | null;
  RegDate?: string | null;
  BusinessName?: string | null;
  BusinessNameAmh?: string | null;
  PaidUpCapital?: number | null;
  AssociateShortInfos?: Array<EtradeRawAssociate | null> | null;
  Businesses?: Array<EtradeRawBusinessSummary | null> | null;
}

/** S2: GET /BusinessMain/GetBusinessByLicenseNo?LicenseNo=&Tin=&Lang=. */
export interface EtradeRawBusiness {
  MainGuid?: string | null;
  OwnerTIN?: string | null;
  DateRegistered?: string | null;
  TradeName?: string | null;
  LicenceNumber?: string | null;
  Status?: number | null;
  StatusDescription?: string | null;
  Capital?: number | null;
  AssociateShortInfos?: Array<EtradeRawAssociate | null> | null;
  AddressInfo?: EtradeRawAddressInfo | null;
  /** ISO date-time, e.g. 2018-07-07T00:00:00. */
  RenewedTo?: string | null;
  /** The same date as M/D/YYYY, like RenewedFrom and RenewalDate. */
  RenewedToDateString?: string | null;
  RenewalDate?: string | null;
  RenewedFrom?: string | null;
  CancellationDate?: string | null;
}

/**
 * One business licence held under a TIN, as a customer picks it. Same keys and rules as EDR's
 * ETradeBusinessOption, so a stored EDR snapshot reads as one.
 */
export interface EtradeBusinessOption {
  licenceNumber: string;
  /** TradesName, trimmed. May be empty. */
  tradeName: string;
  /** Licensed activities, code prefix "(65611)" removed, empty ones dropped, joined with ", ". */
  activity: string;
  /** RenewedTo as e-trade wrote it. May be empty. */
  renewedTo: string;
}

/** S1, normalised. */
export interface EtradeRegistration {
  tin: string;
  /** The registered organisation name (BusinessName). May be empty. */
  businessName: string;
  businessNameAmh: string;
  legalCondition: string;
  regNo: string;
  regDate: string;
  /** Every licence under the TIN that has a licence number, in e-trade's order. */
  businesses: EtradeBusinessOption[];
}

export interface EtradeLicenceAddress {
  /** e-trade's Region text before normalisation, kept for a reviewer. */
  rawRegion: string;
  /** One of ETHIOPIAN_REGIONS, or "" when it could not be resolved (never a guess). */
  region: string;
  zone: string;
  woreda: string;
  kebele: string;
  houseNo: string;
  /** Free text from e-trade ("09        " is a real answer). Check with usableEthiopianPhone. */
  mobilePhone: string;
  regularPhone: string;
}

export interface EtradeLicenceManager {
  /** ManagerNameEng of the first associate. */
  name: string;
  /** ManagerName (Amharic). */
  nameAmh: string;
  position: string;
  mobilePhone: string;
  regularPhone: string;
}

/** S2, normalised. No photo, no capital. */
export interface EtradeLicence {
  licenceNumber: string;
  ownerTin: string;
  /** TradeName of this licence, trimmed. May be empty. */
  tradeName: string;
  status: number | null;
  statusDescription: string;
  dateRegistered: string;
  renewedFrom: string;
  renewalDate: string;
  /** RenewedToDateString (M/D/YYYY), as EDR stores it; RenewedTo when that is missing. */
  renewedTo: string;
  /** The expiry as YYYY-MM-DD, or null when e-trade's text could not be read. */
  validUntil: string | null;
  cancellationDate: string | null;
  address: EtradeLicenceAddress;
  /** The first associate. e-trade does not say which one is the legal representative. */
  manager: EtradeLicenceManager | null;
}

export type EtradeRegistrationLookup = { found: true; registration: EtradeRegistration } | { found: false };
export type EtradeLicenceLookup = { found: true; licence: EtradeLicence } | { found: false };

/** Which of e-trade's two names a company goes by (EDR's CompanyNameSource). */
export type CompanyNameSource = "tradeName" | "businessName";

/**
 * Where a licence stands, as far as e-trade shows it.
 *
 * - ACTIVE: the status reads active, no cancellation date, not past its expiry.
 * - EXPIRED: past validUntil (in Ethiopian time).
 * - CANCELLED: a cancellation date, or a status that reads cancelled or revoked.
 * - SUSPENDED: a status that reads suspended.
 * - NOT_LISTED: e-trade no longer lists the licence under the TIN (recheck only).
 * - UNKNOWN: anything else. The meaning of e-trade's status codes was never published, so an
 *   unknown status is not treated as valid.
 */
export type EtradeLicenceState = "ACTIVE" | "EXPIRED" | "CANCELLED" | "SUSPENDED" | "NOT_LISTED" | "UNKNOWN";

/** Why a licence needs a person before it is trusted. */
export type EtradeLicenceProblem =
  | "LICENCE_EXPIRED"
  | "LICENCE_CANCELLED"
  | "LICENCE_SUSPENDED"
  | "LICENCE_NOT_LISTED"
  | "LICENCE_STATUS_UNKNOWN"
  | "LICENCE_DETAIL_NOT_FOUND"
  | "VALID_UNTIL_UNREADABLE";

/**
 * The registration data a company profile is prefilled from: EDR's CompanyRegistrationData,
 * without tinTaken (your own database answers that) and without managerEmail (e-trade never
 * sends one).
 */
export interface EtradeRegistrationData {
  /** tradeName or businessName, per the company's choice (resolveCompanyName). Never the manager's name. */
  companyName: string;
  tradeName: string;
  businessName: string;
  licenceNumber: string;
  statusDescription: string;
  dateRegistered: string;
  renewedFrom: string;
  renewalDate: string;
  renewedTo: string;
  validUntil: string | null;
  licenceState: EtradeLicenceState;
  region: string;
  rawRegion: string;
  zone: string;
  woreda: string;
  kebele: string;
  houseNo: string;
  mobilePhone: string;
  regularPhone: string;
  managerName: string;
  managerPhone: string;
  /** The first usable Ethiopian number among the manager's and the business's, as +251..., or null. */
  contactPhone: string | null;
  businesses: EtradeBusinessOption[];
}

/**
 * The licence a holder (a company, or one of its operational profiles) operates as, stored on
 * your side so screens never need e-trade. A superset of EDR's ETradeBusinessOption: the first
 * four keys are the same.
 */
export interface EtradeLicenceSnapshot {
  licenceNumber: string;
  tradeName: string;
  activity: string;
  renewedTo: string;
  /** The TIN the licence was looked up under: the holder's own. */
  tin: string;
  validUntil: string | null;
  /** Days from today (Ethiopian time) to validUntil; negative once past. null when unknown. */
  expiresInDays: number | null;
  state: EtradeLicenceState;
  statusCode: number | null;
  statusDescription: string;
  cancellationDate: string | null;
  rawRegion: string;
  region: string;
  /** True when problems is not empty: a person should look before it is relied on. */
  needsReview: boolean;
  problems: EtradeLicenceProblem[];
  /** When e-trade was asked, ISO 8601. */
  checkedAt: string;
  /** What answered: always e-trade's own registration (S1) and licence (S2) calls, never the browser. */
  source: "etrade:registration+licence";
  /** Who or what asked (a user id, "recheck"...), when known. */
  checkedBy: string | null;
}
