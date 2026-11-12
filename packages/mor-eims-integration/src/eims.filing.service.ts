import { randomUUID, timingSafeEqual } from "node:crypto";
import { Logger } from "@nestjs/common";
import { EimsCallContext, EimsClient, EimsRegistration } from "./eims.client";
import { EimsCredentialService } from "./eims.credentials";
import { PreparedDocument, buildEimsDocument, prepareDocument } from "./eims.document";
import { EimsError, definitelyNotStored, retryableNotStored, toStoredError } from "./eims.errors";
import { EimsEvent, EimsHost, EimsLedger } from "./eims.host";
import { ResolvedEimsOptions, invalidEimsOptions, missingEimsOptions } from "./eims.options";
import { eimsOperation, redactEimsPayload } from "./eims.redaction";
import { morExpectedSequence } from "./eims.sequence";
import { EimsBulkCallbackItem, EimsDocument, EimsFiling, EimsStoredError, EimsSystemState } from "./eims.types";

export type EimsFilingOutcome =
  | "REGISTERED"
  | "ALREADY_REGISTERED"
  /** MoR refused it for a reason in the document. Numbers given back. FAILED. */
  | "REJECTED"
  /** Not stored, not the document's fault. Numbers given back. Back to NOT_SUBMITTED. */
  | "RETRY_LATER"
  /** Sent, no clear answer. UNKNOWN; the system number is blocked until resolve(). */
  | "UNKNOWN"
  /** Accepted (IRN known) but not saved. The system number is blocked; resolve() with that IRN. */
  | "PERSIST_FAILED";

export interface EimsFilingResult {
  outcome: EimsFilingOutcome;
  documentId: string;
  filing: EimsFiling | null;
  irn?: string;
  error?: EimsStoredError;
}

export type EimsSweepResult =
  | { outcome: "IDLE" }
  | { outcome: "PAUSED"; reason: string }
  | { outcome: "FILED"; documentId: string; result: EimsFilingResult }
  | { outcome: "DRAINED"; documentId: string; error: EimsStoredError }
  | { outcome: "ERROR"; documentId?: string; error: EimsStoredError };

export interface EimsBulkSubmission {
  conversationId: string | null;
  submitted: string[];
  alreadyRegistered: string[];
  /** Set when the submission itself failed (the batch was not accepted for processing). */
  failure?: { outcome: "REJECTED" | "RETRY_LATER" | "UNKNOWN"; error: EimsStoredError };
}

export interface EimsBulkCallbackResult {
  documentId: string;
  documentNumber: string | null;
  applied: boolean;
  message: string;
  irn?: string;
}

interface Reservation {
  systemNumber: string;
  systemType: string;
  invoiceCounter: number;
  documentNumber: number;
  previousIrn: string;
}

const busy = (code: string, message: string) => new EimsError("BUSY", message, { code, sent: false });
const invalid = (code: string, message: string) => new EimsError("INVALID", message, { code, sent: false });

/**
 * Registering documents with MoR: invoices, credit notes and debit notes.
 *
 * The sequence is a durable reservation (EDR's design, proven live). MoR wants every document to
 * carry its next InvoiceCounter (rule 7015), its next DocumentNumber (7001) and the previous
 * document's IRN, and both numbers move only when MoR ACCEPTS. So:
 *
 *  TX1, committed before any HTTP call: lock the system row, refuse if it is blocked or a
 *      submission is in flight, take the numbers, mark the document SUBMITTING;
 *  the call, outside every transaction;
 *  TX2: accepted, record the IRN and chain to it; refused for certain, give the numbers back
 *      (or adopt MoR's "expected : N"); ambiguous, keep the numbers and BLOCK the system number,
 *      because the next document needs a PreviousIrn nobody knows. Only resolve() unblocks it.
 *
 * Never retries an UNKNOWN: MoR may have stored it, and a resend under new numbers would register
 * a duplicate.
 */
export class EimsFilingService {
  private readonly logger = new Logger("EimsFilingService");
  private sweeping = false;

  constructor(
    private readonly options: ResolvedEimsOptions,
    private readonly client: EimsClient,
    private readonly host: EimsHost,
    private readonly credentials: EimsCredentialService,
  ) {}

  private assertConfigured(): void {
    const problems = [...missingEimsOptions(this.options), ...invalidEimsOptions(this.options)];
    if (problems.length) {
      throw new EimsError("CONFIG", `EIMS filing is not configured: ${problems.join(", ")}`, { code: "CONFIG_INCOMPLETE", sent: false });
    }
  }

  /** The stored filing of a document (NOT_SUBMITTED when it has none). */
  async status(documentId: string): Promise<EimsFiling> {
    const filing = await this.host.transaction((ledger) => ledger.lockFiling(documentId));
    if (!filing) throw invalid("NOT_FOUND", `Document ${documentId} not found`);
    return filing;
  }

