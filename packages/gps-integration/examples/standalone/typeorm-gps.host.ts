import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  GpsAlarmEvent,
  GpsAlertInputs,
  GpsAlertToOpen,
  GpsConnectionInfo,
  GpsDevice,
  GpsDisconnectEvent,
  GpsFixSample,
  GpsHost,
  GpsOpenedAlert,
  GpsPositionBatch,
  GpsRejectionEvent,
  GpsStatusEvent,
} from "@edr/gps-integration";

interface DeviceRow {
  id: string;
  imei: string;
  vehicle_id: string | null;
  last_lat: string | null;
  last_lng: string | null;
  last_fix_at: Date | null;
}

const num = (v: string | number | null | undefined): number | null => (v == null ? null : Number(v));

/**
 * The example's GpsHost on Postgres. The rules that matter:
 * - findDevice answers for registered, not deleted trackers only. Nothing is ever auto-created.
 * - savePositions inserts the batch in one statement with ON CONFLICT (device_id, fix_time) DO
 *   NOTHING, then moves the live fix only forward in time, in one transaction.
 * - openAlert relies on the partial unique index: a racing scan's insert does nothing.
 */
@Injectable()
export class TypeOrmGpsHost implements GpsHost {
  private readonly schema: string | undefined;

  constructor(@InjectDataSource() private readonly db: DataSource) {
    this.schema = (db.options as { schema?: string }).schema;
  }

  private t(name: string): string {
    return this.schema ? `"${this.schema}"."${name}"` : `"${name}"`;
  }

  async findDevice(imei: string): Promise<GpsDevice | null> {
    const rows: DeviceRow[] = await this.db.query(
      `SELECT id, imei, vehicle_id, last_lat, last_lng, last_fix_at FROM ${this.t("gps_devices")}
        WHERE imei = $1 AND deleted_at IS NULL`,
      [imei],
    );
    const d = rows[0];
    if (!d) return null;
    return {
      id: d.id,
      imei: d.imei,
      vehicleId: d.vehicle_id,
      lastFix:
        d.last_fix_at && d.last_lat != null && d.last_lng != null
          ? { latitude: Number(d.last_lat), longitude: Number(d.last_lng), fixTime: new Date(d.last_fix_at) }
          : null,
    };
  }

  async savePositions(batch: GpsPositionBatch): Promise<number> {
    return this.db.transaction(async (m) => {
      const values: unknown[] = [];
      const tuples = batch.positions.map((p) => {
        const row = [
          p.deviceId,
          p.imei,
          p.vehicleId,
          p.fixTime,
          p.receivedAt,
          p.latitude,
          p.longitude,
          p.speedKmh,
          p.course,
          p.satellites,
          p.positioned,
          p.suspect,
          p.impliedSpeedKmh,
          p.replay,
          p.source,
          p.alarm,
          p.protocol,
        ];
        const base = values.length;
        values.push(...row);
        return `(${row.map((_, i) => `$${base + i + 1}`).join(", ")})`;
      });
      const inserted: unknown[] = await m.query(
        `INSERT INTO ${this.t("gps_positions")}
           (device_id, imei, vehicle_id, fix_time, received_at, lat, lng, speed, course, satellites,
            positioned, suspect, implied_speed_kmh, replay, source, alarm, protocol)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (device_id, fix_time) DO NOTHING
         RETURNING id`,
        values,
      );
      const latest = batch.latest;
      if (latest) {
        await m.query(
          `UPDATE ${this.t("gps_devices")}
              SET last_lat = $2, last_lng = $3, last_speed = $4, last_course = $5, last_fix_at = $6
            WHERE id = $1 AND (last_fix_at IS NULL OR last_fix_at <= $6)`,
          [batch.device.id, latest.latitude, latest.longitude, latest.speedKmh, latest.course, latest.fixTime],
        );
      }
      return inserted.length;
    });
  }

