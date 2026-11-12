import { EimsError } from "./eims.errors";
import { eimsLineFigures, num, round2 } from "./eims.document";
import { EimsDocumentLine, EimsDocumentType } from "./eims.types";

const invalid = (code: string, message: string): never => {
  throw new EimsError("INVALID", message, { code, sent: false });
};

export interface MemoLineAmount {
  /** Position of the original line, from 0. */
  index: number;
  amount: number;
  /** How many of the line's units this memo adjusts. Omitted: the whole line. */
  quantity?: number;
}

/**
 * The lines of a credit or debit note against an original invoice.
 *
 * Rule 7020 (live, 2026-09-17): a memo must restate the referenced document's items. MoR compares
 * them line by line on Product, Qty, TaxCode, Unit and Nature; only the money may differ. A
 * one-line "Credit memo" was refused with "Item mismatch at line 1". So every memo line copies an
 * original line as it was FILED: its description, its charge type (which decides the tax code),
 * and its quantity, where a collapsed original (filed as 1 x amount under a description naming the
 * billed quantity) is restated as quantity 1 with that filed description.
 *
 * Accepted elsewhere (another system's documents with MoR test IRNs): a memo can carry only some
 * of the original's lines, a lower quantity than the original's, and a different unit price.
 *
 * `spec.amount`: spread across all lines in proportion to what each carried, the rounding
 * remainder on the last line. `spec.lines`: exactly these lines, each with its own amount.
 */
export function memoLines(
  original: { type?: EimsDocumentType; number?: string; lines: EimsDocumentLine[] },
  memoType: "CRE" | "DEB",
  spec: { amount: number } | { lines: MemoLineAmount[] },
): EimsDocumentLine[] {
  if ((original.type ?? "INV") !== "INV") invalid("MEMO_OF_MEMO", "A memo cannot be issued against another memo");
  const lines = original.lines ?? [];
  if (lines.length === 0) invalid("NO_LINES", `The original ${original.number ?? ""} has no lines to restate`.trim());

  const restate = (line: EimsDocumentLine, amount: number, units?: number): EimsDocumentLine => {
    const filed = eimsLineFigures(line, "INV");
    const billed = round2(num(line.quantity, "original quantity"));
    let quantity = filed.collapsed ? 1 : (units ?? billed);
    if (!(quantity > 0)) invalid("MEMO_QUANTITY", `A memo line needs a quantity above zero`);
    if (memoType === "CRE" && !filed.collapsed && quantity > billed) {
      invalid("MEMO_QUANTITY", `A credit cannot return ${quantity} units of "${filed.description}"; ${billed} were billed`);
    }
    if (filed.collapsed) quantity = 1;
    return {
      chargeType: line.chargeType,
      description: filed.description,
      quantity,
      unitPrice: round2(amount / quantity),
      amount: round2(amount),
      basis: line.basis ?? null,
    };
  };

  if ("amount" in spec) {
    const total = round2(spec.amount);
    if (!(total > 0)) invalid("MEMO_AMOUNT", "A memo amount must be above zero");
    const weights = lines.map((line) => round2(num(line.amount, "original amount")));
    const sum = round2(weights.reduce((a, b) => a + b, 0));
    if (!(sum > 0)) invalid("MEMO_AMOUNT", "The original lines carry no amount to spread over");
    if (memoType === "CRE" && total - sum > 0.001) invalid("MEMO_AMOUNT", `A credit of ${total} exceeds the original's ${sum}`);
    let left = total;
    return lines.map((line, index) => {
      const share = index === lines.length - 1 ? round2(left) : round2((total * weights[index]) / sum);
      left = round2(left - share);
      return restate(line, share);
    });
  }

  if (!spec.lines?.length) invalid("MEMO_LINES", "Name at least one line, or give an amount");
  const seen = new Set<number>();
  return [...spec.lines]
    .sort((a, b) => a.index - b.index)
    .map((selection) => {
      const line = lines[selection.index];
      if (!line) invalid("MEMO_LINES", `Line ${selection.index} is not on the original`);
      if (seen.has(selection.index)) invalid("MEMO_LINES", `Line ${selection.index} is named twice`);
      seen.add(selection.index);
      const amount = round2(selection.amount);
      if (!(amount > 0)) invalid("MEMO_AMOUNT", `Line ${selection.index}: the amount must be above zero`);
      if (memoType === "CRE" && amount - round2(num(line.amount, "original amount")) > 0.001) {
        invalid("MEMO_AMOUNT", `Line ${selection.index}: a credit of ${amount} exceeds the ${line.amount} billed`);
      }
      return restate(line, amount, selection.quantity);
    });
}
