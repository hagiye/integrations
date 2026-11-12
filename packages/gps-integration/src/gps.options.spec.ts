import { GpsError } from "./gps.errors";
import { buildSourceList, isSourceAllowed, maskImei, normalizeAddress, resolveGpsOptions } from "./gps.options";

describe("resolveGpsOptions", () => {
  it("defaults to EDR's port, bind address and idle timeout", () => {
    const o = resolveGpsOptions();
    expect(o).toMatchObject({ listen: true, port: 5023, bindAddress: "0.0.0.0", idleTimeoutMs: 600_000, maxFutureSkewMinutes: 5 });
    expect(o.alerts).toMatchObject({ enabled: true, scanEveryMs: 60_000, resolveAfterMinutes: 0, cooldownMinutes: 15 });
    expect(o.alerts.defaultThresholds).toEqual({ overspeedKmh: 80, idleMinutes: 30, offlineMinutes: 15 });
  });

  it("names every bad option, never its value", () => {
    let err: GpsError | undefined;
    try {
      resolveGpsOptions({ port: 70000, bindAddress: "gps.example.com", maxFrameBytes: 10, alerts: { scanEveryMs: -1 } });
    } catch (e) {
      err = e as GpsError;
    }
    expect(err?.kind).toBe("CONFIG");
    expect(err?.message).toContain("port");
    expect(err?.message).toContain("bindAddress");
    expect(err?.message).toContain("maxFrameBytes");
    expect(err?.message).toContain("alerts.scanEveryMs");
    expect(err?.message).not.toContain("70000");
    expect(err?.message).not.toContain("gps.example.com");
  });

  it("refuses a bad allowedSources entry at start-up, by position", () => {
    expect(() => resolveGpsOptions({ allowedSources: ["10.0.0.0/8", "not-an-ip"] })).toThrow(/allowedSources\[1\]/);
    expect(() => resolveGpsOptions({ allowedSources: ["10.0.0.0/33"] })).toThrow(/prefix/);
  });
});

describe("source allow list", () => {
  const list = buildSourceList(["10.20.0.0/16", "192.0.2.7", "2001:db8::/32"]);

  it("allows the listed ranges and addresses, IPv4 and IPv6", () => {
    expect(isSourceAllowed(list, "10.20.3.4")).toBe(true);
    expect(isSourceAllowed(list, "192.0.2.7")).toBe(true);
    expect(isSourceAllowed(list, "2001:db8:1::5")).toBe(true);
    expect(isSourceAllowed(list, "10.21.0.1")).toBe(false);
    expect(isSourceAllowed(list, "192.0.2.8")).toBe(false);
    expect(isSourceAllowed(list, "")).toBe(false);
  });

  it("treats an IPv4 client on a dual-stack socket as IPv4", () => {
    expect(normalizeAddress("::ffff:10.20.3.4")).toBe("10.20.3.4");
    expect(isSourceAllowed(list, normalizeAddress("::ffff:10.20.3.4"))).toBe(true);
  });

  it("allows anything when the list is empty", () => {
    expect(buildSourceList([])).toBeNull();
    expect(isSourceAllowed(null, "203.0.113.1")).toBe(true);
  });
});

describe("maskImei", () => {
  it("keeps four digits each end unless told otherwise", () => {
    expect(maskImei("359000000000001")).toBe("3590*******0001");
    expect(maskImei("359000000000001", true)).toBe("359000000000001");
  });
});
