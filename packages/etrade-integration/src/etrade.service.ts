import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { TinLookupBudget } from "./etrade.budget";
import { EtradeClient } from "./etrade.client";
import { EtradeError, EtradeErrorKind } from "./etrade.errors";
import { ETRADE_HOST, EtradeHost, EtradeLookupRecord } from "./etrade.host";
import {
  LicenceStanding,
  extractRegistrationData,
  isValidLicenceNumber,
  isValidTin,
  licenceStanding,
  maskTin,
} from "./etrade.normalize";
import { ETRADE_OPTIONS, ResolvedEtradeOptions } from "./etrade.options";
import { buildSnapshot, diffSnapshots, findLicence, notListedSnapshot, selectLicence } from "./etrade.selection";
import type {
  CompanyNameSource,
  EtradeBusinessOption,
  EtradeLanguage,
  EtradeLicence,
  EtradeLicenceProblem,
  EtradeLicenceSnapshot,
  EtradeRegistration,
  EtradeRegistrationData,
} from "./etrade.types";

export interface EtradeLookupInput {
  /** The TIN the customer typed. 10 digits, or INVALID before anything happens. */
  tin: string;
  /** Which of the TIN's licences to resolve. Omitted on the first lookup. */
  licenceNumber?: string;
  /** Who is looking up (a user or session id): charged against the TIN budget. */
  actor?: string;
  /** Which of e-trade's names companyName carries (resolveCompanyName). */
  nameSource?: CompanyNameSource | null;
  language?: EtradeLanguage;
  /** Skip the cache and ask e-trade. */
  fresh?: boolean;
}

/**
 * - RESOLVED: the licence detail is in `data`.
 * - NO_LICENCES: the TIN is registered but holds no trade licence (a co-operative, an investor).
 * - NOT_SELECTED: the chosen licence is not listed under the TIN; the customer chooses again.
 * - NOT_FOUND: listed, but e-trade has no detail for it.
 * - UNAVAILABLE: the detail call failed (licenceDetailError says how); the list is still here.
 */
export type EtradeLicenceDetail = "RESOLVED" | "NO_LICENCES" | "NOT_SELECTED" | "NOT_FOUND" | "UNAVAILABLE";

export type EtradeLookupResult =
  | { found: false; tin: string }
  | {
      found: true;
      tin: string;
      /** The registered organisation name. */
      businessName: string;
      /** Every licence under the TIN, for the customer to choose from. */
      businesses: EtradeBusinessOption[];
      /** The licence `data` describes, or null. */
      selectedLicence: string | null;
      /** A licenceNumber was given and e-trade does not list it under this TIN. */
      chosenLicenceMissing: boolean;
      licenceDetail: EtradeLicenceDetail;
      licenceDetailError?: EtradeErrorKind;
      /** The prefill. null unless licenceDetail is RESOLVED. */
      data: EtradeRegistrationData | null;
    };

export interface EtradeAttachInput {
  /** Your holder id: a company, or one of its profiles. */
  holderId: string;
  /** The licence number the client chose. Only one e-trade lists under the holder's own TIN is accepted. */
  licenceNumber: string;
  /** The TIN the client believes it is attaching under. Refused when it is not the holder's. */
  expectedTin?: string;
  /** Who asked, stored as snapshot.checkedBy. */
  actor?: string | null;
}

export type EtradeAttachRefusal =
  | "UNKNOWN_HOLDER"
  | "MANUAL_REGISTRATION"
  | "HOLDER_TIN_INVALID"
  | "TIN_MISMATCH"
  | "NOT_REGISTERED"
  | "LICENCE_NOT_LISTED"
  | "TIN_CHANGED"
  | "STALE"
  | EtradeLicenceProblem;

export type EtradeAttachResult =
  | { outcome: "ATTACHED"; snapshot: EtradeLicenceSnapshot }
  /** Stored with needsReview (options.licenceProblems = "flag"). */
  | { outcome: "FLAGGED"; snapshot: EtradeLicenceSnapshot; problems: EtradeLicenceProblem[] }
  /** Nothing stored. `snapshot` is what e-trade said, when the refusal is about the licence itself. */
  | { outcome: "REFUSED"; reason: EtradeAttachRefusal; snapshot?: EtradeLicenceSnapshot };

