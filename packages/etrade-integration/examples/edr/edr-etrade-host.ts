/**
 * NOT COMPILED HERE: it imports EDR code. How EDR's freight API (apps/edr-freight-api, origin/dev
 * 4e43da58b) would use this package in place of modules/companies/services/etrade.service.ts.
 * Paths are EDR's. See docs/INTEGRATION-GUIDE.md, section 13.
 *
 * What changes for EDR:
 * - TLS is verified (the bundled GlobalSign CA completes e-trade's chain), and every call has
 *   a deadline. EDR ran with rejectUnauthorized false and no timeout.
 * - company_profiles.etrade_business keeps its column and its first four keys
 *   (licenceNumber, tradeName, activity, renewedTo); the snapshot adds state, validUntil,
 *   checkedAt and the rest, so billing's tradeName reads keep working.
 * - A licence e-trade no longer lists is no longer swapped for the TIN's first licence.
 * - "TIN unknown", "no licence" and "e-trade down" are told apart.
 */
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  ETRADE_PUBLIC_API_URL,
  EtradeError,
  EtradeHolder,
  EtradeHost,
  EtradeLicenceSnapshot,
  EtradeLookupRecord,
  EtradeModule,
  EtradeSaveResult,
  EtradeService,
  isNewer,
  maskTin,
} from "@edr/etrade-integration";
import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
// EDR imports (apps/edr-freight-api/src/...):
import { usesManualRegistration } from "../../modules/companies/entities/company.entity";
import { realTin } from "../../common/validators/is-tin.validator";
import type { CompanyNameSource } from "@edr/types";

/** EtradeHost over freight.company_profiles (the holder) and freight.companies (the TIN). */
@Injectable()
export class EdrEtradeHost implements EtradeHost {
  private readonly logger = new Logger("EdrEtradeHost");

  constructor(private readonly dataSource: DataSource) {}

