import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { EimsBuyer, EimsDocumentLine, MemoLineAmount, memoLines } from "@edr/mor-eims-integration";
import { TypeOrmEimsHost } from "./typeorm-eims.host";

export interface CreateInvoiceInput {
  number: string;
  currency?: string;
  exchangeRate?: number;
  issuedAt?: string | null;
  buyer: EimsBuyer;
  paymentMode?: string;
  lines: Array<{ chargeType: string; description?: string; quantity: number; unitPrice: number; amount: number; basis?: string }>;
}

export interface CreateMemoInput {
  type: "CRE" | "DEB";
  number: string;
  reason: string;
  amount?: number;
  lines?: MemoLineAmount[];
}

export interface RecordPaymentInput {
  key?: string;
  amount: number;
  paidAt?: string;
  method?: string;
  modeOfPayment?: string;
  channel?: string;
  reference?: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The example's invoicing: just enough to have documents, memos and payments to file. */
@Injectable()
export class InvoicesService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly host: TypeOrmEimsHost,
  ) {}

  async create(input: CreateInvoiceInput, extra: { type?: string; reason?: string; relatedId?: string } = {}): Promise<{ id: string }> {
    if (!input.lines?.length) throw new BadRequestException("An invoice needs lines");
    const total = round2(input.lines.reduce((sum, l) => sum + Number(l.amount), 0));
    return this.db.transaction(async (m) => {
      const [row] = await m.query(
        `INSERT INTO ${this.host.t("invoices")} ("invoice_number", "document_type", "reason", "related_invoice_id", "currency", "exchange_rate", "total_amount", "issued_at", "buyer", "payment_mode")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING "id"`,
        [
          input.number,
          extra.type ?? "INV",
          extra.reason ?? null,
          extra.relatedId ?? null,
          input.currency ?? "ETB",
          input.exchangeRate ?? null,
          total,
          input.issuedAt === undefined ? new Date() : input.issuedAt,
          JSON.stringify(input.buyer),
          input.paymentMode ?? null,
        ],
      );
      let lineNo = 1;
      for (const line of input.lines) {
        await m.query(
          `INSERT INTO ${this.host.t("invoice_lines")} ("invoice_id", "line_no", "charge_type", "description", "quantity", "unit_price", "amount", "basis")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [row.id, lineNo++, line.chargeType, line.description ?? null, line.quantity, line.unitPrice, line.amount, line.basis ?? null],
        );
      }
      return { id: row.id };
    });
  }

  /** A credit or debit note that restates the original's filed lines (rule 7020). */
  async createMemo(originalId: string, input: CreateMemoInput): Promise<{ id: string }> {
    const original = await this.host.loadDocument(originalId);
    if (!original) throw new NotFoundException(`Invoice ${originalId} not found`);
    const lines: EimsDocumentLine[] = memoLines(
      { type: original.type, number: original.number, lines: original.lines },
      input.type,
      input.lines?.length ? { lines: input.lines } : { amount: Number(input.amount) },
    );
    return this.create(
      {
        number: input.number,
        currency: original.currency,
        exchangeRate: original.exchangeRate ?? undefined,
        buyer: original.buyer,
        lines: lines.map((l) => ({
          chargeType: l.chargeType,
          description: l.description ?? undefined,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          amount: Number(l.amount),
          basis: l.basis ?? undefined,
        })),
      },
      { type: input.type, reason: input.reason, relatedId: originalId },
    );
  }

  async recordPayment(invoiceId: string, input: RecordPaymentInput): Promise<{ key: string }> {
    const key = input.key ?? `pay-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    await this.db.query(
      `INSERT INTO ${this.host.t("invoice_payments")} ("invoice_id", "payment_key", "amount", "paid_at", "method", "mode_of_payment", "channel", "reference")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [invoiceId, key, input.amount, input.paidAt ?? new Date(), input.method ?? null, input.modeOfPayment ?? null, input.channel ?? null, input.reference ?? null],
    );
    return { key };
  }
}
