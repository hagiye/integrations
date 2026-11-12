import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ExampleAppModule } from "./app.module";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(
    ExampleAppModule.forRoot({
      databaseUrl: required("DATABASE_URL"),
      schema: process.env.DATABASE_SCHEMA || undefined,
      adminToken: required("ADMIN_TOKEN"),
      sweepEveryMs: Number(process.env.EIMS_SWEEP_EVERY_MS ?? 0),
      eims: {
        baseUrl: process.env.EIMS_BASE_URL || undefined,
        clientId: required("EIMS_CLIENT_ID"),
        clientSecret: required("EIMS_CLIENT_SECRET"),
        apiKey: required("EIMS_API_KEY"),
        tin: required("EIMS_TIN"),
        // Either a fixed pair (PEM text of the key, the certificate file as issued)...
        privateKey: process.env.EIMS_PRIVATE_KEY || undefined,
        certificate: process.env.EIMS_CERTIFICATE || undefined,
        // ...or stored pairs: upload and activate them through POST /eims/credentials.
        encryptionKey: process.env.EIMS_ENCRYPTION_KEY || undefined,
        expectedSystemNumber: process.env.EIMS_SYSTEM_NUMBER || undefined,
        seller: {
          legalName: required("EIMS_SELLER_LEGAL_NAME"),
          vatNumber: required("EIMS_SELLER_VAT_NUMBER"),
          phone: required("EIMS_SELLER_PHONE"),
          email: required("EIMS_SELLER_EMAIL"),
          region: required("EIMS_SELLER_REGION"),
          wereda: required("EIMS_SELLER_WEREDA"),
          city: process.env.EIMS_SELLER_CITY,
          subCity: process.env.EIMS_SELLER_SUBCITY,
          houseNumber: process.env.EIMS_SELLER_HOUSE_NUMBER,
          locality: process.env.EIMS_SELLER_LOCALITY,
        },
        // Finance signs these off.
        tax: { code: required("EIMS_TAX_CODE"), ratePercent: Number(required("EIMS_TAX_RATE_PERCENT")) },
        cashierName: process.env.EIMS_CASHIER_NAME,
        bulkWebhookToken: process.env.EIMS_BULK_WEBHOOK_TOKEN || undefined,
      },
    }),
  );
  // Routes under /api: invoices, memos, payments, /invoices/:id/eims/*, /eims/credentials,
  // /eims/bulk, /eims/sweep, and MoR's POST /api/eims/webhook/bulk-register[/<token>].
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
