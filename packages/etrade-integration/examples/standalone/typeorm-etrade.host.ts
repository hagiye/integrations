import { Inject, Injectable } from "@nestjs/common";
import * as crypto from "node:crypto";
import {
  EtradeHolder,
  EtradeHost,
  EtradeLicenceSnapshot,
  EtradeLookupRecord,
  EtradeSaveResult,
  isNewer,
} from "@edr/etrade-integration";
import { DataSource } from "typeorm";

export const EXAMPLE_HOST_CONFIG = Symbol("EXAMPLE_HOST_CONFIG");

export interface ExampleHostConfig {
  /**
   * Key for hashing TINs in the lookup log and the budget. A plain SHA-256 of a 10-digit TIN
   * can be reversed by trying all 10^10 of them, so the hash is keyed (ETRADE_TIN_HASH_KEY).
   */
  tinHashKey: string;
  /** Different TINs per actor per window, shared by every instance. */
  budget: { limit: number; windowMs: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * EtradeHost over the example's tables, in plain SQL so the locking is visible. Only DataSource
 * and the config are injected: TypeOrmModule.forRoot makes DataSource available everywhere, and
 * the config is passed in EtradeModule's `providers`.
 */
@Injectable()
export class TypeOrmEtradeHost implements EtradeHost {
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly dataSource: DataSource,
    @Inject(EXAMPLE_HOST_CONFIG) private readonly config: ExampleHostConfig,
  ) {}

  async findHolder(holderId: string): Promise<EtradeHolder | null> {
    if (!UUID.test(holderId)) return null;
    const [row] = await this.dataSource.query(
      `SELECT p.id, c.tin, c.manual_registration, p.etrade_licence
         FROM ${this.table("company_profiles")} p JOIN ${this.table("companies")} c ON c.id = p.company_id
        WHERE p.id = $1`,
      [holderId],
    );
    if (!row) return null;
    return { id: row.id, tin: row.tin, manualRegistration: row.manual_registration, snapshot: row.etrade_licence ?? null };
  }

  async saveSnapshot(holder: EtradeHolder, snapshot: EtradeLicenceSnapshot): Promise<EtradeSaveResult> {
    return this.dataSource.transaction(async (manager) => {
      // Row locks on the profile and its company: two attaches for one profile queue here, and
      // a TIN edit cannot slip in between this check and the write.
      const [row] = await manager.query(
        `SELECT p.id, c.tin, p.etrade_licence
           FROM ${this.table("company_profiles")} p JOIN ${this.table("companies")} c ON c.id = p.company_id
          WHERE p.id = $1
          FOR UPDATE OF p, c`,
        [holder.id],
      );
      if (!row) return "NOT_FOUND";
      if (row.tin !== snapshot.tin) return "TIN_CHANGED";
      if (!isNewer(snapshot, row.etrade_licence as EtradeLicenceSnapshot | null)) return "STALE";
      await manager.query(
        `UPDATE ${this.table("company_profiles")} SET etrade_licence = $2::jsonb, etrade_checked_at = $3 WHERE id = $1`,
        [holder.id, JSON.stringify(snapshot), snapshot.checkedAt],
      );
      // A changed state (expired, cancelled, gone) is where a staff alert or an audit entry goes.
      return "SAVED";
    });
  }

  /** The TIN budget in Postgres, so a restart or a second instance does not reset it. */
  async chargeLookup(actor: string, tin: string): Promise<boolean> {
    const tinHash = this.hash(tin);
    const table = this.table("etrade_tin_budget");
    return this.dataSource.transaction(async (manager) => {
      // One charge per actor at a time, across instances: no two requests both see room for one.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`etrade-budget:${actor}`]);
      await manager.query(`DELETE FROM ${table} WHERE actor = $1 AND charged_at < now() - make_interval(secs => $2)`, [
        actor,
        this.config.budget.windowMs / 1000,
      ]);
      const rows: Array<{ tin_hash: string }> = await manager.query(`SELECT tin_hash FROM ${table} WHERE actor = $1`, [actor]);
      if (rows.some((r) => r.tin_hash === tinHash)) return true;
      if (rows.length >= this.config.budget.limit) return false;
      await manager.query(`INSERT INTO ${table} (actor, tin_hash) VALUES ($1, $2)`, [actor, tinHash]);
      return true;
    });
  }

  async recordLookup(record: EtradeLookupRecord): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ${this.table("etrade_lookups")}
         (at, actor, call, tin_hash, licence_number, outcome, code, cached, duration_ms, http_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.at,
        record.actor,
        record.call,
        this.hash(record.tin),
        record.licenceNumber ?? null,
        record.outcome,
        record.code ?? null,
        record.cached,
        record.durationMs,
        record.httpStatus,
      ],
    );
  }

  /** In process memory only: the cache holds third parties' business data, so it is not written to disk. */
  async readCache(key: string): Promise<unknown | undefined> {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async writeCache(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  hash(tin: string): string {
    return crypto.createHmac("sha256", this.config.tinHashKey).update(tin).digest("hex");
  }

  private table(name: string): string {
    const schema = (this.dataSource.options as { schema?: string }).schema;
    return schema ? `"${schema}"."${name}"` : `"${name}"`;
  }
}
