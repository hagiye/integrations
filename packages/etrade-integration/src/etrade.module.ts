import {
  CanActivate,
  DynamicModule,
  InjectionToken,
  Module,
  ModuleMetadata,
  OptionalFactoryDependency,
  Provider,
  Type,
} from "@nestjs/common";
import { EtradeClient } from "./etrade.client";
import { ETRADE_HOST, EtradeHost } from "./etrade.host";
import {
  ETRADE_ACTOR_FROM,
  EtradeActorFrom,
  createEtradeLookupController,
  defaultEtradeActorFrom,
} from "./etrade-lookup.controller";
import { ETRADE_OPTIONS, EtradeModuleOptions, resolveEtradeOptions } from "./etrade.options";
import { EtradeService } from "./etrade.service";

interface EtradeModuleParts {
  /**
   * Your EtradeHost class, instantiated inside this module (whatever it injects must come from
   * `imports` or `providers`). Needed for attach and recheck, and for a shared lookup budget,
   * the lookup log and the cache. Without it, EtradeService.lookup still works.
   */
  host?: Type<EtradeHost>;
  /**
   * Default false: no route. A path (relative to your global prefix) mounts
   * `POST /{lookupRoute}` for the signed-in caller; it needs lookupGuard.
   */
  lookupRoute?: string | false;
  /** Your auth guard. Required with lookupRoute: a TIN lookup must never be open to anyone. */
  lookupGuard?: Type<CanActivate>;
  /** Who the caller is, from the request. Default request.user.id, else request.user.sub. */
  actorFrom?: EtradeActorFrom;
  /** Modules that export what your host or guard injects. */
  imports?: ModuleMetadata["imports"];
  /** Extra providers your host or guard needs. */
  providers?: Provider[];
}

export interface EtradeModuleConfig extends EtradeModuleParts {
  options: EtradeModuleOptions;
}

export interface EtradeModuleAsyncConfig extends EtradeModuleParts {
  /** Usually ConfigService: inject it and build the options from env. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...args: never[]) => EtradeModuleOptions | Promise<EtradeModuleOptions>;
}

/**
 * e-trade lookups. EtradeClient and EtradeService always; with a host, attach and recheck;
 * with lookupRoute and lookupGuard, a guarded lookup endpoint. No database of its own.
 */
@Module({})
export class EtradeModule {
  static forRoot(config: EtradeModuleConfig): DynamicModule {
    return EtradeModule.build(config, { provide: ETRADE_OPTIONS, useValue: resolveEtradeOptions(config.options) });
  }

  static forRootAsync(config: EtradeModuleAsyncConfig): DynamicModule {
    const factory = config.useFactory as (...args: unknown[]) => EtradeModuleOptions | Promise<EtradeModuleOptions>;
    return EtradeModule.build(config, {
      provide: ETRADE_OPTIONS,
      inject: config.inject ?? [],
      useFactory: async (...args: unknown[]) => resolveEtradeOptions(await factory(...args)),
    });
  }

  private static build(parts: EtradeModuleParts, optionsProvider: Provider): DynamicModule {
    const route = parts.lookupRoute ?? false;
    if (typeof route === "string" && !parts.lookupGuard) {
      throw new Error("EtradeModule: lookupRoute needs lookupGuard (your auth guard); a TIN lookup must not be open");
    }
    if (typeof route === "string" && !route.trim()) {
      throw new Error("EtradeModule: lookupRoute must be a path, or false");
    }
    const withHost: Provider[] = parts.host ? [parts.host, { provide: ETRADE_HOST, useExisting: parts.host }] : [];
    return {
      module: EtradeModule,
      imports: [...(parts.imports ?? [])],
      controllers: typeof route === "string" && parts.lookupGuard ? [createEtradeLookupController(route, parts.lookupGuard)] : [],
      providers: [
        optionsProvider,
        EtradeClient,
        EtradeService,
        { provide: ETRADE_ACTOR_FROM, useValue: parts.actorFrom ?? defaultEtradeActorFrom },
        ...withHost,
        ...(parts.providers ?? []),
      ],
      exports: [EtradeClient, EtradeService, ETRADE_OPTIONS, ...(parts.host ? [ETRADE_HOST] : [])],
    };
  }
}
