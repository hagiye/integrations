/**
 * GT06 (Concox) tracker protocol: framing, CRC, packet decoding and the server's acknowledgements.
 * Pure: no sockets, no Nest, never throws on device input.
 *
 * Short frame: 78 78 | len (1)  | protocol | content | serial (2) | crc (2) | 0D 0A
 * Long frame:  79 79 | len (2)  | protocol | content | serial (2) | crc (2) | 0D 0A
 * `len` counts protocol..crc (content length + 5). The CRC is CRC-ITU (CRC-16/X.25) over
 * len..serial inclusive.
 */

export const GT06_PROTOCOL = {
  LOGIN: 0x01,
  LOCATION: 0x12,
  HEARTBEAT: 0x13,
  STRING: 0x15,
  ALARM: 0x16,
  ADDRESS_BY_PHONE: 0x1a,
  /** GT06N and newer firmware: location plus ACC, upload mode, re-upload flag, mileage. */
  LOCATION_EXT: 0x22,
  /** GT06N and newer firmware: alarm, same layout as 0x16. */
  ALARM_EXT: 0x26,
  SERVER_COMMAND: 0x80,
} as const;

/** Protocols the server acknowledges, as EDR does: login, heartbeat, alarms. Locations need no reply. */
export const GT06_ACKED_PROTOCOLS: ReadonlySet<number> = new Set([
  GT06_PROTOCOL.LOGIN,
  GT06_PROTOCOL.HEARTBEAT,
  GT06_PROTOCOL.ALARM,
  GT06_PROTOCOL.ALARM_EXT,
]);

/** CRC-16/X.25 (CRC-ITU) as GT06 uses it: reflected, poly 0x8408, init and xorout 0xFFFF. */
export function crcItu(bytes: Uint8Array): number {
  let fcs = 0xffff;
  for (const b of bytes) {
    fcs ^= b;
    for (let i = 0; i < 8; i++) fcs = fcs & 1 ? (fcs >> 1) ^ 0x8408 : fcs >> 1;
  }
  return ~fcs & 0xffff;
}

// ── framing ──────────────────────────────────────────────────────────────────

export interface Gt06Frame {
  /** 0x7979 frame (2-byte length). */
  long: boolean;
  protocol: number;
  content: Buffer;
  serial: number;
}

export interface Gt06ReadResult {
  frames: Gt06Frame[];
  /** Frames whose CRC did not match: dropped, the reader resyncs one byte later. */
  badCrc: number;
  /** Bytes skipped while looking for a frame start (garbage, a port scanner, a wrong protocol). */
  skippedBytes: number;
}

/** Shortest possible frame: start(2) + len(1) + protocol(1) + serial(2) + crc(2) + stop(2). */
const MIN_SHORT_FRAME = 10;

/**
 * Pulls frames out of a TCP byte stream. Keeps at most one partial frame between chunks, and never
 * more than maxFrameBytes of it, so a client that sends garbage cannot grow memory.
 *
 * Differences from EDR's parseStream (each tested):
 * - 0x7979 long frames are read; EDR knew only 0x7878.
 * - A frame with a bad CRC is skipped by one byte, not by its claimed length, so a real frame
 *   that starts inside the bad one's claimed length is still found.
 * - A claimed length under 5 (no room for protocol, serial and CRC) is not a frame.
 */
