import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { FaydaError, FaydaService, readCookie } from "@edr/fayda-integration";
import { ExampleResultView, TypeOrmFaydaHost } from "./typeorm-fayda.host";

interface ExpressLike {
  setHeader(name: string, value: string | string[]): unknown;
}

/**
 * The app's own side of the flow. The package mounts GET /fayda/callback and POST
 * /fayda/complete; this adds:
 *
 * - POST /fayda/start: who is signed in is your auth's business. Here a stand-in header,
 *   x-account-id, plays your guard. Sets the binding cookie on the answer.
 * - GET /fayda/results/:sessionId: the verified view, only for the browser holding the session's
 *   binding cookie. Clears the cookie.
 * - POST /requests: a step that needs a fresh verification (UC-3). It takes the sub with its
 *   proof, and records which proof it used so it cannot be used twice.
 */
@Controller()
export class FaydaExampleController {
  constructor(
    private readonly fayda: FaydaService<ExampleResultView>,
    private readonly host: TypeOrmFaydaHost,
    @InjectDataSource() private readonly db: DataSource,
  ) {}

  @Post("fayda/start")
  @HttpCode(200)
  async start(
    @Body() body: { channel?: string; purpose?: string } | undefined,
    @Headers("x-account-id") accountId: string | undefined,
    @Res({ passthrough: true }) res: ExpressLike,
  ): Promise<{ authorizationUrl: string; sessionId: string }> {
    try {
      const started = await this.fayda.start({ channel: body?.channel, purpose: body?.purpose, accountId: accountId || null });
      if (started.browserBinding) res.setHeader("Set-Cookie", started.browserBinding.setCookie);
      res.setHeader("Cache-Control", "no-store");
      return { authorizationUrl: started.authorizationUrl, sessionId: started.sessionId };
    } catch (err) {
      if (err instanceof FaydaError && err.kind === "INVALID") throw new ForbiddenException(err.message);
      throw err;
    }
  }

  @Get("fayda/results/:sessionId")
  async result(
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Req() req: { headers: Record<string, string | string[] | undefined> },
    @Res({ passthrough: true }) res: ExpressLike,
  ): Promise<ExampleResultView> {
    const view = await this.host.readResult(sessionId, (state) => readCookie(req, this.fayda.bindingCookieName(state)));
    if (!view) throw new NotFoundException("No result for this browser");
    const state = await this.host.stateOf(sessionId);
    if (state) res.setHeader("Set-Cookie", this.fayda.clearBindingCookie(state));
    res.setHeader("Cache-Control", "no-store");
    return view;
  }

  @Post("requests")
  async publicRequest(@Body() body: { sub?: string; proof?: string; text?: string } | undefined): Promise<{ id: string }> {
    const sub = typeof body?.sub === "string" ? body.sub : "";
    const proof = this.fayda.verifyProof(body?.proof, sub);
    if (!proof) throw new ForbiddenException("Verify with Fayda first");
    const text = typeof body?.text === "string" ? body.text.slice(0, 2000) : "";
    try {
      const [row] = await this.db.query(
        `INSERT INTO ${this.table("public_requests")} ("fayda_sub", "proof_session_id", "text") VALUES ($1, $2, $3) RETURNING "id"`,
        [sub, proof.sid, text],
      );
      return { id: row.id };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ForbiddenException("This proof was already used; verify again");
      throw err;
    }
  }

  private table(name: string): string {
    const schema = (this.db.options as { schema?: string }).schema;
    return schema ? `"${schema}"."${name}"` : `"${name}"`;
  }
}
