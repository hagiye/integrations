import * as net from "node:net";
import { GpsError } from "./gps.errors";

export const GPS_OPTIONS = Symbol("GPS_OPTIONS");

export interface GpsAlertThresholds {
  /** Above this a live fix raises OVERSPEED. EDR default 80. */
  overspeedKmh: number;
  /** Stationary this long on a trip raises IDLE. EDR default 30. */
  idleMinutes: number;
  /** Silent this long on a trip raises OFFLINE. EDR default 15. */
  offlineMinutes: number;
}

export const DEFAULT_GPS_ALERT_THRESHOLDS: GpsAlertThresholds = { overspeedKmh: 80, idleMinutes: 30, offlineMinutes: 15 };

export interface GpsAlertOptions {
  /** Default true when the host has the alert methods. false: no scan, ever. */
  enabled?: boolean;
  /** How often GpsAlertService.scan runs on its own. Default 60000 (EDR: every minute). 0: only when you call scan(). */
  scanEveryMs?: number;
  /**
   * An open alert whose condition is gone is resolved only after this many minutes without it.
   * Default 0, as EDR: resolved at the first scan that does not see it.
   */
  resolveAfterMinutes?: number;
  /**
   * A condition that comes back within this many minutes of its alert being resolved opens a new
   * alert without notifying anyone again (a truck hovering around the speed limit). Default 15.
   * 0: notify every time, as EDR.
   */
  cooldownMinutes?: number;
  /**
   * OVERSPEED and GEOFENCE look at the live fix only while it is at most this old. Default: the
   * offline threshold. EDR looked at any last fix while the tracker still sent heartbeats, so a
   * tracker without GPS lock kept raising the same overspeed from hours before.
   */
  fixMaxAgeMinutes?: number;
  /** Used when the host's loadAlertInputs returns no thresholds. Default EDR's 80 / 30 / 15. */
  defaultThresholds?: Partial<GpsAlertThresholds>;
}

export interface GpsModuleOptions {
  /** Default true: GpsModule opens the GT06 TCP listener at application bootstrap. false: codec, rules and ingest only. */
  listen?: boolean;
  /** GT06 TCP port (GT06_TCP_PORT). Default 5023, as EDR. 0: any free port (tests). */
  port?: number;
  /**
   * Address to bind (GT06_TCP_HOST). Default "0.0.0.0", as EDR: trackers reach it over the mobile
   * network. Put a firewall or an APN VPN in front: GT06 has no authentication.
   */
  bindAddress?: string;
  /**
   * IPs or CIDR ranges trackers may connect from (your carrier's APN pool, a VPN range), IPv4 or
   * IPv6. Empty (default): any source. Not in EDR.
   */
  allowedSources?: string[];
  /** Open connections in all. Default 10000. */
  maxConnections?: number;
  /**
   * Open connections from one remote IP. Default 0 (no limit): many trackers on one carrier share
   * a NAT address. Set it when each tracker has its own IP.
   */
  maxConnectionsPerIp?: number;
  /** A connection silent this long is closed. Default 600000 (10 min), as EDR. */
  idleTimeoutMs?: number;
  /** A connection that has not logged in by then is closed. Default 30000. EDR waited for the idle timeout. */
  loginTimeoutMs?: number;
  /** Largest frame accepted. Default 1024 (a short frame is at most 260 bytes). */
  maxFrameBytes?: number;
  /** Bad CRCs, garbage and malformed packets tolerated on one connection before it is closed. Default 10. */
  maxBadFrames?: number;
  /** Frames per connection per minute; more are dropped, twice as many close the connection. Default 240. */
  maxPacketsPerMinute?: number;
  /** Packets waiting for the host on one connection before the socket is paused. Default 500. */
  maxPendingPackets?: number;
  /** Minutes the trackers' clocks run ahead of UTC (GT06 sends UTC). Default 0. */
  deviceUtcOffsetMinutes?: number;
  /** Store fixes taken without satellite lock, flagged (EDR did). Default false: dropped. */
  storeUnpositioned?: boolean;
  /** A fix dated more than this ahead of now is dropped. Default 5, as EDR's live-position guard. */
  maxFutureSkewMinutes?: number;
  /** A fix older than this is dropped. Default 10080 (7 days of buffered replay). */
  maxFixAgeMinutes?: number;
  /** A fix implying more than this from the last trusted one is stored as suspect. Default 300. 0: off. */
  maxImpliedSpeedKmh?: number;
  /** markSeen is called at most once per device in this window. Default 30000. EDR wrote on every packet. */
  seenThrottleMs?: number;
  /** Log the full IMEI. Default false: 3590*******0001. Whoever knows an IMEI can send its positions. */
  logFullImei?: boolean;
  alerts?: GpsAlertOptions;
}

