import { DynamicModule, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EIMS_HOST, EimsModule, EimsModuleOptions } from "@edr/mor-eims-integration";
import { CreateExampleEims1790000000500 } from "./create-eims.migration";
import { ADMIN_TOKEN, EimsExampleController, ExampleAdminGuard } from "./eims-example.controller";
import { EimsScheduler, SWEEP_EVERY_MS } from "./eims.scheduler";
import { InvoicesService } from "./invoices.service";
import { TypeOrmEimsHost } from "./typeorm-eims.host";

export interface ExampleAppConfig {
  databaseUrl: string;
  /** Postgres schema for every table (must exist). Omit to use the search_path. */
  schema?: string;
  eims: EimsModuleOptions;
  /** Shared token for the staff routes (x-admin-token). Use your own auth instead. */
  adminToken: string;
  /** How often the sweeps run. 0 (the default): never; call POST /eims/sweep. */
  sweepEveryMs?: number;
}

/**
 * A complete filing back end around the package: invoices, memos and payments in Postgres, the
 * filing, receipt, cancellation and credential routes, MoR's bulk callback, and the sweeps.
 */
@Module({})
export class ExampleAppModule {
  static forRoot(config: ExampleAppConfig): DynamicModule {
    return {
      module: ExampleAppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: "postgres",
          url: config.databaseUrl,
          schema: config.schema,
          entities: [],
          migrations: [CreateExampleEims1790000000500],
          migrationsRun: true,
          synchronize: false,
          extra: { max: 10 },
        }),
        EimsModule.forRoot({ options: config.eims, host: TypeOrmEimsHost }),
      ],
      controllers: [EimsExampleController],
      providers: [
        { provide: TypeOrmEimsHost, useFactory: (host: TypeOrmEimsHost) => host, inject: [EIMS_HOST] },
        InvoicesService,
        EimsScheduler,
        ExampleAdminGuard,
        { provide: ADMIN_TOKEN, useValue: config.adminToken },
        { provide: SWEEP_EVERY_MS, useValue: config.sweepEveryMs ?? 0 },
      ],
    };
  }
}
