import type { Gt06Gps } from "./gt06.codec";
import { distanceM, isPlausibleCoordinate } from "./gps.geo";

/** Why a fix was not stored. */
export type GpsDropReason =
  /** The receiver had no fix (storeUnpositioned is off). EDR stored these, flagged. */
  | "NO_FIX"
  /** Outside -90..90 / -180..180, or 0,0. */
  | "IMPOSSIBLE_COORDINATES"
  /** Dated further ahead than maxFutureSkewMinutes: a bad clock, not a position. */
  | "FUTURE"
  /** Older than maxFixAgeMinutes. */
  | "TOO_OLD"
  /** Same device, same fix time as one already taken. */
  | "DUPLICATE";

export interface GpsFixLimits {
  storeUnpositioned: boolean;
  maxFutureSkewMs: number;
  maxFixAgeMs: number;
}

/** The first rule a fix breaks, or null. Duplicates and jumps are checked separately (they need history). */
export function checkFix(gps: Gt06Gps, now: Date, limits: GpsFixLimits): GpsDropReason | null {
  if (!gps.positioned && !limits.storeUnpositioned) return "NO_FIX";
  if (gps.positioned && !isPlausibleCoordinate(gps.latitude, gps.longitude)) return "IMPOSSIBLE_COORDINATES";
  const t = gps.fixTime.getTime();
  if (!Number.isFinite(t)) return "IMPOSSIBLE_COORDINATES";
  if (t > now.getTime() + limits.maxFutureSkewMs) return "FUTURE";
  if (t < now.getTime() - limits.maxFixAgeMs) return "TOO_OLD";
  return null;
}

/** km/h needed to get from a to b in the time between them. Infinity for two places at one time. */
export function impliedSpeedKmh(
  a: { latitude: number; longitude: number; fixTime: Date },
  b: { latitude: number; longitude: number; fixTime: Date },
): number {
  const km = distanceM(a.latitude, a.longitude, b.latitude, b.longitude) / 1000;
  const hours = Math.abs(b.fixTime.getTime() - a.fixTime.getTime()) / 3_600_000;
  if (hours === 0) return km < 0.05 ? 0 : Infinity;
  return km / hours;
}

interface Point {
  latitude: number;
  longitude: number;
  fixTime: Date;
}

/** At most this many devices are remembered; the oldest entry goes first. */
const MAX_DEVICES = 100_000;

/**
 * Flags fixes that imply an impossible speed from the last trusted one: a GPS glitch, or someone
 * sending positions for an IMEI they do not own. A flagged fix is stored as suspect and never moves
 * the live position. After reanchorAfter flagged fixes that agree with each other, the device really
 * is somewhere else (the trusted fix was the bad one), and the newest becomes the new anchor.
 * Not in EDR, which trusted every fix.
 */
export class JumpDetector {
  private readonly anchors = new Map<string, Point>();
  private readonly streaks = new Map<string, { point: Point; count: number }>();

  constructor(
    private readonly maxImpliedSpeedKmh: number,
    private readonly reanchorAfter = 3,
  ) {}

  /** Start from the host's last trusted fix (after a restart), unless this process already has one. */
  seed(deviceId: string, fix: Point | null | undefined): void {
    if (!fix || this.anchors.has(deviceId)) return;
    if (!isPlausibleCoordinate(fix.latitude, fix.longitude) || !Number.isFinite(fix.fixTime.getTime())) return;
    this.remember(deviceId, fix);
  }

  /** Whether the fix is suspect, and the speed it implies. Only positioned fixes should come here. */
  check(deviceId: string, fix: Point): { suspect: boolean; impliedKmh: number | null } {
    if (this.maxImpliedSpeedKmh <= 0) return { suspect: false, impliedKmh: null };
    const anchor = this.anchors.get(deviceId);
    if (!anchor) {
      this.remember(deviceId, fix);
      return { suspect: false, impliedKmh: null };
    }
    const kmh = impliedSpeedKmh(anchor, fix);
    if (kmh <= this.maxImpliedSpeedKmh) {
      // An older replayed fix is fine, but only a newer one moves the anchor forward.
      if (fix.fixTime.getTime() >= anchor.fixTime.getTime()) this.remember(deviceId, fix);
      this.streaks.delete(deviceId);
      return { suspect: false, impliedKmh: kmh };
    }
    const streak = this.streaks.get(deviceId);
    const agrees = streak && impliedSpeedKmh(streak.point, fix) <= this.maxImpliedSpeedKmh;
    const count = agrees ? streak.count + 1 : 1;
    if (count >= this.reanchorAfter) {
      this.remember(deviceId, fix);
      this.streaks.delete(deviceId);
      return { suspect: false, impliedKmh: kmh };
    }
    this.streaks.set(deviceId, { point: fix, count });
    return { suspect: true, impliedKmh: kmh };
  }

  forget(deviceId: string): void {
    this.anchors.delete(deviceId);
    this.streaks.delete(deviceId);
  }

  private remember(deviceId: string, fix: Point): void {
    this.anchors.delete(deviceId);
    this.anchors.set(deviceId, { latitude: fix.latitude, longitude: fix.longitude, fixTime: fix.fixTime });
    if (this.anchors.size > MAX_DEVICES) {
      const oldest = this.anchors.keys().next().value;
      if (oldest !== undefined) this.forget(oldest);
    }
  }
}

/**
 * Recent fix times per device, to drop a fix sent twice (an alarm whose ack was lost comes again)
 * before it reaches the database. The host's unique key on (device, fix time) is the real guard;
 * this saves the round trip. EDR had neither: every resend became another history row.
 */
export class RecentFixTimes {
  private readonly byDevice = new Map<string, { set: Set<number>; order: number[] }>();

  constructor(private readonly perDevice = 256) {}

  /** True if seen; otherwise records it. */
  seen(deviceId: string, fixTime: Date): boolean {
    const ms = fixTime.getTime();
    let entry = this.byDevice.get(deviceId);
    if (!entry) {
      entry = { set: new Set(), order: [] };
      this.byDevice.set(deviceId, entry);
      if (this.byDevice.size > MAX_DEVICES) {
        const oldest = this.byDevice.keys().next().value;
        if (oldest !== undefined) this.byDevice.delete(oldest);
      }
    }
    if (entry.set.has(ms)) return true;
    entry.set.add(ms);
    entry.order.push(ms);
    if (entry.order.length > this.perDevice) entry.set.delete(entry.order.shift() as number);
    return false;
  }

  /** Forget a fix time again (the host refused the batch, so the resend must get through). */
  unsee(deviceId: string, fixTime: Date): void {
    this.byDevice.get(deviceId)?.set.delete(fixTime.getTime());
  }
}
