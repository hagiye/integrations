import { Body, Controller, HttpCode, Param, Post, Req, Type } from "@nestjs/common";
import { EimsFilingService } from "./eims.filing.service";

interface IncomingRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const sourceIp = (req: IncomingRequest): string | null => {
  const forwarded = req.headers?.["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return (first || req.ip || null)?.slice(0, 64) ?? null;
};

/**
 * MoR's bulk-register callback: POST <route> and POST <route>/<token>, relative to your global
 * prefix. Public by necessity (MoR sends no credential), so the service trusts nothing in it on
 * its own: acceptances are checked with /v1/verify, rejections need the token in the URL. Always
 * answers 200 with what was applied.
 */
export function createEimsWebhookController(route: string): Type<unknown> {
  @Controller(route)
  class EimsBulkWebhookController {
    constructor(readonly filings: EimsFilingService) {}

    @Post()
    @HttpCode(200)
    receive(@Body() body: unknown, @Req() req: IncomingRequest) {
      return this.filings.receiveBulkCallback(body, undefined, { sourceIp: sourceIp(req) });
    }

    @Post(":token")
    @HttpCode(200)
    receiveWithToken(@Param("token") token: string, @Body() body: unknown, @Req() req: IncomingRequest) {
      return this.filings.receiveBulkCallback(body, token, { sourceIp: sourceIp(req) });
    }
  }
  return EimsBulkWebhookController;
}
