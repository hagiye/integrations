import type { GpsAlertThresholds } from "./gps.options";
import {
  GpsGeofence,
  GpsOpenAlert,
  GpsVehicleSnapshot,
  describeGpsAlert,
  evaluateVehicle,
  isIdle,
  planGpsAlerts,
} from "./gps.alerts.rules";

const now = new Date("2026-10-20T12:00:00Z");
const minAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const t: GpsAlertThresholds = { overspeedKmh: 80, idleMinutes: 30, offlineMinutes: 15 };

const snap = (over: Partial<GpsVehicleSnapshot> = {}): GpsVehicleSnapshot => ({
  vehicleId: "v1",
  deviceId: "d1",
  label: "ET-1",
  onTrip: true,
  lastSeenAt: minAgo(1),
  lastFixAt: minAgo(1),
  lastLat: 9.0,
  lastLng: 38.7,
  lastSpeedKmh: 50,
  recentFixes: [],
  ...over,
});

const kinds = (s: GpsVehicleSnapshot, fences: GpsGeofence[] = []) => evaluateVehicle(s, t, fences, now).map((c) => c.kind);

// EDR's gps-alerts.rules.spec cases, unchanged in meaning.
describe("evaluateVehicle (EDR's rules)", () => {
  it("raises nothing for a vehicle moving within the limit", () => {
    expect(kinds(snap())).toEqual([]);
  });

  it("raises overspeed above the limit, on or off a trip, not at the limit", () => {
    expect(kinds(snap({ lastSpeedKmh: 95, onTrip: false }))).toEqual(["OVERSPEED"]);
    expect(kinds(snap({ lastSpeedKmh: 80 }))).toEqual([]);
  });

  it("raises offline only on a trip, and ignores a silent tracker's old fix", () => {
    expect(kinds(snap({ lastSeenAt: minAgo(40) }))).toEqual(["OFFLINE"]);
    expect(kinds(snap({ lastSeenAt: minAgo(40), onTrip: false }))).toEqual([]);
    expect(kinds(snap({ lastSeenAt: minAgo(40), lastSpeedKmh: 120 }))).toEqual(["OFFLINE"]);
    expect(kinds(snap({ lastSeenAt: null }))).toEqual([]);
  });

  it("raises idle when stationary for the whole window on a trip", () => {
    const fixes = [
      { fixTime: minAgo(40), speedKmh: 0 },
      { fixTime: minAgo(20), speedKmh: 1 },
      { fixTime: minAgo(2), speedKmh: 0 },
    ];
    expect(kinds(snap({ lastSpeedKmh: 0, recentFixes: fixes }))).toEqual(["IDLE"]);
    expect(kinds(snap({ lastSpeedKmh: 0, recentFixes: fixes, onTrip: false }))).toEqual([]);
  });

  describe("geofence", () => {
    const fence = (kind: "KEEP_OUT" | "KEEP_IN"): GpsGeofence => ({ id: "g1", name: "Zone", kind, lat: 9.0, lng: 38.7, radiusM: 1000 });

    it("KEEP_OUT alerts inside; KEEP_IN alerts outside", () => {
      expect(kinds(snap(), [fence("KEEP_OUT")])).toEqual(["GEOFENCE"]);
      expect(kinds(snap({ lastLat: 9.5 }), [fence("KEEP_OUT")])).toEqual([]);
      expect(kinds(snap({ lastLat: 9.5 }), [fence("KEEP_IN")])).toEqual(["GEOFENCE"]);
      expect(kinds(snap(), [fence("KEEP_IN")])).toEqual([]);
    });

    it("carries the geofence id so each fence is its own alert", () => {
      expect(evaluateVehicle(snap(), t, [fence("KEEP_OUT")], now)[0].geofenceId).toBe("g1");
    });
  });
});

describe("evaluateVehicle: a stale fix behind fresh heartbeats (EDR kept alerting on it)", () => {
  it("no overspeed or geofence from a fix older than fixMaxAgeMinutes", () => {
    const stale = snap({ lastSeenAt: minAgo(1), lastFixAt: minAgo(120), lastSpeedKmh: 120 });
    expect(kinds(stale)).toEqual([]);
    const fence: GpsGeofence = { id: "g1", name: "Zone", kind: "KEEP_OUT", lat: 9.0, lng: 38.7, radiusM: 1000 };
    expect(kinds(stale, [fence])).toEqual([]);
  });

  it("fixMaxAgeMinutes widens or narrows the window", () => {
    const s = snap({ lastFixAt: minAgo(20), lastSpeedKmh: 120 });
    expect(evaluateVehicle(s, t, [], now).map((c) => c.kind)).toEqual([]);
    expect(evaluateVehicle(s, t, [], now, { fixMaxAgeMinutes: 30 }).map((c) => c.kind)).toEqual(["OVERSPEED"]);
  });
});