export type EtradeRecheckResult =
  | {
      /** UPDATED: something changed. LICENCE_GONE: e-trade no longer lists it; the last known data is kept, flagged. */
      outcome: "UNCHANGED" | "UPDATED" | "LICENCE_GONE";
      snapshot: EtradeLicenceSnapshot;
      changes: string[];
    }
  | { outcome: "SKIPPED"; reason: "UNKNOWN_HOLDER" | "MANUAL_REGISTRATION" | "NO_SNAPSHOT" | "HOLDER_TIN_INVALID" | "TIN_CHANGED" | "STALE" };

interface CallContext {
  actor: string | null;
  language: EtradeLanguage;
  /** Read and write the cache. False for attach and recheck. */
  useCache: boolean;
}

/**
 * The rules around e-trade: the lookup a customer makes while onboarding (budgeted, cached),
 * and the licence snapshot attached to a company or profile (always fresh, always e-trade's
 * own data, under the holder's own TIN).
 */
@Injectable()
export class EtradeService {
  private readonly logger = new Logger("EtradeService");
  private readonly budget: TinLookupBudget | null;

  constructor(
    private readonly client: EtradeClient,
    @Inject(ETRADE_OPTIONS) private readonly options: ResolvedEtradeOptions,
    @Optional() @Inject(ETRADE_HOST) private readonly host?: EtradeHost,
  ) {
    this.budget =
      !host?.chargeLookup && options.lookupBudget
        ? new TinLookupBudget(options.lookupBudget.limit, options.lookupBudget.windowMs)
        : null;
    if (!host?.chargeLookup && !options.lookupBudget) {
      this.logger.warn("No TIN lookup budget: lookups are not limited per actor (options.lookupBudget is false).");
    }
  }

  /**
   * A customer's TIN lookup, with the licence they chose (or the first): EDR's
   * fetchETradeData, without the TIN-taken check, which is your database's to answer.
   *
   * Charged against the TIN budget before anything is sent. A failed licence-detail call still
   * returns the registration and the licence list (licenceDetail UNAVAILABLE).
   */
  async lookup(input: EtradeLookupInput): Promise<EtradeLookupResult> {
    const tin = typeof input.tin === "string" ? input.tin.trim() : "";
    if (!isValidTin(tin)) throw new EtradeError("INVALID", "TIN must be exactly 10 digits");
    if (input.licenceNumber !== undefined && input.licenceNumber !== null && input.licenceNumber !== "" && !isValidLicenceNumber(input.licenceNumber)) {
      throw new EtradeError("INVALID", "licenceNumber must be 1 to 120 characters without control characters");
    }
    const actor = typeof input.actor === "string" && input.actor.trim() ? input.actor.trim() : null;
    await this.charge(actor, tin);
    const context: CallContext = { actor, language: input.language ?? this.options.language, useCache: input.fresh !== true };

    const registration = await this.registration(tin, context);
    if (!registration) return { found: false, tin };
    const base = { found: true as const, tin, businessName: registration.businessName, businesses: registration.businesses };
    if (!registration.businesses.length) {
      return { ...base, selectedLicence: null, chosenLicenceMissing: false, licenceDetail: "NO_LICENCES", data: null };
    }
    const selection = selectLicence(registration.businesses, input.licenceNumber, this.options.onMissingChosenLicence);
    if (!selection.selected) {
      return { ...base, selectedLicence: null, chosenLicenceMissing: true, licenceDetail: "NOT_SELECTED", data: null };
    }
    const chosen = selection.selected.licenceNumber;
    let licence: EtradeLicence | null;
    try {
      licence = await this.licence(chosen, tin, context);
    } catch (err) {
      if (!(err instanceof EtradeError) || err.kind === "CONFIG" || err.kind === "INVALID") throw err;
      return {
        ...base,
        selectedLicence: chosen,
        chosenLicenceMissing: selection.chosenMissing,
        licenceDetail: "UNAVAILABLE",
        licenceDetailError: err.kind,
        data: null,
      };
    }
    if (!licence) {
      return { ...base, selectedLicence: chosen, chosenLicenceMissing: selection.chosenMissing, licenceDetail: "NOT_FOUND", data: null };
    }
    return {
      ...base,
      selectedLicence: chosen,
      chosenLicenceMissing: selection.chosenMissing,
      licenceDetail: "RESOLVED",
      data: extractRegistrationData(licence, registration, this.standing(licence), input.nameSource),
    };
  }