  /**
   * Register one document. Returns MoR's outcome; throws only when nothing was reserved: INVALID
   * (the document cannot be filed as it is), CONFIG, BUSY (a submission in flight or the system
   * number blocked), or a login failure.
   */
  async register(documentId: string, opts: { trigger?: string } = {}): Promise<EimsFilingResult> {
    this.assertConfigured();
    let document = await this.host.loadDocument(documentId);
    if (!document) throw invalid("NOT_FOUND", `Document ${documentId} not found`);

    const current = await this.status(documentId);
    if (current.irn) return { outcome: "ALREADY_REGISTERED", documentId, filing: current, irn: current.irn };
    if (current.status === "CANCELLED") throw invalid("CANCELLED", `Document ${document.number} is cancelled`);
    if (current.status === "SUBMITTING" || current.status === "UNKNOWN") {
      throw busy("IN_FLIGHT", `Document ${document.number} is ${current.status}: it was sent and is waiting for an answer or a resolve`);
    }

    document = await this.ensureIssued(document);
    const prepared = prepareDocument(document, this.options);
    const context: EimsCallContext = { documentIds: [documentId], trigger: opts.trigger ?? null };
    const session = await this.client.session(context);

    const reserved = await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(session.systemNumber);
      this.assertSequenceFree(state);
      const filing = await this.lockExisting(ledger, documentId);
      if (filing.irn) return { already: filing };
      if (filing.status === "CANCELLED") throw invalid("CANCELLED", `Document ${document!.number} is cancelled`);
      const invoiceCounter = Number(state.nextInvoiceCounter);
      const documentNumber = Number(state.nextDocumentNumber);
      // Consumed now, not on success: once an attempt begins its numbers are never reused.
      await ledger.saveSystemState({
        ...state,
        nextInvoiceCounter: invoiceCounter + 1,
        nextDocumentNumber: documentNumber + 1,
        inFlightDocumentId: documentId,
        inFlightCounter: invoiceCounter,
        inFlightDocumentNumber: documentNumber,
      });
      await ledger.saveFiling({
        ...filing,
        status: "SUBMITTING",
        invoiceCounter,
        documentNumber: String(documentNumber),
        submittedAt: new Date(),
        lastError: null,
      });
      return {
        reservation: {
          systemNumber: session.systemNumber,
          systemType: session.systemType,
          invoiceCounter,
          documentNumber,
          previousIrn: state.previousIrn ?? "",
        } satisfies Reservation,
      };
    });
    if (reserved.already) return { outcome: "ALREADY_REGISTERED", documentId, filing: reserved.already, irn: reserved.already.irn ?? undefined };
    const reservation = reserved.reservation!;

    let registration: EimsRegistration;
    try {
      // Built only now (the numbers come from the reservation), and inside the try: any failure
      // from here on must settle the reservation, never orphan it.
      const request = buildEimsDocument(
        document,
        {
          documentNumber: String(reservation.documentNumber),
          invoiceCounter: reservation.invoiceCounter,
          previousIrn: reservation.previousIrn,
          systemNumber: reservation.systemNumber,
          systemType: reservation.systemType,
        },
        prepared,
        this.options,
      );
      registration = await this.client.register(request, context);
    } catch (err) {
      return this.settleFailure(document, reservation, err);
    }

    try {
      const filing = await this.settleSuccess(documentId, reservation, registration);
      this.logger.log(`Document ${document.number} registered with MoR (counter ${reservation.invoiceCounter}, IRN ${registration.irn})`);
      await this.emit({ type: "REGISTERED", priority: "NORMAL", documentId, documentNumber: document.number, irn: registration.irn, message: `${document.number} was registered with MoR EIMS. IRN: ${registration.irn}` });
      return { outcome: "REGISTERED", documentId, filing, irn: registration.irn };
    } catch (err) {
      return this.blockOnPersistFailure(document, reservation, registration, err);
    }
  }

  /** Stamp an unissued document as issued now, before anything is reserved (filing is issuing). */
  private async ensureIssued(document: EimsDocument): Promise<EimsDocument> {
    if (document.issuedAt) return document;
    if (!this.options.stampIssueDate || !this.host.markIssued) {
      throw invalid("NOT_ISSUED", `Document ${document.number} has no issue date`);
    }
    const issuedAt = new Date();
    await this.host.markIssued(document.id, issuedAt);
    this.logger.log(`Document ${document.number} had no issue date; stamped ${issuedAt.toISOString()} as it was filed`);
    return { ...document, issuedAt };
  }

  private assertSequenceFree(state: EimsSystemState): void {
    if (state.blockedReason) {
      throw busy("SYSTEM_BLOCKED", `EIMS filing is blocked for system ${state.systemNumber}: ${state.blockedReason}`);
    }
    if (state.inFlightDocumentId) {
      throw busy("IN_FLIGHT", `A submission for document ${state.inFlightDocumentId} is in flight on system ${state.systemNumber}; try again when it settles`);
    }
    if (state.inFlightConversationId) {
      throw busy("BULK_IN_FLIGHT", `A bulk submission (${state.inFlightConversationId}) is in flight on system ${state.systemNumber}`);
    }
  }

  private async lockExisting(ledger: EimsLedger, documentId: string): Promise<EimsFiling> {
    const filing = await ledger.lockFiling(documentId);
    if (!filing) throw invalid("NOT_FOUND", `Document ${documentId} not found`);
    return filing;
  }

  /** TX2a: record the IRN, chain to it, release the reservation. */
  private async settleSuccess(documentId: string, reservation: Reservation, registration: EimsRegistration): Promise<EimsFiling> {
    return this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(reservation.systemNumber);
      const filing = await this.lockExisting(ledger, documentId);
      const registered: EimsFiling = {
        ...filing,
        status: "REGISTERED",
        irn: registration.irn,
        ackDate: registration.ackDate,
        signedQr: registration.signedQr,
        lastError: null,
      };
      await ledger.saveFiling(registered);
      const holds = state.inFlightDocumentId === documentId;
      await ledger.saveSystemState({
        ...state,
        previousIrn: registration.irn,
        ...(holds ? { inFlightDocumentId: null, inFlightCounter: null, inFlightDocumentNumber: null, blockedReason: null } : {}),
      });
      return registered;
    });
  }

  /**
   * TX2b. Not stored for certain: the numbers return (MoR counts only accepted documents, and
   * skipping ahead is refused like reusing), or MoR's "expected : N" is adopted. Conditional on the
   * row still holding exactly what TX1 left, so a counter someone corrected while the call was on
   * the wire is not overwritten (EDR lost such a correction twice on 2026-09-17). Ambiguous: the
   * numbers stay taken and the system number is blocked.
   */
  private async settleFailure(document: EimsDocument, reservation: Reservation, err: unknown): Promise<EimsFilingResult> {
    const documentId = document.id;
    const stored = toStoredError(err);
    // Anything that is not an EimsError was thrown by local code before the request left.
    const notStored = !(err instanceof EimsError) || definitelyNotStored(err);
    const retryable = notStored && retryableNotStored(err);
    const expected = err instanceof EimsError && err.kind === "RULE_VALIDATION" ? morExpectedSequence(err.details.body) : {};
    let moved = false;

    const filing = await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(reservation.systemNumber);
      const current = await this.lockExisting(ledger, documentId);
      if (!notStored) {
        const unknown: EimsFiling = { ...current, status: "UNKNOWN", lastError: stored };
        await ledger.saveFiling(unknown);
        await ledger.saveSystemState({
          ...state,
          blockedReason:
            `Document ${document.number} was sent with counter ${reservation.invoiceCounter} / document number ` +
            `${reservation.documentNumber} and never acknowledged (${stored.kind}). Its IRN is unknown, so nothing ` +
            "else can be chained until it is resolved with MoR.",
        });
        return unknown;
      }
      const holds = state.inFlightDocumentId === documentId;
      const untouched =
        holds &&
        Number(state.nextInvoiceCounter) === reservation.invoiceCounter + 1 &&
        Number(state.nextDocumentNumber) === reservation.documentNumber + 1;
      moved = holds && !untouched;
      await ledger.saveSystemState({
        ...state,
        ...(untouched
          ? {
              nextInvoiceCounter: expected.invoiceCounter ?? reservation.invoiceCounter,
              nextDocumentNumber: expected.documentNumber ?? reservation.documentNumber,
            }
          : {}),
        ...(holds ? { inFlightDocumentId: null, inFlightCounter: null, inFlightDocumentNumber: null, blockedReason: null } : {}),
      });
      const settled: EimsFiling = {
        ...current,
        status: retryable ? "NOT_SUBMITTED" : "FAILED",
        invoiceCounter: null,
        documentNumber: null,
        lastError: stored,
        retryCount: retryable ? current.retryCount + 1 : current.retryCount,
      };
      await ledger.saveFiling(settled);
      return settled;
    });

    if (moved) this.logger.warn(`The EIMS sequence moved while ${document.number} was on the wire; released the reservation, left the counters as found`);
    if (expected.invoiceCounter || expected.documentNumber) {
      this.logger.warn(
        `MoR reported a sequence mismatch for ${document.number}; adopted counter ${expected.invoiceCounter ?? reservation.invoiceCounter} / document ${expected.documentNumber ?? reservation.documentNumber}`,
      );
    }
    const outcome: EimsFilingOutcome = !notStored ? "UNKNOWN" : retryable ? "RETRY_LATER" : "REJECTED";
    this.logger.error(`Document ${document.number} EIMS filing ${outcome}: ${stored.message}`);
    await this.emit({
      type: outcome === "UNKNOWN" ? "UNKNOWN" : outcome === "RETRY_LATER" ? "RETRY_LATER" : "REJECTED",
      priority: outcome === "UNKNOWN" ? "HIGH" : "NORMAL",
      documentId,
      documentNumber: document.number,
      error: stored,
      message:
        outcome === "UNKNOWN"
          ? `${document.number} was sent to MoR and never acknowledged (${stored.kind}). All further filing on system ${reservation.systemNumber} is blocked until it is resolved.`
          : outcome === "RETRY_LATER"
            ? `${document.number} was not stored by MoR (${stored.kind}${stored.code ? ` ${stored.code}` : ""}) and stays queued: ${stored.message}`
            : `MoR refused ${document.number} (${stored.kind}${stored.rules?.length ? ` ${stored.rules.join(",")}` : ""}): ${stored.message}`,
    });
    return { outcome, documentId, filing, error: stored };
  }

  /**
   * MoR accepted it (the IRN is known) but saving that failed. Not ambiguous: the IRN must not be
   * lost, so it goes into the block reason and a HIGH event. Resolve with it once fixed; never resend.
   */
  private async blockOnPersistFailure(document: EimsDocument, reservation: Reservation, registration: EimsRegistration, err: unknown): Promise<EimsFilingResult> {
    const reason =
      `Document ${document.number} was ACCEPTED by MoR (IRN ${registration.irn}${registration.ackDate ? `, ack ${registration.ackDate}` : ""}) ` +
      `but saving it failed: ${(err as Error)?.message ?? "unknown error"}. Resolve it with this IRN once fixed; do not resend.`;
    try {
      await this.host.transaction(async (ledger) => {
        const state = await ledger.lockSystemState(reservation.systemNumber);
        await ledger.saveSystemState({ ...state, blockedReason: reason });
      });
    } catch (blockErr) {
      this.logger.error(`Could not record the EIMS block either. ${reason}`, blockErr as Error);
    }
    this.logger.error(reason);
    const error: EimsStoredError = { kind: "PERSIST", message: reason, at: new Date().toISOString() };
    await this.emit({ type: "PERSIST_FAILED", priority: "HIGH", documentId: document.id, documentNumber: document.number, irn: registration.irn, error, message: reason });
    return { outcome: "PERSIST_FAILED", documentId: document.id, filing: null, irn: registration.irn, error };
  }

  /** POST /v1/verify for a registered document. MoR can only be asked by IRN. */
  async verify(documentId: string): Promise<{ irn: string; documentNumber: string | null; type: string | null; date: string | null; body: unknown }> {
    const filing = await this.status(documentId);
    if (!filing.irn) {
      throw invalid("NO_IRN", `Document ${documentId} has no IRN (status ${filing.status}). MoR is queried by IRN only; an unacknowledged submission is resolved instead.`);
    }
    const response = await this.client.verify(filing.irn, { documentIds: [documentId] });
    return {
      irn: response.body!.Irn!,
      documentNumber: response.body?.DocumentDetails?.DocumentNumber ?? null,
      type: response.body?.DocumentDetails?.Type ?? null,
      date: response.body?.DocumentDetails?.Date ?? null,
      body: response.body,
    };
  }

  /**
   * The only way out of an UNKNOWN (or PERSIST_FAILED). With an IRN found in the MoR portal: it is
   * verified at MoR first (the returned Irn must equal it AND its DocumentNumber must be the one
   * this document reserved; a mistyped IRN would otherwise chain every later document to a
   * stranger's), then recorded and the chain resumes from it. With discard: the document is FAILED
   * and its numbers are given back (MoR has no record, so it expects them again; EDR kept them
   * consumed, which cost one 7015/7001 rejection to self-correct).
   */
  async resolve(documentId: string, input: { irn?: string; discard?: boolean }): Promise<EimsFiling> {
    const irn = input.irn?.trim();
    if (!irn && !input.discard) throw invalid("RESOLVE_INPUT", "Give the IRN confirmed with MoR, or discard: true");
    const session = await this.client.session({ documentIds: [documentId] });
    const before = await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(session.systemNumber);
      const filing = await this.lockExisting(ledger, documentId);
      return { state, filing };
    });
    if (before.filing.irn) throw invalid("ALREADY_REGISTERED", `Document ${documentId} already has IRN ${before.filing.irn}`);
    if (before.state.inFlightDocumentId !== documentId) {
      throw invalid(
        "NOT_IN_FLIGHT",
        before.state.inFlightDocumentId
          ? `The submission in flight is document ${before.state.inFlightDocumentId}, not ${documentId}`
          : `Nothing is in flight for document ${documentId}`,
      );
    }
    if (irn) {
      if (!before.filing.documentNumber) throw invalid("NO_DOCUMENT_NUMBER", `Document ${documentId} never reserved a MoR document number`);
      const response = await this.client.verify(irn, { documentIds: [documentId], trigger: "RESOLVE" });
      const returned = response.body?.Irn?.trim();
      const returnedNumber = response.body?.DocumentDetails?.DocumentNumber?.toString().trim();
      if (returned !== irn) throw invalid("RESOLVE_IRN_MISMATCH", `MoR answered the lookup of ${irn} with ${returned ?? "(none)"}; recheck the IRN in the MoR portal`);
      if (returnedNumber !== before.filing.documentNumber) {
        throw invalid(
          "RESOLVE_DOCUMENT_MISMATCH",
          `MoR holds IRN ${irn} against document number ${returnedNumber ?? "(none)"}, not ${before.filing.documentNumber}; recheck the IRN in the MoR portal`,
        );
      }
    }
    const resolved = await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(session.systemNumber);
      const filing = await this.lockExisting(ledger, documentId);
      if (state.inFlightDocumentId !== documentId) throw busy("RESOLVE_RACE", `Document ${documentId} no longer holds the reservation`);
      if (filing.irn) throw invalid("ALREADY_REGISTERED", `Document ${documentId} already has IRN ${filing.irn}`);
      const counter = Number(state.inFlightCounter ?? filing.invoiceCounter);
      const docNo = Number(state.inFlightDocumentNumber ?? filing.documentNumber);
      const giveBack =
        !irn && Number(state.nextInvoiceCounter) === counter + 1 && Number(state.nextDocumentNumber) === docNo + 1;
      const next: EimsFiling = irn
        ? { ...filing, status: "REGISTERED", irn, lastError: null }
        : {
            ...filing,
            status: "FAILED",
            invoiceCounter: null,
            documentNumber: null,
            lastError: { kind: "DISCARDED", message: "Discarded by an operator: MoR has no record of it", at: new Date().toISOString() },
          };
      await ledger.saveFiling(next);
      await ledger.saveSystemState({
        ...state,
        ...(irn ? { previousIrn: irn } : {}),
        ...(giveBack ? { nextInvoiceCounter: counter, nextDocumentNumber: docNo } : {}),
        inFlightDocumentId: null,
        inFlightCounter: null,
        inFlightDocumentNumber: null,
        blockedReason: null,
      });
      return next;
    });
    this.logger.warn(`EIMS block on document ${documentId} resolved (${irn ? `IRN ${irn} recorded` : "discarded"})`);
    await this.emit({ type: "RESOLVED", priority: "NORMAL", documentId, irn, message: `EIMS filing of ${documentId} resolved: ${irn ? `IRN ${irn}` : "discarded"}` });
    return resolved;
  }

  // ── bulk ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * POST /v1/bulkRegister. Reserves a contiguous block of numbers (single and bulk filing share
   * the sequence and block each other), sends one signed envelope around the array, and answers
   * with MoR's conversation id. Results arrive later at the webhook. NOT tested against MoR.
   */
  async registerBulk(documentIds: string[], opts: { trigger?: string } = {}): Promise<EimsBulkSubmission> {
    this.assertConfigured();
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) throw invalid("BULK_EMPTY", "No documents given");
    const prepared: Array<{ document: EimsDocument; prepared: PreparedDocument }> = [];
    const alreadyRegistered: string[] = [];
    for (const id of ids) {
      let document = await this.host.loadDocument(id);
      if (!document) throw invalid("NOT_FOUND", `Document ${id} not found`);
      const filing = await this.status(id);
      if (filing.irn) {
        alreadyRegistered.push(id);
        continue;
      }
      if (filing.status !== "NOT_SUBMITTED" && filing.status !== "FAILED") {
        throw busy("IN_FLIGHT", `Document ${document.number} is ${filing.status}`);
      }
      document = await this.ensureIssued(document);
      // One bad member fails the whole batch here, before anything is reserved.
      prepared.push({ document, prepared: prepareDocument(document, this.options) });
    }
    if (prepared.length === 0) return { conversationId: null, submitted: [], alreadyRegistered };

    const context: EimsCallContext = { documentIds: prepared.map((p) => p.document.id), trigger: opts.trigger ?? null };
    const session = await this.client.session(context);
    const placeholder = `local:${randomUUID()}`;
    const block = await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(session.systemNumber);
      this.assertSequenceFree(state);
      const first = { counter: Number(state.nextInvoiceCounter), docNo: Number(state.nextDocumentNumber), previousIrn: state.previousIrn ?? "" };
      let counter = first.counter;
      let docNo = first.docNo;
      const members: Array<{ document: EimsDocument; prepared: PreparedDocument; counter: number; docNo: number; previousIrn: string }> = [];
      for (const item of prepared) {
        const filing = await this.lockExisting(ledger, item.document.id);
        if (filing.irn) {
          alreadyRegistered.push(item.document.id);
          continue;
        }
        members.push({ ...item, counter, docNo, previousIrn: members.length === 0 ? first.previousIrn : "" });
        await ledger.saveFiling({
          ...filing,
          status: "SUBMITTING",
          invoiceCounter: counter,
          documentNumber: String(docNo),
          submittedAt: new Date(),
          lastError: null,
          bulkConversationId: placeholder,
        });
        counter++;
        docNo++;
      }
      if (members.length) {
        await ledger.saveSystemState({ ...state, nextInvoiceCounter: counter, nextDocumentNumber: docNo, inFlightConversationId: placeholder });
      }
      return { members, first, end: { counter, docNo } };
    });
    if (block.members.length === 0) return { conversationId: null, submitted: [], alreadyRegistered };

    let conversationId: string;
    try {
      const requests = block.members.map((m) =>
        buildEimsDocument(
          m.document,
          { documentNumber: String(m.docNo), invoiceCounter: m.counter, previousIrn: m.previousIrn, systemNumber: session.systemNumber, systemType: session.systemType },
          m.prepared,
          this.options,
        ),
      );
      conversationId = await this.client.bulkRegister(requests, context);
    } catch (err) {
      const failure = await this.settleBulkFailure(session.systemNumber, placeholder, block, err);
      return { conversationId: null, submitted: [], alreadyRegistered, failure };
    }

    await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(session.systemNumber);
      if (state.inFlightConversationId === placeholder) await ledger.saveSystemState({ ...state, inFlightConversationId: conversationId });
      for (const filing of await ledger.lockFilingsByConversation(placeholder)) {
        await ledger.saveFiling({ ...filing, bulkConversationId: conversationId });
      }
    });
    this.logger.log(`Bulk-registered ${block.members.length} document(s) with MoR (conversation ${conversationId}); awaiting the callback`);
    return { conversationId, submitted: block.members.map((m) => m.document.id), alreadyRegistered };
  }

  private async settleBulkFailure(
    systemNumber: string,
    placeholder: string,
    block: { members: Array<{ document: EimsDocument }>; first: { counter: number; docNo: number }; end: { counter: number; docNo: number } },
    err: unknown,
  ): Promise<EimsBulkSubmission["failure"]> {
    const stored = toStoredError(err);
    const notStored = !(err instanceof EimsError) || definitelyNotStored(err);
    const retryable = notStored && retryableNotStored(err);
    await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(systemNumber);
      const filings = await ledger.lockFilingsByConversation(placeholder);
      for (const filing of filings) {
        await ledger.saveFiling(
          notStored
            ? { ...filing, status: retryable ? "NOT_SUBMITTED" : "FAILED", invoiceCounter: null, documentNumber: null, bulkConversationId: null, lastError: stored }
            : { ...filing, status: "UNKNOWN", lastError: stored },
        );
      }
      if (!notStored) {
        await ledger.saveSystemState({
          ...state,
          blockedReason: `A bulk submission of ${block.members.length} document(s) from counter ${block.first.counter} was sent and never acknowledged (${stored.kind}). Resolve it before filing anything else.`,
        });
        return;
      }
      const holds = state.inFlightConversationId === placeholder;
      const untouched = holds && Number(state.nextInvoiceCounter) === block.end.counter && Number(state.nextDocumentNumber) === block.end.docNo;
      await ledger.saveSystemState({
        ...state,
        ...(untouched ? { nextInvoiceCounter: block.first.counter, nextDocumentNumber: block.first.docNo } : {}),
        ...(holds ? { inFlightConversationId: null } : {}),
      });
    });
    const outcome = !notStored ? "UNKNOWN" : retryable ? "RETRY_LATER" : "REJECTED";
    await this.emit({ type: outcome, priority: outcome === "UNKNOWN" ? "HIGH" : "NORMAL", error: stored, message: `EIMS bulk submission ${outcome}: ${stored.message}` });
    return { outcome, error: stored };
  }

  /**
   * MoR's bulk callback. MoR sends no credential, so nothing in it is taken on trust:
   *  - an acceptance is applied only after /v1/verify confirms its IRN AND that the IRN belongs to
   *    the document number this batch reserved;
   *  - a rejection is applied only when the call came with the bulkWebhookToken in its URL;
   *    otherwise it is left SUBMITTING for a person (discardBulk).
   * Unknown conversations are logged and ignored.
   */
  async receiveBulkCallback(items: unknown, token: string | undefined, meta: { sourceIp?: string | null } = {}): Promise<EimsBulkCallbackResult[]> {
    const startedAt = Date.now();
    const authenticated = this.tokenMatches(token);
    let results: EimsBulkCallbackResult[] = [];
    let failure: Error | undefined;
    try {
      results = await this.applyBulkCallback(items, authenticated);
      return results;
    } catch (err) {
      failure = err as Error;
      this.logger.error(`EIMS bulk callback failed: ${failure.message}`);
      return [];
    } finally {
      await this.recordInbound(items, results, failure, meta, startedAt, authenticated);
    }
  }

  private tokenMatches(token: string | undefined): boolean {
    const expected = this.options.bulkWebhookToken;
    if (!expected || !token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async applyBulkCallback(items: unknown, authenticated: boolean): Promise<EimsBulkCallbackResult[]> {
    if (!Array.isArray(items)) return [];
    const list = items as EimsBulkCallbackItem[];
    const marker = list.find((i) => i && typeof i === "object" && ("conversationId" in i || "conversionId" in i)) as
      | { conversationId?: string; conversionId?: string }
      | undefined;
    const conversationId = String(marker?.conversationId ?? marker?.conversionId ?? "").slice(0, 128);
    if (!conversationId || conversationId.startsWith("local:")) {
      this.logger.warn("EIMS bulk callback with no conversation id: ignored");
      return [];
    }
    const filings = await this.host.transaction((ledger) => ledger.lockFilingsByConversation(conversationId));
    if (filings.length === 0) {
      this.logger.warn(`EIMS bulk callback for an unknown or settled conversation ${conversationId}: ignored`);
      return [];
    }
    const byNumber = new Map(filings.map((f) => [f.documentNumber ?? "", f]));
    const results: EimsBulkCallbackResult[] = [];
    const accepted: Array<{ filing: EimsFiling; irn: string; signedQr: string | null }> = [];
    const rejected: Array<{ filing: EimsFiling; message: string }> = [];

    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if ("irn" in item && typeof item.irn === "string") {
        const filing = byNumber.get(String(item.documentNumber ?? ""));
        if (!filing || filing.status !== "SUBMITTING") continue;
        let verified = false;
        try {
          const response = await this.client.verify(item.irn, { documentIds: [filing.documentId], trigger: "BULK_CALLBACK" });
          verified =
            response.body?.Irn?.trim() === item.irn.trim() &&
            String(response.body?.DocumentDetails?.DocumentNumber ?? "").trim() === filing.documentNumber;
        } catch (err) {
          this.logger.warn(`Could not verify bulk callback IRN for document ${filing.documentId}: ${(err as Error).message}`);
        }
        if (verified) {
          accepted.push({ filing, irn: item.irn.trim(), signedQr: item.signedQR ?? null });
        } else {
          results.push({ documentId: filing.documentId, documentNumber: filing.documentNumber, applied: false, message: "IRN not confirmed by /v1/verify; left for a person" });
          await this.emit({ type: "BULK_CALLBACK_UNTRUSTED", priority: "HIGH", documentId: filing.documentId, irn: item.irn, message: `A bulk callback claimed IRN ${item.irn} for document ${filing.documentId}, and MoR's verify did not confirm it` });
        }
      } else if ("ruleError" in item) {
        const filing = byNumber.get(String(item.docNo ?? ""));
        if (!filing || filing.status !== "SUBMITTING") continue;
        const message = (item.ruleError ?? []).flatMap((e) => e?.errorMessage ?? []).join("; ") || "MoR bulk rule error";
        if (authenticated) {
          rejected.push({ filing, message });
        } else {
          results.push({ documentId: filing.documentId, documentNumber: filing.documentNumber, applied: false, message: "Rejection from an unauthenticated callback; left for a person" });
          await this.emit({ type: "BULK_CALLBACK_UNTRUSTED", priority: "NORMAL", documentId: filing.documentId, message: `A bulk callback without the webhook token reported a rejection for document ${filing.documentId}: ${message}` });
        }
      }
    }

    const session = await this.client.session({ trigger: "BULK_CALLBACK" });
    await this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(session.systemNumber);
      let previousIrn = state.previousIrn;
      for (const { filing, irn, signedQr } of accepted.sort((a, b) => (a.filing.invoiceCounter ?? 0) - (b.filing.invoiceCounter ?? 0))) {
        const current = await this.lockExisting(ledger, filing.documentId);
        if (current.status !== "SUBMITTING") continue;
        await ledger.saveFiling({ ...current, status: "REGISTERED", irn, signedQr, lastError: null });
        previousIrn = irn;
        results.push({ documentId: filing.documentId, documentNumber: filing.documentNumber, applied: true, irn, message: `Registered (IRN ${irn})` });
      }
      for (const { filing, message } of rejected) {
        const current = await this.lockExisting(ledger, filing.documentId);
        if (current.status !== "SUBMITTING") continue;
        // The numbers stay consumed as EDR assumes for bulk; a wrong assumption self-corrects through 7015/7001.
        await ledger.saveFiling({ ...current, status: "FAILED", lastError: { kind: "RULE_VALIDATION", message, at: new Date().toISOString() } });
        results.push({ documentId: filing.documentId, documentNumber: filing.documentNumber, applied: true, message });
      }
      const pending = (await ledger.lockFilingsByConversation(conversationId)).filter((f) => f.status === "SUBMITTING");
      await ledger.saveSystemState({
        ...state,
        previousIrn,
        ...(pending.length === 0 && state.inFlightConversationId === conversationId ? { inFlightConversationId: null } : {}),
      });
    });
    return results;
  }

  /** A person's way out of a bulk batch whose callback never came: its waiting documents become FAILED. */
  async discardBulk(conversationId: string): Promise<number> {
    const session = await this.client.session({ trigger: "RESOLVE" });
    return this.host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(session.systemNumber);
      const waiting = (await ledger.lockFilingsByConversation(conversationId)).filter((f) => f.status === "SUBMITTING" || f.status === "UNKNOWN");
      for (const filing of waiting) {
        await ledger.saveFiling({
          ...filing,
          status: "FAILED",
          lastError: { kind: "DISCARDED", message: `Bulk conversation ${conversationId} discarded by an operator`, at: new Date().toISOString() },
        });
      }
      if (state.inFlightConversationId === conversationId) await ledger.saveSystemState({ ...state, inFlightConversationId: null, blockedReason: null });
      return waiting.length;
    });
  }

  private async recordInbound(
    items: unknown,
    results: EimsBulkCallbackResult[],
    failure: Error | undefined,
    meta: { sourceIp?: string | null },
    startedAt: number,
    authenticated: boolean,
  ): Promise<void> {
    if (!this.host.recordExchange) return;
    try {
      await this.host.recordExchange({
        direction: "INBOUND",
        operation: "BULK_CALLBACK",
        path: "bulk-callback",
        attempt: 1,
        documentIds: results.map((r) => r.documentId),
        receiptId: null,
        trigger: authenticated ? "TOKEN" : "NO_TOKEN",
        systemNumber: this.client.currentSystemNumber(),
        statusCode: 200,
        isSuccess: !failure,
        failureKind: failure ? "HANDLER" : null,
        errorMessage: failure?.message?.slice(0, 2000) ?? null,
        requestHeaders: null,
        requestBody: redactEimsPayload(items),
        responseBody: redactEimsPayload(results),
        sourceIp: meta.sourceIp ?? null,
        durationMs: Date.now() - startedAt,
        at: new Date(),
      });
    } catch (err) {
      this.logger.warn(`Could not record the EIMS bulk callback: ${(err as Error).message}`);
    }
  }

  // ── the sweep ────────────────────────────────────────────────────────────────────────────────

  /**
   * One document per call, for a timer of your own (EDR ran it every 5 minutes): slow on purpose,
   * so a misconfiguration costs one rejected document, not a burst. Pauses while the certificate
   * is expired, the system number is blocked or a submission is in flight. Only NOT_SUBMITTED
   * documents are picked (host.nextUnfiledDocument); FAILED waits for a person and UNKNOWN for
   * resolve(). A document refused before anything was reserved is marked FAILED so it does not
   * hold up the ones behind it. Never throws.
   */
  async autoSubmitNext(now = new Date()): Promise<EimsSweepResult> {
    if (!this.host.nextUnfiledDocument) return { outcome: "PAUSED", reason: "host.nextUnfiledDocument is not implemented" };
    if (this.sweeping) return { outcome: "PAUSED", reason: "the previous run is still filing" };
    this.sweeping = true;
    let documentId: string | undefined;
    try {
      const expired = await this.credentials.expiryBlockReason(now);
      if (expired) return { outcome: "PAUSED", reason: expired };
      const session = await this.client.session({ trigger: "AUTO_SUBMIT" });
      const state = await this.host.transaction((ledger) => ledger.lockSystemState(session.systemNumber));
      try {
        this.assertSequenceFree(state);
      } catch (err) {
        return { outcome: "PAUSED", reason: (err as Error).message };
      }
      documentId = (await this.host.nextUnfiledDocument({ maxAgeDays: this.options.maxDocumentAgeDays, now })) ?? undefined;
      if (!documentId) return { outcome: "IDLE" };
      try {
        return { outcome: "FILED", documentId, result: await this.register(documentId, { trigger: "AUTO_SUBMIT" }) };
      } catch (err) {
        if (err instanceof EimsError && err.kind === "INVALID") {
          const error = toStoredError(err);
          const id = documentId;
          await this.host.transaction(async (ledger) => {
            const filing = await ledger.lockFiling(id);
            if (filing && filing.status === "NOT_SUBMITTED") await ledger.saveFiling({ ...filing, status: "FAILED", lastError: error });
          });
          await this.emit({ type: "REJECTED", priority: "NORMAL", documentId: id, error, message: `Auto-submit could not file ${id}: ${error.message}` });
          return { outcome: "DRAINED", documentId: id, error };
        }
        if (err instanceof EimsError && (err.kind === "BUSY" || err.kind === "CONFIG")) return { outcome: "PAUSED", reason: err.message };
        throw err;
      }
    } catch (err) {
      this.logger.error(`EIMS auto-submit run failed: ${(err as Error).message}`);
      return { outcome: "ERROR", documentId, error: toStoredError(err) };
    } finally {
      this.sweeping = false;
    }
  }

  private async emit(event: EimsEvent): Promise<void> {
    try {
      await this.host.onEvent?.(event);
    } catch (err) {
      this.logger.warn(`EIMS event ${event.type} could not be delivered: ${(err as Error).message}`);
    }
  }
}
