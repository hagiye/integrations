import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ExampleAppModule } from "./app.module";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const list = (text: string | undefined): string[] => (text ? text.split(",").map((s) => s.trim()).filter(Boolean) : []);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(
    ExampleAppModule.forRoot({
      databaseUrl: required("DATABASE_URL"),
      schema: process.env.DATABASE_SCHEMA || undefined,
      gps: {
        // EDR's names: GT06_TCP_PORT and GT06_TCP_HOST.
        port: Number(process.env.GT06_TCP_PORT ?? 5023),
        bindAddress: process.env.GT06_TCP_HOST ?? "0.0.0.0",
        // The carrier APN pool or VPN range the SIMs come from. Empty: anyone who reaches the port.
        allowedSources: list(process.env.GT06_ALLOWED_SOURCES),
        maxConnectionsPerIp: Number(process.env.GT06_MAX_CONNECTIONS_PER_IP ?? 0),
      },
    }),
  );
  // HTTP: POST /api/gps/devices, GET /api/gps/positions/latest, GET /api/gps/positions/:vehicleId/history.
  // TCP: the GT06 listener on GT06_TCP_PORT, opened at bootstrap.
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
