import { FakeGpsHost, MinimalGpsHost } from "../test/fakes";
import { GpsAlertService } from "./gps.alerts.service";
import type { GpsVehicleSnapshot } from "./gps.alerts.rules";
import { GpsModuleOptions, resolveGpsOptions } from "./gps.options";

const t0 = new Date("2026-10-20T12:00:00Z");
const minutes = (m: number) => new Date(t0.getTime() + m * 60_000);

function vehicle(at: Date, speed: number, over: Partial<GpsVehicleSnapshot> = {}): GpsVehicleSnapshot {
  return {
    vehicleId: "v1",
    deviceId: "d1",
    label: "ET-1",
    onTrip: true,
    lastSeenAt: at,
    lastFixAt: at,
    lastLat: 9.0,
    lastLng: 38.7,
    lastSpeedKmh: speed,
    recentFixes: [],
    ...over,
  };
}

function setup(alerts: GpsModuleOptions["alerts"] = {}) {
  const host = new FakeGpsHost();
  const service = new GpsAlertService(host, resolveGpsOptions({ listen: false, alerts: { scanEveryMs: 0, ...alerts } }));
  return { host, service };
}

describe("GpsAlertService", () => {
  it("opens and notifies an overspeed once, touches it while it lasts, resolves it after", async () => {
    const { host, service } = setup();
    host.vehicles = [vehicle(minutes(0), 95)];
    expect(await service.scan(minutes(0))).toMatchObject({ opened: 1, notified: 1 });
    host.vehicles = [vehicle(minutes(1), 110)];
    expect(await service.scan(minutes(1))).toMatchObject({ opened: 0, touched: 1 });
    expect(host.alerts[0].details.speedKmh).toBe(110);
    host.vehicles = [vehicle(minutes(2), 60)];
    expect(await service.scan(minutes(2))).toMatchObject({ resolved: 1 });
    expect(host.notified).toHaveLength(1);
    expect(host.notified[0]).toMatchObject({ kind: "OVERSPEED", title: "Overspeed: ET-1", label: "ET-1" });
  });

  it("does not notify again when the same overspeed comes back within the cooldown", async () => {
    const { host, service } = setup({ cooldownMinutes: 15 });
    for (const [m, speed] of [[0, 95], [1, 60], [2, 95], [3, 60], [20, 95]] as const) {
      host.vehicles = [vehicle(minutes(m), speed)];
      await service.scan(minutes(m));
    }
    expect(host.alerts.filter((a) => a.kind === "OVERSPEED")).toHaveLength(3);
    expect(host.notified).toHaveLength(2); // minute 0 and minute 20
  });

  it("notifies every time with cooldown 0, as EDR", async () => {
    const { host, service } = setup({ cooldownMinutes: 0 });
    for (const [m, speed] of [[0, 95], [1, 60], [2, 95]] as const) {
      host.vehicles = [vehicle(minutes(m), speed)];
      await service.scan(minutes(m));
    }
    expect(host.notified).toHaveLength(2);
  });

  it("raises a KEEP_IN geofence alert when the vehicle leaves, and resolves it on return", async () => {
    const { host, service } = setup();
    host.geofences = [{ id: "g1", name: "Corridor", kind: "KEEP_IN", lat: 9.0, lng: 38.7, radiusM: 5000 }];
    host.vehicles = [vehicle(minutes(0), 40)];
    await service.scan(minutes(0));
    host.vehicles = [vehicle(minutes(1), 40, { lastLat: 9.2 })];
    await service.scan(minutes(1));
    expect(host.alerts).toHaveLength(1);
    expect(host.notified[0].body).toBe("ET-1 left the allowed area Corridor.");
    host.vehicles = [vehicle(minutes(2), 40)];
    await service.scan(minutes(2));
    expect(host.alerts[0].resolvedAt).toEqual(minutes(2));
  });

  it("uses the host's thresholds when it has them", async () => {
    const { host, service } = setup();
    const load = host.loadAlertInputs.bind(host);
    host.loadAlertInputs = async (q) => ({ ...(await load(q)), thresholds: { overspeedKmh: 120, idleMinutes: 30, offlineMinutes: 15 } });
    host.vehicles = [vehicle(minutes(0), 110)];
    expect((await service.scan(minutes(0))).opened).toBe(0);
  });

  it("counts an alert another scan opened first as not opened, and keeps going when notifying fails", async () => {
    const { host, service } = setup();
    host.vehicles = [vehicle(minutes(0), 95), vehicle(minutes(0), 95, { vehicleId: "v2" })];
    const open = host.openAlert.bind(host);
    let first = true;
    host.openAlert = async (a) => {
      if (first) {
        first = false;
        return null;
      }
      return open(a);
    };
    host.notifyAlert = async () => {
      throw new Error("inbox down");
    };
    expect(await service.scan(minutes(0))).toMatchObject({ opened: 1, notified: 0 });
  });

  it("runs one scan at a time", async () => {
    const { host, service } = setup();
    const load = host.loadAlertInputs.bind(host);
    let release!: () => void;
    host.loadAlertInputs = async (q) => {
      await new Promise<void>((r) => (release = r));
      return load(q);
    };
    const first = service.scan(minutes(0));
    expect(await service.scan(minutes(0))).toMatchObject({ skipped: true });
    release();
    expect(await first).toMatchObject({ skipped: false });
  });

  it("is inactive without the alert methods, and scan says why", async () => {
    const service = new GpsAlertService(new MinimalGpsHost(), resolveGpsOptions({ listen: false }));
    expect(service.active).toBe(false);
    await expect(service.scan()).rejects.toMatchObject({ kind: "CONFIG", details: { code: "NOT_ALERT_HOST" } });
  });

  it("is inactive when switched off, and start() then does nothing", () => {
    const { service } = setup({ enabled: false, scanEveryMs: 1000 });
    expect(service.active).toBe(false);
    service.start();
    service.stop();
  });

  it("scans on its own timer", async () => {
    jest.useFakeTimers();
    try {
      const { host, service } = setup({ scanEveryMs: 1000 });
      host.vehicles = [vehicle(new Date(), 95)];
      service.start();
      await jest.advanceTimersByTimeAsync(1000);
      expect(host.alerts).toHaveLength(1);
      service.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
