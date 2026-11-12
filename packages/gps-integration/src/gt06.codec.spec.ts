import * as dev from "../test/gt06-device";
import { GT06_PROTOCOL, Gt06FrameReader, Gt06Packet, buildGt06Ack, crcItu, decodeGt06, decodeGt06Imei } from "./gt06.codec";

const hex = (s: string) => Buffer.from(s, "hex");

// Worked examples from the Concox GT06 protocol sheet (EDR's codec spec uses the same three).
const SPEC_LOGIN = "78780D01012345678901234500018CDD0D0A";
const SPEC_LOGIN_ACK = "787805010001D9DC0D0A";
const SPEC_LOCATION = "78781F120B081D112E10CF027AC7EB0C46584900148F01CC00287D001FB8000380810D0A";

function decodeAll(buf: Buffer, reader = new Gt06FrameReader()): { packets: Gt06Packet[]; badCrc: number; reader: Gt06FrameReader } {
  const r = reader.push(buf);
  return { packets: r.frames.map((f) => decodeGt06(f)), badCrc: r.badCrc, reader };
}

function only<T extends Gt06Packet["type"]>(buf: Buffer, type: T): Extract<Gt06Packet, { type: T }> {
  const { packets, reader } = decodeAll(buf);
  expect(reader.bufferedBytes).toBe(0);
  expect(packets).toHaveLength(1);
  expect(packets[0].type).toBe(type);
  return packets[0] as Extract<Gt06Packet, { type: T }>;
}

const time = new Date("2026-09-29T06:00:00Z");

describe("GT06 spec vectors", () => {
  it("decodes the sheet's login packet", () => {
    const p = only(hex(SPEC_LOGIN), "login");
    expect(p.imei).toBe("123456789012345");
    expect(p.serial).toBe(1);
  });

  it("builds the sheet's login ack", () => {
    expect(buildGt06Ack(GT06_PROTOCOL.LOGIN, 1).toString("hex").toUpperCase()).toBe(SPEC_LOGIN_ACK);
  });

  it("decodes the sheet's location packet", () => {
    const p = only(hex(SPEC_LOCATION), "location");
    expect(p.serial).toBe(3);
    expect(p.gps.fixTime.toISOString()).toBe("2011-08-29T17:46:16.000Z");
    expect(p.gps.satellites).toBe(15);
    expect(p.gps.latitude).toBeCloseTo(23.111668, 5);
    expect(p.gps.longitude).toBeCloseTo(114.409285, 5);
    expect(p.gps.speedKmh).toBe(0);
    expect(p.gps.course).toBe(0x8f);
    expect(p.gps.positioned).toBe(true);
    expect(p.lbs).toEqual({ mcc: 460, mnc: 0, lac: 0x287d, cellId: 0x001fb8 });
  });

  it("the simulator's encoder reproduces the sheet's login bytes", () => {
    expect(dev.login("123456789012345", 1).toString("hex").toUpperCase()).toBe(SPEC_LOGIN);
  });

  it("agrees with an independent table-driven CRC-16/X.25", () => {
    for (let n = 0; n < 50; n++) {
      const bytes = Buffer.from(Array.from({ length: 1 + ((n * 7) % 40) }, (_, i) => (i * 31 + n * 17) & 0xff));
      expect(crcItu(bytes)).toBe(dev.deviceCrc(bytes));
    }
    // The CRC-16/X.25 check value for "123456789".
    expect(crcItu(Buffer.from("123456789"))).toBe(0x906e);
  });
});