export interface ResolvedGpsAlertOptions {
  enabled: boolean;
  scanEveryMs: number;
  resolveAfterMinutes: number;
  cooldownMinutes: number;
  fixMaxAgeMinutes: number | null;
  defaultThresholds: GpsAlertThresholds;
}

export interface ResolvedGpsOptions {
  listen: boolean;
  port: number;
  bindAddress: string;
  allowedSources: string[];
  maxConnections: number;
  maxConnectionsPerIp: number;
  idleTimeoutMs: number;
  loginTimeoutMs: number;
  maxFrameBytes: number;
  maxBadFrames: number;
  maxPacketsPerMinute: number;
  maxPendingPackets: number;
  deviceUtcOffsetMinutes: number;
  storeUnpositioned: boolean;
  maxFutureSkewMinutes: number;
  maxFixAgeMinutes: number;
  maxImpliedSpeedKmh: number;
  seenThrottleMs: number;
  logFullImei: boolean;
  alerts: ResolvedGpsAlertOptions;
}

/** Parses allowedSources into a BlockList (used as an allow list). Throws CONFIG naming the bad entry's position. */
export function buildSourceList(entries: string[]): net.BlockList | null {
  if (!entries.length) return null;
  const list = new net.BlockList();
  entries.forEach((raw, i) => {
    const entry = raw.trim();
    const [addr, prefixText] = entry.split("/");
    const family = net.isIPv4(addr) ? "ipv4" : net.isIPv6(addr) ? "ipv6" : null;
    if (!family) throw new GpsError("CONFIG", `allowedSources[${i}] is not an IP address or CIDR range`);
    if (prefixText === undefined) {
      list.addAddress(addr, family);
      return;
    }
    const prefix = Number(prefixText);
    const max = family === "ipv4" ? 32 : 128;
    if (!/^\d+$/.test(prefixText) || prefix > max) {
      throw new GpsError("CONFIG", `allowedSources[${i}] has a prefix length outside 0-${max}`);
    }
    list.addSubnet(addr, prefix, family);
  });
  return list;
}

/** "::ffff:10.1.2.3" (an IPv4 client on a dual-stack socket) as "10.1.2.3". */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

export function isSourceAllowed(list: net.BlockList | null, address: string): boolean {
  if (!list) return true;
  const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
  return family ? list.check(address, family) : false;
}

/** 15 digits as 3590*******0001. */
export function maskImei(imei: string, full = false): string {
  if (full || imei.length < 9) return imei;
  return `${imei.slice(0, 4)}${"*".repeat(imei.length - 8)}${imei.slice(-4)}`;
}

