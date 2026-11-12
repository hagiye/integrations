/**
 * The standalone example on a real Postgres, its GT06 listener on 127.0.0.1, driven by the device
 * simulator over real TCP.
 * Needs a throwaway database: GPS_TEST_DATABASE_URL=postgres://user:pass@host:5432/db.
 * Everything lives in its own schema, dropped and re-created on each run.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { GpsAlertService, GpsListener, GpsModuleOptions } from "@edr/gps-integration";
import { ExampleAppModule } from "../examples/standalone/app.module";
import { CreateExampleGps1790000000500 } from "../examples/standalone/create-gps.migration";
import * as dev from "./gt06-device";

const DATABASE_URL = process.env.GPS_TEST_DATABASE_URL;
const SCHEMA = "gps_pg_spec";
const IMEI = "359000000000001";
const IMEI_2 = "359000000000002";

interface Instance {
  app: INestApplication;
  port: number;
  alerts: GpsAlertService;
}

describe("GPS on Postgres (standalone example)", () => {
  let admin: DataSource;
  let main: Instance;
  const extra: Instance[] = [];
  let vehicleId: string;
  const trackers: dev.SimTracker[] = [];

  async function boot(options: GpsModuleOptions = {}): Promise<Instance> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ExampleAppModule.forRoot({
          databaseUrl: DATABASE_URL!,
          schema: SCHEMA,
          gps: { port: 0, bindAddress: "127.0.0.1", seenThrottleMs: 0, alerts: { scanEveryMs: 0 }, ...options },
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { app, port: app.get(GpsListener).address()!.port, alerts: app.get(GpsAlertService) };
  }

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    admin.query(sql.replace(/\b(gps_\w+|vehicles)\b/g, `"${SCHEMA}"."$1"`), params);

  async function tracker(port = main.port): Promise<dev.SimTracker> {
    const t = await dev.SimTracker.connect(port);
    trackers.push(t);
    return t;
  }

  async function loggedIn(imei = IMEI, port = main.port): Promise<dev.SimTracker> {
    const t = await tracker(port);
    t.send(dev.login(imei, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    return t;
  }

  // The listener remembers recent fix times, the last trusted fix and the newest fix per device
  // across tests (as a real process would). Each test therefore gets its own time window, later
  // than the one before: starting six days back (inside the 7-day replay window), six hours apart.
  // The alert tests come last and use the real clock, because alerts need a fresh fix.
  const start = Math.floor(Date.now() / 1000) * 1000 - 6 * 24 * 3_600_000;
  let testNo = 0;
  let base = start;
  let lastRealBase = 0;
  const useRealClock = () => {
    // Strictly later than the previous real-clock test, so no fix time repeats.
    base = Math.max(Math.floor(Date.now() / 1000) * 1000, lastRealBase + 1000);
    lastRealBase = base;
  };
  const fix = (secondsAgo: number, over: Partial<dev.Fix> = {}): dev.Fix => ({
    time: new Date(base - secondsAgo * 1000),
    lat: 9.0108,
    lng: 38.7613,
    speed: 40,
    ...over,
  });

  const positions = (imei = IMEI) =>
    q<{ fix_time: Date; lat: string; speed: string; suspect: boolean; replay: boolean; vehicle_id: string | null }>(
      `SELECT p.fix_time, p.lat, p.speed, p.suspect, p.replay, p.vehicle_id FROM gps_positions p
         JOIN gps_devices d ON d.id = p.device_id WHERE d.imei = $1 ORDER BY p.fix_time`,
      [imei],
    );
  const device = async (imei = IMEI) =>
    (await q<{ last_lat: string | null; last_fix_at: Date | null; last_seen_at: Date | null; status: string; voltage_level: number | null }>(
      `SELECT last_lat, last_fix_at, last_seen_at, status, voltage_level FROM gps_devices WHERE imei = $1`,
      [imei],
    ))[0];
  const wipe = async () => {
    await q(`DELETE FROM gps_positions`);
    await q(`DELETE FROM gps_alarms`);
    await q(`DELETE FROM gps_rejections`);
    await q(`DELETE FROM gps_alerts`);
    await q(`DELETE FROM gps_notifications`);
    await q(`DELETE FROM gps_geofences`);
    await q(`UPDATE gps_devices SET last_lat = NULL, last_lng = NULL, last_speed = NULL, last_fix_at = NULL, last_seen_at = NULL, deleted_at = NULL`);
    await q(`UPDATE vehicles SET on_trip = true`);
  };

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error("Set GPS_TEST_DATABASE_URL to a throwaway Postgres database");
    admin = new DataSource({ type: "postgres", url: DATABASE_URL });
    await admin.initialize();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    main = await boot();
    const [v] = await q<{ id: string }>(`INSERT INTO vehicles (plate, on_trip) VALUES ('ET-3-12345', true) RETURNING id`);
    vehicleId = v.id;
    const res = await request(main.app.getHttpServer()).post("/gps/devices").send({ imei: IMEI, name: "Truck 03", vehicleId }).expect(201);
    expect(res.body).toMatchObject({ imei: IMEI, vehicleId });
    await request(main.app.getHttpServer()).post("/gps/devices").send({ imei: IMEI_2 }).expect(201);
  });

  afterEach(async () => {
    for (const t of trackers.splice(0)) t.socket.destroy();
    await dev.sleep(50);
  });

  afterAll(async () => {
    for (const i of extra) await i.app.close();
    if (main) await main.app.close();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    testNo += 1;
    base = start + testNo * 6 * 3_600_000;
    await wipe();
  });

  it("runs its migration twice without harm, and refuses a bad IMEI at registration", async () => {
    // The example's own DataSource carries the schema; the migration ran at boot, run it again.
    const runner = main.app.get(DataSource).createQueryRunner();
    try {
      await new CreateExampleGps1790000000500().up(runner);
    } finally {
      await runner.release();
    }
    await request(main.app.getHttpServer()).post("/gps/devices").send({ imei: "35900000000000x" }).expect(400);
  });

  it("stores a logged-in tracker's fixes, moves the live position, copies the vehicle, marks it online", async () => {
    const t = await loggedIn();
    t.send(dev.location(fix(30), 2), dev.location(fix(20), 3), dev.heartbeat(4, { voltage: 5 }));
    expect(await t.waitAck(0x13, 4)).toBe(true);
    expect(await dev.until(async () => (await positions()).length === 2)).toBe(true);
    const rows = await positions();
    expect(rows.every((r) => r.vehicle_id === vehicleId)).toBe(true);
    const d = await device();
    expect(new Date(d.last_fix_at!).getTime()).toBe(base - 20_000);
    expect(d.status).toBe("ONLINE");
    expect(d.voltage_level).toBe(5);
    expect(d.last_seen_at).not.toBeNull();

    const latest = await request(main.app.getHttpServer()).get("/gps/positions/latest").expect(200);
    expect(latest.body).toEqual([expect.objectContaining({ imei: IMEI, online: true })]);
    const trail = await request(main.app.getHttpServer()).get(`/gps/positions/${vehicleId}/history`).expect(200);
    expect(trail.body).toHaveLength(2);
  });

  it("refuses an unregistered IMEI: no ack, socket closed, nothing created, rejection recorded", async () => {
    const t = await tracker();
    t.send(dev.login("359999999999999", 1), dev.location(fix(5), 2));
    expect(await t.waitClosed()).toBe(true);
    expect(t.bytesReceived.length).toBe(0);
    expect(await q(`SELECT 1 FROM gps_devices WHERE imei = '359999999999999'`)).toHaveLength(0);
    expect(await dev.until(async () => (await q(`SELECT 1 FROM gps_rejections WHERE reason = 'UNKNOWN_DEVICE'`)).length === 1)).toBe(true);
  });

  it("refuses a deleted tracker until it is registered again", async () => {
    await q(`UPDATE gps_devices SET deleted_at = now() WHERE imei = $1`, [IMEI]);
    const t = await tracker();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitClosed()).toBe(true);
    await request(main.app.getHttpServer()).post("/gps/devices").send({ imei: IMEI, vehicleId }).expect(201);
    await loggedIn();
  });

  it("drops a frame with a bad CRC and keeps the connection", async () => {
    const t = await loggedIn();
    const bad = dev.location(fix(10), 2);
    bad[bad.length - 4] ^= 0xff;
    t.send(bad, dev.location(fix(9), 3), dev.heartbeat(4));
    expect(await t.waitAck(0x13, 4)).toBe(true);
    expect((await positions()).map((r) => new Date(r.fix_time).getTime())).toEqual([base - 9000]);
    expect(t.closed).toBe(false);
  });

  it("stores nothing sent before the login", async () => {
    const t = await tracker();
    t.send(dev.location(fix(10), 1));
    await dev.sleep(100);
    t.send(dev.login(IMEI, 2));
    expect(await t.waitAck(0x01, 2)).toBe(true);
    await dev.sleep(100);
    expect(await positions()).toHaveLength(0);
  });

  it("de-duplicates resent fixes: in one read, across reads, and across a restart (the unique key)", async () => {
    const t = await loggedIn();
    t.send(dev.location(fix(10), 2), dev.location(fix(10), 2));
    t.send(dev.location(fix(10), 2));
    t.send(dev.heartbeat(3));
    expect(await t.waitAck(0x13, 3)).toBe(true);
    expect(await positions()).toHaveLength(1);

    // A second instance has no memory of it: the database's unique key decides.
    const other = await boot();
    extra.push(other);
    const t2 = await loggedIn(IMEI, other.port);
    t2.send(dev.location(fix(10), 5), dev.location(fix(8), 6), dev.heartbeat(7));
    expect(await t2.waitAck(0x13, 7)).toBe(true);
    expect(await dev.until(async () => (await positions()).length === 2)).toBe(true);
    await dev.sleep(100);
    expect(await positions()).toHaveLength(2);
  });

  it("reassembles frames split across TCP reads and splits reads holding several frames", async () => {
    const t = await tracker();
    const all = Buffer.concat([dev.login(IMEI, 1), dev.location(fix(30), 2), dev.location(fix(20), 3), dev.heartbeat(4)]);
    // Cut inside the login, inside a location, and between the two locations.
    await t.sendInPieces(all, [7, 25, 54, 60]);
    expect(await t.waitAck(0x01, 1)).toBe(true);
    expect(await t.waitAck(0x13, 4)).toBe(true);
    expect(await dev.until(async () => (await positions()).length === 2)).toBe(true);
  });

  it("keeps the live position on the newest fix when old ones are replayed, and marks the replays", async () => {
    const t = await loggedIn();
    t.send(dev.location(fix(10), 2));
    t.send(dev.location(fix(600, { lat: 8.9 }), 3), dev.locationExt(fix(500, { lat: 8.95 }), 4, { reupload: true }), dev.heartbeat(5));
    expect(await t.waitAck(0x13, 5)).toBe(true);
    expect(await dev.until(async () => (await positions()).length === 3)).toBe(true);
    const d = await device();
    expect(new Date(d.last_fix_at!).getTime()).toBe(base - 10_000);
    expect((await positions()).map((r) => r.replay)).toEqual([true, true, false]);
  });

  it("stores a jump as suspect and leaves the live position where it was", async () => {
    const t = await loggedIn();
    t.send(dev.location(fix(120), 2), dev.location(fix(60, { lat: 9.6, lng: 41.85 }), 3), dev.heartbeat(4));
    expect(await t.waitAck(0x13, 4)).toBe(true);
    expect((await positions()).map((r) => r.suspect)).toEqual([false, true]);
    expect(Number((await device()).last_lat)).toBeCloseTo(9.0108, 4);
    const trail = await request(main.app.getHttpServer()).get(`/gps/positions/${vehicleId}/history`).expect(200);
    expect(trail.body).toHaveLength(1);
  });

  it("lets a second connection for the same IMEI replace the first, and keeps one device", async () => {
    const first = await loggedIn();
    first.send(dev.location(fix(30), 2), dev.heartbeat(3));
    expect(await first.waitAck(0x13, 3)).toBe(true);
    const second = await loggedIn();
    expect(await first.waitClosed()).toBe(true);
    second.send(dev.location(fix(20), 2), dev.heartbeat(3));
    expect(await second.waitAck(0x13, 3)).toBe(true);
    expect(await positions()).toHaveLength(2);
    expect(await q(`SELECT 1 FROM gps_devices WHERE imei = $1`, [IMEI])).toHaveLength(1);
    expect((await device()).status).toBe("ONLINE"); // REPLACED does not mark it offline
  });

  it("stores a batch of 200 fixes sent at once", async () => {
    const t = await loggedIn();
    const frames = Array.from({ length: 200 }, (_, i) => dev.location(fix(4000 - i * 10, { lat: 9 + i * 0.0001 }), 10 + i));
    t.send(...frames, dev.heartbeat(999));
    expect(await t.waitAck(0x13, 999, 5000)).toBe(true);
    expect(await positions()).toHaveLength(200);
    expect(new Date((await device()).last_fix_at!).getTime()).toBe(base - (4000 - 199 * 10) * 1000);
  });

  it("acks an SOS alarm after storing it and its fix", async () => {
    const t = await loggedIn();
    t.send(dev.alarm(fix(5), 2, { alarm: 0x01 }));
    expect(await t.waitAck(0x16, 2)).toBe(true);
    const alarms = await q<{ alarm: string; fix_time: Date | null }>(`SELECT alarm, fix_time FROM gps_alarms`);
    expect(alarms).toEqual([{ alarm: "SOS", fix_time: new Date(base - 5000) }]);
    t.send(dev.alarm(null, 3, { alarm: 0x01 }));
    expect(await t.waitAck(0x16, 3)).toBe(true);
    expect(await q(`SELECT 1 FROM gps_alarms WHERE position_dropped = 'NO_GPS_BLOCK'`)).toHaveLength(1);
  });

  it("raises an overspeed once, resolves it, and reopens it quietly within the cooldown", async () => {
    useRealClock();
    const t = await loggedIn();
    t.send(dev.location(fix(30, { speed: 100 }), 2), dev.heartbeat(3));
    expect(await t.waitAck(0x13, 3)).toBe(true);
    const now = new Date();
    expect(await main.alerts.scan(now)).toMatchObject({ opened: 1, notified: 1 });
    expect(await main.alerts.scan(new Date(now.getTime() + 60_000))).toMatchObject({ opened: 0, touched: 1 });

    t.send(dev.location(fix(20, { speed: 50 }), 4), dev.heartbeat(5));
    expect(await t.waitAck(0x13, 5)).toBe(true);
    expect(await main.alerts.scan(new Date(now.getTime() + 120_000))).toMatchObject({ resolved: 1 });

    t.send(dev.location(fix(10, { speed: 105 }), 6), dev.heartbeat(7));
    expect(await t.waitAck(0x13, 7)).toBe(true);
    expect(await main.alerts.scan(new Date(now.getTime() + 180_000))).toMatchObject({ opened: 1, notified: 0 });
    expect(await q(`SELECT 1 FROM gps_alerts WHERE kind = 'OVERSPEED'`)).toHaveLength(2);
    const notes = await q<{ title: string; body: string }>(`SELECT title, body FROM gps_notifications`);
    expect(notes).toEqual([{ title: "Overspeed: ET-3-12345", body: "ET-3-12345 is doing 100 km/h (limit 80)." }]);
  });

  it("raises a KEEP_IN geofence alert when the truck leaves the area, and resolves it on return", async () => {
    useRealClock();
    await q(`INSERT INTO gps_geofences (name, kind, lat, lng, radius_m) VALUES ('Addis corridor', 'KEEP_IN', 9.0108, 38.7613, 3000)`);
    const t = await loggedIn();
    t.send(dev.location(fix(600), 2), dev.heartbeat(3));
    expect(await t.waitAck(0x13, 3)).toBe(true);
    expect((await main.alerts.scan()).opened).toBe(0);
    // ~5.5 km north five minutes later: outside the corridor, and a believable 66 km/h.
    t.send(dev.location(fix(300, { lat: 9.06 }), 4), dev.heartbeat(5));
    expect(await t.waitAck(0x13, 5)).toBe(true);
    expect(await main.alerts.scan()).toMatchObject({ opened: 1, notified: 1 });
    const [note] = await q<{ body: string }>(`SELECT body FROM gps_notifications`);
    expect(note.body).toBe("ET-3-12345 left the allowed area Addis corridor.");
    t.send(dev.location(fix(10), 6), dev.heartbeat(7));
    expect(await t.waitAck(0x13, 7)).toBe(true);
    expect((await main.alerts.scan()).resolved).toBe(1);
  });

  it("opens one alert when two instances scan at the same moment (the partial unique index)", async () => {
    useRealClock();
    const t = await loggedIn();
    t.send(dev.location(fix(30, { speed: 120 }), 2), dev.heartbeat(3));
    expect(await t.waitAck(0x13, 3)).toBe(true);
    const other = extra[0] ?? (await boot());
    if (!extra.length) extra.push(other);
    const now = new Date();
    const results = await Promise.all([main.alerts.scan(now), other.alerts.scan(now), main.alerts.scan(now)]);
    expect(results.reduce((n, r) => n + r.opened, 0)).toBe(1);
    expect(await q(`SELECT 1 FROM gps_alerts WHERE resolved_at IS NULL`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM gps_notifications`)).toHaveLength(1);
  });
});
