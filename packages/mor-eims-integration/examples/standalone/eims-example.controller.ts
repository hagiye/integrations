import {
  ArgumentsHost,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import {
  EimsCancellationService,
  EimsCredentialService,
  EimsError,
  EimsFilingService,
  EimsReceiptInput,
  EimsReceiptService,
} from "@edr/mor-eims-integration";
import { CreateInvoiceInput, CreateMemoInput, InvoicesService, RecordPaymentInput } from "./invoices.service";

export const ADMIN_TOKEN = Symbol("ADMIN_TOKEN");

/**
 * Staff-only routes: filing, resolving and cancelling change what the tax authority holds. The
 * example checks a shared token header; put your own authentication and permissions here (EDR
 * splits view, resolve and credentials permissions).
 */
@Injectable()
export class ExampleAdminGuard implements CanActivate {
  constructor(@Inject(ADMIN_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): boolean {
    const given = String(context.switchToHttp().getRequest().headers["x-admin-token"] ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** EimsError to HTTP: refused locally 400 (404 not found), busy 409, not configured 503, MoR's answer 502. */
@Catch(EimsError)
export class EimsErrorFilter implements ExceptionFilter {
  catch(error: EimsError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const status =
      error.kind === "INVALID" ? (error.details.code === "NOT_FOUND" ? 404 : 400) : error.kind === "BUSY" ? 409 : error.kind === "CONFIG" ? 503 : 502;
    res.status(status).json({
      statusCode: status,
      kind: error.kind,
      code: error.details.code ?? null,
      rules: error.details.rules ?? [],
      message: error.message,
    });
  }
}

@Controller()
@UseGuards(ExampleAdminGuard)
@UseFilters(EimsErrorFilter)
export class EimsExampleController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly filings: EimsFilingService,
    private readonly receipts: EimsReceiptService,
    private readonly cancellation: EimsCancellationService,
    private readonly credentials: EimsCredentialService,
  ) {}

  @Post("invoices")
  create(@Body() body: CreateInvoiceInput) {
    return this.invoices.create(body);
  }

  @Post("invoices/:id/memos")
  memo(@Param("id") id: string, @Body() body: CreateMemoInput) {
    return this.invoices.createMemo(id, body);
  }

  @Post("invoices/:id/payments")
  pay(@Param("id") id: string, @Body() body: RecordPaymentInput) {
    return this.invoices.recordPayment(id, body);
  }

  @Post("invoices/:id/eims/register")
  register(@Param("id") id: string) {
    return this.filings.register(id);
  }

  @Get("invoices/:id/eims")
  status(@Param("id") id: string) {
    return this.filings.status(id);
  }

  @Post("invoices/:id/eims/verify")
  verify(@Param("id") id: string) {
    return this.filings.verify(id);
  }

  @Post("invoices/:id/eims/resolve")
  resolve(@Param("id") id: string, @Body() body: { irn?: string; discard?: boolean }) {
    return this.filings.resolve(id, body);
  }

  @Post("invoices/:id/eims/cancel")
  cancel(@Param("id") id: string, @Body() body: { reasonCode: string; remark?: string }) {
    return this.cancellation.cancel(id, body.reasonCode, body.remark);
  }

  @Post("invoices/:id/eims/receipts")
  receipt(@Param("id") id: string, @Body() body: EimsReceiptInput) {
    return this.receipts.fileSalesReceipt(id, body);
  }

  @Get("invoices/:id/eims/receipts")
  listReceipts(@Param("id") id: string) {
    return this.receipts.list(id);
  }

  @Post("eims/bulk")
  bulk(@Body() body: { invoiceIds: string[] }) {
    return this.filings.registerBulk(body.invoiceIds ?? []);
  }

  @Post("eims/sweep")
  async sweep() {
    return { filing: await this.filings.autoSubmitNext(), receipt: await this.receipts.autoFileNext() };
  }

  @Get("eims/credentials")
  listCredentials() {
    return this.credentials.list();
  }

  /** The key and certificate files, base64 of their bytes. */
  @Post("eims/credentials")
  upload(@Body() body: { privateKeyBase64: string; certificateBase64: string; label?: string }) {
    return this.credentials.upload({
      privateKey: Buffer.from(body.privateKeyBase64 ?? "", "base64"),
      certificate: Buffer.from(body.certificateBase64 ?? "", "base64"),
      label: body.label,
    });
  }

  @Post("eims/credentials/import")
  importStatic() {
    return this.credentials.importStaticPair();
  }

  @Post("eims/credentials/:id/activate")
  activate(@Param("id") id: string) {
    return this.credentials.activate(id);
  }
}
