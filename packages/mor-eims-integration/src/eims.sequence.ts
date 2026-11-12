import { EimsErrorBody, errorStrings } from "./eims.errors";

/** 7015 names the expected invoice counter, 7001 the expected document number. */
const RULES = { invoiceCounter: "7015", documentNumber: "7001" } as const;

/** "... is not in correct sequence expected : 10": the number MoR wants next. */
const EXPECTED = /expected\s*:\s*(\d+)/i;

export interface MorExpectedSequence {
  invoiceCounter?: number;
  documentNumber?: number;
}

/**
 * The sequence numbers MoR says it expects next, read out of a rule rejection.
 *
 * A local state row can disagree with MoR's ledger (a recreated row starts at 1 against a system
 * that has filed forty documents), and every filing then fails 7015 + 7001. The rejection carries
 * the answer:
 *
 *   7015: (id) Invoice Counter is not correct. : Invoice counter is not correct expected : 10
 *   7001: (id) Document number error. : Document number is not in correct sequence expected : 10
 *
 * so the next attempt can use it. Only these two rules are read, and only a plain positive
 * integer is accepted. Self-correction was proven live on 2026-10-09 (a row went from 1 to 40).
 */
export function morExpectedSequence(body: EimsErrorBody | undefined): MorExpectedSequence {
  const found: MorExpectedSequence = {};
  if (!body) return found;
  for (const line of errorStrings(body)) {
    const expected = EXPECTED.exec(line);
    if (!expected) continue;
    const value = Number(expected[1]);
    if (!Number.isSafeInteger(value) || value < 1) continue;
    if (line.includes(RULES.invoiceCounter)) found.invoiceCounter ??= value;
    if (line.includes(RULES.documentNumber)) found.documentNumber ??= value;
  }
  return found;
}

/**
 * MoR sends ackDate as Java's ZonedDateTime#toString(), which drops the seconds when they are
 * zero (2026-08-07T09:05Z[Etc/UTC]). Writes the :00 back; anything else is returned as given.
 */
const SECONDS_LESS_ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?!:\d{2})(.*)$/;

export function normalizeAckDate<T extends string | null | undefined>(ackDate: T): T {
  if (!ackDate) return ackDate;
  return ackDate.replace(SECONDS_LESS_ISO, "$1:00$2") as T;
}