export class Gt06FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = 1024) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 64) {
      throw new RangeError("maxFrameBytes must be an integer of at least 64");
    }
  }

  /** Bytes held for a frame that has not fully arrived yet. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): Gt06ReadResult {
    const buf = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Gt06Frame[] = [];
    let badCrc = 0;
    let skippedBytes = 0;
    let i = 0;
    while (buf.length - i >= 2) {
      const short = buf[i] === 0x78 && buf[i + 1] === 0x78;
      const long = buf[i] === 0x79 && buf[i + 1] === 0x79;
      if (!short && !long) {
        i += 1;
        skippedBytes += 1;
        continue;
      }
      const lenBytes = short ? 1 : 2;
      if (buf.length - i < 2 + lenBytes) break; // the length has not arrived yet
      const len = short ? buf[i + 2] : buf.readUInt16BE(i + 2);
      const frameLen = 2 + lenBytes + len + 2;
      if (len < 5 || frameLen > this.maxFrameBytes) {
        i += 1;
        skippedBytes += 1;
        continue;
      }
      if (buf.length - i < frameLen) break; // the rest of this frame has not arrived yet
      if (buf[i + frameLen - 2] !== 0x0d || buf[i + frameLen - 1] !== 0x0a) {
        i += 1;
        skippedBytes += 1;
        continue;
      }
      const crcCalc = crcItu(buf.subarray(i + 2, i + frameLen - 4));
      const crcRecv = buf.readUInt16BE(i + frameLen - 4);
      if (crcCalc !== crcRecv) {
        badCrc += 1;
        i += 1;
        skippedBytes += 1;
        continue;
      }
      const protocolAt = i + 2 + lenBytes;
      frames.push({
        long,
        protocol: buf[protocolAt],
        // A copy: the frame outlives this chunk (queued for the host), the chunk buffer does not.
        content: Buffer.from(buf.subarray(protocolAt + 1, i + frameLen - 6)),
        serial: buf.readUInt16BE(i + frameLen - 6),
      });
      i += frameLen;
    }
    const rest = buf.subarray(i);
    // The loop only stops on an incomplete frame no longer than maxFrameBytes, or on fewer than
    // four bytes, so the remainder is bounded. Copy it so the big chunk can be freed.
    this.buffer = rest.length ? Buffer.from(rest) : Buffer.alloc(0);
    return { frames, badCrc, skippedBytes };
  }
}

/** Builds a frame. The server only sends acknowledgements; the tests' simulator has its own encoder. */
export function buildGt06Frame(protocol: number, content: Buffer, serial: number, long = false): Buffer {
  const lenBytes = long ? 2 : 1;
  const len = content.length + 5;
  if (!long && len > 0xff) throw new RangeError("content too long for a short frame");
  const body = Buffer.alloc(lenBytes + 1 + content.length + 2);
  if (long) body.writeUInt16BE(len, 0);
  else body[0] = len;
  body[lenBytes] = protocol;
  content.copy(body, lenBytes + 1);
  body.writeUInt16BE(serial & 0xffff, lenBytes + 1 + content.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(crcItu(body), 0);
  tail[2] = 0x0d;
  tail[3] = 0x0a;
  return Buffer.concat([Buffer.from(long ? [0x79, 0x79] : [0x78, 0x78]), body, tail]);
}

/** The server's reply to login, heartbeat and alarm: same protocol, same serial, no content (EDR's buildAck). */
export function buildGt06Ack(protocol: number, serial: number): Buffer {
  return buildGt06Frame(protocol, Buffer.alloc(0), serial);
}

// ── packets ──────────────────────────────────────────────────────────────────

export interface Gt06Gps {
  /** When the fix was taken, from the tracker's clock (UTC unless utcOffsetMinutes says otherwise). */
  fixTime: Date;
  satellites: number;
  latitude: number;
  longitude: number;
  /** km/h, 0-255. */
  speedKmh: number;
  /** Degrees from north, 0-1023 on the wire (0-359 from a real fix). */
  course: number;
  /** The receiver had a fix. An unpositioned packet carries the last known or a zero position. */
  positioned: boolean;
  /** Differential GPS rather than real-time (course/status bit 13). */
  differential: boolean;
}

export interface Gt06Lbs {
  mcc: number;
  mnc: number;
  lac: number;
  cellId: number;
}

export type Gt06AlarmType = "NORMAL" | "SOS" | "POWER_CUT" | "SHOCK" | "FENCE_IN" | "FENCE_OUT" | "UNKNOWN";
export type Gt06TerminalAlarm = "NORMAL" | "SHOCK" | "POWER_CUT" | "LOW_BATTERY" | "SOS" | "UNKNOWN";

export interface Gt06Status {
  /** The raw terminal-information byte. */
  terminalInfo: number;
  /** Bit 7: oil and electricity disconnected (relay cut). */
  oilCut: boolean;
  /** Bit 6: GPS tracking on. */
  gpsTracking: boolean;
  /** Bits 3-5. */
  terminalAlarm: Gt06TerminalAlarm;
  /** Bit 2. */
  charging: boolean;
  /** Bit 1: ignition. */
  accOn: boolean;
  /** Bit 0: defense (arming) on. */
  defenseOn: boolean;
  /** 0 (no power) to 6 (very high). */
  voltageLevel: number;
  /** 0 (no signal) to 4 (strong). */
  gsmLevel: number;
  /** The alarm byte (heartbeat and alarm packets), null when the packet had none. */
  alarmCode: number | null;
  language: number | null;
}

export type Gt06Packet =
  | { type: "login"; protocol: number; serial: number; imei: string }
  | {
      type: "location";
      protocol: number;
      serial: number;
      gps: Gt06Gps;
      lbs: Gt06Lbs | null;
      /** 0x22 only: ignition, the upload trigger, and whether this fix is a buffered replay. */
      accOn?: boolean;
      uploadMode?: number;
      reupload?: boolean;
      mileageM?: number;
    }
  | { type: "heartbeat"; protocol: number; serial: number; status: Gt06Status }
  | {
      type: "alarm";
      protocol: number;
      serial: number;
      /** null when the alarm's GPS block is not a fix (no date yet, say): the alarm still counts. */
      gps: Gt06Gps | null;
      gpsProblem?: Gt06MalformedReason;
      lbs: Gt06Lbs | null;
      status: Gt06Status;
      alarm: Gt06AlarmType;
    }
  | { type: "unknown"; protocol: number; serial: number }
  /** CRC was right but the content does not fit the protocol (too short, a date that is not one, an IMEI that is not digits). */
  | { type: "malformed"; protocol: number; serial: number; reason: Gt06MalformedReason };

export type Gt06MalformedReason = "TOO_SHORT" | "BAD_IMEI" | "BAD_DATE" | "BAD_COORDINATES";

export interface Gt06DecodeOptions {
  /**
   * Minutes the tracker's clock is ahead of UTC. Default 0: GT06 sends GPS time, which is UTC
   * (EDR reads it as UTC). Set it only for a unit configured to send local time.
   */
  utcOffsetMinutes?: number;
}

const ALARM_TYPES: Record<number, Gt06AlarmType> = {
  0x00: "NORMAL",
  0x01: "SOS",
  0x02: "POWER_CUT",
  0x03: "SHOCK",
  0x04: "FENCE_IN",
  0x05: "FENCE_OUT",
};

const TERMINAL_ALARMS: Record<number, Gt06TerminalAlarm> = {
  0b000: "NORMAL",
  0b001: "SHOCK",
  0b010: "POWER_CUT",
  0b011: "LOW_BATTERY",
  0b100: "SOS",
};

const GPS_BYTES = 18;
const LBS_BYTES = 8;

class Malformed extends Error {
  constructor(readonly reason: Gt06MalformedReason) {
    super(reason);
  }
}

function need(content: Buffer, bytes: number): void {
  if (content.length < bytes) throw new Malformed("TOO_SHORT");
}

/**
 * The 8-byte terminal id is BCD: 16 digits, a 15-digit IMEI padded with a leading 0. EDR took the
 * hex as is, so a frame of any bytes produced an "IMEI" with letters in it, which EDR then
 * auto-registered. Here every nibble must be a digit.
 */
export function decodeGt06Imei(bytes: Buffer): string | null {
  if (bytes.length !== 8) return null;
  const digits = bytes.toString("hex");
  if (!/^\d{16}$/.test(digits)) return null;
  return digits.startsWith("0") ? digits.slice(1) : digits;
}

function decodeTime(c: Buffer, off: number, utcOffsetMinutes: number): Date {
  const [yy, mo, dd, hh, mi, ss] = [c[off], c[off + 1], c[off + 2], c[off + 3], c[off + 4], c[off + 5]];
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) throw new Malformed("BAD_DATE");
  const ms = Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss);
  const date = new Date(ms);
  // Date.UTC rolls 31 February into March; a real clock never sends it.
  if (date.getUTCDate() !== dd) throw new Malformed("BAD_DATE");
  return new Date(ms - utcOffsetMinutes * 60_000);
}

