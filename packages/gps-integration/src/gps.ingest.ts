import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Gt06AlarmType, Gt06Gps, Gt06Lbs, Gt06Packet, Gt06Status } from "./gt06.codec";
import { GPS_HOST, GpsHost } from "./gps.host";
import { GPS_OPTIONS, ResolvedGpsOptions, maskImei } from "./gps.options";
import type {
  GpsConnectionInfo,
  GpsDevice,
  GpsDisconnectReason,
  GpsIngestReport,
  GpsPosition,
  GpsRejectionEvent,
} from "./gps.types";
import { GpsDropReason, JumpDetector, RecentFixTimes, checkFix } from "./gps.validation";

/** One fix on its way in: from a location packet or from inside an alarm. */
export interface GpsIncomingFix {
  gps: Gt06Gps;
  lbs: Gt06Lbs | null;
  protocol: number;
  source: "LOCATION" | "ALARM";
  alarm?: Gt06AlarmType | null;
  /** 0x22's re-upload flag. */
  reupload?: boolean;
}

export type GpsLocationPacket = Extract<Gt06Packet, { type: "location" }>;
export type GpsAlarmPacket = Extract<Gt06Packet, { type: "alarm" }>;

const MAX_DELIVERED_ALARMS = 10_000;

/**
 * The write path between the GT06 listener and your host: checks each fix, drops duplicates,
 * flags jumps, and hands the host one batch per TCP read. Usable without the listener (feed it
 * packets from your own transport) and without Nest (new GpsIngestService(host, options)).
 */
@Injectable()
export class GpsIngestService {
  private readonly logger = new Logger("GpsIngestService");
  private readonly jumps: JumpDetector;
  private readonly recent = new RecentFixTimes();
  private readonly seenAt = new Map<string, number>();
  private readonly newestFix = new Map<string, number>();
  private readonly deliveredAlarms = new Set<string>();
  /** Overridable clock, for tests. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(GPS_HOST) private readonly host: GpsHost,
    @Inject(GPS_OPTIONS) private readonly options: ResolvedGpsOptions,
  ) {
    this.jumps = new JumpDetector(options.maxImpliedSpeedKmh);
  }

  /** The device for an IMEI, or null to refuse it. Throws whatever the host throws. */
  async login(imei: string, connection: GpsConnectionInfo): Promise<GpsDevice | null> {
    const device = await this.host.findDevice(imei, connection);
    if (!device) return null;
    this.jumps.seed(device.id, device.lastFix ?? null);
    return device;
  }

  async connected(device: GpsDevice, connection: GpsConnectionInfo): Promise<void> {
    await this.host.onConnect?.(device, connection);
    await this.seen(device, connection, true);
  }

  async disconnected(device: GpsDevice, connection: GpsConnectionInfo, reason: GpsDisconnectReason): Promise<void> {
    this.seenAt.delete(device.id);
    await this.host.onDisconnect?.({ device, connection, reason, at: this.now() });
  }

  /** Never throws: a host that cannot record a rejection must not keep a bad connection open. */
  async rejected(event: GpsRejectionEvent): Promise<void> {
    try {
      await this.host.onRejected?.(event);
    } catch (err) {
      this.logger.warn(`onRejected failed: ${(err as Error).message}`);
    }
  }

  /** Location packets of one TCP read, in order: one savePositions call. */
  async locations(device: GpsDevice, connection: GpsConnectionInfo, packets: GpsLocationPacket[]): Promise<GpsIngestReport> {
    const fixes = packets.map(
      (p): GpsIncomingFix => ({ gps: p.gps, lbs: p.lbs, protocol: p.protocol, source: "LOCATION", reupload: p.reupload }),
    );
    const { report } = await this.ingest(device, connection, fixes);
    await this.seen(device, connection);
    return report;
  }

  async heartbeat(device: GpsDevice, connection: GpsConnectionInfo, status: Gt06Status): Promise<void> {
    await this.host.onStatus?.({ device, connection, source: "HEARTBEAT", status, receivedAt: this.now() });
    await this.seen(device, connection);
  }

  /**
   * The alarm's fix is stored first, then onAlarm runs, then onStatus. A resent alarm (its ack was
   * lost) finds its fix already stored and does not call onAlarm a second time, unless the first
   * onAlarm threw.
   */
  async alarm(device: GpsDevice, connection: GpsConnectionInfo, packet: GpsAlarmPacket): Promise<void> {
    let position: GpsPosition | null = null;
    let positionDropped: GpsDropReason | "NO_GPS_BLOCK" | null = null;
    if (packet.gps) {
      const result = await this.ingest(device, connection, [
        { gps: packet.gps, lbs: packet.lbs, protocol: packet.protocol, source: "ALARM", alarm: packet.alarm },
      ]);
      position = result.stored[0] ?? null;
      positionDropped = result.droppedReasons[0] ?? null;
    } else {
      positionDropped = "NO_GPS_BLOCK";
    }
    const key = `${device.id}|${packet.serial}|${packet.status.alarmCode}|${packet.gps?.fixTime.getTime() ?? "-"}`;
    if (!this.deliveredAlarms.has(key)) {
      await this.host.onAlarm?.({
        device,
        connection,
        alarm: packet.alarm,
        alarmCode: packet.status.alarmCode,
        status: packet.status,
        position,
        positionDropped,
        receivedAt: this.now(),
      });
      this.deliveredAlarms.add(key);
      if (this.deliveredAlarms.size > MAX_DELIVERED_ALARMS) {
        const oldest = this.deliveredAlarms.values().next().value;
        if (oldest !== undefined) this.deliveredAlarms.delete(oldest);
      }
    }
    await this.host.onStatus?.({ device, connection, source: "ALARM", status: packet.status, receivedAt: this.now() });
    await this.seen(device, connection);
  }

