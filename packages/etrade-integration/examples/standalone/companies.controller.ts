import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { EtradeAttachResult, EtradeRecheckResult, EtradeService, etradeHttpError } from "@edr/etrade-integration";
import { CompaniesService, CreatedCompany, StoredProfile } from "./companies.service";
import { ExampleAuthGuard } from "./example-auth.guard";

@Controller()
export class CompaniesController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly etrade: EtradeService,
  ) {}

  /** Example only, unguarded so tests can seed. Your onboarding creates the company. */
  @Post("companies")
  create(@Body() body: { tin: string; name?: string; manualRegistration?: boolean; profiles?: string[] }): Promise<CreatedCompany> {
    return this.companies.create(body);
  }

  @Get("profiles/:id")
  profile(@Param("id") id: string): Promise<StoredProfile> {
    return this.companies.profile(id);
  }

  /**
   * Attach one of the company's licences to a profile. Only the licence number is read from the
   * body; the stored snapshot is e-trade's. Your app first checks the profile belongs to the
   * caller's company (EDR: getCompanyInfoByUserId); this example has no users to check against.
   */
  @Patch("profiles/:id/etrade-licence")
  @UseGuards(ExampleAuthGuard)
  async attach(
    @Param("id") id: string,
    @Body() body: { licenceNumber?: unknown },
    @Req() request: { user: { id: string } },
  ): Promise<EtradeAttachResult> {
    let result: EtradeAttachResult;
    try {
      result = await this.etrade.attach({
        holderId: id,
        licenceNumber: typeof body?.licenceNumber === "string" ? body.licenceNumber : "",
        actor: request.user.id,
      });
    } catch (err) {
      throw etradeHttpError(err);
    }
    if (result.outcome === "REFUSED") throw new UnprocessableEntityException(result);
    return result;
  }

  /** Staff or a job: refresh the stored snapshot from e-trade. */
  @Post("profiles/:id/etrade-recheck")
  @HttpCode(200)
  @UseGuards(ExampleAuthGuard)
  async recheck(@Param("id") id: string, @Req() request: { user: { id: string } }): Promise<EtradeRecheckResult> {
    try {
      return await this.etrade.recheck(id, request.user.id);
    } catch (err) {
      throw etradeHttpError(err);
    }
  }
}
