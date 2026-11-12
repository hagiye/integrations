import type {
  GpsAlarmEvent,
  GpsAlertInputs,
  GpsAlertToOpen,
  GpsConnectionInfo,
  GpsDevice,
  GpsDisconnectEvent,
  GpsGeofence,
  GpsHost,
  GpsOpenedAlert,
  GpsPosition,
  GpsPositionBatch,
  GpsRejectionEvent,
  GpsStatusEvent,
  GpsVehicleSnapshot,
} from "../src";
import { gpsAlertKey } from "../src";

interface StoredAlert {
  id: string;
  vehicleId: string;
  deviceId: string | null;
  kind: GpsAlertToOpen["condition"]["kind"];
  geofenceId: string | null;
  details: Record<string, unknown>;
  startedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
}

/** An in-memory GpsHost that behaves like the TypeORM example: unique (device, fix time), forward-only live fix. */
export class FakeGpsHost implements GpsHost {
  readonly devices = new Map<string, GpsDevice & { lastSeenAt?: Date; live?: GpsPosition | null }>();
  readonly positions: GpsPosition[] = [];
  readonly batches: GpsPositionBatch[] = [];
  readonly statuses: GpsStatusEvent[] = [];
  readonly alarms: GpsAlarmEvent[] = [];
  readonly connects: Array<{ device: GpsDevice; connection: GpsConnectionInfo }> = [];
  readonly disconnects: GpsDisconnectEvent[] = [];
  readonly rejections: GpsRejectionEvent[] = [];
  readonly seen: Array<{ imei: string; at: Date }> = [];
  readonly alerts: StoredAlert[] = [];
  readonly notified: GpsOpenedAlert[] = [];
  geofences: GpsGeofence[] = [];
  vehicles: GpsVehicleSnapshot[] = [];
  /** Delay every savePositions by this much (backpressure tests). */
  saveDelayMs = 0;
  /** Throw on the next n savePositions calls. */
  failSaves = 0;
  failFind = 0;
  failAlarms = 0;
  private nextId = 1;

  register(imei: string, extra: Partial<GpsDevice> = {}): GpsDevice {
    const device: GpsDevice = { id: `dev-${this.nextId++}`, imei, vehicleId: null, ...extra };
    this.devices.set(imei, device);
    return device;
  }

  async findDevice(imei: string): Promise<GpsDevice | null> {
    if (this.failFind > 0) {
      this.failFind -= 1;
      throw new Error("database down");
    }
    return this.devices.get(imei) ?? null;
  }

  async savePositions(batch: GpsPositionBatch): Promise<number> {
    if (this.saveDelayMs) await new Promise((r) => setTimeout(r, this.saveDelayMs));
    if (this.failSaves > 0) {
      this.failSaves -= 1;
      throw new Error("database down");
    }
    this.batches.push(batch);
    let inserted = 0;
    for (const p of batch.positions) {
      if (this.positions.some((q) => q.deviceId === p.deviceId && q.fixTime.getTime() === p.fixTime.getTime())) continue;
      this.positions.push(p);
      inserted += 1;
    }
    const d = this.devices.get(batch.device.imei);
    if (d && batch.latest && (!d.live || d.live.fixTime.getTime() <= batch.latest.fixTime.getTime())) d.live = batch.latest;
    return inserted;
  }

  async markSeen(device: GpsDevice, at: Date): Promise<void> {
    this.seen.push({ imei: device.imei, at });
    const d = this.devices.get(device.imei);
    if (d) d.lastSeenAt = at;
  }

  async onStatus(e: GpsStatusEvent): Promise<void> {
    this.statuses.push(e);
  }

  async onAlarm(e: GpsAlarmEvent): Promise<void> {
    if (this.failAlarms > 0) {
      this.failAlarms -= 1;
      throw new Error("notification service down");
    }
    this.alarms.push(e);
  }

  async onConnect(device: GpsDevice, connection: GpsConnectionInfo): Promise<void> {
    this.connects.push({ device, connection });
  }

  async onDisconnect(e: GpsDisconnectEvent): Promise<void> {
    this.disconnects.push(e);
  }

  async onRejected(e: GpsRejectionEvent): Promise<void> {
    this.rejections.push(e);
  }

  async loadAlertInputs(q: { now: Date; resolvedSince: Date }): Promise<GpsAlertInputs> {
    return {
      thresholds: null,
      geofences: this.geofences,
      vehicles: this.vehicles,
      open: this.alerts
        .filter((a) => !a.resolvedAt)
        .map((a) => ({ id: a.id, vehicleId: a.vehicleId, kind: a.kind, geofenceId: a.geofenceId, lastSeenAt: a.lastSeenAt, details: a.details })),
      recentlyResolved: this.alerts
        .filter((a) => a.resolvedAt && a.resolvedAt >= q.resolvedSince)
        .map((a) => ({ vehicleId: a.vehicleId, kind: a.kind, geofenceId: a.geofenceId, resolvedAt: a.resolvedAt as Date })),
    };
  }

  async openAlert(a: GpsAlertToOpen): Promise<string | null> {
    const key = gpsAlertKey(a.condition);
    if (this.alerts.some((x) => !x.resolvedAt && gpsAlertKey(x) === key)) return null; // the partial unique index
    const id = `alert-${this.nextId++}`;
    this.alerts.push({
      id,
      vehicleId: a.condition.vehicleId,
      deviceId: a.condition.deviceId ?? null,
      kind: a.condition.kind,
      geofenceId: a.condition.geofenceId ?? null,
      details: a.condition.details,
      startedAt: a.startedAt,
      lastSeenAt: a.startedAt,
      resolvedAt: null,
    });
    return id;
  }

  async touchAlert(u: { id: string; lastSeenAt: Date; details: Record<string, unknown> }): Promise<void> {
    const a = this.alerts.find((x) => x.id === u.id);
    if (a) Object.assign(a, { lastSeenAt: u.lastSeenAt, details: u.details });
  }

  async resolveAlert(u: { id: string; resolvedAt: Date }): Promise<void> {
    const a = this.alerts.find((x) => x.id === u.id);
    if (a) a.resolvedAt = u.resolvedAt;
  }

  async notifyAlert(a: GpsOpenedAlert): Promise<void> {
    this.notified.push(a);
  }
}

/** A host with only the required methods. */
export class MinimalGpsHost implements GpsHost {
  readonly saved: GpsPosition[] = [];
  constructor(private readonly known: Record<string, string> = {}) {}
  async findDevice(imei: string): Promise<GpsDevice | null> {
    return this.known[imei] ? { id: this.known[imei], imei } : null;
  }
  async savePositions(batch: GpsPositionBatch): Promise<void> {
    this.saved.push(...batch.positions);
  }
}