describe("GT06 packets", () => {
  it("keeps hemisphere signs (south, west), course and speed", () => {
    const p = only(dev.location({ time, lat: -33.8688, lng: -70.6693, course: 300, speed: 88 }, 9), "location");
    expect(p.gps.latitude).toBeCloseTo(-33.8688, 5);
    expect(p.gps.longitude).toBeCloseTo(-70.6693, 5);
    expect(p.gps.course).toBe(300);
    expect(p.gps.speedKmh).toBe(88);
    expect(p.gps.fixTime.toISOString()).toBe(time.toISOString());
  });

  it("reports an unpositioned fix", () => {
    expect(only(dev.location({ time, lat: 0, lng: 0, positioned: false }, 1), "location").gps.positioned).toBe(false);
  });

  it("decodes heartbeat status bits", () => {
    const p = only(dev.heartbeat(7, { terminalInfo: 0b1110_0111, voltage: 3, gsm: 2 }), "heartbeat");
    expect(p.status).toMatchObject({
      oilCut: true,
      gpsTracking: true,
      terminalAlarm: "SOS",
      charging: true,
      accOn: true,
      defenseOn: true,
      voltageLevel: 3,
      gsmLevel: 2,
      alarmCode: 0,
    });
  });

  it("decodes an alarm with its fix, LBS and status", () => {
    const p = only(dev.alarm({ time, lat: 8.55, lng: 39.24, speed: 5 }, 12, { alarm: 0x01, voltage: 4 }), "alarm");
    expect(p.alarm).toBe("SOS");
    expect(p.gps?.latitude).toBeCloseTo(8.55, 5);
    expect(p.lbs?.mcc).toBe(636);
    expect(p.status.voltageLevel).toBe(4);
  });

  it("keeps an alarm whose GPS block is empty (an SOS before the first fix)", () => {
    const p = only(dev.alarm(null, 4, { alarm: 0x01 }), "alarm");
    expect(p.alarm).toBe("SOS");
    expect(p.gps).toBeNull();
    expect(p.gpsProblem).toBe("BAD_DATE");
  });

  it("decodes 0x26 like 0x16, and power cut / fence alarms", () => {
    expect(only(dev.alarm({ time, lat: 9, lng: 38.7 }, 1, { alarm: 0x02 }, 0x26), "alarm").alarm).toBe("POWER_CUT");
    expect(only(dev.alarm({ time, lat: 9, lng: 38.7 }, 1, { alarm: 0x05 }), "alarm").alarm).toBe("FENCE_OUT");
    expect(only(dev.alarm({ time, lat: 9, lng: 38.7 }, 1, { alarm: 0x77 }), "alarm").alarm).toBe("UNKNOWN");
  });

  it("decodes the 0x22 location EDR ignored, with ACC, re-upload and mileage", () => {
    const p = only(dev.locationExt({ time, lat: 9.01, lng: 38.76, speed: 42 }, 5, { acc: true, reupload: true, mileageM: 123456 }), "location");
    expect(p.protocol).toBe(0x22);
    expect(p.gps.latitude).toBeCloseTo(9.01, 5);
    expect(p).toMatchObject({ accOn: true, reupload: true, mileageM: 123456 });
  });

  it("reads the tracker clock with a UTC offset when configured", () => {
    const [f] = new Gt06FrameReader().push(dev.location({ time, lat: 9, lng: 38.7 }, 1)).frames;
    const p = decodeGt06(f, { utcOffsetMinutes: 180 }) as Extract<Gt06Packet, { type: "location" }>;
    expect(p.gps.fixTime.toISOString()).toBe("2026-09-29T03:00:00.000Z");
  });

  it("calls an unsupported protocol unknown", () => {
    expect(only(dev.frame(0x8a, Buffer.alloc(0), 5), "unknown")).toEqual({ type: "unknown", protocol: 0x8a, serial: 5 });
  });
});

describe("GT06 malformed content (EDR threw, or read garbage)", () => {
  it("a 12-byte location (EDR's crash: RangeError in the data handler) is malformed, not thrown", () => {
    const p = only(dev.frame(0x12, Buffer.alloc(2), 1), "malformed");
    expect(p.reason).toBe("TOO_SHORT");
  });

  it("a short alarm is malformed", () => {
    expect(only(dev.frame(0x16, Buffer.alloc(20), 1), "malformed").reason).toBe("TOO_SHORT");
  });

  it("a heartbeat without status bytes is malformed (EDR read the serial and CRC as status)", () => {
    expect(only(dev.frame(0x13, Buffer.alloc(0), 1), "malformed").reason).toBe("TOO_SHORT");
  });

  it("a 3-byte login is malformed (EDR built an IMEI from the serial and CRC)", () => {
    expect(only(dev.frame(0x01, Buffer.alloc(3), 1), "malformed").reason).toBe("TOO_SHORT");
  });

  it("a terminal id that is not BCD digits is refused (EDR auto-registered 000000001473e0d)", () => {
    expect(only(dev.frame(0x01, hex("0123456789abcdef"), 1), "malformed").reason).toBe("BAD_IMEI");
    expect(decodeGt06Imei(hex("0359000000000001"))).toBe("359000000000001");
    expect(decodeGt06Imei(hex("1234567890123456"))).toBe("1234567890123456");
    expect(decodeGt06Imei(hex("00ff"))).toBeNull();
  });

  it("a location with month 13 or 31 February is malformed", () => {
    const content = Buffer.concat([hex("1a0d0f0a0000"), Buffer.alloc(20)]);
    expect(only(dev.frame(0x12, content, 1), "malformed").reason).toBe("BAD_DATE");
    const feb31 = Buffer.concat([hex("1a021f0a0000"), Buffer.alloc(20)]);
    expect(only(dev.frame(0x12, feb31, 1), "malformed").reason).toBe("BAD_DATE");
  });

  it("decodes every possible short frame of every handled protocol without throwing", () => {
    for (const protocol of [0x01, 0x12, 0x13, 0x16, 0x22, 0x26]) {
      for (let len = 0; len <= 40; len++) {
        const buf = dev.frame(protocol, Buffer.alloc(len, 0x5a), 1);
        expect(() => decodeAll(buf)).not.toThrow();
      }
    }
  });
});

