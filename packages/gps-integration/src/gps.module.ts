import {
  DynamicModule,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  ModuleMetadata,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OptionalFactoryDependency,
  Provider,
  Type,
} from "@nestjs/common";
import type { AddressInfo } from "node:net";
import { GpsAlertService } from "./gps.alerts.service";
import { GpsError } from "./gps.errors";
import { GPS_HOST, GpsHost } from "./gps.host";
import { GpsIngestService } from "./gps.ingest";
import { GPS_OPTIONS, GpsModuleOptions, ResolvedGpsOptions, resolveGpsOptions } from "./gps.options";
import { Gt06TcpServer } from "./gps.server";

/** Opens the GT06 listener at application bootstrap (when options.listen) and closes it on shutdown. */
@Injectable()
export class GpsListener implements OnApplicationBootstrap, OnModuleDestroy {
  readonly server: Gt06TcpServer;

  constructor(ingest: GpsIngestService, @Inject(GPS_OPTIONS) private readonly options: ResolvedGpsOptions) {
    this.server = new Gt06TcpServer(ingest, options);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.listen) await this.server.listen();
  }

  async onModuleDestroy(): Promise<void> {
    await this.server.close();
  }

  /** The bound address (the real port when options.port is 0), or null when not listening. */
  address(): AddressInfo | null {
    return this.server.address();
  }
}

interface GpsModuleParts {
  /**
   * Your GpsHost class, instantiated inside this module (whatever it injects must come from
   * imports or providers). Needed for the listener, ingest and alerts. Without it only the pure
   * parts (codec, rules, validation) are usable, and options.listen must be false.
   */
  host?: Type<GpsHost>;
  /** Modules that export what your host injects. */
  imports?: ModuleMetadata["imports"];
  /** Extra providers your host needs. */
  providers?: Provider[];
}

export interface GpsModuleConfig extends GpsModuleParts {
  options?: GpsModuleOptions;
}

export interface GpsModuleAsyncConfig extends GpsModuleParts {
  /** Usually ConfigService: inject it and build the options from env. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...args: never[]) => GpsModuleOptions | Promise<GpsModuleOptions>;
}

/**
 * GT06 GPS trackers. No database of its own: devices, positions and alerts live in your host's
 * tables.
 */
@Module({})
export class GpsModule {
  static forRoot(config: GpsModuleConfig = {}): DynamicModule {
    const resolved = GpsModule.check(resolveGpsOptions(config.options), Boolean(config.host));
    return GpsModule.build(config, { provide: GPS_OPTIONS, useValue: resolved });
  }

  static forRootAsync(config: GpsModuleAsyncConfig): DynamicModule {
    const factory = config.useFactory as (...args: unknown[]) => GpsModuleOptions | Promise<GpsModuleOptions>;
    return GpsModule.build(config, {
      provide: GPS_OPTIONS,
      inject: config.inject ?? [],
      useFactory: async (...args: unknown[]) => GpsModule.check(resolveGpsOptions(await factory(...args)), Boolean(config.host)),
    });
  }

  private static check(options: ResolvedGpsOptions, hasHost: boolean): ResolvedGpsOptions {
    if (options.listen && !hasHost) {
      throw new GpsError("CONFIG", "GpsModule: the GT06 listener needs a host (the devices live in your database); pass host, or listen: false");
    }
    return options;
  }

  private static build(parts: GpsModuleParts, optionsProvider: Provider): DynamicModule {
    const withHost: Provider[] = parts.host
      ? [parts.host, { provide: GPS_HOST, useExisting: parts.host }, GpsIngestService, GpsAlertService, GpsListener]
      : [];
    return {
      module: GpsModule,
      imports: [...(parts.imports ?? [])],
      providers: [optionsProvider, ...withHost, ...(parts.providers ?? [])],
      exports: [GPS_OPTIONS, ...(parts.host ? [GPS_HOST, GpsIngestService, GpsAlertService, GpsListener] : [])],
    };
  }
}
