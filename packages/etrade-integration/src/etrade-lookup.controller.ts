import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Post,
  Req,
  ServiceUnavailableException,
  Type,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { EtradeError } from "./etrade.errors";
import { asCompanyNameSource } from "./etrade.normalize";
import { EtradeLookupResult, EtradeService } from "./etrade.service";

export const ETRADE_ACTOR_FROM = Symbol("ETRADE_ACTOR_FROM");

/** Who is calling, from the request your guard let through. */
export type EtradeActorFrom = (request: unknown) => string | undefined;

/** request.user.id, else request.user.sub: what Passport-style guards leave on the request. */
export const defaultEtradeActorFrom: EtradeActorFrom = (request) => {
  const user = (request as { user?: { id?: unknown; sub?: unknown } } | undefined)?.user;
  const id = user?.id ?? user?.sub;
  return typeof id === "string" && id.trim() ? id.trim() : typeof id === "number" ? String(id) : undefined;
};

/**
 * EtradeError onto an HTTP answer with no internal detail in it: no addresses, no TLS codes,
 * no e-trade body. The customer is pointed at the manual route whenever e-trade cannot answer.
 */
export function etradeHttpError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof EtradeError) {
    if (err.kind === "INVALID") return new BadRequestException(err.message);
    if (err.kind === "BUDGET") {
      return new HttpException(
        "Too many different TINs were checked from this account. Try again tomorrow, or enter your details by hand.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return new ServiceUnavailableException(
      "The business registry did not answer. Try again, or enter your details by hand.",
    );
  }
  return new InternalServerErrorException();
}

/**
 * `POST /{route}` with `{ tin, licenceNumber?, nameSource? }`: EtradeService.lookup for the
 * signed-in caller. Mounted only when EtradeModule is given lookupRoute AND lookupGuard: a TIN
 * lookup returns a business's licences and its manager's name and phone, for any TIN typed, so
 * it is never open. The caller is charged against the TIN budget.
 */
export function createEtradeLookupController(route: string, guard: Type<CanActivate>): Type<unknown> {
  @Controller(route)
  @UseGuards(guard)
  class EtradeLookupController {
    constructor(
      private readonly etrade: EtradeService,
      @Inject(ETRADE_ACTOR_FROM) private readonly actorFrom: EtradeActorFrom,
    ) {}

    @Post()
    @HttpCode(200)
    async lookup(@Req() request: unknown, @Body() body: unknown): Promise<EtradeLookupResult> {
      const actor = this.actorFrom(request);
      if (!actor) throw new UnauthorizedException("Sign in to look up a TIN");
      const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      try {
        return await this.etrade.lookup({
          tin: typeof fields.tin === "string" ? fields.tin : "",
          licenceNumber: typeof fields.licenceNumber === "string" && fields.licenceNumber ? fields.licenceNumber : undefined,
          nameSource: asCompanyNameSource(fields.nameSource),
          actor,
        });
      } catch (err) {
        throw etradeHttpError(err);
      }
    }
  }
  return EtradeLookupController;
}
