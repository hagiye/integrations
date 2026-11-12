import type { Gt06AlarmType, Gt06Lbs, Gt06Status } from "./gt06.codec";
import type { GpsDropReason } from "./gps.validation";

/** A registered tracker, as your host stores it. */
export interface GpsDevice {
  /** Your id for the device row. */
  id: string;
  /** 15 digits (16 for the odd terminal id), as the tracker sends it at login. */
  imei: string;
  /** What the tracker is fitted to (a vehicle id), copied onto each position. */
  vehicleId?: string | null;
  /** The newest trusted fix you hold. Seeds jump detection after a restart. */
  lastFix?: { latitude: number; longitude: number; fixTime: Date } | null;
}

export interface GpsConnectionInfo {
  /** Unique per TCP connection in this process. */
  connectionId: string;
  remoteAddress: string;
  remotePort: number;
  connectedAt: Date;
}

export interface GpsPosition {
  deviceId: string;
  imei: string;
  vehicleId: string | null;
  /** From the tracker's GPS clock. Your unique key is (deviceId, fixTime). */
  fixTime: Date;
  receivedAt: Date;
  latitude: number;
  longitude: number;
  speedKmh: number;
  course: number;
  satellites: number;
  /** false only with storeUnpositioned: the tracker had no satellite lock. */
  positioned: boolean;
  /**
   * The speed from the last trusted fix to this one is impossible (maxImpliedSpeedKmh). Store it
   * for review; never make it the live position or feed it to alerts.
   */
  suspect: boolean;
  /** km/h implied from the last trusted fix, when there was one. */
  impliedSpeedKmh: number | null;
  /** The tracker says it is a buffered fix sent late (0x22), or it is older than one already taken. */
  replay: boolean;
  /** LOCATION for a location packet, ALARM for the fix inside an alarm. */
  source: "LOCATION" | "ALARM";
  /** For source ALARM. */
  alarm: Gt06AlarmType | null;
  /** The GT06 protocol number (0x12, 0x22, 0x16, 0x26). */
  protocol: number;
  lbs: Gt06Lbs | null;
}

export interface GpsPositionBatch {
  device: GpsDevice;
  connection: GpsConnectionInfo;
  /** In arrival order, already checked and de-duplicated. Never empty. */
  positions: GpsPosition[];
  /**
   * The newest positioned, non-suspect fix of the batch, or null. Move your live position to it
   * only if it is newer than the one you hold (UPDATE ... WHERE last_fix_at IS NULL OR
   * last_fix_at <= :fixTime), as EDR did: trackers replay old fixes after a coverage gap.
   */
  latest: GpsPosition | null;
}

export interface GpsStatusEvent {
  device: GpsDevice;
  connection: GpsConnectionInfo;
  source: "HEARTBEAT" | "ALARM";
  status: Gt06Status;
  receivedAt: Date;
}

export interface GpsAlarmEvent {
  device: GpsDevice;
  connection: GpsConnectionInfo;
  alarm: Gt06AlarmType;
  alarmCode: number | null;
  status: Gt06Status;
  /** The alarm's fix, as stored (null when it had none or it was dropped). */
  position: GpsPosition | null;
  /** Why the alarm's fix was not stored, if it was not. */
  positionDropped: GpsDropReason | "NO_GPS_BLOCK" | null;
  receivedAt: Date;
}

export type GpsRejectionReason =
  /** The remote IP is not in allowedSources. */
  | "SOURCE_NOT_ALLOWED"
  /** maxConnections or maxConnectionsPerIp reached. */
  | "TOO_MANY_CONNECTIONS"
  /** findDevice returned null: not registered, or deleted. EDR auto-registered every IMEI. */
  | "UNKNOWN_DEVICE"
  /** A login whose terminal id is not BCD digits. */
  | "BAD_IMEI"
  /** A second login on the same connection with another IMEI. EDR switched the session to it. */
  | "IMEI_CHANGED"
  /** No login within loginTimeoutMs. */
  | "LOGIN_TIMEOUT"
  /** More than maxBadFrames bad CRCs, garbage or malformed packets. */
  | "TOO_MANY_BAD_FRAMES"
  /** Over twice maxPacketsPerMinute. */
  | "RATE_LIMITED"
  /** findDevice threw: closed without an ack, the tracker logs in again. */
  | "HOST_ERROR";

export interface GpsRejectionEvent {
  reason: GpsRejectionReason;
  connection: GpsConnectionInfo;
  /** As sent, when the connection got as far as a login. */
  imei: string | null;
  at: Date;
}

export type GpsDisconnectReason =
  | "CLOSED_BY_TRACKER"
  | "IDLE"
  /** The same IMEI logged in on a new connection; the old one is closed. */
  | "REPLACED"
  | "SHUTDOWN"
  | GpsRejectionReason;

export interface GpsDisconnectEvent {
  device: GpsDevice;
  connection: GpsConnectionInfo;
  reason: GpsDisconnectReason;
  at: Date;
}

/** What GpsIngestService did with one batch, for logs and tests. */
export interface GpsIngestReport {
  stored: number;
  suspect: number;
  dropped: Partial<Record<GpsDropReason, number>>;
}
