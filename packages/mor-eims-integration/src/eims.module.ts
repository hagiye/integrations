import {
  DynamicModule,
  InjectionToken,
  Module,
  ModuleMetadata,
  OptionalFactoryDependency,
  Provider,
  Type,
} from "@nestjs/common";
import { EimsCancellationService } from "./eims.cancellation.service";
import { EimsClient } from "./eims.client";
import { createEimsWebhookController } from "./eims.controller";
import { EimsCredentialService } from "./eims.credentials";
import { EimsFilingService } from "./eims.filing.service";
import { EIMS_HOST, EimsHost } from "./eims.host";
import { EIMS_OPTIONS, EimsModuleOptions, ResolvedEimsOptions, resolveEimsOptions } from "./eims.options";
import { EimsReceiptService } from "./eims.receipt.service";

interface EimsModuleParts {
  /**
   * Your EimsHost class, instantiated inside this module (what it injects must come from
   * `imports` or `providers`). Needed for filing, receipts, cancellation and stored credentials.
   * Without it, only EimsClient is usable (signing with the static options pair).
   */
  host?: Type<EimsHost>;
  /**
   * Default "eims/webhook/bulk-register" when there is a host: mounts MoR's bulk callback (under
   * your global prefix). false: no route; call EimsFilingService.receiveBulkCallback yourself.
   */
  route?: string | false;
  imports?: ModuleMetadata["imports"];
  providers?: Provider[];
}

export interface EimsModuleConfig extends EimsModuleParts {
  options: EimsModuleOptions;
}

export interface EimsModuleAsyncConfig extends EimsModuleParts {
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...args: never[]) => EimsModuleOptions | Promise<EimsModuleOptions>;
}

/**
 * MoR EIMS e-invoicing. EimsClient and EimsCredentialService always; with a host, the filing,
 * receipt and cancellation services and the bulk callback route. No database of its own, and no
 * timers: run autoSubmitNext / autoFileNext / checkCertificateExpiry from your own scheduler.
 */
@Module({})
export class EimsModule {
  static forRoot(config: EimsModuleConfig): DynamicModule {
    return EimsModule.build(config, { provide: EIMS_OPTIONS, useValue: resolveEimsOptions(config.options) });
  }

  static forRootAsync(config: EimsModuleAsyncConfig): DynamicModule {
    const factory = config.useFactory as (...args: unknown[]) => EimsModuleOptions | Promise<EimsModuleOptions>;
    return EimsModule.build(config, {
      provide: EIMS_OPTIONS,
      inject: config.inject ?? [],
      useFactory: async (...args: unknown[]) => resolveEimsOptions(await factory(...args)),
    });
  }

  private static build(parts: EimsModuleParts, optionsProvider: Provider): DynamicModule {
    if (typeof parts.route === "string" && !parts.host) {
      throw new Error("EimsModule: route needs a host (the filings live in your database)");
    }
    if (typeof parts.route === "string" && !parts.route.trim()) {
      throw new Error("EimsModule: route must be a path, or false");
    }
    const route = parts.host ? (parts.route === undefined ? "eims/webhook/bulk-register" : parts.route) : false;
    const hostToken = parts.host ? [EIMS_HOST] : [];

    const credentials: Provider = {
      provide: EimsCredentialService,
      inject: [EIMS_OPTIONS, ...hostToken],
      useFactory: (options: ResolvedEimsOptions, host?: EimsHost) => new EimsCredentialService(options, host),
    };
    const client: Provider = {
      provide: EimsClient,
      inject: [EIMS_OPTIONS, EimsCredentialService, ...hostToken],
      useFactory: (options: ResolvedEimsOptions, keys: EimsCredentialService, host?: EimsHost) => {
        const instance = new EimsClient(options, keys, host?.recordExchange ? (record) => host.recordExchange!(record) : undefined);
        keys.attachClient(instance);
        return instance;
      },
    };
    const withHost: Provider[] = parts.host
      ? [
          parts.host,
          { provide: EIMS_HOST, useExisting: parts.host },
          {
            provide: EimsFilingService,
            inject: [EIMS_OPTIONS, EimsClient, EIMS_HOST, EimsCredentialService],
            useFactory: (o: ResolvedEimsOptions, c: EimsClient, h: EimsHost, k: EimsCredentialService) => new EimsFilingService(o, c, h, k),
          },
          {
            provide: EimsReceiptService,
            inject: [EIMS_OPTIONS, EimsClient, EIMS_HOST],
            useFactory: (o: ResolvedEimsOptions, c: EimsClient, h: EimsHost) => new EimsReceiptService(o, c, h),
          },
          {
            provide: EimsCancellationService,
            inject: [EimsClient, EIMS_HOST],
            useFactory: (c: EimsClient, h: EimsHost) => new EimsCancellationService(c, h),
          },
        ]
      : [];
    return {
      module: EimsModule,
      imports: [...(parts.imports ?? [])],
      controllers: typeof route === "string" ? [createEimsWebhookController(route)] : [],
      providers: [optionsProvider, credentials, client, ...withHost, ...(parts.providers ?? [])],
      exports: [
        EIMS_OPTIONS,
        EimsClient,
        EimsCredentialService,
        ...(parts.host ? [EIMS_HOST, EimsFilingService, EimsReceiptService, EimsCancellationService] : []),
      ],
    };
  }
}
