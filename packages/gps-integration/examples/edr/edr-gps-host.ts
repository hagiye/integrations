/**
 * How EDR would use @edr/gps-integration. NOT compiled in this package: it imports EDR's own
 * code. It shows the two hosts EDR needs on its existing freight.gps_* tables.
 *
 * 1. apps/edr-gps-tracker: the GT06 listener. Replaces GpsModule, GpsIngestService, Gt06Server
 *    and gps.repository.ts. The app keeps its DB-only boot (createApplicationContext).
 * 2. apps/edr-freight-api: the alert scan. Replaces GpsAlertsService.scan / loadSnapshots; the
 *    controllers, settings and geofence CRUD stay.
 *
 * Needs the migration in INTEGRATION-GUIDE section 14, step 2: UNIQUE (device_id, gps_time) on
 * freight.gps_positions, plus suspect, implied_speed_kmh and replay.
 */
import { Injectable, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { InjectDataSource, TypeOrmModule } from "@nestjs/typeorm";
import { NotificationAudience, NotificationType } from "@edr/types";
import { DataSource } from "typeorm";
import {
  GpsAlertInputs,
  GpsAlertToOpen,
  GpsDevice,
  GpsDisconnectEvent,
  GpsHost,
  GpsModule,
  GpsOpenedAlert,
  GpsPositionBatch,
  GpsRejectionEvent,
  GpsStatusEvent,
} from "@edr/gps-integration";

// ── 1. apps/edr-gps-tracker ─────────────────────────────────────────────────

@Injectable()
export class EdrTrackerHost implements GpsHost {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * Registered and not deleted only. EDR's ensureDevice inserted unknown IMEIs here; trackers
   * are now registered through POST /api/gps/devices (tracking.manage), as the freight API
   * already allows.
   */
  async findDevice(imei: string): Promise<GpsDevice | null> {
    const [d] = await this.db.query(
      `SELECT id, imei, vehicle_id, last_lat, last_lng, last_fix_at
         FROM freight.gps_devices WHERE imei = $1 AND deleted_at IS NULL`,
      [imei],
    );
    if (!d) return null;
    return {
      id: d.id,
      imei: d.imei,
      vehicleId: d.vehicle_id,
      lastFix: d.last_fix_at ? { latitude: Number(d.last_lat), longitude: Number(d.last_lng), fixTime: new Date(d.last_fix_at) } : null,
    };
  }

  /** gps_positions keeps its columns (lat, lng, speed, gps_time, alarm int); suspect and replay are new. */
  async savePositions(batch: GpsPositionBatch): Promise<number> {
    return this.db.transaction(async (m) => {
      let inserted = 0;
      for (const p of batch.positions) {
        const rows = await m.query(
          `INSERT INTO freight.gps_positions
             (device_id, imei, vehicle_id, lat, lng, speed, course, satellites, positioned, gps_time, alarm,
              suspect, implied_speed_kmh, replay)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (device_id, gps_time) DO NOTHING RETURNING id`,
          [
            p.deviceId, p.imei, p.vehicleId, p.latitude, p.longitude, p.speedKmh, p.course, p.satellites,
            p.positioned, p.fixTime, p.alarm ? ALARM_CODES[p.alarm] ?? 0 : 0, p.suspect, p.impliedSpeedKmh, p.replay,
          ],
        );
        inserted += rows.length;
      }
      if (batch.latest) {
        // EDR's updateLiveFix: only forward in time.
        await m.query(
          `UPDATE freight.gps_devices
              SET last_lat = $2, last_lng = $3, last_speed = $4, last_course = $5, last_fix_at = $6
            WHERE id = $1 AND (last_fix_at IS NULL OR last_fix_at <= $6)`,
          [batch.device.id, batch.latest.latitude, batch.latest.longitude, batch.latest.speedKmh, batch.latest.course, batch.latest.fixTime],
        );
      }
      return inserted;
    });
  }

  async markSeen(device: GpsDevice, seenAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE freight.gps_devices SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2), $2), status = 'ONLINE' WHERE id = $1`,
      [device.id, seenAt],
    );
  }

  async onStatus(e: GpsStatusEvent): Promise<void> {
    await this.db.query(`UPDATE freight.gps_devices SET voltage_level = $2, gsm_level = $3 WHERE id = $1`, [
      e.device.id,
      e.status.voltageLevel,
      e.status.gsmLevel,
    ]);
  }

  async onDisconnect(e: GpsDisconnectEvent): Promise<void> {
    // EDR derives OFFLINE at read time (5-minute window); nothing to write.
    void e;
  }

  /** Where "Auto-registering new GPS tracker" used to be: unknown trackers are now refused and logged. */
  async onRejected(e: GpsRejectionEvent): Promise<void> {
    console.warn(`GT06 ${e.reason} from ${e.connection.remoteAddress}`);
  }
}

/** EDR stored the alarm byte as an int in gps_positions.alarm. */
const ALARM_CODES: Record<string, number> = { NORMAL: 0, SOS: 1, POWER_CUT: 2, SHOCK: 3, FENCE_IN: 4, FENCE_OUT: 5 };

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: (c: ConfigService) => c.get("database")! }),
    GpsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        port: Number(c.get("GT06_TCP_PORT") ?? 5023),
        bindAddress: c.get("GT06_TCP_HOST") ?? "0.0.0.0",
        allowedSources: (c.get<string>("GT06_ALLOWED_SOURCES") ?? "").split(",").filter(Boolean),
        // The tracker app does not scan; the freight API does (below).
        alerts: { enabled: false },
      }),
      host: EdrTrackerHost,
    }),
  ],
})
export class EdrGpsTrackerModule {}

// ── 2. apps/edr-freight-api: alerts ─────────────────────────────────────────

interface NotificationInboxService {
  notify(input: Record<string, unknown>): Promise<void>;
}

@Injectable()
export class EdrAlertHost extends EdrTrackerHost {
  constructor(
    @InjectDataSource() db: DataSource,
    private readonly inbox: NotificationInboxService,
  ) {
    super(db);
  }

  /** GpsAlertsService.loadSnapshots, getSettings and the active geofences, unchanged in SQL. */
  async loadAlertInputs(q: { now: Date; resolvedSince: Date }): Promise<GpsAlertInputs> {
    // ... the three queries of loadSnapshots (devices joined to vehicles, availability = 'BUSY'
    //     as onTrip, positions inside the idle window plus the one before it), now with
    //     AND NOT suspect on the position queries;
    // ... SELECT * FROM freight.gps_alerts WHERE resolved_at IS NULL AND deleted_at IS NULL;
    // ... SELECT vehicle_id, kind, geofence_id, resolved_at FROM freight.gps_alerts WHERE resolved_at >= $1
    void q;
    throw new Error("see GpsAlertsService.loadSnapshots");
  }

  /** EDR's insert with .orIgnore() and the uq_gps_alerts_open partial index. */
  async openAlert(a: GpsAlertToOpen): Promise<string | null> {
    const rows = await this.dbQuery(
      `INSERT INTO freight.gps_alerts (vehicle_id, device_id, kind, geofence_id, started_at, last_seen_at, details)
       VALUES ($1,$2,$3,$4,$5,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [a.condition.vehicleId, a.condition.deviceId ?? null, a.condition.kind, a.condition.geofenceId ?? null, a.startedAt, a.condition.details],
    );
    return rows[0]?.id ?? null;
  }

  async touchAlert(u: { id: string; lastSeenAt: Date; details: Record<string, unknown> }): Promise<void> {
    await this.dbQuery(`UPDATE freight.gps_alerts SET last_seen_at = $2, details = $3 WHERE id = $1`, [u.id, u.lastSeenAt, u.details]);
  }

  async resolveAlert(u: { id: string; resolvedAt: Date }): Promise<void> {
    await this.dbQuery(`UPDATE freight.gps_alerts SET resolved_at = $2 WHERE id = $1`, [u.id, u.resolvedAt]);
  }

  /** GpsAlertsService.notifyOpened: tracking.view holders, back office audience. */
  async notifyAlert(a: GpsOpenedAlert): Promise<void> {
    await this.inbox.notify({
      recipients: { permissionKeys: ["tracking.view"] },
      audience: NotificationAudience.BACKOFFICE,
      type: NotificationType.GENERIC,
      title: a.title,
      body: a.body,
      link: `/dashboard/tracking?vehicleId=${a.vehicleId}`,
      data: { vehicleId: a.vehicleId, action: `GPS_${a.kind}` },
    });
  }

  private dbQuery(sql: string, params: unknown[]): Promise<Array<{ id: string }>> {
    return (this as unknown as { db: DataSource }).db.query(sql, params);
  }
}

/**
 * In GpsTrackingModule: listen false (the tracker app owns the socket; two processes must not
 * fight for it, as the module's own comment says), alerts on.
 *
 *   GpsModule.forRoot({ options: { listen: false, alerts: { cooldownMinutes: 15 } }, host: EdrAlertHost,
 *                       imports: [NotificationInboxModule] })
 */