function decodeGps(c: Buffer, off: number, utcOffsetMinutes: number): Gt06Gps {
  need(c, off + GPS_BYTES);
  const fixTime = decodeTime(c, off, utcOffsetMinutes);
  const satellites = c[off + 6] & 0x0f;
  const latRaw = c.readUInt32BE(off + 7);
  const lonRaw = c.readUInt32BE(off + 11);
  const speedKmh = c[off + 15];
  const cs = c.readUInt16BE(off + 16);
  const hi = cs >> 8;
  const positioned = Boolean(hi & 0x10);
  const west = Boolean(hi & 0x08);
  const north = Boolean(hi & 0x04);
  // degrees * 60 * 30000 on the wire
  let latitude = latRaw / 1_800_000;
  let longitude = lonRaw / 1_800_000;
  if (latitude > 90 || longitude > 180) throw new Malformed("BAD_COORDINATES");
  if (!north) latitude = -latitude;
  if (west) longitude = -longitude;
  return {
    fixTime,
    satellites,
    latitude,
    longitude,
    speedKmh,
    course: cs & 0x03ff,
    positioned,
    differential: Boolean(hi & 0x20),
  };
}

function decodeLbs(c: Buffer, off: number): Gt06Lbs | null {
  if (c.length < off + LBS_BYTES) return null;
  return { mcc: c.readUInt16BE(off), mnc: c[off + 2], lac: c.readUInt16BE(off + 3), cellId: c.readUIntBE(off + 5, 3) };
}

