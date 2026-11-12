/** e-trade (Ministry of Trade) lookups: registration by TIN, licence detail, verified licence snapshots. */
export * from "./etrade.module";
export * from "./etrade.options";
export * from "./etrade.client";
export * from "./etrade.service";
export * from "./etrade.host";
export * from "./etrade-lookup.controller";
export * from "./etrade.errors";
export * from "./etrade.types";
export * from "./etrade.budget";
export * from "./etrade.regions";
export { ETRADE_ISSUING_CA_PEM, etradeCaList, isEtradeProductionHost } from "./etrade.tls";
export {
  TIN_PATTERN,
  asCompanyNameSource,
  daysBetween,
  extractRegistrationData,
  isValidLicenceNumber,
  isValidTin,
  licenceStanding,
  maskTin,
  normalizeLicence,
  normalizeRegistration,
  parseEtradeDate,
  resolveCompanyName,
  stateFromStatus,
  stripActivityCode,
  toBusinessOption,
  usableEthiopianPhone,
} from "./etrade.normalize";
export type { LicenceStanding, LicenceStateContext } from "./etrade.normalize";
export { buildSnapshot, diffSnapshots, findLicence, isNewer, notListedSnapshot, selectLicence } from "./etrade.selection";
export type { LicenceSelection } from "./etrade.selection";
