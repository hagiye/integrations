import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { GpsError } from "./gps.errors";
import { GpsIngestService, GpsLocationPacket } from "./gps.ingest";
import { ResolvedGpsOptions, buildSourceList, isSourceAllowed, maskImei, normalizeAddress } from "./gps.options";
import type { GpsConnectionInfo, GpsDevice, GpsDisconnectReason, GpsRejectionReason } from "./gps.types";
import { GT06_ACKED_PROTOCOLS, Gt06FrameReader, Gt06Packet, buildGt06Ack, decodeGt06 } from "./gt06.codec";

interface Session {
  socket: net.Socket;
  info: GpsConnectionInfo;
  reader: Gt06FrameReader;
  imei: string | null;
  device: GpsDevice | null;
  /** Packets run one at a time, in arrival order, across TCP reads (EDR's rule). */
  queue: Promise<void>;
  pending: number;
  paused: boolean;
  closing: GpsDisconnectReason | null;
  /**
   * Closed by a rule (unknown device, IMEI change, rate...): packets still queued are dropped.
   * A connection closed by the tracker, replaced, idle or shut down still stores what it sent.
   */
  rejected: boolean;
  badFrames: number;
  windowStart: number;
  windowCount: number;
  rateWarned: boolean;
  unknownLogged: Set<number>;
  loginTimer?: NodeJS.Timeout;
}

export interface GpsServerStats {
  connections: number;
  loggedIn: number;
}

/**
 * The GT06 TCP listener. A tracker connects, logs in with its IMEI, then streams locations,
 * heartbeats and alarms; login, heartbeat and alarm are acknowledged once the host has them.
 * Usable without Nest: new Gt06TcpServer(ingest, options).listen().
 *
 * Rules EDR did not have (EDR accepted any source, any number of connections, auto-registered
 * any IMEI, and let one connection switch IMEIs):
 * - allowedSources, maxConnections, maxConnectionsPerIp at connect;
 * - a login within loginTimeoutMs, for a device the host knows, before anything else counts;
 * - one IMEI per connection; a newer connection for an IMEI replaces the older one;
 * - maxBadFrames, maxPacketsPerMinute; the socket pauses while maxPendingPackets wait.
 */
export class Gt06TcpServer {
  private readonly logger = new Logger("Gt06TcpServer");
  private server?: net.Server;
  private readonly sessions = new Set<Session>();
  private readonly byImei = new Map<string, Session>();
  private readonly perIp = new Map<string, number>();
  private readonly sources: net.BlockList | null;
  private stopping = false;

  constructor(
    private readonly ingest: GpsIngestService,
    private readonly options: ResolvedGpsOptions,
  ) {
    this.sources = buildSourceList(options.allowedSources);
  }

