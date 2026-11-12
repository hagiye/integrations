import { MigrationInterface, QueryRunner } from "typeorm";

export const qualified = (queryRunner: QueryRunner, name: string): string => {
  const schema = (queryRunner.connection.options as { schema?: string }).schema;
  return schema ? `"${schema}"."${name}"` : `"${name}"`;
};

/**
 * The example's own tables. The package has none: in your system they live wherever your fleet
 * data does (EDR: freight.gps_devices, freight.gps_positions, freight.gps_alerts...).
 *
 * - vehicles: what a tracker is fitted to. on_trip stands in for EDR's availability = BUSY.
 * - gps_devices: registered trackers only (imei unique), with the live fix. deleted_at stops a
 *   tracker: its logins are refused.
 * - gps_positions: history. UNIQUE (device_id, fix_time) is what makes a resent fix a no-op
 *   (EDR had no such key). suspect fixes are kept for review and never become the live fix.
 * - gps_alarms: SOS, power cut, shock, fence alarms from the trackers.
 * - gps_rejections: connections refused by the rules (unknown IMEI, source, rate...).
 * - gps_alert_settings, gps_geofences, gps_alerts: as EDR's migration 5230000000000-GpsAlerts,
 *   with the same partial unique index on open alerts.
 * - gps_notifications: an outbox for opened alerts (EDR sent them to its notification inbox).
 */
export class CreateExampleGps1790000000500 implements MigrationInterface {
  name = "CreateExampleGps1790000000500";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = (name: string) => qualified(queryRunner, name);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("vehicles")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "plate" varchar(32) NOT NULL,
        "on_trip" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_devices")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "imei" varchar(20) NOT NULL UNIQUE,
        "name" varchar(100),
        "vehicle_id" uuid REFERENCES ${t("vehicles")} ("id"),
        "status" varchar(16) NOT NULL DEFAULT 'REGISTERED',
        "last_seen_at" timestamptz,
        "last_lat" numeric(10,6),
        "last_lng" numeric(10,6),
        "last_speed" numeric(6,2),
        "last_course" int,
        "last_fix_at" timestamptz,
        "voltage_level" int,
        "gsm_level" int,
        "acc_on" boolean,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "gps_devices_vehicle_idx" ON ${t("gps_devices")} ("vehicle_id")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_positions")} (
        "id" bigserial PRIMARY KEY,
        "device_id" uuid NOT NULL REFERENCES ${t("gps_devices")} ("id"),
        "imei" varchar(20) NOT NULL,
        "vehicle_id" uuid,
        "fix_time" timestamptz NOT NULL,
        "received_at" timestamptz NOT NULL,
        "lat" numeric(10,6) NOT NULL,
        "lng" numeric(10,6) NOT NULL,
        "speed" numeric(6,2) NOT NULL DEFAULT 0,
        "course" int NOT NULL DEFAULT 0,
        "satellites" int NOT NULL DEFAULT 0,
        "positioned" boolean NOT NULL,
        "suspect" boolean NOT NULL DEFAULT false,
        "implied_speed_kmh" int,
        "replay" boolean NOT NULL DEFAULT false,
        "source" varchar(8) NOT NULL,
        "alarm" varchar(16),
        "protocol" int NOT NULL,
        CONSTRAINT "gps_positions_device_fix_uq" UNIQUE ("device_id", "fix_time")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "gps_positions_vehicle_time_idx" ON ${t("gps_positions")} ("vehicle_id", "fix_time") WHERE "positioned" AND NOT "suspect"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_alarms")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id" uuid NOT NULL REFERENCES ${t("gps_devices")} ("id"),
        "alarm" varchar(16) NOT NULL,
        "alarm_code" int,
        "fix_time" timestamptz,
        "lat" numeric(10,6),
        "lng" numeric(10,6),
        "position_dropped" varchar(32),
        "received_at" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_rejections")} (
        "id" bigserial PRIMARY KEY,
        "reason" varchar(32) NOT NULL,
        "imei" varchar(20),
        "remote_address" varchar(64) NOT NULL,
        "at" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_alert_settings")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "overspeed_kmh" int NOT NULL DEFAULT 80,
        "idle_minutes" int NOT NULL DEFAULT 30,
        "offline_minutes" int NOT NULL DEFAULT 15,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO ${t("gps_alert_settings")} ("overspeed_kmh")
      SELECT 80 WHERE NOT EXISTS (SELECT 1 FROM ${t("gps_alert_settings")})
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_geofences")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "kind" varchar(16) NOT NULL CHECK ("kind" IN ('KEEP_OUT', 'KEEP_IN')),
        "lat" numeric(10,6) NOT NULL,
        "lng" numeric(10,6) NOT NULL,
        "radius_m" int NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_alerts")} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vehicle_id" uuid NOT NULL,
        "device_id" uuid,
        "kind" varchar(16) NOT NULL,
        "geofence_id" uuid,
        "started_at" timestamptz NOT NULL,
        "last_seen_at" timestamptz NOT NULL,
        "resolved_at" timestamptz,
        "details" jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    // One OPEN alert per vehicle, kind and geofence: a racing scan's insert becomes a no-op (EDR).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "gps_alerts_open_uq" ON ${t("gps_alerts")}
        ("vehicle_id", "kind", COALESCE("geofence_id", '00000000-0000-0000-0000-000000000000'::uuid))
        WHERE "resolved_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${t("gps_notifications")} (
        "id" bigserial PRIMARY KEY,
        "alert_id" uuid NOT NULL,
        "title" varchar(200) NOT NULL,
        "body" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(): Promise<void> {
    // The example never drops its tables.
  }
}
