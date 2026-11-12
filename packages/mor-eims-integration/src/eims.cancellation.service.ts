import { Logger } from "@nestjs/common";
import { EimsClient } from "./eims.client";
import { EimsError, errorStrings } from "./eims.errors";
import { EimsHost } from "./eims.host";
import { EimsBulkCancelResponseItem, EimsFiling } from "./eims.types";

const invalid = (code: string, message: string) => new EimsError("INVALID", message, { code, sent: false });

/** MoR's answer to a second cancel of the same IRN. */
const ALREADY_CANCELLED = /already\s+cancel+ed/i;

export function isAlreadyCancelled(err: unknown): boolean {
  if (!(err instanceof EimsError)) return false;
  return ALREADY_CANCELLED.test(err.message) || errorStrings(err.details.body).some((s) => ALREADY_CANCELLED.test(s));
}

export interface EimsBulkCancelItem {
  documentId: string;
  reasonCode: string;
  remark?: string;
}

export interface EimsBulkCancelResult {
  documentId: string;
  success: boolean;
  message: string;
}

/**
 * POST /v1/cancel and /v1/bulkCancel. A cancel carries no counter, so there is no reservation:
 * check under a lock, call outside it, record under a lock again. A retried cancel is safe: MoR
 * answers a second one with "IRN already Canceled.", which is recorded as done here (EDR treats it
 * as a failure, so a cancel whose first answer was lost can never be recorded). Locally, a second
 * cancel is refused with an error, as MoR's checklist (IRC-N010) expects. CANCELLED is final.
 *
 * Not tested live since MoR required the signed envelope: that means cancelling a real document.
 */
export class EimsCancellationService {
  private readonly logger = new Logger("EimsCancellationService");

  constructor(
    private readonly client: EimsClient,
    private readonly host: EimsHost,
  ) {}

  private checkReason(reasonCode: string): string {
    const code = String(reasonCode ?? "").trim();
    if (!/^[0-9]{1,3}$/.test(code)) throw invalid("CANCEL_REASON", `ReasonCode must be MoR's numeric code ("1" duplicate, "6" calculation error), not "${reasonCode}"`);
    return code;
  }

  private async eligible(documentId: string): Promise<EimsFiling> {
    return this.host.transaction(async (ledger) => {
      const filing = await ledger.lockFiling(documentId);
      if (!filing) throw invalid("NOT_FOUND", `Document ${documentId} not found`);
      if (filing.status === "CANCELLED") {
        throw invalid("ALREADY_CANCELLED", `Document ${documentId} was already cancelled with MoR${filing.cancellationDate ? ` (${filing.cancellationDate})` : ""}`);
      }
      if (!filing.irn) throw invalid("NOT_REGISTERED", `Document ${documentId} was never registered with MoR: nothing to cancel`);
      return filing;
    });
  }

  private async record(documentId: string, reasonCode: string, remark: string | null, cancellationDate: string | null): Promise<EimsFiling> {
    return this.host.transaction(async (ledger) => {
      const filing = await ledger.lockFiling(documentId);
      if (!filing) throw invalid("NOT_FOUND", `Document ${documentId} not found`);
      if (filing.status === "CANCELLED") return filing;
      const cancelled: EimsFiling = {
        ...filing,
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationDate,
        cancellationReasonCode: reasonCode,
        cancellationRemark: remark,
      };
      await ledger.saveFiling(cancelled);
      return cancelled;
    });
  }

  async cancel(documentId: string, reasonCode: string, remark?: string): Promise<EimsFiling> {
    const code = this.checkReason(reasonCode);
    const filing = await this.eligible(documentId);
    let cancellationDate: string | null = null;
    try {
      const response = await this.client.cancel({ Irn: filing.irn!, ReasonCode: code, Remark: remark ?? "" }, { documentIds: [documentId] });
      cancellationDate = response?.body?.cancellationDate ?? null;
    } catch (err) {
      if (!isAlreadyCancelled(err)) throw err;
      this.logger.warn(`MoR already holds ${filing.irn} as cancelled; recording it`);
    }
    const cancelled = await this.record(documentId, code, remark ?? null, cancellationDate);
    this.logger.log(`Document ${documentId} cancelled with MoR (IRN ${filing.irn})`);
    try {
      await this.host.onEvent?.({ type: "CANCELLED", priority: "NORMAL", documentId, irn: filing.irn!, message: `Document ${documentId} was cancelled with MoR EIMS` });
    } catch (err) {
      this.logger.warn(`EIMS event CANCELLED could not be delivered: ${(err as Error).message}`);
    }
    return cancelled;
  }

  /** One MoR call for every eligible document; ineligible ones are refused locally and take no seat in the batch. */
  async cancelBulk(items: EimsBulkCancelItem[]): Promise<EimsBulkCancelResult[]> {
    const results = new Map<string, EimsBulkCancelResult>();
    const eligible: Array<{ item: EimsBulkCancelItem; code: string; irn: string }> = [];
    for (const item of items) {
      try {
        const code = this.checkReason(item.reasonCode);
        const filing = await this.eligible(item.documentId);
        eligible.push({ item, code, irn: filing.irn! });
      } catch (err) {
        results.set(item.documentId, { documentId: item.documentId, success: false, message: (err as Error).message });
      }
    }
    if (eligible.length) {
      const response = await this.client.bulkCancel(
        eligible.map((e) => ({ Irn: e.irn, ReasonCode: e.code, Remark: e.item.remark ?? "" })),
        { documentIds: eligible.map((e) => e.item.documentId) },
      );
      const byIrn = new Map<string, EimsBulkCancelResponseItem>((response?.body ?? []).map((entry) => [entry.Irn, entry]));
      for (const { item, code, irn } of eligible) {
        const entry = byIrn.get(irn);
        const failed = !entry || "Status" in entry;
        const message = entry && "msg" in entry ? entry.msg : "MoR returned no result for this IRN";
        if (failed && !ALREADY_CANCELLED.test(message)) {
          results.set(item.documentId, { documentId: item.documentId, success: false, message });
          continue;
        }
        // A bulk success carries no cancellationDate.
        await this.record(item.documentId, code, item.remark ?? null, null);
        results.set(item.documentId, { documentId: item.documentId, success: true, message: `Cancelled with MoR (IRN ${irn})` });
      }
    }
    return items.map((item) => results.get(item.documentId)!);
  }
}
