import { FakeGpsHost } from "../test/fakes";
import type { Gt06Gps, Gt06Status } from "./gt06.codec";
import { GpsAlarmPacket, GpsIngestService, GpsLocationPacket } from "./gps.ingest";
import { resolveGpsOptions } from "./gps.options";
import type { GpsConnectionInfo } from "./gps.types";

const now = new Date("2026-10-20T12:00:00Z");
const conn: GpsConnectionInfo = { connectionId: "c1", remoteAddress: "10.0.0.5", remotePort: 4000, connectedAt: now };
const at = (s: number) => new Date(now.getTime() + s * 1000);
const gps = (s: number, over: Partial<Gt06Gps> = {}): Gt06Gps => ({
  fixTime: at(s),
  satellites: 9,
  latitude: 9.0108,
  longitude: 38.7613,
  speedKmh: 40,
  course: 90,
  positioned: true,
  differential: false,
  ...over,
});
const loc = (s: number, over: Partial<Gt06Gps> = {}, extra: Partial<GpsLocationPacket> = {}): GpsLocationPacket => ({
  type: "location",
  protocol: 0x12,
  serial: 1,
  gps: gps(s, over),
  lbs: null,
  ...extra,
});
const status: Gt06Status = {
  terminalInfo: 0x46,
  oilCut: false,
  gpsTracking: true,
  terminalAlarm: "NORMAL",
  charging: true,
  accOn: true,
  defenseOn: false,
  voltageLevel: 5,
  gsmLevel: 3,
  alarmCode: 1,
  language: 2,
};

function setup(options = {}) {
  const host = new FakeGpsHost();
  const device = host.register("359000000000001", { vehicleId: "veh-1" });
  const ingest = new GpsIngestService(host, resolveGpsOptions({ listen: false, ...options }));
  ingest.now = () => now;
  return { host, device, ingest };
}