  /**
   * The licences a holder can attach, under its own TIN (EDR's listEtradeBusinessesForUser).
   * Empty for a manually registered company and for a TIN e-trade does not know. Not budgeted:
   * the TIN is the holder's, not typed by the caller.
   */
  async licencesFor(holderId: string, actor: string | null = null): Promise<EtradeBusinessOption[]> {
    const holder = await this.requireHost().findHolder(holderId);
    if (!holder) throw new EtradeError("INVALID", "Unknown holder");
    if (holder.manualRegistration || !isValidTin(holder.tin)) return [];
    const registration = await this.registration(holder.tin, { actor, language: this.options.language, useCache: true });
    return registration?.businesses ?? [];
  }

  /**
   * Attach one of the holder's licences (EDR's attachEtradeBusinessToProfile). The client sends
   * only a licence number; what is stored is built from e-trade's own answers for the holder's
   * own TIN, asked afresh. A licence that is not plainly active is refused, or stored flagged
   * when options.licenceProblems is "flag". Attaching again refreshes the snapshot, which is how
   * a renewed licence's new expiry arrives.
   */
  async attach(input: EtradeAttachInput): Promise<EtradeAttachResult> {
    const host = this.requireHost();
    if (!isValidLicenceNumber(input.licenceNumber)) {
      throw new EtradeError("INVALID", "licenceNumber must be 1 to 120 characters without control characters");
    }
    const holder = await host.findHolder(input.holderId);
    if (!holder) return { outcome: "REFUSED", reason: "UNKNOWN_HOLDER" };
    if (holder.manualRegistration) return { outcome: "REFUSED", reason: "MANUAL_REGISTRATION" };
    if (!isValidTin(holder.tin)) return { outcome: "REFUSED", reason: "HOLDER_TIN_INVALID" };
    if (input.expectedTin !== undefined && input.expectedTin.trim() !== holder.tin) {
      return { outcome: "REFUSED", reason: "TIN_MISMATCH" };
    }
    const actor = input.actor ?? null;
    const context: CallContext = { actor, language: this.options.language, useCache: false };
    const checkedAt = new Date();

    const registration = await this.registration(holder.tin, context);
    if (!registration) return { outcome: "REFUSED", reason: "NOT_REGISTERED" };
    const option = findLicence(registration.businesses, input.licenceNumber);
    if (!option) return { outcome: "REFUSED", reason: "LICENCE_NOT_LISTED" };
    const licence = await this.licence(option.licenceNumber, holder.tin, context);
    const snapshot = buildSnapshot({
      tin: holder.tin,
      option,
      licence,
      standing: licence ? this.standing(licence) : null,
      checkedAt,
      checkedBy: actor,
    });

    if (snapshot.problems.length && this.options.licenceProblems === "refuse") {
      return { outcome: "REFUSED", reason: snapshot.problems[0], snapshot };
    }
    const saved = await host.saveSnapshot(holder, snapshot);
    if (saved === "NOT_FOUND") return { outcome: "REFUSED", reason: "UNKNOWN_HOLDER" };
    if (saved === "TIN_CHANGED" || saved === "STALE") return { outcome: "REFUSED", reason: saved };
    return snapshot.problems.length
      ? { outcome: "FLAGGED", snapshot, problems: snapshot.problems }
      : { outcome: "ATTACHED", snapshot };
  }

