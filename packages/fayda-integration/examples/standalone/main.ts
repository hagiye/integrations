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
      fayda: {
        clientId: required("FAYDA_CLIENT_ID"),
        issuer: required("FAYDA_ISSUER"),
        authorizationEndpoint: required("FAYDA_AUTHORIZATION_ENDPOINT"),
        tokenEndpoint: required("FAYDA_TOKEN_ENDPOINT"),
        userinfoEndpoint: required("FAYDA_USERINFO_ENDPOINT"),
        jwksUri: required("FAYDA_JWKS_URI"),
        // Base64 of the JWK JSON, as EDR stores it (FAYDA_PRIVATE_KEY_BASE64), or a PEM.
        privateKey: required("FAYDA_PRIVATE_KEY_BASE64"),
        keyId: process.env.FAYDA_PRIVATE_KEY_ID || undefined,
        redirectUris: {
          // Each must be registered with NIDP for the client, exactly.
          WEB: required("FAYDA_WEB_REDIRECT_URI"),
          ...(process.env.FAYDA_REDIRECT_URI ? { MOBILE: process.env.FAYDA_REDIRECT_URI } : {}),
        },
        returnUrls: process.env.FAYDA_WEB_RETURN_URL
          ? { WEB: { success: process.env.FAYDA_WEB_RETURN_URL, failure: process.env.FAYDA_WEB_RETURN_URL } }
          : undefined,
        sessionTtlMinutes: Number(process.env.FAYDA_SESSION_TTL_MINUTES ?? 10),
        ...(process.env.FAYDA_PROOF_SECRET ? { proof: { secret: process.env.FAYDA_PROOF_SECRET } } : {}),
      },
    }),
  );
  // Routes: POST /api/fayda/start, GET /api/fayda/callback, POST /api/fayda/complete,
  // GET /api/fayda/results/:id, POST /api/requests.
  app.setGlobalPrefix("api");
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
