/**
 * A simulated GT06 tracker for the tests. Its encoder and CRC are written here, independently of
 * src/gt06.codec.ts (a table-driven CRC instead of the bitwise one), so a mistake in the package's
 * decoder cannot hide behind the same mistake in the encoder. Layouts from the Concox GT06 sheet
 * and EDR's gt06.frames.ts.
 */
import * as net from "node:net";

const CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x8408 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function deviceCrc(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xff];
  return (crc ^ 0xffff) & 0xffff;
}

export function frame(protocol: number, content: Buffer, serial: number, long = false): Buffer {
  const len = content.length + 5;
  const lenBytes = long ? Buffer.from([(len >> 8) & 0xff, len & 0xff]) : Buffer.from([len]);
  const body = Buffer.concat([lenBytes, Buffer.from([protocol]), content, Buffer.from([(serial >> 8) & 0xff, serial & 0xff])]);
  const crc = deviceCrc(body);
  return Buffer.concat([
    Buffer.from(long ? [0x79, 0x79] : [0x78, 0x78]),
    body,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff, 0x0d, 0x0a]),
  ]);
}

export const ack = (protocol: number, serial: number): Buffer => frame(protocol, Buffer.alloc(0), serial);

export interface Fix {
  time: Date;
  lat: number;
  lng: number;
  speed?: number;
  course?: number;
  satellites?: number;
  positioned?: boolean;
}

function gpsBlock(f: Fix): Buffer {
  const b = Buffer.alloc(18);
  b[0] = f.time.getUTCFullYear() - 2000;
  b[1] = f.time.getUTCMonth() + 1;
  b[2] = f.time.getUTCDate();
  b[3] = f.time.getUTCHours();
  b[4] = f.time.getUTCMinutes();
  b[5] = f.time.getUTCSeconds();
  b[6] = 0xc0 | ((f.satellites ?? 9) & 0x0f);
  b.writeUInt32BE(Math.round(Math.abs(f.lat) * 1_800_000), 7);
  b.writeUInt32BE(Math.round(Math.abs(f.lng) * 1_800_000), 11);
  b[15] = f.speed ?? 0;
  const course = (f.course ?? 0) & 0x3ff;
  let hi = course >> 8;
  if (f.positioned ?? true) hi |= 0x10;
  if (f.lng < 0) hi |= 0x08;
  if (f.lat >= 0) hi |= 0x04;
  b[16] = hi;
  b[17] = course & 0xff;
  return b;
}

/** Ethio Telecom MCC 636, MNC 1. */
const LBS = Buffer.from([0x02, 0x7c, 0x01, 0x12, 0x34, 0x00, 0xab, 0xcd]);

export function imeiBytes(imei: string): Buffer {
  return Buffer.from(imei.padStart(16, "0"), "hex");
}

export const login = (imei: string, serial: number): Buffer => frame(0x01, imeiBytes(imei), serial);

export const location = (f: Fix, serial: number): Buffer => frame(0x12, Buffer.concat([gpsBlock(f), LBS]), serial);

/** 0x22: GPS, LBS, ACC, upload mode, re-upload flag, mileage. */
export const locationExt = (f: Fix, serial: number, opts: { acc?: boolean; reupload?: boolean; mileageM?: number } = {}): Buffer => {
  const tail = Buffer.alloc(7);
  tail[0] = opts.acc ? 1 : 0;
  tail[1] = 0x00;
  tail[2] = opts.reupload ? 1 : 0;
  tail.writeUInt32BE(opts.mileageM ?? 0, 3);
  return frame(0x22, Buffer.concat([gpsBlock(f), LBS, tail]), serial);
};

export interface Status {
  terminalInfo?: number;
  voltage?: number;
  gsm?: number;
  alarm?: number;
}

function statusBlock(s: Status): Buffer {
  return Buffer.from([s.terminalInfo ?? 0x46, s.voltage ?? 6, s.gsm ?? 4, s.alarm ?? 0, 0x02]);
}

export const heartbeat = (serial: number, s: Status = {}): Buffer => frame(0x13, statusBlock(s), serial);

export const alarm = (f: Fix | null, serial: number, s: Status = {}, protocol = 0x16): Buffer => {
  const gps = f ? gpsBlock(f) : Buffer.alloc(18); // all zero: month 0, no fix
  return frame(protocol, Buffer.concat([gps, Buffer.from([0x09]), LBS, statusBlock(s)]), serial);
};

/** A TCP client that behaves like a tracker. */
export class SimTracker {
  private received = Buffer.alloc(0);
  private ended = false;
  private readonly closedPromise: Promise<void>;

  private constructor(readonly socket: net.Socket) {
    socket.setNoDelay(true);
    socket.on("data", (d) => {
      this.received = Buffer.concat([this.received, d]);
    });
    socket.on("error", () => undefined);
    this.closedPromise = new Promise((resolve) =>
      socket.on("close", () => {
        this.ended = true;
        resolve();
      }),
    );
  }

  static connect(port: number, host = "127.0.0.1"): Promise<SimTracker> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () => resolve(new SimTracker(socket)));
      socket.once("error", reject);
    });
  }

  get closed(): boolean {
    return this.ended;
  }

  get bytesReceived(): Buffer {
    return this.received;
  }

  send(...frames: Buffer[]): void {
    if (!this.ended) this.socket.write(Buffer.concat(frames));
  }

  /** Sends one buffer in pieces, waiting between them, so the server sees separate TCP reads. */
  async sendInPieces(buf: Buffer, cuts: number[], pauseMs = 30): Promise<void> {
    let start = 0;
    for (const cut of [...cuts, buf.length]) {
      this.send(buf.subarray(start, cut));
      start = cut;
      await sleep(pauseMs);
    }
  }

  async waitAck(protocol: number, serial: number, timeoutMs = 2000): Promise<boolean> {
    const want = ack(protocol, serial);
    for (let waited = 0; waited <= timeoutMs; waited += 20) {
      if (this.received.includes(want)) return true;
      if (this.ended) return this.received.includes(want);
      await sleep(20);
    }
    return false;
  }

  async waitClosed(timeoutMs = 2000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.closedPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return this.ended;
  }

  close(): Promise<void> {
    this.socket.end();
    return this.waitClosed(1000).then(() => undefined);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls until check() is true or the time is up. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000, stepMs = 25): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += stepMs) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}
