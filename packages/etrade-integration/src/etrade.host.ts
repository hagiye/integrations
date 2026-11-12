import type { EtradeErrorKind } from "./etrade.errors";
import type { EtradeLicenceSnapshot } from "./etrade.types";

export const ETRADE_HOST = Symbol("ETRADE_HOST");

/**
 * What a licence snapshot attaches to: a company, or one of its operational profiles (EDR
 * attaches one per profile: importer, exporter, freight forwarder). Several holders may carry
 * the same licence.
 */
export interface EtradeHolder {
  /** Your id for the holder. */
  id: string;
  /** The TIN of the company the holder belongs to, as stored on your side. */
  tin: string;
  /**
   * True for a company registered by hand rather than from e-trade (a co-operative, an
   * investment-licence company, one with no Ethiopian TIN): it has no e-trade licences, so
   * attach refuses and nothing is sent.
   */
  manualRegistration?: boolean;
  /** The snapshot stored now, if any. recheck refreshes it. */
  snapshot?: EtradeLicenceSnapshot | null;
}

/**
 * - SAVED: stored.
 * - STALE: your row already holds a snapshot checked later than this one; nothing changed.
 * - TIN_CHANGED: the holder's TIN changed after the lookup started; nothing changed.
 * - NOT_FOUND: the holder is gone.
 */
export type EtradeSaveResult = "SAVED" | "STALE" | "TIN_CHANGED" | "NOT_FOUND";

/** One e-trade call, for your lookup log. Holds no answer body and no personal data. */
export interface EtradeLookupRecord {
  at: Date;
  /** Who caused it: a user id, "recheck", or null. */
  actor: string | null;
  call: "REGISTRATION" | "LICENCE";
  /** The TIN asked about. Hash it before storing if the log is widely shared. */
  tin: string;
  licenceNumber?: string;
  outcome: "FOUND" | "NOT_FOUND" | EtradeErrorKind;
  /** A finer reason for a failure: REFERER_REJECTED, CIRCUIT_OPEN, a TLS code... */
  code?: string;
  /** True when the answer came from your cache and e-trade was not called. */
  cached: boolean;
  durationMs: number;
  httpStatus: number | null;
}

/**
 * The port your app implements. Only findHolder and saveSnapshot are needed, and only for
 * attach and recheck: lookup works without a host.
 */
export interface EtradeHost {
  findHolder(holderId: string): Promise<EtradeHolder | null>;

  /**
   * Store a snapshot on the holder. In one transaction:
   *
   * 1. lock the holder's row (and its company's, where the TIN lives) and re-read them;
   * 2. return "NOT_FOUND" if it is gone;
   * 3. return "TIN_CHANGED" if the company's TIN is no longer snapshot.tin;
   * 4. return "STALE" if the stored snapshot's checkedAt is later than snapshot.checkedAt;
   * 5. otherwise store it and return "SAVED".
   *
   * Two attaches for one holder (two tabs, two instances) then leave the later answer stored,
   * and a snapshot never sits on a company whose TIN it was not looked up under.
   */
  saveSnapshot(holder: EtradeHolder, snapshot: EtradeLicenceSnapshot): Promise<EtradeSaveResult>;

  /**
   * Charge a lookup of `tin` to `actor`, against a budget shared by every instance. Return false
   * to refuse it (EtradeError BUDGET, nothing sent). Without this method, options.lookupBudget
   * applies in process memory.
   */
  chargeLookup?(actor: string, tin: string): Promise<boolean>;

  /** Called once per call (or cache hit). A failure here is logged and never fails the lookup. */
  recordLookup?(record: EtradeLookupRecord): Promise<void>;

  /** Optional cache for lookup(): found answers only, for options.cacheTtlMs. */
  readCache?(key: string): Promise<unknown | undefined>;
  writeCache?(key: string, value: unknown, ttlMs: number): Promise<void>;
}
