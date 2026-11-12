import { DynamicModule, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EtradeModule, EtradeModuleOptions, EtradeService } from "@edr/etrade-integration";
import { CompaniesController } from "./companies.controller";
import { CompaniesService, EtradeRechecker } from "./companies.service";
import { CreateExampleCompanies1790000000300 } from "./create-companies.migration";
import { ExampleAuthGuard } from "./example-auth.guard";
import { EXAMPLE_HOST_CONFIG, ExampleHostConfig, TypeOrmEtradeHost } from "./typeorm-etrade.host";

export interface ExampleAppConfig {
  databaseUrl: string;
  /** Postgres schema for every table (must exist). Omit to use the search_path. */
  schema?: string;
  etrade: EtradeModuleOptions;
  /** Key for hashing TINs in the log and the budget (ETRADE_TIN_HASH_KEY). */
  tinHashKey: string;
  /** Default 10 different TINs per actor per 24 hours. */
  budget?: ExampleHostConfig["budget"];
  /** How often to look for licences due a recheck. Default 0: off. */
  recheckEveryMs?: number;
  /** A licence is due a recheck this many days after its last check. Default 30. */
  recheckAfterDays?: number;
}

/**
 * A complete onboarding back end around e-trade: companies with operational profiles, a guarded
 * TIN lookup (POST /etrade/lookup, under your global prefix), licence attach and recheck
 * endpoints, a lookup log and a TIN budget in Postgres, and a scheduled recheck.
 */
@Module({})
export class ExampleAppModule {
  static forRoot(config: ExampleAppConfig): DynamicModule {
    const hostConfig: ExampleHostConfig = {
      tinHashKey: config.tinHashKey,
      budget: config.budget ?? { limit: 10, windowMs: 24 * 60 * 60 * 1000 },
    };
    return {
      module: ExampleAppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: "postgres",
          url: config.databaseUrl,
          schema: config.schema,
          entities: [],
          migrations: [CreateExampleCompanies1790000000300],
          migrationsRun: true,
          synchronize: false,
        }),
        EtradeModule.forRoot({
          options: config.etrade,
          host: TypeOrmEtradeHost,
          providers: [{ provide: EXAMPLE_HOST_CONFIG, useValue: hostConfig }],
          lookupRoute: "etrade/lookup",
          lookupGuard: ExampleAuthGuard,
        }),
      ],
      controllers: [CompaniesController],
      providers: [
        CompaniesService,
        {
          provide: EtradeRechecker,
          inject: [CompaniesService, EtradeService],
          useFactory: (companies: CompaniesService, etrade: EtradeService) =>
            new EtradeRechecker(companies, etrade, config.recheckEveryMs ?? 0, config.recheckAfterDays ?? 30),
        },
      ],
      exports: [CompaniesService],
    };
  }
}