  async markSeen(device: GpsDevice, seenAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE ${this.t("gps_devices")}
          SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2), $2), status = 'ONLINE'
        WHERE id = $1`,
      [device.id, seenAt],
    );
  }

  async onStatus(e: GpsStatusEvent): Promise<void> {
    await this.db.query(
      `UPDATE ${this.t("gps_devices")} SET voltage_level = $2, gsm_level = $3, acc_on = $4 WHERE id = $1`,
      [e.device.id, e.status.voltageLevel, e.status.gsmLevel, e.status.accOn],
    );
  }

  async onAlarm(e: GpsAlarmEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t("gps_alarms")} (device_id, alarm, alarm_code, fix_time, lat, lng, position_dropped, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        e.device.id,
        e.alarm,
        e.alarmCode,
        e.position?.fixTime ?? null,
        e.position?.latitude ?? null,
        e.position?.longitude ?? null,
        e.positionDropped,
        e.receivedAt,
      ],
    );
  }

  async onConnect(device: GpsDevice, _connection: GpsConnectionInfo): Promise<void> {
    await this.db.query(`UPDATE ${this.t("gps_devices")} SET status = 'ONLINE' WHERE id = $1`, [device.id]);
  }

  async onDisconnect(e: GpsDisconnectEvent): Promise<void> {
    // A replaced connection means the tracker is already back on a new one.
    if (e.reason === "REPLACED") return;
    await this.db.query(`UPDATE ${this.t("gps_devices")} SET status = 'OFFLINE' WHERE id = $1`, [e.device.id]);
  }

  async onRejected(e: GpsRejectionEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.t("gps_rejections")} (reason, imei, remote_address, at) VALUES ($1, $2, $3, $4)`,
      [e.reason, e.imei, e.connection.remoteAddress, e.at],
    );
  }

  // ── alerts ──

  async loadAlertInputs(q: { now: Date; resolvedSince: Date }): Promise<GpsAlertInputs> {
    const [settings] = await this.db.query(
      `SELECT overspeed_kmh, idle_minutes, offline_minutes FROM ${this.t("gps_alert_settings")} ORDER BY created_at LIMIT 1`,
    );
    const thresholds = settings
      ? { overspeedKmh: settings.overspeed_kmh, idleMinutes: settings.idle_minutes, offlineMinutes: settings.offline_minutes }
      : null;
    const geofences = (
      await this.db.query(`SELECT id, name, kind, lat, lng, radius_m FROM ${this.t("gps_geofences")} WHERE is_active`)
    ).map((g: { id: string; name: string; kind: "KEEP_OUT" | "KEEP_IN"; lat: string; lng: string; radius_m: number }) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      lat: Number(g.lat),
      lng: Number(g.lng),
      radiusM: g.radius_m,
    }));
    const devices: Array<{
      device_id: string;
      vehicle_id: string;
      plate: string;
      on_trip: boolean;
      last_seen_at: Date | null;
      last_fix_at: Date | null;
      last_lat: string | null;
      last_lng: string | null;
      last_speed: string | null;
    }> = await this.db.query(
      `SELECT d.id AS device_id, d.vehicle_id, v.plate, v.on_trip, d.last_seen_at, d.last_fix_at, d.last_lat, d.last_lng, d.last_speed
         FROM ${this.t("gps_devices")} d
         JOIN ${this.t("vehicles")} v ON v.id = d.vehicle_id
        WHERE d.deleted_at IS NULL`,
    );
    // EDR's idle window: trusted fixes since the cut, plus the newest one at or before it.
    const idleMinutes = thresholds?.idleMinutes ?? 30;
    const cut = new Date(q.now.getTime() - idleMinutes * 60_000);
    const onTrip = devices.filter((d) => d.on_trip).map((d) => d.device_id);
    const fixes = new Map<string, GpsFixSample[]>();
    if (onTrip.length) {
      const rows: Array<{ device_id: string; fix_time: Date; speed: string }> = await this.db.query(
        `(SELECT device_id, fix_time, speed FROM ${this.t("gps_positions")}
           WHERE device_id = ANY($1::uuid[]) AND positioned AND NOT suspect AND fix_time > $2)
         UNION ALL
         (SELECT DISTINCT ON (device_id) device_id, fix_time, speed FROM ${this.t("gps_positions")}
           WHERE device_id = ANY($1::uuid[]) AND positioned AND NOT suspect
             AND fix_time <= $2 AND fix_time > $2::timestamptz - interval '1 day'
           ORDER BY device_id, fix_time DESC)`,
        [onTrip, cut],
      );
      for (const r of rows) {
        const list = fixes.get(r.device_id) ?? [];
        list.push({ fixTime: new Date(r.fix_time), speedKmh: Number(r.speed) });
        fixes.set(r.device_id, list);
      }
    }
    const open = await this.db.query(
      `SELECT id, vehicle_id, kind, geofence_id, last_seen_at, details FROM ${this.t("gps_alerts")} WHERE resolved_at IS NULL`,
    );
    const resolved = await this.db.query(
      `SELECT vehicle_id, kind, geofence_id, resolved_at FROM ${this.t("gps_alerts")} WHERE resolved_at >= $1`,
      [q.resolvedSince],
    );
    return {
      thresholds,
      geofences,
      vehicles: devices.map((d) => ({
        vehicleId: d.vehicle_id,
        deviceId: d.device_id,
        label: d.plate,
        onTrip: d.on_trip,
        lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at) : null,
        lastFixAt: d.last_fix_at ? new Date(d.last_fix_at) : null,
        lastLat: num(d.last_lat),
        lastLng: num(d.last_lng),
        lastSpeedKmh: num(d.last_speed),
        recentFixes: fixes.get(d.device_id) ?? [],
      })),
      open: open.map((a: { id: string; vehicle_id: string; kind: never; geofence_id: string | null; last_seen_at: Date; details: Record<string, unknown> }) => ({
        id: a.id,
        vehicleId: a.vehicle_id,
        kind: a.kind,
        geofenceId: a.geofence_id,
        lastSeenAt: new Date(a.last_seen_at),
        details: a.details,
      })),
      recentlyResolved: resolved.map((a: { vehicle_id: string; kind: never; geofence_id: string | null; resolved_at: Date }) => ({
        vehicleId: a.vehicle_id,
        kind: a.kind,
        geofenceId: a.geofence_id,
        resolvedAt: new Date(a.resolved_at),
      })),
    };
  }

  async openAlert(a: GpsAlertToOpen): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.db.query(
      `INSERT INTO ${this.t("gps_alerts")} (vehicle_id, device_id, kind, geofence_id, started_at, last_seen_at, details)
       VALUES ($1, $2, $3, $4, $5, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [a.condition.vehicleId, a.condition.deviceId ?? null, a.condition.kind, a.condition.geofenceId ?? null, a.startedAt, a.condition.details],
    );
    return rows[0]?.id ?? null;
  }

  async touchAlert(u: { id: string; lastSeenAt: Date; details: Record<string, unknown> }): Promise<void> {
    await this.db.query(`UPDATE ${this.t("gps_alerts")} SET last_seen_at = $2, details = $3 WHERE id = $1`, [u.id, u.lastSeenAt, u.details]);
  }

  async resolveAlert(u: { id: string; resolvedAt: Date }): Promise<void> {
    await this.db.query(`UPDATE ${this.t("gps_alerts")} SET resolved_at = $2 WHERE id = $1 AND resolved_at IS NULL`, [u.id, u.resolvedAt]);
  }

  async notifyAlert(a: GpsOpenedAlert): Promise<void> {
    await this.db.query(`INSERT INTO ${this.t("gps_notifications")} (alert_id, title, body) VALUES ($1, $2, $3)`, [a.id, a.title, a.body]);
  }
}