  /**
   * Refresh a holder's stored snapshot from e-trade (EDR did this only on a customer's
   * re-verify). Always fresh, always stored with its new check time. A licence e-trade no longer
   * lists keeps its last known data, flagged NOT_LISTED. Run it on a schedule (the guide
   * suggests every 30 days, and as the expiry nears); a failure throws and leaves the stored
   * snapshot as it was.
   */
  async recheck(holderId: string, actor: string | null = "recheck"): Promise<EtradeRecheckResult> {
    const host = this.requireHost();
    const holder = await host.findHolder(holderId);
    if (!holder) return { outcome: "SKIPPED", reason: "UNKNOWN_HOLDER" };
    if (holder.manualRegistration) return { outcome: "SKIPPED", reason: "MANUAL_REGISTRATION" };
    const previous = holder.snapshot;
    if (!previous) return { outcome: "SKIPPED", reason: "NO_SNAPSHOT" };
    if (!isValidTin(holder.tin)) return { outcome: "SKIPPED", reason: "HOLDER_TIN_INVALID" };
    const context: CallContext = { actor, language: this.options.language, useCache: false };
    const checkedAt = new Date();

    const registration = await this.registration(holder.tin, context);
    const option = registration ? findLicence(registration.businesses, previous.licenceNumber) : null;
    let snapshot: EtradeLicenceSnapshot;
    if (!option) {
      snapshot = { ...notListedSnapshot(previous, checkedAt, actor), tin: holder.tin };
    } else {
      const licence = await this.licence(option.licenceNumber, holder.tin, context);
      snapshot = buildSnapshot({
        tin: holder.tin,
        option,
        licence,
        standing: licence ? this.standing(licence) : null,
        checkedAt,
        checkedBy: actor,
      });
    }
    const changes = diffSnapshots(previous, snapshot);
    const saved = await host.saveSnapshot(holder, snapshot);
    if (saved === "NOT_FOUND") return { outcome: "SKIPPED", reason: "UNKNOWN_HOLDER" };
    if (saved === "TIN_CHANGED" || saved === "STALE") return { outcome: "SKIPPED", reason: saved };
    if (changes.length) {
      this.logger.log(`e-trade recheck of holder ${holder.id}: ${changes.join(", ")} changed (${snapshot.state})`);
    }
    return { outcome: snapshot.state === "NOT_LISTED" ? "LICENCE_GONE" : changes.length ? "UPDATED" : "UNCHANGED", snapshot, changes };
  }

  /** Where a licence stands today (Ethiopian time). */
  standing(licence: EtradeLicence, now = new Date()): LicenceStanding {
    return licenceStanding(licence, {
      now,
      dateUtcOffsetMinutes: this.options.dateUtcOffsetMinutes,
      statusMap: this.options.statusMap,
    });
  }

  private requireHost(): EtradeHost {
    if (!this.host) throw new EtradeError("CONFIG", "EtradeModule has no host: attach and recheck need one (EtradeHost)");
    return this.host;
  }

  private async charge(actor: string | null, tin: string): Promise<void> {
    if (this.host?.chargeLookup) {
      if (!actor) throw new EtradeError("INVALID", "actor is required: lookups are charged to who makes them", { code: "ACTOR_REQUIRED" });
      if (!(await this.host.chargeLookup(actor, tin))) {
        throw new EtradeError("BUDGET", "Too many different TINs have been looked up from this account");
      }
      return;
    }
    if (this.budget) {
      if (!actor) throw new EtradeError("INVALID", "actor is required: lookups are charged to who makes them", { code: "ACTOR_REQUIRED" });
      if (!this.budget.charge(actor, tin)) {
        throw new EtradeError("BUDGET", "Too many different TINs have been looked up from this account");
      }
    }
  }

