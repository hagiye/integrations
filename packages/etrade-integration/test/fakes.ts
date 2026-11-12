import { Injectable } from "@nestjs/common";
import type { EtradeHolder, EtradeHost, EtradeLookupRecord, EtradeSaveResult } from "../src/etrade.host";
import type { EtradeLicenceSnapshot } from "../src/etrade.types";

/**
 * An in-memory EtradeHost that follows the saveSnapshot rules: re-reads the holder, refuses a
 * snapshot for a TIN the holder no longer has, never replaces a later snapshot with an older one.
 */
@Injectable()
export class FakeEtradeHost implements EtradeHost {
  readonly holders = new Map<string, EtradeHolder>();
  readonly saved: EtradeLicenceSnapshot[] = [];
  readonly records: EtradeLookupRecord[] = [];
  readonly cache = new Map<string, { value: unknown; ttlMs: number }>();
  /** Makes recordLookup throw. */
  failRecord = false;
  /** Changes the holder's TIN while saveSnapshot runs, as a concurrent edit would. */
  changeTinOnSave?: string;

  add(holder: EtradeHolder): EtradeHolder {
    this.holders.set(holder.id, { ...holder });
    return holder;
  }

  async findHolder(holderId: string): Promise<EtradeHolder | null> {
    const holder = this.holders.get(holderId);
    return holder ? { ...holder } : null;
  }

  async saveSnapshot(holder: EtradeHolder, snapshot: EtradeLicenceSnapshot): Promise<EtradeSaveResult> {
    const current = this.holders.get(holder.id);
    if (!current) return "NOT_FOUND";
    if (this.changeTinOnSave) current.tin = this.changeTinOnSave;
    if (current.tin !== snapshot.tin) return "TIN_CHANGED";
    if (current.snapshot && Date.parse(current.snapshot.checkedAt) > Date.parse(snapshot.checkedAt)) return "STALE";
    current.snapshot = snapshot;
    this.saved.push(snapshot);
    return "SAVED";
  }

  async recordLookup(record: EtradeLookupRecord): Promise<void> {
    if (this.failRecord) throw new Error("audit table is down");
    this.records.push(record);
  }

  async readCache(key: string): Promise<unknown | undefined> {
    return this.cache.get(key)?.value;
  }

  async writeCache(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.cache.set(key, { value, ttlMs });
  }
}

/** The same host with a shared lookup budget it controls. */
@Injectable()
export class BudgetedFakeEtradeHost extends FakeEtradeHost {
  readonly charges: Array<{ actor: string; tin: string }> = [];
  allow = true;

  async chargeLookup(actor: string, tin: string): Promise<boolean> {
    this.charges.push({ actor, tin });
    return this.allow;
  }
}