  /** A valid packet that carries nothing to store (an unknown protocol): the device is alive. */
  async alive(device: GpsDevice, connection: GpsConnectionInfo): Promise<void> {
    await this.seen(device, connection);
  }

  private async ingest(
    device: GpsDevice,
    connection: GpsConnectionInfo,
    fixes: GpsIncomingFix[],
  ): Promise<{ report: GpsIngestReport; stored: GpsPosition[]; droppedReasons: GpsDropReason[] }> {
    const now = this.now();
    const limits = {
      storeUnpositioned: this.options.storeUnpositioned,
      maxFutureSkewMs: this.options.maxFutureSkewMinutes * 60_000,
      maxFixAgeMs: this.options.maxFixAgeMinutes * 60_000,
    };
    const report: GpsIngestReport = { stored: 0, suspect: 0, dropped: {} };
    const droppedReasons: GpsDropReason[] = [];
    const drop = (reason: GpsDropReason) => {
      report.dropped[reason] = (report.dropped[reason] ?? 0) + 1;
      droppedReasons.push(reason);
    };
    const positions: GpsPosition[] = [];
    let newest = this.newestFix.get(device.id) ?? -Infinity;
    for (const f of fixes) {
      const reason = checkFix(f.gps, now, limits);
      if (reason) {
        drop(reason);
        continue;
      }
      if (this.recent.seen(device.id, f.gps.fixTime)) {
        drop("DUPLICATE");
        continue;
      }
      const t = f.gps.fixTime.getTime();
      const jump = f.gps.positioned
        ? this.jumps.check(device.id, {
            latitude: f.gps.latitude,
            longitude: f.gps.longitude,
            fixTime: f.gps.fixTime,
          })
        : { suspect: false, impliedKmh: null };
      positions.push({
        deviceId: device.id,
        imei: device.imei,
        vehicleId: device.vehicleId ?? null,
        fixTime: f.gps.fixTime,
        receivedAt: now,
        latitude: f.gps.latitude,
        longitude: f.gps.longitude,
        speedKmh: f.gps.speedKmh,
        course: f.gps.course,
        satellites: f.gps.satellites,
        positioned: f.gps.positioned,
        suspect: jump.suspect,
        impliedSpeedKmh: jump.impliedKmh == null || !Number.isFinite(jump.impliedKmh) ? null : Math.round(jump.impliedKmh),
        replay: Boolean(f.reupload) || t < newest,
        source: f.source,
        alarm: f.alarm ?? null,
        protocol: f.protocol,
        lbs: f.lbs,
      });
      if (t > newest) newest = t;
    }
    if (!positions.length) return { report, stored: [], droppedReasons };

    const trusted = positions.filter((p) => p.positioned && !p.suspect);
    const latest = trusted.length
      ? trusted.reduce((a, b) => (b.fixTime.getTime() >= a.fixTime.getTime() ? b : a))
      : null;
    try {
      await this.host.savePositions({ device, connection, positions, latest });
    } catch (err) {
      // Let the resend through next time.
      for (const p of positions) this.recent.unsee(device.id, p.fixTime);
      throw err;
    }
    this.newestFix.set(device.id, newest);
    report.stored = positions.length;
    report.suspect = positions.filter((p) => p.suspect).length;
    if (report.suspect) {
      this.logger.warn(
        `${maskImei(device.imei, this.options.logFullImei)}: ${report.suspect} fix(es) imply more than ` +
          `${this.options.maxImpliedSpeedKmh} km/h from the last trusted one; stored as suspect`,
      );
    }
    return { report, stored: positions, droppedReasons };
  }

  private async seen(device: GpsDevice, connection: GpsConnectionInfo, force = false): Promise<void> {
    if (!this.host.markSeen) return;
    const now = this.now();
    const last = this.seenAt.get(device.id);
    if (!force && last !== undefined && now.getTime() - last < this.options.seenThrottleMs) return;
    this.seenAt.set(device.id, now.getTime());
    try {
      await this.host.markSeen(device, now, connection);
    } catch (err) {
      this.seenAt.delete(device.id);
      throw err;
    }
  }
}
