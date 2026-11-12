import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EtradeLicenceSnapshot, EtradeService, isValidTin } from "@edr/etrade-integration";
import { DataSource } from "typeorm";

export interface CreatedCompany {
  id: string;
  tin: string;
  profiles: Array<{ id: string; type: string }>;
}

export interface StoredProfile {
  id: string;
  companyId: string;
  type: string;
  tin: string;
  etradeLicence: EtradeLicenceSnapshot | null;
  etradeCheckedAt: string | null;
}

/** The example's companies and profiles. Your app has its own; only the e-trade calls matter here. */
@Injectable()
export class CompaniesService {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: { tin: string; name?: string; manualRegistration?: boolean; profiles?: string[] }): Promise<CreatedCompany> {
    if (!isValidTin(input.tin)) throw new BadRequestException("TIN must be exactly 10 digits");
    return this.dataSource.transaction(async (manager) => {
      const [company] = await manager.query(
        `INSERT INTO ${this.table("companies")} (tin, name, manual_registration) VALUES ($1, $2, $3) RETURNING id, tin`,
        [input.tin, input.name ?? "", input.manualRegistration === true],
      );
      const profiles: CreatedCompany["profiles"] = [];
      for (const type of input.profiles ?? ["importer"]) {
        const [profile] = await manager.query(
          `INSERT INTO ${this.table("company_profiles")} (company_id, type) VALUES ($1, $2) RETURNING id, type`,
          [company.id, type],
        );
        profiles.push(profile);
      }
      return { id: company.id, tin: company.tin, profiles };
    });
  }

  async profile(id: string): Promise<StoredProfile> {
    const rows = /^[0-9a-f-]{36}$/i.test(id)
      ? await this.dataSource.query(
          `SELECT p.id, p.company_id, p.type, c.tin, p.etrade_licence, p.etrade_checked_at
             FROM ${this.table("company_profiles")} p JOIN ${this.table("companies")} c ON c.id = p.company_id
            WHERE p.id = $1`,
          [id],
        )
      : [];
    const row = rows[0];
    if (!row) throw new NotFoundException("No such profile");
    return {
      id: row.id,
      companyId: row.company_id,
      type: row.type,
      tin: row.tin,
      etradeLicence: row.etrade_licence ?? null,
      etradeCheckedAt: row.etrade_checked_at ? new Date(row.etrade_checked_at).toISOString() : null,
    };
  }

  /** Profiles whose licence was last checked more than `days` ago, oldest first. */
  async dueForRecheck(days: number, limit: number): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT id FROM ${this.table("company_profiles")}
        WHERE etrade_licence IS NOT NULL AND etrade_checked_at < now() - make_interval(days => $1)
        ORDER BY etrade_checked_at LIMIT $2`,
      [days, limit],
    );
    return rows.map((r) => r.id);
  }

  private table(name: string): string {
    const schema = (this.dataSource.options as { schema?: string }).schema;
    return schema ? `"${schema}"."${name}"` : `"${name}"`;
  }
}

/**
 * Rechecks attached licences on a schedule, a few at a time so e-trade is not flooded. A failure
 * leaves that profile's snapshot as it was (stale), and it is tried again on the next round.
 */
export class EtradeRechecker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("EtradeRechecker");
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly companies: CompaniesService,
    private readonly etrade: EtradeService,
    private readonly everyMs: number,
    private readonly afterDays: number,
  ) {}

  onModuleInit(): void {
    if (this.everyMs > 0) this.timer = setInterval(() => void this.runOnce(), this.everyMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(batch = 20): Promise<{ checked: number; failed: number }> {
    let checked = 0;
    let failed = 0;
    for (const id of await this.companies.dueForRecheck(this.afterDays, batch)) {
      try {
        await this.etrade.recheck(id);
        checked++;
      } catch (err) {
        failed++;
        this.logger.warn(`recheck of profile ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { checked, failed };
  }
}
