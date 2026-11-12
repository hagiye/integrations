import { distanceM, isPlausibleCoordinate } from "./gps.geo";
import type { Gt06Gps } from "./gt06.codec";
import { JumpDetector, RecentFixTimes, checkFix, impliedSpeedKmh } from "./gps.validation";

const now = new Date("2026-10-20T12:00:00Z");
const limits = { storeUnpositioned: false, maxFutureSkewMs: 5 * 60_000, maxFixAgeMs: 7 * 24 * 3_600_000 };
const gps = (over: Partial<Gt06Gps> = {}): Gt06Gps => ({
  fixTime: new Date(now.getTime() - 60_000),
  satellites: 9,
  latitude: 9.0108,
  longitude: 38.7613,
  speedKmh: 40,
  course: 90,
  positioned: true,
  differential: false,
  ...over,
});
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

describe("checkFix", () => {
  it("accepts a normal fix", () => {
    expect(checkFix(gps(), now, limits)).toBeNull();
  });

  it("drops a fix without satellite lock unless storeUnpositioned", () => {
    expect(checkFix(gps({ positioned: false, latitude: 0, longitude: 0 }), now, limits)).toBe("NO_FIX");
    expect(checkFix(gps({ positioned: false, latitude: 0, longitude: 0 }), now, { ...limits, storeUnpositioned: true })).toBeNull();
  });

  it("drops 0,0 and out-of-range coordinates", () => {
    expect(checkFix(gps({ latitude: 0, longitude: 0 }), now, limits)).toBe("IMPOSSIBLE_COORDINATES");
    expect(checkFix(gps({ latitude: 91 }), now, limits)).toBe("IMPOSSIBLE_COORDINATES");
    expect(checkFix(gps({ longitude: -181 }), now, limits)).toBe("IMPOSSIBLE_COORDINATES");
  });

  it("drops a fix from the future (bad clock) and one older than the replay window", () => {
    expect(checkFix(gps({ fixTime: at(6) }), now, limits)).toBe("FUTURE");
    expect(checkFix(gps({ fixTime: at(4) }), now, limits)).toBeNull();
    expect(checkFix(gps({ fixTime: at(-8 * 24 * 60) }), now, limits)).toBe("TOO_OLD");
  });
});

describe("geo", () => {
  it("is about 111 km per degree of latitude (EDR's check)", () => {
    expect(Math.round(distanceM(9, 38.7, 10, 38.7) / 1000)).toBe(111);
  });

  it("calls 0,0 and NaN implausible", () => {
    expect(isPlausibleCoordinate(0, 0)).toBe(false);
    expect(isPlausibleCoordinate(Number.NaN, 1)).toBe(false);
    expect(isPlausibleCoordinate(9, 38.7)).toBe(true);
  });

  it("implies speed from distance over time, Infinity for two places at one time", () => {
    const a = { latitude: 9, longitude: 38.7, fixTime: at(0) };
    expect(Math.round(impliedSpeedKmh(a, { latitude: 10, longitude: 38.7, fixTime: at(60) }))).toBe(111);
    expect(impliedSpeedKmh(a, { latitude: 10, longitude: 38.7, fixTime: at(0) })).toBe(Infinity);
    expect(impliedSpeedKmh(a, { ...a })).toBe(0);
  });
});

describe("JumpDetector", () => {
  const addis = { latitude: 9.0108, longitude: 38.7613 };
  const adama = { latitude: 8.54, longitude: 39.27 }; // ~75 km away
  const direDawa = { latitude: 9.6, longitude: 41.85 }; // ~350 km away

  it("trusts the first fix and anything reachable from it", () => {
    const j = new JumpDetector(300);
    expect(j.check("d", { ...addis, fixTime: at(0) }).suspect).toBe(false);
    expect(j.check("d", { ...adama, fixTime: at(60) }).suspect).toBe(false);
  });

  it("flags a fix 350 km away a minute later, and keeps the anchor where it was", () => {
    const j = new JumpDetector(300);
    j.check("d", { ...addis, fixTime: at(0) });
    const r = j.check("d", { ...direDawa, fixTime: at(1) });
    expect(r.suspect).toBe(true);
    expect(r.impliedKmh).toBeGreaterThan(10_000);
    expect(j.check("d", { ...addis, fixTime: at(2) }).suspect).toBe(false);
  });

  it("re-anchors after three suspect fixes that agree with each other (the old anchor was the bad one)", () => {
    const j = new JumpDetector(300, 3);
    j.check("d", { ...addis, fixTime: at(0) });
    expect(j.check("d", { ...direDawa, fixTime: at(1) }).suspect).toBe(true);
    expect(j.check("d", { ...direDawa, fixTime: at(2) }).suspect).toBe(true);
    expect(j.check("d", { ...direDawa, fixTime: at(3) }).suspect).toBe(false);
    expect(j.check("d", { ...direDawa, fixTime: at(4) }).suspect).toBe(false);
  });

  it("starts from the host's last fix after a restart", () => {
    const j = new JumpDetector(300);
    j.seed("d", { ...addis, fixTime: at(0) });
    expect(j.check("d", { ...direDawa, fixTime: at(1) }).suspect).toBe(true);
  });

  it("does nothing when maxImpliedSpeedKmh is 0", () => {
    const j = new JumpDetector(0);
    j.check("d", { ...addis, fixTime: at(0) });
    expect(j.check("d", { ...direDawa, fixTime: at(1) })).toEqual({ suspect: false, impliedKmh: null });
  });

  it("does not move the anchor back for a replayed older fix", () => {
    const j = new JumpDetector(300);
    j.check("d", { ...addis, fixTime: at(60) });
    expect(j.check("d", { ...adama, fixTime: at(0) }).suspect).toBe(false); // 75 km in 60 min
    // Still anchored at Addis at +60: Dire Dawa at +61 is a jump.
    expect(j.check("d", { ...direDawa, fixTime: at(61) }).suspect).toBe(true);
  });
});

describe("RecentFixTimes", () => {
  it("remembers fix times per device, a bounded number of them", () => {
    const r = new RecentFixTimes(2);
    expect(r.seen("a", at(1))).toBe(false);
    expect(r.seen("a", at(1))).toBe(true);
    expect(r.seen("b", at(1))).toBe(false);
    r.seen("a", at(2));
    r.seen("a", at(3));
    expect(r.seen("a", at(1))).toBe(false); // pushed out
  });

  it("forgets one again when the host refused it", () => {
    const r = new RecentFixTimes();
    r.seen("a", at(1));
    r.unsee("a", at(1));
    expect(r.seen("a", at(1))).toBe(false);
  });
});