  /** Binds options.port on options.bindAddress. Resolves with the address (the real port when 0). */
  listen(): Promise<net.AddressInfo> {
    if (this.server) throw new GpsError("CONFIG", "the GT06 listener is already started");
    this.stopping = false;
    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.server = undefined;
        reject(new GpsError("LISTEN", `GT06 listener could not bind ${this.options.bindAddress}:${this.options.port}`, { code: err.code, cause: err }));
      };
      server.once("error", onError);
      server.listen(this.options.port, this.options.bindAddress, () => {
        server.off("error", onError);
        server.on("error", (err) => this.logger.error(`GT06 listener error: ${err.message}`));
        const address = server.address() as net.AddressInfo;
        this.logger.log(`GT06 listener on ${address.address}:${address.port}`);
        resolve(address);
      });
    });
  }

  address(): net.AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a : null;
  }

  stats(): GpsServerStats {
    return { connections: this.sessions.size, loggedIn: this.byImei.size };
  }

  /** Stops accepting, closes every connection, and waits (up to drainMs) for queued packets. */
  async close(drainMs = 5000): Promise<void> {
    if (!this.server) return;
    this.stopping = true;
    const server = this.server;
    this.server = undefined;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const ending = [...this.sessions];
    for (const s of ending) this.end(s, "SHUTDOWN");
    // The close events (which queue onDisconnect behind each connection's packets) fire next tick.
    await new Promise((resolve) => setImmediate(resolve));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...ending.map((s) => s.queue), closed]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, drainMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  // ── connections ──

  private onConnection(socket: net.Socket): void {
    const remoteAddress = normalizeAddress(socket.remoteAddress);
    const info: GpsConnectionInfo = {
      connectionId: randomUUID(),
      remoteAddress,
      remotePort: socket.remotePort ?? 0,
      connectedAt: new Date(),
    };
    socket.on("error", () => undefined); // a reset from a tracker is normal; close follows
    if (this.stopping) {
      socket.destroy();
      return;
    }
    if (!isSourceAllowed(this.sources, remoteAddress)) {
      this.refuse(socket, info, "SOURCE_NOT_ALLOWED");
      return;
    }
    const fromIp = this.perIp.get(remoteAddress) ?? 0;
    if (
      this.sessions.size >= this.options.maxConnections ||
      (this.options.maxConnectionsPerIp > 0 && fromIp >= this.options.maxConnectionsPerIp)
    ) {
      this.refuse(socket, info, "TOO_MANY_CONNECTIONS");
      return;
    }
    this.perIp.set(remoteAddress, fromIp + 1);
    const session: Session = {
      socket,
      info,
      reader: new Gt06FrameReader(this.options.maxFrameBytes),
      imei: null,
      device: null,
      queue: Promise.resolve(),
      pending: 0,
      paused: false,
      closing: null,
      rejected: false,
      badFrames: 0,
      windowStart: Date.now(),
      windowCount: 0,
      rateWarned: false,
      unknownLogged: new Set(),
    };
    this.sessions.add(session);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(this.options.idleTimeoutMs);
    session.loginTimer = setTimeout(() => {
      if (!session.device) this.reject(session, "LOGIN_TIMEOUT");
    }, this.options.loginTimeoutMs);
    session.loginTimer.unref?.();
    socket.on("timeout", () => this.end(session, "IDLE"));
    socket.on("data", (chunk: Buffer) => this.onData(session, chunk));
    socket.on("close", () => this.onClose(session));
  }

  private refuse(socket: net.Socket, info: GpsConnectionInfo, reason: GpsRejectionReason): void {
    socket.destroy();
    void this.ingest.rejected({ reason, connection: info, imei: null, at: new Date() });
  }

  private onData(session: Session, chunk: Buffer): void {
    if (session.closing) return;
    const { frames, badCrc, skippedBytes } = session.reader.push(chunk);
    session.badFrames += badCrc + (skippedBytes > 0 ? 1 : 0);

    const now = Date.now();
    if (now - session.windowStart >= 60_000) {
      session.windowStart = now;
      session.windowCount = 0;
      session.rateWarned = false;
    }
    const room = Math.max(0, this.options.maxPacketsPerMinute - session.windowCount);
    session.windowCount += frames.length;
    if (session.windowCount > 2 * this.options.maxPacketsPerMinute) {
      this.reject(session, "RATE_LIMITED");
      return;
    }
    const accepted = frames.length > room ? frames.slice(0, room) : frames;
    if (accepted.length < frames.length && !session.rateWarned) {
      session.rateWarned = true;
      this.logger.warn(`${this.who(session)}: over ${this.options.maxPacketsPerMinute} packets a minute, dropping`);
    }

    const packets: Gt06Packet[] = [];
    for (const frame of accepted) {
      const p = decodeGt06(frame, { utcOffsetMinutes: this.options.deviceUtcOffsetMinutes });
      if (p.type === "malformed") {
        session.badFrames += 1;
        this.logger.warn(`${this.who(session)}: malformed 0x${hex(p.protocol)} packet (${p.reason}), dropped`);
        continue;
      }
      packets.push(p);
    }
    if (session.badFrames > this.options.maxBadFrames) {
      this.reject(session, "TOO_MANY_BAD_FRAMES");
      return;
    }
    if (!packets.length) return;

    session.pending += packets.length;
    if (session.pending >= this.options.maxPendingPackets && !session.paused) {
      session.paused = true;
      session.socket.pause();
    }
    session.queue = session.queue
      .then(() => this.process(session, packets))
      .catch((err) => this.logger.error(`${this.who(session)}: ${(err as Error).message}`));
  }

  private async process(session: Session, packets: Gt06Packet[]): Promise<void> {
    let locations: GpsLocationPacket[] = [];
    const done = (n: number) => {
      session.pending -= n;
      if (session.paused && session.pending <= this.options.maxPendingPackets / 2 && !session.closing) {
        session.paused = false;
        session.socket.resume();
      }
    };
    const flush = async () => {
      if (!locations.length) return;
      const batch = locations;
      locations = [];
      try {
        if (session.device && !session.rejected) await this.ingest.locations(session.device, session.info, batch);
      } catch (err) {
        this.logger.error(`${this.who(session)}: savePositions failed: ${(err as Error).message}`);
      } finally {
        done(batch.length);
      }
    };
    for (const p of packets) {
      if (session.rejected || (session.closing && p.type === "login")) {
        done(1);
        continue;
      }
      if (p.type === "location" && session.device) {
        locations.push(p);
        continue;
      }
      await flush();
      try {
        await this.handle(session, p);
      } catch (err) {
        // No ack: the tracker sends it again.
        this.logger.error(`${this.who(session)}: ${p.type} failed: ${(err as Error).message}`);
      } finally {
        done(1);
      }
    }
    await flush();
  }

  private async handle(session: Session, p: Gt06Packet): Promise<void> {
    if (p.type === "login") return this.login(session, p.imei, p.serial, p.protocol);
    const device = session.device;
    if (!device) return; // nothing counts before a login (EDR acked heartbeats anyway)
    switch (p.type) {
      case "heartbeat":
        await this.ingest.heartbeat(device, session.info, p.status);
        break;
      case "alarm":
        await this.ingest.alarm(device, session.info, p);
        break;
      case "unknown":
        if (!session.unknownLogged.has(p.protocol)) {
          session.unknownLogged.add(p.protocol);
          this.logger.warn(`${this.who(session)}: ignoring unsupported GT06 protocol 0x${hex(p.protocol)}`);
        }
        await this.ingest.alive(device, session.info);
        return;
      default:
        return;
    }
    this.ack(session, p.protocol, p.serial);
  }

  private async login(session: Session, imei: string, serial: number, protocol: number): Promise<void> {
    if (session.imei && session.imei !== imei) {
      this.reject(session, "IMEI_CHANGED", imei);
      return;
    }
    if (session.device) {
      this.ack(session, protocol, serial); // a repeated login on the same connection
      return;
    }
    session.imei = imei;
    let device: GpsDevice | null;
    try {
      device = await this.ingest.login(imei, session.info);
    } catch (err) {
      this.logger.error(`${this.who(session)}: findDevice failed: ${(err as Error).message}`);
      this.reject(session, "HOST_ERROR", imei);
      return;
    }
    if (!device) {
      this.logger.warn(`${this.who(session)}: unknown device, connection closed`);
      this.reject(session, "UNKNOWN_DEVICE", imei);
      return;
    }
    if (session.closing) return;
    const older = this.byImei.get(imei);
    if (older && older !== session) {
      // A tracker that reconnects after a NAT drop leaves a half-open socket behind: the new one wins.
      this.end(older, "REPLACED");
    }
    session.device = device;
    this.byImei.set(imei, session);
    if (session.loginTimer) clearTimeout(session.loginTimer);
    this.ack(session, protocol, serial);
    await this.ingest.connected(device, session.info);
  }

  private ack(session: Session, protocol: number, serial: number): void {
    if (session.closing || !GT06_ACKED_PROTOCOLS.has(protocol)) return;
    session.socket.write(buildGt06Ack(protocol, serial));
  }

  private reject(session: Session, reason: GpsRejectionReason, imei: string | null = session.imei): void {
    if (session.closing) return;
    session.rejected = true;
    void this.ingest.rejected({ reason, connection: session.info, imei, at: new Date() });
    this.end(session, reason);
  }

  private end(session: Session, reason: GpsDisconnectReason): void {
    if (session.closing) return;
    session.closing = reason;
    session.socket.destroy();
  }

  private onClose(session: Session): void {
    if (!this.sessions.delete(session)) return;
    if (session.loginTimer) clearTimeout(session.loginTimer);
    const ip = session.info.remoteAddress;
    const left = (this.perIp.get(ip) ?? 1) - 1;
    if (left > 0) this.perIp.set(ip, left);
    else this.perIp.delete(ip);
    if (session.imei && this.byImei.get(session.imei) === session) this.byImei.delete(session.imei);
    const reason = session.closing ?? "CLOSED_BY_TRACKER";
    session.closing = reason;
    const device = session.device;
    if (device) {
      // After the packets already queued, so the host sees them before the disconnect.
      session.queue = session.queue
        .then(() => this.ingest.disconnected(device, session.info, reason))
        .catch((err) => this.logger.error(`${this.who(session)}: onDisconnect failed: ${(err as Error).message}`));
    }
  }

  private who(session: Session): string {
    return session.imei ? maskImei(session.imei, this.options.logFullImei) : `unidentified tracker ${session.info.remoteAddress}`;
  }
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