  async findHolder(profileId: string): Promise<EtradeHolder | null> {
    const [row] = await this.dataSource.query(
      `SELECT p.id, p.etrade_business, c.tin, c.attributes, c.kind
         FROM freight.company_profiles p JOIN freight.companies c ON c.id = p.company_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [profileId],
    );
    if (!row) return null;
    return {
      id: row.id,
      // A placeholder TIN (D/F/I + 9 digits) is never sent: realTin() blanks it, and the package
      // then refuses with HOLDER_TIN_INVALID.
      tin: realTin(row.tin) ?? "",
      manualRegistration: usesManualRegistration({ attributes: row.attributes, kind: row.kind }),
      // Older EDR snapshots have no checkedAt; isNewer() treats them as older than any new one.
      snapshot: row.etrade_business ?? null,
    };
  }

  async saveSnapshot(holder: EtradeHolder, snapshot: EtradeLicenceSnapshot): Promise<EtradeSaveResult> {
    return this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `SELECT p.id, p.etrade_business, c.tin
           FROM freight.company_profiles p JOIN freight.companies c ON c.id = p.company_id
          WHERE p.id = $1 AND p.deleted_at IS NULL
          FOR UPDATE OF p, c`,
        [holder.id],
      );
      if (!row) return "NOT_FOUND";
      if (row.tin !== snapshot.tin) return "TIN_CHANGED";
      if (!isNewer(snapshot, row.etrade_business)) return "STALE";
      await manager.query(`UPDATE freight.company_profiles SET etrade_business = $2::jsonb, updated_at = now() WHERE id = $1`, [
        holder.id,
        JSON.stringify(snapshot),
      ]);
      return "SAVED";
    });
  }

  // chargeLookup is left out on purpose for a first step: options.lookupBudget then applies in
  // process memory with EDR's own numbers (10 TINs per account per 24 h), exactly as
  // TinLookupBudget does today. Behind more than one API replica, implement it over Redis or a
  // table (see the standalone example's TypeOrmEtradeHost.chargeLookup).

  async recordLookup(record: EtradeLookupRecord): Promise<void> {
    // EDR has no e-trade log today. One structured line per call, never the body; a table like
    // the example's etrade_lookups is the better home.
    this.logger.log(
      `etrade ${record.call} tin=${maskTin(record.tin)} outcome=${record.outcome}${record.code ? `/${record.code}` : ""} ` +
        `cached=${record.cached} ms=${record.durationMs} http=${record.httpStatus ?? "-"} actor=${record.actor ?? "-"}`,
    );
  }
}

/** In CompaniesModule: replaces the ETradeService provider and the HttpModule it needed. */
@Module({
  imports: [
    EtradeModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // EDR hard-coded this. Make it config, so the Ministry's formal address can replace it.
        baseUrl: config.get<string>("ETRADE_BASE_URL") || ETRADE_PUBLIC_API_URL,
        ...(config.get<string>("ETRADE_CA_PEM") ? { ca: config.get<string>("ETRADE_CA_PEM") } : {}),
        // EDR's numbers. The package's defaults would also refuse expired licences on attach;
        // "flag" keeps EDR's behaviour of attaching anyway, now with needsReview set.
        lookupBudget: { limit: 10, windowMs: 24 * 60 * 60 * 1000 },
        licenceProblems: "flag",
      }),
      host: EdrEtradeHost,
    }),
  ],
  exports: [EtradeModule],
})
export class EdrEtradeModule {}

/**
 * The CompaniesService call sites, rewritten. Each replaces the method named in its comment.
 */
@Injectable()
export class EdrCompaniesEtradeCalls {
  constructor(
    private readonly etrade: EtradeService,
    private readonly companiesRepo: { findActiveByTin(tin: string, excludeId?: string): Promise<unknown> },
  ) {}

  /** CompaniesService.fetchETradeData (POST /companies/fetch-etrade-info). */
  async fetchETradeData(userId: string, tin: string, companyId?: string, licenceNumber?: string, nameSource?: CompanyNameSource | null) {
    let result;
    try {
      // The package charges the budget (it replaces this.tinLookups.charge) and validates the TIN.
      result = await this.etrade.lookup({ tin, licenceNumber, nameSource, actor: userId });
    } catch (err) {
      throw toHttp(err);
    }
    if (!result.found) throw new BadRequestException("eTrade has no registration for this TIN. Check the number, or register by hand.");
    if (result.licenceDetail === "NO_LICENCES") {
      throw new BadRequestException("We couldn't find a business license for this TIN with eTrade.");
    }
    if (result.licenceDetail === "NOT_SELECTED") {
      // EDR silently took the first licence here. Ask again instead.
      throw new BadRequestException("That business licence is no longer listed under this TIN. Please choose again.");
    }
    if (!result.data) {
      // UNAVAILABLE / NOT_FOUND: e-trade failed or has no detail. EDR said "no licence" for both.
      throw new ServiceUnavailableException("eTrade did not answer for this licence. Try again, or register by hand.");
    }
    const tinTaken = Boolean(await this.companiesRepo.findActiveByTin(tin, companyId));
    // Re-verifying the company's own TIN: refresh each profile's snapshot (EDR's
    // refreshProfileBusinesses) by calling this.etrade.recheck(profile.id) for each profile.
    return { ...result.data, tinTaken };
  }

  /** CompaniesService.attachEtradeBusinessToProfile (PATCH /companies/company-profiles/:id/etrade-business). */
  async attachEtradeBusinessToProfile(userId: string, profileId: string, licenceNumber: string) {
    // Keep EDR's ownership check first: the profile must belong to the caller's company.
    let result;
    try {
      result = await this.etrade.attach({ holderId: profileId, licenceNumber, actor: userId });
    } catch (err) {
      throw toHttp(err);
    }
    if (result.outcome === "REFUSED") {
      throw new BadRequestException(
        result.reason === "LICENCE_NOT_LISTED"
          ? "eTrade lists no such business licence under your TIN."
          : result.reason === "MANUAL_REGISTRATION"
            ? "This company is not registered with eTrade, so it has no business licences to attach."
            : `This licence cannot be attached (${result.reason}).`,
      );
    }
    return result.snapshot;
  }
}

function toHttp(err: unknown) {
  if (err instanceof EtradeError && err.kind === "INVALID") return new BadRequestException(err.message);
  if (err instanceof EtradeError && err.kind === "BUDGET") {
    // The same 429 and wording as EDR's TinLookupBudget.
    return new HttpException(
      "Too many different TINs have been looked up from this account. Try again tomorrow, or contact EDR support.",
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  // EDR put error.message (TLS codes, addresses) into a 400 for the customer. Never again.
  return new ServiceUnavailableException("eTrade did not answer. Try again, or register by hand.");
}
