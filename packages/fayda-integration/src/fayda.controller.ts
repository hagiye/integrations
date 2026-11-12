import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, Type } from "@nestjs/common";
import { FaydaService } from "./fayda.service";
import type { FaydaCompleteResult } from "./fayda.types";

/** The parts of an Express request and response used here (no @types/express needed). */
interface CookieRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface ExpressResponse {
  setHeader(name: string, value: string | string[]): unknown;
  status(code: number): ExpressResponse;
  json(body: unknown): unknown;
  redirect(status: number, url: string): unknown;
}

/** One cookie's value from the Cookie header, or undefined. */
export function readCookie(request: CookieRequest, name: string): string | undefined {
  const raw = request.headers.cookie;
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The JSON a caller gets: no identity fields unless your host put them in its result. */
export function faydaResultBody(result: FaydaCompleteResult): Record<string, unknown> {
  if (result.outcome === "VERIFIED") {
    return {
      outcome: "VERIFIED",
      sessionId: result.sessionId,
      purpose: result.purpose,
      result: result.result,
      ...(result.proof ? { proof: result.proof } : {}),
    };
  }
  return { outcome: "FAILED", code: result.code, message: result.message };
}

function noStore(res: ExpressResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  // The callback URL carries the code: keep it out of the Referer of whatever loads next.
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Two routes under `route` (relative to your global prefix), for Express:
 *
 * - `GET {route}/callback?code&state` (or `?error&state`): register this as the redirect_uri of
 *   a channel when eSignet should come back to the API. It completes the verification and sends
 *   the browser on to options.returnUrls[channel] (?result=<session id> or ?error=<code>), or
 *   answers JSON when the channel has no return URLs.
 * - `POST {route}/complete` with `{ code, state }` (or `{ error, state }`): for a front-end
 *   callback page that received eSignet's redirect itself. Answers JSON.
 *
 * Both read the session's binding cookie (set by your start endpoint). The cookie is left in
 * place, to expire with the session (Max-Age): your result page uses it to show the result only
 * to the browser that started, then clears it (FaydaService.clearBindingCookie). Neither route
 * puts claims or tokens in a URL.
 */
export function createFaydaController(route: string): Type<unknown> {
  @Controller(route)
  class FaydaCallbackController {
    constructor(private readonly fayda: FaydaService) {}

    @Get("callback")
    async callback(@Query() query: Record<string, unknown>, @Req() req: CookieRequest, @Res() res: ExpressResponse): Promise<void> {
      const result = await this.run(query, req, res);
      const target = this.fayda.returnUrlFor(result);
      if (target) {
        res.redirect(303, target);
        return;
      }
      res.status(result.outcome === "VERIFIED" ? 200 : result.httpStatus).json(faydaResultBody(result));
    }

    @Post("complete")
    @HttpCode(200)
    async complete(@Body() body: Record<string, unknown> | undefined, @Req() req: CookieRequest, @Res() res: ExpressResponse): Promise<void> {
      const result = await this.run(body ?? {}, req, res);
      res.status(result.outcome === "VERIFIED" ? 200 : result.httpStatus).json(faydaResultBody(result));
    }

    private async run(fields: Record<string, unknown>, req: CookieRequest, res: ExpressResponse): Promise<FaydaCompleteResult> {
      const state = str(fields.state) ?? "";
      const cookieName = this.fayda.bindingCookieName(state);
      const result = await this.fayda.complete({
        code: fields.code,
        state,
        error: fields.error,
        errorDescription: fields.error_description ?? fields.errorDescription,
        browserBinding: readCookie(req, cookieName),
      });
      noStore(res);
      return result;
    }
  }
  return FaydaCallbackController;
}