describe("isIdle (EDR)", () => {
  it("needs a stopped fix at or before the window start, and no movement inside it", () => {
    expect(isIdle([{ fixTime: minAgo(10), speedKmh: 0 }], 30, now)).toBe(false);
    expect(isIdle([{ fixTime: minAgo(45), speedKmh: 0 }, { fixTime: minAgo(10), speedKmh: 40 }], 30, now)).toBe(false);
    expect(isIdle([{ fixTime: minAgo(45), speedKmh: 30 }, { fixTime: minAgo(5), speedKmh: 0 }], 30, now)).toBe(false);
    expect(isIdle([], 30, now)).toBe(false);
  });
});

describe("planGpsAlerts", () => {
  const cond = (kind: "OVERSPEED" | "IDLE", vehicleId = "v1", details: Record<string, unknown> = {}) => ({ kind, vehicleId, details });
  const open = (id: string, kind: "OVERSPEED" | "IDLE" | "GEOFENCE", over: Partial<GpsOpenAlert> = {}): GpsOpenAlert => ({
    id,
    vehicleId: "v1",
    kind,
    lastSeenAt: minAgo(1),
    details: {},
    ...over,
  });
  const noDelay = { resolveAfterMs: 0, cooldownMs: 0 };

  it("opens new, touches ongoing, resolves cleared (EDR's reconcile)", () => {
    const plan = planGpsAlerts([open("a1", "OVERSPEED"), open("a2", "IDLE")], [], [cond("OVERSPEED"), cond("OVERSPEED", "v2")], now, noDelay);
    expect(plan.toOpen.map((x) => x.condition.vehicleId)).toEqual(["v2"]);
    expect(plan.toTouch.map((x) => x.id)).toEqual(["a1"]);
    expect(plan.toResolve.map((a) => a.id)).toEqual(["a2"]);
  });

  it("treats the same kind on another geofence as another alert", () => {
    const plan = planGpsAlerts(
      [open("a1", "GEOFENCE", { geofenceId: "g1" })],
      [],
      [{ kind: "GEOFENCE", vehicleId: "v1", geofenceId: "g2", details: {} }],
      now,
      noDelay,
    );
    expect(plan.toOpen).toHaveLength(1);
    expect(plan.toResolve).toHaveLength(1);
  });

  it("keeps the worst speed while an overspeed stays open", () => {
    const plan = planGpsAlerts([open("a1", "OVERSPEED", { details: { speedKmh: 110 } })], [], [cond("OVERSPEED", "v1", { speedKmh: 90 })], now, noDelay);
    expect(plan.toTouch[0].details.speedKmh).toBe(110);
  });

  it("opens quietly when the same condition was resolved within the cooldown", () => {
    const resolved = [{ vehicleId: "v1", kind: "OVERSPEED" as const, resolvedAt: minAgo(5) }];
    const opts = { resolveAfterMs: 0, cooldownMs: 15 * 60_000 };
    expect(planGpsAlerts([], resolved, [cond("OVERSPEED")], now, opts).toOpen).toEqual([{ condition: cond("OVERSPEED"), notify: false }]);
    const longAgo = [{ ...resolved[0], resolvedAt: minAgo(20) }];
    expect(planGpsAlerts([], longAgo, [cond("OVERSPEED")], now, opts).toOpen[0].notify).toBe(true);
  });

  it("resolves only after the condition has been gone for resolveAfterMs", () => {
    const opts = { resolveAfterMs: 3 * 60_000, cooldownMs: 0 };
    expect(planGpsAlerts([open("a1", "OVERSPEED", { lastSeenAt: minAgo(1) })], [], [], now, opts).toResolve).toEqual([]);
    expect(planGpsAlerts([open("a1", "OVERSPEED", { lastSeenAt: minAgo(4) })], [], [], now, opts).toResolve).toHaveLength(1);
  });

  it("counts one condition per key and scan", () => {
    expect(planGpsAlerts([], [], [cond("OVERSPEED"), cond("OVERSPEED")], now, noDelay).toOpen).toHaveLength(1);
  });
});

describe("describeGpsAlert", () => {
  it("words each kind as EDR's notifications did", () => {
    expect(describeGpsAlert({ kind: "OVERSPEED", details: { speedKmh: 95, limitKmh: 80 } }, "ET-1")).toEqual({
      title: "Overspeed: ET-1",
      body: "ET-1 is doing 95 km/h (limit 80).",
    });
    expect(describeGpsAlert({ kind: "GEOFENCE", details: { fence: "Port", fenceKind: "KEEP_IN" } }).body).toBe(
      "A vehicle left the allowed area Port.",
    );
  });
});
