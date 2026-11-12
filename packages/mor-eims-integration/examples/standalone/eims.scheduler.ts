import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { EimsCredentialService, EimsFilingService, EimsReceiptService } from "@edr/mor-eims-integration";

export const SWEEP_EVERY_MS = Symbol("SWEEP_EVERY_MS");

/**
 * The timers the package leaves to you. Each run files at most one document and one receipt:
 * slow on purpose (EDR: every 5 minutes), so a misconfiguration costs one rejection, not a burst.
 * The certificate-expiry check runs on its own daily-ish timer. 0 turns the sweeps off.
 *
 * With several API instances, every instance may run this: the reservation and the receipt slot
 * are taken under row locks, so two sweeps never file the same thing.
 */
@Injectable()
export class EimsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EimsScheduler.name);
  private sweep?: NodeJS.Timeout;
  private expiry?: NodeJS.Timeout;

  constructor(
    private readonly filings: EimsFilingService,
    private readonly receipts: EimsReceiptService,
    private readonly credentials: EimsCredentialService,
    @Inject(SWEEP_EVERY_MS) private readonly everyMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.everyMs <= 0) return;
    this.sweep = setInterval(() => void this.run(), this.everyMs);
    this.sweep.unref();
    this.expiry = setInterval(() => void this.credentials.checkCertificateExpiry().catch(() => undefined), 6 * 3_600_000);
    this.expiry.unref();
  }

  onModuleDestroy(): void {
    if (this.sweep) clearInterval(this.sweep);
    if (this.expiry) clearInterval(this.expiry);
  }

  async run(): Promise<void> {
    const filing = await this.filings.autoSubmitNext();
    if (filing.outcome !== "IDLE") this.logger.log(`EIMS sweep: ${filing.outcome}${"documentId" in filing ? ` ${filing.documentId}` : ""}`);
    const receipt = await this.receipts.autoFileNext();
    if (receipt.outcome !== "IDLE") this.logger.log(`EIMS receipt sweep: ${receipt.outcome}`);
  }
}
