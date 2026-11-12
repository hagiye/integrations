import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

/**
 * The admin side the example needs: register a tracker, read the live map and a trail. Put your
 * own authentication in front of all of it; the GT06 listener itself has none to offer.
 */
@Controller("gps")
export class GpsExampleController {
  private readonly schema: string | undefined;

  constructor(@InjectDataSource() private readonly db: DataSource) {
    this.schema = (db.options as { schema?: string }).schema;
  }

  private t(name: string): string {
    return this.schema ? `"${this.schema}"."${name}"` : `"${name}"`;
  }

  /** Register (or restore) a tracker. Only registered IMEIs may log in. */
  @Post("devices")
  async register(@Body() body: { imei?: unknown; name?: unknown; vehicleId?: unknown }) {
    const imei = typeof body.imei === "string" ? body.imei.trim() : "";
    if (!/^\d{15,16}$/.test(imei)) throw new BadRequestException("imei must be the 15-digit IMEI printed on the tracker");
    const name = typeof body.name === "string" ? body.name.slice(0, 100) : null;
    const vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : null;
    const [row] = await this.db.query(
      `INSERT INTO ${this.t("gps_devices")} (imei, name, vehicle_id) VALUES ($1, $2, $3)
       ON CONFLICT (imei) DO UPDATE SET deleted_at = NULL, name = EXCLUDED.name, vehicle_id = EXCLUDED.vehicle_id
       RETURNING id, imei, name, vehicle_id AS "vehicleId"`,
      [imei, name, vehicleId],
    );
    return row;
  }

  /** The live map: devices with a fix, ONLINE if seen within 5 minutes (EDR's window). */
  @Get("positions/latest")
  async latest() {
    const rows = await this.db.query(
      `SELECT id, imei, vehicle_id AS "vehicleId", last_lat AS "lat", last_lng AS "lng", last_speed AS "speed",
              last_fix_at AS "fixTime", last_seen_at AS "lastSeenAt",
              (last_seen_at > now() - interval '5 minutes') AS "online"
         FROM ${this.t("gps_devices")} WHERE deleted_at IS NULL AND last_lat IS NOT NULL`,
    );
    return rows.map((r: Record<string, unknown>) => ({ ...r, online: Boolean(r.online) }));
  }

  /** A vehicle's trail: trusted, positioned fixes only, newest first (EDR: default 200, max 1000). */
  @Get("positions/:vehicleId/history")
  async history(@Param("vehicleId", ParseUUIDPipe) vehicleId: string, @Query("limit") limitText?: string) {
    const limit = Math.min(Math.max(Number(limitText ?? 200) || 200, 1), 1000);
    return this.db.query(
      `SELECT fix_time AS "fixTime", lat, lng, speed, course FROM ${this.t("gps_positions")}
        WHERE vehicle_id = $1 AND positioned AND NOT suspect ORDER BY fix_time DESC LIMIT $2`,
      [vehicleId, limit],
    );
  }
}
