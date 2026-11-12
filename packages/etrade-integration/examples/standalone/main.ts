import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ETRADE_PUBLIC_API_URL } from "@edr/etrade-integration";
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
      tinHashKey: required("ETRADE_TIN_HASH_KEY"),
      recheckEveryMs: process.env.ETRADE_RECHECK_EVERY_MS ? Number(process.env.ETRADE_RECHECK_EVERY_MS) : 6 * 60 * 60 * 1000,
      etrade: {
        // The public checker's back end, as EDR calls it. Read section 1 of the guide first:
        // there is no known agreement behind it. Replace with the Ministry's address once issued.
        baseUrl: process.env.ETRADE_BASE_URL || ETRADE_PUBLIC_API_URL,
        ...(process.env.ETRADE_API_KEY ? { headers: { "X-Api-Key": process.env.ETRADE_API_KEY } } : {}),
        // TLS is verified. The bundled GlobalSign CA completes e-trade's chain; ETRADE_CA_PEM
        // adds another CA if e-trade's certificate changes issuer.
        ...(process.env.ETRADE_CA_PEM ? { ca: process.env.ETRADE_CA_PEM } : {}),
      },
    }),
  );
  // The lookup is POST /api/etrade/lookup, for signed-in callers only.
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
