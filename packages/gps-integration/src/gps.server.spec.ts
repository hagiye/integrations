import { FakeGpsHost } from "../test/fakes";
import * as dev from "../test/gt06-device";
import { GpsIngestService } from "./gps.ingest";
import { GpsModuleOptions, resolveGpsOptions } from "./gps.options";
import { Gt06TcpServer } from "./gps.server";

const IMEI = "359000000000001";
const OTHER = "359000000000002";

async function start(options: GpsModuleOptions = {}) {
  const host = new FakeGpsHost();
  host.register(IMEI, { vehicleId: "veh-1" });
  host.register(OTHER);
  const resolved = resolveGpsOptions({ port: 0, bindAddress: "127.0.0.1", seenThrottleMs: 0, ...options });
  const ingest = new GpsIngestService(host, resolved);
  const server = new Gt06TcpServer(ingest, resolved);
  const { port } = await server.listen();
  const trackers: dev.SimTracker[] = [];
  const connect = async () => {
    const t = await dev.SimTracker.connect(port);
    trackers.push(t);
    return t;
  };
  const stop = async () => {
    for (const t of trackers) t.socket.destroy();
    await server.close(1000);
  };
  return { host, server, port, connect, stop };
}

const fix = (secondsAgo: number, over: Partial<dev.Fix> = {}): dev.Fix => ({
  time: new Date(Math.floor(Date.now() / 1000) * 1000 - secondsAgo * 1000),
  lat: 9.0108,
  lng: 38.7613,
  speed: 40,
  ...over,
});