  private async registration(tin: string, context: CallContext): Promise<EtradeRegistration | null> {
    const key = `etrade:registration:${context.language}:${tin}`;
    if (context.useCache) {
      const hit = await this.cacheRead(key);
      if (isCachedRegistration(hit, tin)) {
        await this.record({ at: new Date(), actor: context.actor, call: "REGISTRATION", tin, outcome: "FOUND", cached: true, durationMs: 0, httpStatus: null });
        return hit;
      }
    }
    const started = Date.now();
    try {
      const result = await this.client.getRegistrationByTin(tin, { language: context.language });
      await this.record({
        at: new Date(started),
        actor: context.actor,
        call: "REGISTRATION",
        tin,
        outcome: result.found ? "FOUND" : "NOT_FOUND",
        cached: false,
        durationMs: Date.now() - started,
        httpStatus: result.httpStatus,
      });
      if (!result.found) return null;
      if (context.useCache) await this.cacheWrite(key, result.registration);
      return result.registration;
    } catch (err) {
      await this.recordFailure(err, { started, actor: context.actor, call: "REGISTRATION", tin });
      throw err;
    }
  }

  private async licence(licenceNumber: string, tin: string, context: CallContext): Promise<EtradeLicence | null> {
    const key = `etrade:licence:${context.language}:${tin}:${licenceNumber}`;
    if (context.useCache) {
      const hit = await this.cacheRead(key);
      if (isCachedLicence(hit, licenceNumber)) {
        await this.record({ at: new Date(), actor: context.actor, call: "LICENCE", tin, licenceNumber, outcome: "FOUND", cached: true, durationMs: 0, httpStatus: null });
        return hit;
      }
    }
    const started = Date.now();
    try {
      const result = await this.client.getBusinessByLicence(licenceNumber, tin, { language: context.language });
      await this.record({
        at: new Date(started),
        actor: context.actor,
        call: "LICENCE",
        tin,
        licenceNumber,
        outcome: result.found ? "FOUND" : "NOT_FOUND",
        cached: false,
        durationMs: Date.now() - started,
        httpStatus: result.httpStatus,
      });
      if (!result.found) return null;
      if (context.useCache) await this.cacheWrite(key, result.licence);
      return result.licence;
    } catch (err) {
      await this.recordFailure(err, { started, actor: context.actor, call: "LICENCE", tin, licenceNumber });
      throw err;
    }
  }

  private async recordFailure(
    err: unknown,
    call: { started: number; actor: string | null; call: EtradeLookupRecord["call"]; tin: string; licenceNumber?: string },
  ): Promise<void> {
    const kind: EtradeErrorKind = err instanceof EtradeError ? err.kind : "NETWORK";
    await this.record({
      at: new Date(call.started),
      actor: call.actor,
      call: call.call,
      tin: call.tin,
      ...(call.licenceNumber ? { licenceNumber: call.licenceNumber } : {}),
      outcome: kind,
      ...(err instanceof EtradeError && err.details.code ? { code: err.details.code } : {}),
      cached: false,
      durationMs: Date.now() - call.started,
      httpStatus: err instanceof EtradeError && typeof err.details.status === "number" ? err.details.status : null,
    });
  }

  private async record(entry: EtradeLookupRecord): Promise<void> {
    if (!this.host?.recordLookup) return;
    try {
      await this.host.recordLookup(entry);
    } catch (err) {
      this.logger.error(`recordLookup failed for TIN ${maskTin(entry.tin)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cacheRead(key: string): Promise<unknown> {
    if (!this.options.cacheTtlMs || !this.host?.readCache) return undefined;
    try {
      return await this.host.readCache(key);
    } catch (err) {
      this.logger.warn(`readCache failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async cacheWrite(key: string, value: unknown): Promise<void> {
    if (!this.options.cacheTtlMs || !this.host?.writeCache) return;
    try {
      await this.host.writeCache(key, value, this.options.cacheTtlMs);
    } catch (err) {
      this.logger.warn(`writeCache failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isCachedRegistration(value: unknown, tin: string): value is EtradeRegistration {
  const v = value as EtradeRegistration | undefined;
  return !!v && typeof v === "object" && v.tin === tin && Array.isArray(v.businesses);
}

function isCachedLicence(value: unknown, licenceNumber: string): value is EtradeLicence {
  const v = value as EtradeLicence | undefined;
  return !!v && typeof v === "object" && v.licenceNumber === licenceNumber && typeof v.address === "object";
}
