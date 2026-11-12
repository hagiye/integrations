import type {
  GpsGeofence,
  GpsAlertKind,
  GpsOpenAlert,
  GpsResolvedAlert,
  GpsVehicleCondition,
  GpsVehicleSnapshot,
} from "./gps.alerts.rules";
import type { GpsAlertThresholds } from "./gps.options";
import type {
  GpsAlarmEvent,
  GpsConnectionInfo,
  GpsDevice,
  GpsDisconnectEvent,
  GpsPositionBatch,
  GpsRejectionEvent,
  GpsStatusEvent,
} from "./gps.types";

export const GPS_HOST = Symbol("GPS_HOST");

/** What GpsAlertService needs for one scan. */
export interface GpsAlertInputs {
  /** null or missing: options.alerts.defaultThresholds. */
  thresholds?: GpsAlertThresholds | null;
  /** Active geofences only. */
  geofences: GpsGeofence[];
  /** Devices fitted to a vehicle (EDR: device not deleted, vehicle not deleted). */
  vehicles: GpsVehicleSnapshot[];
  /** Alerts with no resolvedAt. */
  open: GpsOpenAlert[];
  /** Alerts resolved at or after query.resolvedSince (for the cooldown). */
  recentlyResolved: GpsResolvedAlert[];
}

export interface GpsAlertToOpen {
  condition: GpsVehicleCondition;
  startedAt: Date;
}

export interface GpsOpenedAlert {
  id: string;
  vehicleId: string;
  deviceId: string | null;
  kind: GpsAlertKind;
  geofenceId: string | null;
  details: Record<string, unknown>;
  startedAt: Date;
  /** A ready-made title and body (describeGpsAlert); use your own if you like. */
  title: string;
  body: string;
  label: string | null;
}

/**
 * Your side of the tracker integration. The package owns the protocol and the rules; your host
 * owns the tables.
 */
export interface GpsHost {
  /**
   * The registered, active device for an IMEI, or null to refuse the connection (it is closed
   * without an ack). Never create a device here: EDR auto-registered any IMEI that connected, so
   * anyone reaching the port could create devices and history. Register trackers through your
   * own admin flow.
   */
  findDevice(imei: string, connection: GpsConnectionInfo): Promise<GpsDevice | null>;

  /**
   * Store the batch. Use a unique key on (device, fix time) and ON CONFLICT DO NOTHING, and move
   * the live position to batch.latest only forward in time. Return how many rows were new. If
   * this throws, nothing in the batch is acknowledged and the fixes may come again.
   */
  savePositions(batch: GpsPositionBatch): Promise<number | void>;

  /**
   * The device sent something valid (login, a fix, a heartbeat, a no-fix packet). Called at most
   * once per seenThrottleMs per device. Update last_seen_at here: the OFFLINE alert reads it.
   */
  markSeen?(device: GpsDevice, seenAt: Date, connection: GpsConnectionInfo): Promise<void>;

  /** Battery, GSM signal, ACC, relay: from heartbeats and alarms. */
  onStatus?(event: GpsStatusEvent): Promise<void>;

  /** SOS, power cut, shock, fence: the alarm is acknowledged only after this returns. */
  onAlarm?(event: GpsAlarmEvent): Promise<void>;

  onConnect?(device: GpsDevice, connection: GpsConnectionInfo): Promise<void>;
  onDisconnect?(event: GpsDisconnectEvent): Promise<void>;

  /** A connection refused or closed by the rules: worth a log or a security alert. */
  onRejected?(event: GpsRejectionEvent): Promise<void>;

  // ── alerts: GpsAlertService runs only when the host has all four of these ──

  loadAlertInputs?(query: { now: Date; resolvedSince: Date }): Promise<GpsAlertInputs>;
  /**
   * Insert the alert. Return its id, or null when an open alert with the same vehicle, kind and
   * geofence already exists (a partial unique index makes a racing scan a no-op, as in EDR).
   */
  openAlert?(alert: GpsAlertToOpen): Promise<string | null>;
  touchAlert?(update: { id: string; lastSeenAt: Date; details: Record<string, unknown> }): Promise<void>;
  resolveAlert?(update: { id: string; resolvedAt: Date }): Promise<void>;
  /** Tell someone. Errors are logged, never retried (EDR). Not called inside the cooldown. */
  notifyAlert?(alert: GpsOpenedAlert): Promise<void>;
}

export function hostHasAlerts(host: GpsHost): boolean {
  return Boolean(host.loadAlertInputs && host.openAlert && host.touchAlert && host.resolveAlert);
}
