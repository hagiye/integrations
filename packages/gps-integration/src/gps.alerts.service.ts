import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { GpsError } from "./gps.errors";
import { GPS_HOST, GpsHost, hostHasAlerts } from "./gps.host";
import { GPS_OPTIONS, ResolvedGpsOptions } from "./gps.options";
import { GpsVehicleCondition, describeGpsAlert, evaluateVehicle, planGpsAlerts } from "./gps.alerts.rules";

export interface GpsAlertScanResult {
  opened: number;
  notified: number;
  touched: number;
  resolved: number;
  /** A scan was already running: this call did nothing. */
  skipped: boolean;
}

/**
 * Tracking alerts: every scanEveryMs (EDR: a cron every minute) the host's snapshot is evaluated,
 * then alerts are opened, touched and resolved through the host. One scan at a time per process;
 * across replicas the host's partial unique index on open alerts keeps a racing scan from opening
 * the same alert twice (openAlert returns null).
 */
@Injectable()
export class GpsAlertService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("GpsAlertService");
  private scanning = false;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(GPS_HOST) private readonly host: GpsHost,
    @Inject(GPS_OPTIONS) private readonly options: ResolvedGpsOptions,
  ) {}

  /** True when the host implements the alert methods and alerts are not switched off. */
  get active(): boolean {
    return this.options.alerts.enabled && hostHasAlerts(this.host);
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Starts the timer (Nest does this at bootstrap). No-op when inactive or scanEveryMs is 0. */
  start(): void {
    if (this.timer || !this.active || this.options.alerts.scanEveryMs <= 0) return;
    this.timer = setInterval(() => {
      this.scan(new Date()).catch((err) => this.logger.error(`GPS alert scan failed: ${(err as Error).message}`));
    }, this.options.alerts.scanEveryMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan(now: Date = new Date()): Promise<GpsAlertScanResult> {
    if (!hostHasAlerts(this.host)) {
      throw new GpsError("CONFIG", "GpsAlertService needs a host with loadAlertInputs, openAlert, touchAlert and resolveAlert", {
        code: "NOT_ALERT_HOST",
      });
    }
    const empty = { opened: 0, notified: 0, touched: 0, resolved: 0 };
    if (this.scanning) return { ...empty, skipped: true };
    this.scanning = true;
    try {
      return { ...(await this.run(now)), skipped: false };
    } finally {
      this.scanning = false;
    }
  }

  private async run(now: Date): Promise<Omit<GpsAlertScanResult, "skipped">> {
    const a = this.options.alerts;
    const cooldownMs = a.cooldownMinutes * 60_000;
    const host = this.host as Required<Pick<GpsHost, "loadAlertInputs" | "openAlert" | "touchAlert" | "resolveAlert">> & GpsHost;
    const inputs = await host.loadAlertInputs({ now, resolvedSince: new Date(now.getTime() - cooldownMs) });
    const thresholds = inputs.thresholds ?? a.defaultThresholds;
    const conditions: GpsVehicleCondition[] = [];
    const labels = new Map<string, string | null>();
    for (const v of inputs.vehicles) {
      labels.set(v.vehicleId, v.label ?? null);
      for (const c of evaluateVehicle(v, thresholds, inputs.geofences, now, { fixMaxAgeMinutes: a.fixMaxAgeMinutes })) {
        conditions.push({ ...c, vehicleId: v.vehicleId, deviceId: v.deviceId });
      }
    }
    const plan = planGpsAlerts(inputs.open, inputs.recentlyResolved, conditions, now, {
      resolveAfterMs: a.resolveAfterMinutes * 60_000,
      cooldownMs,
    });

    for (const r of plan.toResolve) await host.resolveAlert({ id: r.id, resolvedAt: now });
    for (const t of plan.toTouch) await host.touchAlert({ id: t.id, lastSeenAt: now, details: t.details });
    let opened = 0;
    let notified = 0;
    for (const { condition, notify } of plan.toOpen) {
      const id = await host.openAlert({ condition, startedAt: now });
      if (!id) continue; // another scan opened it first
      opened += 1;
      if (!notify || !host.notifyAlert) continue;
      const label = labels.get(condition.vehicleId) ?? null;
      const text = describeGpsAlert(condition, label);
      try {
        await host.notifyAlert({
          id,
          vehicleId: condition.vehicleId,
          deviceId: condition.deviceId ?? null,
          kind: condition.kind,
          geofenceId: condition.geofenceId ?? null,
          details: condition.details,
          startedAt: now,
          label,
          ...text,
        });
        notified += 1;
      } catch (err) {
        this.logger.warn(`GPS alert notification failed: ${(err as Error).message}`);
      }
    }
    return { opened, notified, touched: plan.toTouch.length, resolved: plan.toResolve.length };
  }
}