/** Option names whose values are out of range (never the values). Empty when all is well. */
export function invalidGpsOptions(o: ResolvedGpsOptions): string[] {
  const bad: string[] = [];
  const int = (name: keyof ResolvedGpsOptions, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const v = o[name] as number;
    if (!Number.isInteger(v) || v < min || v > max) bad.push(name);
  };
  int("port", 0, 65535);
  int("maxConnections", 1);
  int("maxConnectionsPerIp", 0);
  int("idleTimeoutMs", 1000);
  int("loginTimeoutMs", 100);
  int("maxFrameBytes", 64, 65_541);
  int("maxBadFrames", 0);
  int("maxPacketsPerMinute", 1);
  int("maxPendingPackets", 1);
  int("deviceUtcOffsetMinutes", -14 * 60, 14 * 60);
  int("maxFutureSkewMinutes", 0);
  int("maxFixAgeMinutes", 1);
  int("maxImpliedSpeedKmh", 0);
  int("seenThrottleMs", 0);
  if (!o.bindAddress || !net.isIP(o.bindAddress)) bad.push("bindAddress");
  const a = o.alerts;
  if (!Number.isInteger(a.scanEveryMs) || a.scanEveryMs < 0) bad.push("alerts.scanEveryMs");
  if (!(a.resolveAfterMinutes >= 0)) bad.push("alerts.resolveAfterMinutes");
  if (!(a.cooldownMinutes >= 0)) bad.push("alerts.cooldownMinutes");
  if (a.fixMaxAgeMinutes !== null && !(a.fixMaxAgeMinutes > 0)) bad.push("alerts.fixMaxAgeMinutes");
  const t = a.defaultThresholds;
  if (!(t.overspeedKmh > 0) || !(t.idleMinutes > 0) || !(t.offlineMinutes > 0)) bad.push("alerts.defaultThresholds");
  return bad;
}

export function resolveGpsOptions(options: GpsModuleOptions = {}): ResolvedGpsOptions {
  const alerts = options.alerts ?? {};
  const resolved: ResolvedGpsOptions = {
    listen: options.listen ?? true,
    port: options.port ?? 5023,
    bindAddress: (options.bindAddress ?? "0.0.0.0").trim(),
    allowedSources: (options.allowedSources ?? []).map((s) => s.trim()).filter(Boolean),
    maxConnections: options.maxConnections ?? 10_000,
    maxConnectionsPerIp: options.maxConnectionsPerIp ?? 0,
    idleTimeoutMs: options.idleTimeoutMs ?? 10 * 60_000,
    loginTimeoutMs: options.loginTimeoutMs ?? 30_000,
    maxFrameBytes: options.maxFrameBytes ?? 1024,
    maxBadFrames: options.maxBadFrames ?? 10,
    maxPacketsPerMinute: options.maxPacketsPerMinute ?? 240,
    maxPendingPackets: options.maxPendingPackets ?? 500,
    deviceUtcOffsetMinutes: options.deviceUtcOffsetMinutes ?? 0,
    storeUnpositioned: options.storeUnpositioned ?? false,
    maxFutureSkewMinutes: options.maxFutureSkewMinutes ?? 5,
    maxFixAgeMinutes: options.maxFixAgeMinutes ?? 7 * 24 * 60,
    maxImpliedSpeedKmh: options.maxImpliedSpeedKmh ?? 300,
    seenThrottleMs: options.seenThrottleMs ?? 30_000,
    logFullImei: options.logFullImei ?? false,
    alerts: {
      enabled: alerts.enabled ?? true,
      scanEveryMs: alerts.scanEveryMs ?? 60_000,
      resolveAfterMinutes: alerts.resolveAfterMinutes ?? 0,
      cooldownMinutes: alerts.cooldownMinutes ?? 15,
      fixMaxAgeMinutes: alerts.fixMaxAgeMinutes ?? null,
      defaultThresholds: { ...DEFAULT_GPS_ALERT_THRESHOLDS, ...(alerts.defaultThresholds ?? {}) },
    },
  };
  const bad = invalidGpsOptions(resolved);
  if (bad.length) throw new GpsError("CONFIG", `GPS options out of range: ${bad.join(", ")}`);
  // Parse now so a bad CIDR stops the app at start-up, not at the first connection.
  buildSourceList(resolved.allowedSources);
  return resolved;
}