function decodeStatus(c: Buffer, off: number): Gt06Status {
  need(c, off + 3);
  const t = c[off];
  return {
    terminalInfo: t,
    oilCut: Boolean(t & 0x80),
    gpsTracking: Boolean(t & 0x40),
    terminalAlarm: TERMINAL_ALARMS[(t >> 3) & 0x07] ?? "UNKNOWN",
    charging: Boolean(t & 0x04),
    accOn: Boolean(t & 0x02),
    defenseOn: Boolean(t & 0x01),
    voltageLevel: c[off + 1],
    gsmLevel: c[off + 2],
    alarmCode: c.length > off + 3 ? c[off + 3] : null,
    language: c.length > off + 4 ? c[off + 4] : null,
  };
}

/**
 * Decodes one frame. Never throws: content that does not fit its protocol comes back as
 * "malformed". EDR read fields at fixed offsets without a length check, so a 12-byte frame with a
 * valid CRC (protocol 0x12, 2 bytes of content) threw RangeError inside the socket's data handler
 * and took the whole ingester process down.
 */
export function decodeGt06(frame: Gt06Frame, options: Gt06DecodeOptions = {}): Gt06Packet {
  const { protocol, serial, content: c } = frame;
  const offset = options.utcOffsetMinutes ?? 0;
  try {
    switch (protocol) {
      case GT06_PROTOCOL.LOGIN: {
        need(c, 8);
        const imei = decodeGt06Imei(c.subarray(0, 8));
        if (!imei) throw new Malformed("BAD_IMEI");
        return { type: "login", protocol, serial, imei };
      }
      case GT06_PROTOCOL.LOCATION:
        return { type: "location", protocol, serial, gps: decodeGps(c, 0, offset), lbs: decodeLbs(c, GPS_BYTES) };
      case GT06_PROTOCOL.LOCATION_EXT: {
        const gps = decodeGps(c, 0, offset);
        const lbs = decodeLbs(c, GPS_BYTES);
        const ext = GPS_BYTES + LBS_BYTES;
        const packet: Extract<Gt06Packet, { type: "location" }> = { type: "location", protocol, serial, gps, lbs };
        if (c.length >= ext + 3) {
          packet.accOn = c[ext] === 0x01;
          packet.uploadMode = c[ext + 1];
          packet.reupload = c[ext + 2] === 0x01;
        }
        if (c.length >= ext + 7) packet.mileageM = c.readUInt32BE(ext + 3);
        return packet;
      }
      case GT06_PROTOCOL.HEARTBEAT:
        return { type: "heartbeat", protocol, serial, status: decodeStatus(c, 0) };
      case GT06_PROTOCOL.ALARM:
      case GT06_PROTOCOL.ALARM_EXT: {
        need(c, GPS_BYTES + 1);
        // An SOS without a fix may carry a zero date: keep the alarm, drop only its position.
        let gps: Gt06Gps | null = null;
        let gpsProblem: Gt06MalformedReason | undefined;
        try {
          gps = decodeGps(c, 0, offset);
        } catch (err) {
          if (!(err instanceof Malformed)) throw err;
          gpsProblem = err.reason;
        }
        // The LBS length counts itself (9 = 1 + 8). EDR assumed 9; a different value moves the status.
        const lbsLen = Math.max(c[GPS_BYTES], 1);
        const lbs = lbsLen >= 1 + LBS_BYTES ? decodeLbs(c, GPS_BYTES + 1) : null;
        const status = decodeStatus(c, GPS_BYTES + lbsLen);
        const alarm = status.alarmCode == null ? "UNKNOWN" : (ALARM_TYPES[status.alarmCode] ?? "UNKNOWN");
        return { type: "alarm", protocol, serial, gps, lbs, status, alarm, ...(gpsProblem ? { gpsProblem } : {}) };
      }
      default:
        return { type: "unknown", protocol, serial };
    }
  } catch (err) {
    if (err instanceof Malformed) return { type: "malformed", protocol, serial, reason: err.reason };
    // A read past the end that a length check above missed: still malformed, never a crash.
    if (err instanceof RangeError) return { type: "malformed", protocol, serial, reason: "TOO_SHORT" };
    throw err;
  }
}