describe("Gt06TcpServer", () => {
  let env: Awaited<ReturnType<typeof start>> | undefined;
  afterEach(async () => {
    await env?.stop();
    env = undefined;
  });

  it("acks a known device's login, stores its fixes and acks heartbeats", async () => {
    env = await start();
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    t.send(dev.location(fix(30), 2), dev.location(fix(20), 3), dev.heartbeat(4));
    expect(await t.waitAck(0x13, 4)).toBe(true);
    expect(await dev.until(() => env!.host.positions.length === 2)).toBe(true);
    expect(env.host.connects[0].device.imei).toBe(IMEI);
    expect(env.host.statuses).toHaveLength(1);
    expect(env.host.positions[0].vehicleId).toBe("veh-1");
  });

  it("refuses an unknown IMEI: no ack, socket closed, rejection reported (EDR auto-registered it)", async () => {
    env = await start();
    const t = await env.connect();
    t.send(dev.login("359999999999999", 1));
    expect(await t.waitClosed()).toBe(true);
    expect(t.bytesReceived.length).toBe(0);
    expect(env.host.rejections.map((r) => r.reason)).toEqual(["UNKNOWN_DEVICE"]);
  });

  it("drops everything sent before the login, and does not ack it", async () => {
    env = await start();
    const t = await env.connect();
    t.send(dev.location(fix(10), 1), dev.heartbeat(2));
    await dev.sleep(150);
    expect(t.bytesReceived.length).toBe(0);
    t.send(dev.login(IMEI, 3));
    expect(await t.waitAck(0x01, 3)).toBe(true);
    await dev.sleep(100);
    expect(env.host.positions).toHaveLength(0);
  });

  it("survives EDR's crash frame and keeps serving", async () => {
    env = await start();
    const bad = await env.connect();
    bad.send(dev.frame(0x12, Buffer.alloc(2), 1));
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
  });

  it("closes a connection that changes IMEI, and keeps nothing it sent after", async () => {
    env = await start();
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    t.send(dev.login(OTHER, 2), dev.location(fix(5), 3));
    expect(await t.waitClosed()).toBe(true);
    expect(env.host.rejections.map((r) => r.reason)).toEqual(["IMEI_CHANGED"]);
    expect(env.host.positions).toHaveLength(0);
  });

  it("re-acks a repeated login on the same connection", async () => {
    env = await start();
    const t = await env.connect();
    t.send(dev.login(IMEI, 1), dev.login(IMEI, 2));
    expect(await t.waitAck(0x01, 2)).toBe(true);
    expect(env.host.connects).toHaveLength(1);
  });

  it("lets a newer connection for the same IMEI replace the older one", async () => {
    env = await start();
    const first = await env.connect();
    first.send(dev.login(IMEI, 1));
    expect(await first.waitAck(0x01, 1)).toBe(true);
    const second = await env.connect();
    second.send(dev.login(IMEI, 1));
    expect(await second.waitAck(0x01, 1)).toBe(true);
    expect(await first.waitClosed()).toBe(true);
    expect(await dev.until(() => env!.host.disconnects.some((d) => d.reason === "REPLACED"))).toBe(true);
    second.send(dev.location(fix(3), 2));
    expect(await dev.until(() => env!.host.positions.length === 1)).toBe(true);
    expect(env.server.stats()).toEqual({ connections: 1, loggedIn: 1 });
  });

  it("closes a connection that never logs in", async () => {
    env = await start({ loginTimeoutMs: 150 });
    const t = await env.connect();
    expect(await t.waitClosed(1500)).toBe(true);
    expect(env.host.rejections.map((r) => r.reason)).toEqual(["LOGIN_TIMEOUT"]);
  });

  it("closes an idle connection and reports the disconnect", async () => {
    env = await start({ idleTimeoutMs: 1000 });
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    expect(await t.waitClosed(3000)).toBe(true);
    expect(await dev.until(() => env!.host.disconnects.some((d) => d.reason === "IDLE"))).toBe(true);
  });

  it("refuses sources outside allowedSources", async () => {
    env = await start({ allowedSources: ["10.0.0.0/8"] });
    const t = await env.connect();
    expect(await t.waitClosed()).toBe(true);
    expect(env.host.rejections.map((r) => r.reason)).toEqual(["SOURCE_NOT_ALLOWED"]);
  });

  it("caps connections per IP and in all", async () => {
    env = await start({ maxConnectionsPerIp: 2 });
    const a = await env.connect();
    const b = await env.connect();
    const c = await env.connect();
    expect(await c.waitClosed()).toBe(true);
    expect(a.closed || b.closed).toBe(false);
    expect(env.host.rejections.map((r) => r.reason)).toEqual(["TOO_MANY_CONNECTIONS"]);
  });

  it("closes a connection after too many bad frames", async () => {
    env = await start({ maxBadFrames: 3 });
    const t = await env.connect();
    const bad = dev.login(IMEI, 1);
    bad[bad.length - 4] ^= 0xff;
    for (let i = 0; i < 5; i++) t.send(bad);
    expect(await t.waitClosed()).toBe(true);
    expect(env.host.rejections.map((r) => r.reason)).toEqual(["TOO_MANY_BAD_FRAMES"]);
  });

  it("drops packets over maxPacketsPerMinute and closes at twice that", async () => {
    env = await start({ maxPacketsPerMinute: 5 });
    const t = await env.connect();
    t.send(dev.login(IMEI, 1), ...Array.from({ length: 6 }, (_, i) => dev.location(fix(60 - i), 2 + i)));
    expect(await dev.until(() => env!.host.positions.length === 4)).toBe(true);
    await dev.sleep(100);
    expect(env.host.positions).toHaveLength(4); // login + 4 fixes = 5 frames
    t.send(...Array.from({ length: 6 }, (_, i) => dev.heartbeat(20 + i)));
    expect(await t.waitClosed()).toBe(true);
    expect(env.host.rejections.map((r) => r.reason)).toContain("RATE_LIMITED");
  });

  it("pauses a socket while the host is behind, and loses nothing", async () => {
    env = await start({ maxPendingPackets: 4, maxPacketsPerMinute: 1000 });
    env.host.saveDelayMs = 40;
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    for (let i = 0; i < 20; i++) t.send(dev.location(fix(200 - i), 10 + i));
    expect(await dev.until(() => env!.host.positions.length === 20, 5000)).toBe(true);
  });

  it("does not ack a heartbeat the host failed on, then acks the resend", async () => {
    env = await start();
    let fail = 1;
    env.host.onStatus = async () => {
      if (fail-- > 0) throw new Error("db down");
    };
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    t.send(dev.heartbeat(2));
    expect(await t.waitAck(0x13, 2, 300)).toBe(false);
    t.send(dev.heartbeat(3));
    expect(await t.waitAck(0x13, 3)).toBe(true);
  });

  it("closes without an ack when findDevice throws, so the tracker logs in again", async () => {
    env = await start();
    env.host.failFind = 1;
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitClosed()).toBe(true);
    expect(t.bytesReceived.length).toBe(0);
    expect(env.host.rejections.map((r) => r.reason)).toEqual(["HOST_ERROR"]);
  });

  it("acks 0x16 and 0x26 alarms, not locations", async () => {
    env = await start();
    const t = await env.connect();
    t.send(dev.login(IMEI, 1), dev.location(fix(9), 2), dev.alarm(fix(8), 3, { alarm: 1 }), dev.alarm(fix(7), 4, { alarm: 2 }, 0x26));
    expect(await t.waitAck(0x16, 3)).toBe(true);
    expect(await t.waitAck(0x26, 4)).toBe(true);
    expect(t.bytesReceived.includes(dev.ack(0x12, 2))).toBe(false);
    expect(env.host.alarms.map((a) => a.alarm)).toEqual(["SOS", "POWER_CUT"]);
  });

  it("stores what was queued on shutdown and reports the disconnects", async () => {
    env = await start();
    env.host.saveDelayMs = 50;
    const t = await env.connect();
    t.send(dev.login(IMEI, 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    t.send(dev.location(fix(5), 2));
    await dev.sleep(20);
    await env.server.close(2000);
    expect(env.host.positions).toHaveLength(1);
    expect(env.host.disconnects.map((d) => d.reason)).toEqual(["SHUTDOWN"]);
    env = undefined;
  });

  it("reports LISTEN when the port is taken", async () => {
    env = await start();
    const again = new Gt06TcpServer(
      new GpsIngestService(new FakeGpsHost(), resolveGpsOptions({ listen: false })),
      resolveGpsOptions({ port: env.port, bindAddress: "127.0.0.1" }),
    );
    await expect(again.listen()).rejects.toMatchObject({ kind: "LISTEN", details: { code: "EADDRINUSE" } });
  });
});
