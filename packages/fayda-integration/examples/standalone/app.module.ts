import { DynamicModule, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FAYDA_HOST, FaydaModule, FaydaModuleOptions } from "@edr/fayda-integration";
import { CreateExampleFayda1790000000400 } from "./create-fayda.migration";
import { FaydaExampleController } from "./fayda-example.controller";
import { TypeOrmFaydaHost } from "./typeorm-fayda.host";

export interface ExampleAppConfig {
  databaseUrl: string;
  /** Postgres schema for every table (must exist). Omit to use the search_path. */
  schema?: string;
  fayda: FaydaModuleOptions;
}

/**
 * A complete verification back end around Fayda: sessions, accounts and identities in Postgres,
 * the package's callback routes (GET /fayda/callback, POST /fayda/complete), a start endpoint,
 * a result page for the starting browser, and a step that takes a proof.
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
          migrations: [CreateExampleFayda1790000000400],
          migrationsRun: true,
          synchronize: false,
          // Two connections at least: a completion's transaction and its audit write overlap.
          extra: { max: 10 },
        }),
        FaydaModule.forRoot({ options: config.fayda, host: TypeOrmFaydaHost }),
      ],
      controllers: [FaydaExampleController],
      providers: [{ provide: TypeOrmFaydaHost, useFactory: (host: TypeOrmFaydaHost) => host, inject: [FAYDA_HOST] }],
    };
  }
}
