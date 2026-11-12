/**
 * What a vehicle's latest GPS state says is wrong right now, and how that changes the alerts that
 * are open. Pure: GpsAlertService loads the snapshot from the host and applies the plan.
 * Ported from EDR's freight-api gps-alerts.rules.ts; differences are marked.
 */
import { distanceM } from "./gps.geo";
import type { GpsAlertThresholds } from "./gps.options";

export type GpsAlertKind = "OVERSPEED" | "IDLE" | "OFFLINE" | "GEOFENCE";

export interface GpsGeofence {
  id: string;
  name: string;
  /** KEEP_OUT alerts while the vehicle is inside; KEEP_IN alerts while it is outside. */
  kind: "KEEP_OUT" | "KEEP_IN";
  lat: number;
  lng: number;
  radiusM: number;
}

export interface GpsFixSample {
  fixTime: Date;
  speedKmh: number;
}

export interface GpsVehicleSnapshot {
  vehicleId: string;
  deviceId: string;
  /** Shown in notifications. */
  label?: string | null;
  /** On a trip: OFFLINE, IDLE and GEOFENCE only apply then (EDR: vehicle availability BUSY). */
  onTrip: boolean;
  /** Last packet of any kind (heartbeats too). */
  lastSeenAt: Date | null;
  /** The live fix: the newest trusted, positioned fix. */
  lastFixAt: Date | null;
  lastLat: number | null;
  lastLng: number | null;
  lastSpeedKmh: number | null;
  /** Positioned, trusted fixes from the idle window onward, plus the newest one before it. */
  recentFixes: GpsFixSample[];
}

export interface GpsCondition {
  kind: GpsAlertKind;
  geofenceId?: string;
  details: Record<string, unknown>;
}

export interface GpsVehicleCondition extends GpsCondition {
  vehicleId: string;
  deviceId?: string | null;
}

/** Below this a vehicle counts as stationary (GPS drift reads a few km/h at rest). */
export const STATIONARY_KMH = 3;
const MIN = 60_000;

export interface GpsEvaluateOptions {
  /**
   * OVERSPEED and GEOFENCE need the live fix to be at most this old. Default: offlineMinutes.
   * Not in EDR, which judged "live" by the last packet of any kind: a tracker that lost GPS lock
   * but kept sending heartbeats kept raising an hours-old overspeed, and kept a vehicle that had
   * long left a fence inside it.
   */
  fixMaxAgeMinutes?: number | null;
}

export function evaluateVehicle(
  s: GpsVehicleSnapshot,
  t: GpsAlertThresholds,
  fences: GpsGeofence[],
  now: Date,
  options: GpsEvaluateOptions = {},
): GpsCondition[] {
  const out: GpsCondition[] = [];
  const offlineMs = t.offlineMinutes * MIN;
  const silentMs = s.lastSeenAt ? now.getTime() - s.lastSeenAt.getTime() : null;
  if (s.onTrip && silentMs != null && silentMs > offlineMs) {
    out.push({ kind: "OFFLINE", details: { silentMinutes: Math.floor(silentMs / MIN) } });
  }
  // A silent tracker's last fix is history, not where the vehicle is now (EDR).
  const live = silentMs != null && silentMs <= offlineMs;
  if (!live) return out;

  const fixMaxAgeMs = (options.fixMaxAgeMinutes ?? t.offlineMinutes) * MIN;
  const fixFresh = s.lastFixAt != null && now.getTime() - s.lastFixAt.getTime() <= fixMaxAgeMs;

  if (fixFresh && s.lastSpeedKmh != null && s.lastSpeedKmh > t.overspeedKmh) {
    out.push({
      kind: "OVERSPEED",
      details: { speedKmh: Math.round(s.lastSpeedKmh), limitKmh: t.overspeedKmh, lat: s.lastLat, lng: s.lastLng },
    });
  }

  if (s.onTrip && isIdle(s.recentFixes, t.idleMinutes, now)) {
    out.push({ kind: "IDLE", details: { idleMinutes: t.idleMinutes, lat: s.lastLat, lng: s.lastLng } });
  }

  if (s.onTrip && fixFresh && s.lastLat != null && s.lastLng != null) {
    for (const f of fences) {
      const d = distanceM(s.lastLat, s.lastLng, f.lat, f.lng);
      const inside = d <= f.radiusM;
      if ((f.kind === "KEEP_OUT" && inside) || (f.kind === "KEEP_IN" && !inside)) {
        out.push({
          kind: "GEOFENCE",
          geofenceId: f.id,
          details: { fence: f.name, fenceKind: f.kind, distanceM: Math.round(d), lat: s.lastLat, lng: s.lastLng },
        });
      }
    }
  }
  return out;
}

/**
 * Stationary for the whole window: every fix since the window opened is below the stationary
 * speed, and a stationary fix at or before its start proves the vehicle was already stopped then
 * (without it we only know about a short stop). EDR's rule, unchanged.
 */