describe("GT06 stream framing", () => {
  const a = dev.login("359000000000001", 1);
  const b = dev.heartbeat(2);

  it("pulls several frames out of one read", () => {
    expect(decodeAll(Buffer.concat([a, b, a])).packets.map((p) => p.type)).toEqual(["login", "heartbeat", "login"]);
  });

  it("keeps a partial frame across reads, even byte by byte", () => {
    const reader = new Gt06FrameReader();
    const all = Buffer.concat([a, b]);
    const types: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (const f of reader.push(all.subarray(i, i + 1)).frames) types.push(decodeGt06(f).type);
    }
    expect(types).toEqual(["login", "heartbeat"]);
    expect(reader.bufferedBytes).toBe(0);
  });

  it("resyncs past leading garbage", () => {
    expect(decodeAll(Buffer.concat([hex("00ff7812"), a])).packets.map((p) => p.type)).toEqual(["login"]);
  });

  it("drops a frame with a bad CRC and keeps the next one", () => {
    const bad = Buffer.from(a);
    bad[bad.length - 4] ^= 0xff;
    const r = decodeAll(Buffer.concat([bad, b]));
    expect(r.packets.map((p) => p.type)).toEqual(["heartbeat"]);
    expect(r.badCrc).toBe(1);
  });

  it("finds a real frame that starts inside a false frame's claimed length (EDR skipped the whole claim)", () => {
    // 78 78 10 claims 21 bytes and ends on the real login's 0D 0A; its CRC is wrong.
    const fake = Buffer.concat([hex("787810"), a]);
    const r = decodeAll(fake);
    expect(r.packets.map((p) => p.type)).toEqual(["login"]);
    expect(r.badCrc).toBe(1);
  });

  it("reads 0x7979 long frames", () => {
    const long = dev.frame(0x13, Buffer.from([0x46, 6, 4, 0, 2]), 9, true);
    expect(long.subarray(0, 2).toString("hex")).toBe("7979");
    const p = only(long, "heartbeat");
    expect(p.serial).toBe(9);
    expect(p.status.voltageLevel).toBe(6);
  });

  it("does not wait for a frame longer than maxFrameBytes", () => {
    const reader = new Gt06FrameReader(256);
    const r = reader.push(Buffer.concat([hex("79791388"), a]));
    expect(r.frames.map((f) => decodeGt06(f).type)).toEqual(["login"]);
  });

  it("holds at most one bounded partial frame whatever arrives", () => {
    const reader = new Gt06FrameReader(256);
    for (let i = 0; i < 200; i++) reader.push(Buffer.alloc(1000, i % 2 ? 0x78 : 0x41));
    expect(reader.bufferedBytes).toBeLessThanOrEqual(256);
    reader.push(Buffer.concat([hex("787805"), Buffer.alloc(2)]));
    expect(reader.bufferedBytes).toBeLessThanOrEqual(256);
  });

  it("ignores a claimed length below 5", () => {
    expect(decodeAll(Buffer.concat([hex("7878020102"), a])).packets.map((p) => p.type)).toEqual(["login"]);
  });

  it("refuses a maxFrameBytes below 64", () => {
    expect(() => new Gt06FrameReader(10)).toThrow(RangeError);
  });
});