describe("GpsIngestService", () => {
  it("stores a batch, copies the vehicle, and names the newest trusted fix as latest", async () => {
    const { host, device, ingest } = setup();
    const report = await ingest.locations(device, conn, [loc(-30), loc(-20), loc(-10)]);
    expect(report).toEqual({ stored: 3, suspect: 0, dropped: {} });
    expect(host.batches).toHaveLength(1);
    expect(host.batches[0].positions.every((p) => p.vehicleId === "veh-1" && p.source === "LOCATION")).toBe(true);
    expect(host.batches[0].latest?.fixTime).toEqual(at(-10));
  });

  it("drops no-fix, 0,0, future and duplicate fixes, and still marks the device seen", async () => {
    const { host, device, ingest } = setup();
    const report = await ingest.locations(device, conn, [
      loc(-30, { positioned: false, latitude: 0, longitude: 0 }),
      loc(-25, { latitude: 0, longitude: 0 }),
      loc(600),
      loc(-20),
      loc(-20),
    ]);
    expect(report.dropped).toEqual({ NO_FIX: 1, IMPOSSIBLE_COORDINATES: 1, FUTURE: 1, DUPLICATE: 1 });
    expect(host.positions).toHaveLength(1);
    expect(host.seen).toHaveLength(1);
  });

  it("calls savePositions not at all when everything was dropped, but marks seen", async () => {
    const { host, device, ingest } = setup();
    await ingest.locations(device, conn, [loc(-30, { positioned: false, latitude: 0, longitude: 0 })]);
    expect(host.batches).toHaveLength(0);
    expect(host.seen).toHaveLength(1);
  });

  it("stores a jump as suspect and leaves latest on the trusted fix", async () => {
    const { host, device, ingest } = setup();
    await ingest.locations(device, conn, [loc(-120), loc(-60, { latitude: 9.6, longitude: 41.85 })]);
    const [ok, jump] = host.batches[0].positions;
    expect(ok.suspect).toBe(false);
    expect(jump.suspect).toBe(true);
    expect(jump.impliedSpeedKmh).toBeGreaterThan(10_000);
    expect(host.batches[0].latest?.fixTime).toEqual(at(-120));
  });

  it("seeds jump detection from the host's last fix", async () => {
    const { host, ingest } = setup();
    const device = host.register("359000000000002", { lastFix: { latitude: 9.6, longitude: 41.85, fixTime: at(-60) } });
    await ingest.login(device.imei, conn);
    await ingest.locations(device, conn, [loc(-30)]);
    expect(host.positions[0].suspect).toBe(true);
  });

  it("marks replays: the 0x22 flag, or older than a fix already taken", async () => {
    const { host, device, ingest } = setup();
    await ingest.locations(device, conn, [loc(-10), loc(-300), loc(-5, {}, { protocol: 0x22, reupload: true })]);
    expect(host.positions.map((p) => p.replay)).toEqual([false, true, true]);
  });

  it("lets a fix through again when the host failed to store it", async () => {
    const { host, device, ingest } = setup();
    host.failSaves = 1;
    await expect(ingest.locations(device, conn, [loc(-10)])).rejects.toThrow("database down");
    await ingest.locations(device, conn, [loc(-10)]);
    expect(host.positions).toHaveLength(1);
  });

  it("throttles markSeen per device", async () => {
    const { host, device, ingest } = setup({ seenThrottleMs: 30_000 });
    await ingest.heartbeat(device, conn, status);
    await ingest.heartbeat(device, conn, status);
    ingest.now = () => at(31);
    await ingest.heartbeat(device, conn, status);
    expect(host.seen).toHaveLength(2);
    expect(host.statuses).toHaveLength(3);
  });

  describe("alarms", () => {
    const alarm = (over: Partial<GpsAlarmPacket> = {}): GpsAlarmPacket => ({
      type: "alarm",
      protocol: 0x16,
      serial: 9,
      gps: gps(-5),
      lbs: null,
      status,
      alarm: "SOS",
      ...over,
    });

    it("stores the alarm's fix, then calls onAlarm with it, then onStatus", async () => {
      const { host, device, ingest } = setup();
      await ingest.alarm(device, conn, alarm());
      expect(host.positions[0]).toMatchObject({ source: "ALARM", alarm: "SOS" });
      expect(host.alarms[0]).toMatchObject({ alarm: "SOS", alarmCode: 1, positionDropped: null });
      expect(host.alarms[0].position?.fixTime).toEqual(at(-5));
      expect(host.statuses[0].source).toBe("ALARM");
    });

    it("delivers an alarm without a GPS block", async () => {
      const { host, device, ingest } = setup();
      await ingest.alarm(device, conn, alarm({ gps: null, gpsProblem: "BAD_DATE" }));
      expect(host.alarms[0]).toMatchObject({ position: null, positionDropped: "NO_GPS_BLOCK" });
    });

    it("does not deliver a resent alarm twice, but does retry one whose onAlarm failed", async () => {
      const { host, device, ingest } = setup();
      await ingest.alarm(device, conn, alarm());
      await ingest.alarm(device, conn, alarm());
      expect(host.alarms).toHaveLength(1);

      host.failAlarms = 1;
      await expect(ingest.alarm(device, conn, alarm({ serial: 10, gps: gps(-4) }))).rejects.toThrow();
      await ingest.alarm(device, conn, alarm({ serial: 10, gps: gps(-4) }));
      expect(host.alarms).toHaveLength(2);
      expect(host.alarms[1].positionDropped).toBe("DUPLICATE"); // its fix was stored the first time
    });
  });

  it("never throws from rejected(), even when the host does", async () => {
    const { host, ingest } = setup();
    host.onRejected = async () => {
      throw new Error("audit table gone");
    };
    await expect(ingest.rejected({ reason: "UNKNOWN_DEVICE", connection: conn, imei: "1", at: now })).resolves.toBeUndefined();
  });
});