export function isIdle(fixes: GpsFixSample[], idleMinutes: number, now: Date): boolean {
  if (!fixes.length) return false;
  const cut = now.getTime() - idleMinutes * MIN;
  const before = fixes.filter((f) => f.fixTime.getTime() <= cut);
  const within = fixes.filter((f) => f.fixTime.getTime() > cut);
  if (!before.length) return false;
  const anchor = before.reduce((a, b) => (a.fixTime > b.fixTime ? a : b));
  return anchor.speedKmh < STATIONARY_KMH && within.every((f) => f.speedKmh < STATIONARY_KMH);
}

export const gpsAlertKey = (a: { vehicleId: string; kind: string; geofenceId?: string | null }): string =>
  `${a.vehicleId}|${a.kind}|${a.geofenceId ?? ""}`;

export interface GpsOpenAlert {
  id: string;
  vehicleId: string;
  kind: GpsAlertKind;
  geofenceId?: string | null;
  /** Last scan that still saw the condition. */
  lastSeenAt: Date;
  details: Record<string, unknown>;
}

export interface GpsResolvedAlert {
  vehicleId: string;
  kind: GpsAlertKind;
  geofenceId?: string | null;
  resolvedAt: Date;
}

export interface GpsAlertPlanOptions {
  /** See GpsAlertOptions.resolveAfterMinutes. */
  resolveAfterMs: number;
  /** See GpsAlertOptions.cooldownMinutes. */
  cooldownMs: number;
}

export interface GpsAlertPlan {
  /** New alerts. notify false: the same condition was resolved within the cooldown. */
  toOpen: Array<{ condition: GpsVehicleCondition; notify: boolean }>;
  /** Still true: lastSeenAt moves, details merge (the worst speed is kept). */
  toTouch: Array<{ id: string; condition: GpsVehicleCondition; details: Record<string, unknown> }>;
  /** Gone (for at least resolveAfterMs). */
  toResolve: GpsOpenAlert[];
}

/**
 * Compare what is wrong now with what is open: new conditions open an alert, ongoing ones are
 * touched, cleared ones are resolved. EDR's reconcile plus two things: an alert is resolved only
 * after its condition has been gone for resolveAfterMs, and a condition that returns within
 * cooldownMs of being resolved opens quietly. Without them a truck driving at 79-81 km/h opened,
 * notified and resolved an overspeed every minute.
 */
export function planGpsAlerts(
  open: GpsOpenAlert[],
  recentlyResolved: GpsResolvedAlert[],
  conditions: GpsVehicleCondition[],
  now: Date,
  options: GpsAlertPlanOptions,
): GpsAlertPlan {
  const openByKey = new Map(open.map((a) => [gpsAlertKey(a), a]));
  const nowKeys = new Set<string>();
  const plan: GpsAlertPlan = { toOpen: [], toTouch: [], toResolve: [] };
  const lastResolved = new Map<string, number>();
  for (const r of recentlyResolved) {
    const key = gpsAlertKey(r);
    lastResolved.set(key, Math.max(lastResolved.get(key) ?? 0, r.resolvedAt.getTime()));
  }
  for (const c of conditions) {
    const key = gpsAlertKey(c);
    if (nowKeys.has(key)) continue; // one condition per key and scan
    nowKeys.add(key);
    const existing = openByKey.get(key);
    if (existing) {
      plan.toTouch.push({ id: existing.id, condition: c, details: mergeGpsAlertDetails(existing.details, c.details) });
    } else {
      const resolvedAt = lastResolved.get(key);
      const quiet = resolvedAt !== undefined && now.getTime() - resolvedAt < options.cooldownMs;
      plan.toOpen.push({ condition: c, notify: !quiet });
    }
  }
  for (const a of open) {
    if (nowKeys.has(gpsAlertKey(a))) continue;
    if (now.getTime() - a.lastSeenAt.getTime() >= options.resolveAfterMs) plan.toResolve.push(a);
  }
  return plan;
}

/** Keep the worst speed seen while an overspeed alert stays open (EDR). */
export function mergeGpsAlertDetails(prior: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...next };
  if (typeof prior.speedKmh === "number" && typeof next.speedKmh === "number") {
    merged.speedKmh = Math.max(prior.speedKmh, next.speedKmh);
  }
  return merged;
}

const TITLES: Record<GpsAlertKind, string> = {
  OVERSPEED: "Overspeed",
  IDLE: "Vehicle idle",
  OFFLINE: "Tracker offline",
  GEOFENCE: "Geofence",
};

/** A one-line title and body for a notification, worded as EDR's (with "A vehicle" for "A truck"). */
export function describeGpsAlert(c: GpsCondition, label?: string | null): { title: string; body: string } {
  const who = label || "A vehicle";
  const d = c.details;
  const body =
    c.kind === "OVERSPEED"
      ? `${who} is doing ${d.speedKmh} km/h (limit ${d.limitKmh}).`
      : c.kind === "IDLE"
        ? `${who} has not moved for ${d.idleMinutes} minutes while on a trip.`
        : c.kind === "OFFLINE"
          ? `${who} has not reported for ${d.silentMinutes} minutes while on a trip.`
          : d.fenceKind === "KEEP_OUT"
            ? `${who} entered the restricted area ${d.fence}.`
            : `${who} left the allowed area ${d.fence}.`;
  return { title: `${TITLES[c.kind]}: ${who}`, body };
}
