import { DynamicModule, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { GPS_HOST, GpsModule, GpsModuleOptions } from "@edr/gps-integration";
import { CreateExampleGps1790000000500 } from "./create-gps.migration";
import { GpsExampleController } from "./gps-example.controller";
import { TypeOrmGpsHost } from "./typeorm-gps.host";

export interface ExampleAppConfig {
  databaseUrl: string;
  /** Postgres schema for every table (must exist). Omit to use the search_path. */
  schema?: string;
  gps: GpsModuleOptions;
}

/**
 * A complete tracker back end: the GT06 listener (GpsModule), devices, positions, alarms and
 * alerts in Postgres, and a small admin API (POST /gps/devices, GET /gps/positions/latest,
 * GET /gps/positions/:vehicleId/history).
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
          migrations: [CreateExampleGps1790000000500],
          migrationsRun: true,
          synchronize: false,
          extra: { max: 10 },
        }),
        GpsModule.forRoot({ options: config.gps, host: TypeOrmGpsHost }),
      ],
      controllers: [GpsExampleController],
      providers: [{ provide: TypeOrmGpsHost, useFactory: (host: TypeOrmGpsHost) => host, inject: [GPS_HOST] }],
    };
  }
}
