import {
  DynamicModule,
  InjectionToken,
  Module,
  ModuleMetadata,
  OptionalFactoryDependency,
  Provider,
  Type,
} from "@nestjs/common";
import { FaydaClient } from "./fayda.client";
import { createFaydaController } from "./fayda.controller";
import { FAYDA_HOST, FaydaHost } from "./fayda.host";
import { FAYDA_OPTIONS, FaydaModuleOptions, resolveFaydaOptions } from "./fayda.options";
import { FaydaService } from "./fayda.service";

interface FaydaModuleParts {
  /**
   * Your FaydaHost class, instantiated inside this module (whatever it injects must come from
   * `imports` or `providers`). Needed for start and complete. Without it, only FaydaClient is
   * usable.
   */
  host?: Type<FaydaHost>;
  /**
   * Default "fayda" when there is a host: mounts GET fayda/callback and POST fayda/complete
   * (under your global prefix). false: no routes; call FaydaService.complete from your own
   * controller.
   */
  route?: string | false;
  /** Modules that export what your host injects. */
  imports?: ModuleMetadata["imports"];
  /** Extra providers your host needs. */
  providers?: Provider[];
}

export interface FaydaModuleConfig extends FaydaModuleParts {
  options: FaydaModuleOptions;
}

export interface FaydaModuleAsyncConfig extends FaydaModuleParts {
  /** Usually ConfigService: inject it and build the options from env. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...args: never[]) => FaydaModuleOptions | Promise<FaydaModuleOptions>;
}

/**
 * Fayda (eSignet) verification. FaydaClient always; with a host, FaydaService and the callback
 * routes. No database of its own: sessions and identities live in your host's tables.
 */
@Module({})
export class FaydaModule {
  static forRoot(config: FaydaModuleConfig): DynamicModule {
    return FaydaModule.build(config, { provide: FAYDA_OPTIONS, useValue: resolveFaydaOptions(config.options) });
  }

  static forRootAsync(config: FaydaModuleAsyncConfig): DynamicModule {
    const factory = config.useFactory as (...args: unknown[]) => FaydaModuleOptions | Promise<FaydaModuleOptions>;
    return FaydaModule.build(config, {
      provide: FAYDA_OPTIONS,
      inject: config.inject ?? [],
      useFactory: async (...args: unknown[]) => resolveFaydaOptions(await factory(...args)),
    });
  }

  private static build(parts: FaydaModuleParts, optionsProvider: Provider): DynamicModule {
    if (typeof parts.route === "string" && !parts.host) {
      throw new Error("FaydaModule: route needs a host (the sessions live in your database)");
    }
    if (typeof parts.route === "string" && !parts.route.trim()) {
      throw new Error("FaydaModule: route must be a path, or false");
    }
    const route = parts.host ? (parts.route === undefined ? "fayda" : parts.route) : false;
    const withHost: Provider[] = parts.host ? [parts.host, { provide: FAYDA_HOST, useExisting: parts.host }] : [];
    return {
      module: FaydaModule,
      imports: [...(parts.imports ?? [])],
      controllers: typeof route === "string" ? [createFaydaController(route)] : [],
      providers: [optionsProvider, FaydaClient, FaydaService, ...withHost, ...(parts.providers ?? [])],
      exports: [FaydaClient, FaydaService, FAYDA_OPTIONS, ...(parts.host ? [FAYDA_HOST] : [])],
    };
  }
}
