import { FakeEimsHost, invoice, optionsFor, wire } from "../test/fakes";
import { SYSTEM_NUMBER, testPair } from "../test/fixtures";
import { MockMor, mockConfig } from "../test/mock-mor";

describe("EimsFilingService", () => {
  const pair = testPair("filing");
  let mock: MockMor;
  let host: FakeEimsHost;
  let svc: ReturnType<typeof wire>;

  beforeAll(async () => {
    mock = new MockMor(mockConfig(pair.fingerprint256));
    await mock.start();
  });
  afterAll(() => mock.stop());
  beforeEach(() => {
    mock.reset();
    mock.ledger = { nextCounter: 1, nextDocumentNumber: 1, previousIrn: "" };
    mock.documents.clear();
    host = new FakeEimsHost();
    svc = wire(host, optionsFor(mock.url, pair));
  });

  const add = (id: string, overrides = {}) => host.documents.set(id, invoice(id, overrides));

  it("registers, chains the next document to its IRN, and is idempotent", async () => {
    add("a");
    add("b");
    const first = await svc.filings.register("a");
    expect(first).toMatchObject({ outcome: "REGISTERED", irn: expect.stringMatching(/^test-[0-9a-f]{64}$/) });
    expect(first.filing).toMatchObject({ status: "REGISTERED", documentNumber: "1", invoiceCounter: 1, ackDate: expect.stringMatching(/:00Z\[Etc\/UTC\]$/) });
    const second = await svc.filings.register("b");
    expect(second.filing).toMatchObject({ documentNumber: "2", invoiceCounter: 2 });
    expect((mock.calls.filter((c) => c.path === "/v1/register")[1].request as any).ReferenceDetails.PreviousIrn).toBe(first.irn);

    const again = await svc.filings.register("a");
    expect(again).toMatchObject({ outcome: "ALREADY_REGISTERED", irn: first.irn });
    expect(mock.countCalls("/v1/register")).toBe(2);
    expect(host.state(SYSTEM_NUMBER)).toMatchObject({ nextInvoiceCounter: 3, nextDocumentNumber: 3, previousIrn: second.irn, inFlightDocumentId: null });
    expect(host.events.filter((e) => e.type === "REGISTERED")).toHaveLength(2);
  });

  it("gives the numbers back on a rejection, and adopts MoR's expected : N", async () => {
    add("a", { buyer: { ...invoice("a").buyer, legalName: "Afri" } });
    mock.config.sellerLegalName = "Someone Else";
    const rejected = await svc.filings.register("a");
    mock.config.sellerLegalName = "Test Seller PLC";
    expect(rejected).toMatchObject({ outcome: "REJECTED", error: { kind: "RULE_VALIDATION", rules: ["7017"] } });
    expect(rejected.filing).toMatchObject({ status: "FAILED", documentNumber: null });
    expect(host.state(SYSTEM_NUMBER)).toMatchObject({ nextInvoiceCounter: 1, nextDocumentNumber: 1, inFlightDocumentId: null, blockedReason: null });

    // MoR's ledger is ahead (a restored database): the rejection names the numbers, the next attempt uses them.
    mock.ledger = { nextCounter: 40, nextDocumentNumber: 40, previousIrn: "" };
    add("b");
    const desynced = await svc.filings.register("b");
    expect(desynced).toMatchObject({ outcome: "REJECTED", error: { rules: expect.arrayContaining(["7015", "7001"]) } });
    expect(host.state(SYSTEM_NUMBER)).toMatchObject({ nextInvoiceCounter: 40, nextDocumentNumber: 40 });
    host.filings.set("b", { ...host.filing("b"), status: "NOT_SUBMITTED" });
    expect(await svc.filings.register("b")).toMatchObject({ outcome: "REGISTERED", filing: { documentNumber: "40" } });
  });

  it("keeps a document queued when MoR's buyer lookup is down (503) or it is rate limited", async () => {
    add("a");
    mock.buyerLookupDown.add("0089238373");
    const down = await svc.filings.register("a");
    expect(down).toMatchObject({ outcome: "RETRY_LATER", filing: { status: "NOT_SUBMITTED", retryCount: 1 }, error: { code: "BUYER_LOOKUP_UNAVAILABLE" } });
    mock.buyerLookupDown.clear();
    mock.failNext("/v1/register", "429");
    expect(await svc.filings.register("a")).toMatchObject({ outcome: "RETRY_LATER", filing: { retryCount: 2 } });
    expect(await svc.filings.register("a")).toMatchObject({ outcome: "REGISTERED", filing: { documentNumber: "1" } });
  });

  it("blocks the system number on a timeout, refuses everything else, and resolves with the IRN MoR holds", async () => {
    add("a");
    add("b");
    mock.failNext("/v1/register", "reset-after");
    const lost = await svc.filings.register("a");
    expect(lost).toMatchObject({ outcome: "UNKNOWN", filing: { status: "UNKNOWN", documentNumber: "1" } });
    expect(host.state(SYSTEM_NUMBER).blockedReason).toMatch(/never acknowledged/);
    expect(host.events.find((e) => e.type === "UNKNOWN")).toMatchObject({ priority: "HIGH" });
    await expect(svc.filings.register("b")).rejects.toMatchObject({ kind: "BUSY", details: { code: "SYSTEM_BLOCKED" } });

    const storedIrn = [...mock.documents.keys()][0];
    await expect(svc.filings.resolve("a", { irn: "test-typo" })).rejects.toMatchObject({ kind: "UNKNOWN" });
    const other = { irn: "test-other", request: { DocumentDetails: { Type: "INV" } }, documentNumber: "99", counter: 99, cancelled: false, cancellationDate: null };
    mock.documents.set("test-other", other);
    await expect(svc.filings.resolve("a", { irn: "test-other" })).rejects.toMatchObject({ details: { code: "RESOLVE_DOCUMENT_MISMATCH" } });
    mock.documents.delete("test-other");

    const resolved = await svc.filings.resolve("a", { irn: storedIrn });
    expect(resolved).toMatchObject({ status: "REGISTERED", irn: storedIrn });
    expect(host.state(SYSTEM_NUMBER)).toMatchObject({ blockedReason: null, inFlightDocumentId: null, previousIrn: storedIrn, nextDocumentNumber: 2 });
    expect(await svc.filings.register("b")).toMatchObject({ outcome: "REGISTERED", filing: { documentNumber: "2" } });
  });

  it("discarding an attempt MoR never stored gives its numbers back", async () => {
    add("a");
    mock.failNext("/v1/register", "timeout");
    expect(await svc.filings.register("a")).toMatchObject({ outcome: "UNKNOWN" });
    await svc.filings.resolve("a", { discard: true });
    expect(host.filing("a")).toMatchObject({ status: "FAILED", lastError: { kind: "DISCARDED" } });
    expect(host.state(SYSTEM_NUMBER)).toMatchObject({ nextInvoiceCounter: 1, nextDocumentNumber: 1, blockedReason: null });
  });

  it("treats a 200 without an IRN as unknown, not as a rejection", async () => {
    add("a");
    mock.failNext("/v1/register", "no-irn");
    expect(await svc.filings.register("a")).toMatchObject({ outcome: "UNKNOWN", error: { code: "NO_IRN" } });
  });

  it("puts an accepted IRN that could not be saved into the block reason and a HIGH event", async () => {
    add("a");
    host.failNextSaveOf = "REGISTERED";
    const result = await svc.filings.register("a");
    expect(result).toMatchObject({ outcome: "PERSIST_FAILED", irn: expect.stringMatching(/^test-/) });
    expect(host.state(SYSTEM_NUMBER).blockedReason).toContain(result.irn);
    expect(host.events.find((e) => e.type === "PERSIST_FAILED")).toMatchObject({ priority: "HIGH", irn: result.irn });
    expect(await svc.filings.resolve("a", { irn: result.irn! })).toMatchObject({ status: "REGISTERED" });
  });

  it("refuses locally before reserving, and stamps an unissued document as issued now", async () => {
    add("a", { buyer: { ...invoice("a").buyer, tin: "I000000001" } });
    await expect(svc.filings.register("a")).rejects.toMatchObject({ kind: "INVALID", details: { code: "BUYER_TIN_REQUIRED" } });
    expect(mock.countCalls("/v1/register")).toBe(0);
    expect(host.state(SYSTEM_NUMBER).nextInvoiceCounter).toBe(1);

    add("b", { issuedAt: null });
    expect(await svc.filings.register("b")).toMatchObject({ outcome: "REGISTERED" });
    expect(host.issued.map((i) => i.documentId)).toEqual(["b"]);
  });

  it("lets only one of two racing documents reserve; the other is told to wait", async () => {
    add("a");
    add("b");
    const results = await Promise.allSettled([svc.filings.register("a"), svc.filings.register("b")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(refused.map((r) => r.reason.details.code)).toEqual(["IN_FLIGHT"]);
  });

  it("auto-submit files one per run, drains an unfilable one, and pauses while blocked", async () => {
    add("old", { issuedAt: new Date(Date.now() - 2 * 3_600_000), buyer: { ...invoice("old").buyer, tin: null } });
    add("new", { issuedAt: new Date(Date.now() - 3_600_000) });
    expect(await svc.filings.autoSubmitNext()).toMatchObject({ outcome: "DRAINED", documentId: "old" });
    expect(host.filing("old").status).toBe("FAILED");
    expect(await svc.filings.autoSubmitNext()).toMatchObject({ outcome: "FILED", documentId: "new", result: { outcome: "REGISTERED" } });
    expect(await svc.filings.autoSubmitNext()).toEqual({ outcome: "IDLE" });

    add("later");
    mock.failNext("/v1/register", "500");
    expect(await svc.filings.autoSubmitNext()).toMatchObject({ outcome: "FILED", result: { outcome: "UNKNOWN" } });
    add("next");
    expect(await svc.filings.autoSubmitNext()).toMatchObject({ outcome: "PAUSED", reason: expect.stringMatching(/blocked/) });
  });

  describe("bulk", () => {
    const deliver = async (conversationId: string, token?: string, mutate?: (items: any[]) => any[]) => {
      const items = structuredClone(mock.bulkCallbacks.get(conversationId)!) as any[];
      return svc.filings.receiveBulkCallback(mutate ? mutate(items) : items, token);
    };

    it("reserves a block, then applies only acceptances that /v1/verify confirms", async () => {
      add("a");
      add("b");
      const submission = await svc.filings.registerBulk(["a", "b"]);
      expect(submission.submitted).toEqual(["a", "b"]);
      expect(host.state(SYSTEM_NUMBER)).toMatchObject({ inFlightConversationId: submission.conversationId, nextInvoiceCounter: 3 });
      await expect(svc.filings.register("a")).rejects.toMatchObject({ kind: "BUSY" });

      // A forged callback: right conversation id, made-up IRN. Not applied.
      const forged = await deliver(submission.conversationId!, undefined, (items) =>
        items.map((i) => (i.irn ? { ...i, irn: `test-${"0".repeat(64)}` } : i)),
      );
      expect(forged.every((r) => !r.applied)).toBe(true);
      expect(host.filing("a").status).toBe("SUBMITTING");

      const genuine = await deliver(submission.conversationId!);
      expect(genuine.filter((r) => r.applied)).toHaveLength(2);
      expect(host.filing("b")).toMatchObject({ status: "REGISTERED", documentNumber: "2" });
      expect(host.state(SYSTEM_NUMBER)).toMatchObject({ inFlightConversationId: null, previousIrn: host.filing("b").irn });
    });

    it("applies a rejection only when the callback carries the webhook token", async () => {
      svc = wire(host, optionsFor(mock.url, pair, { bulkWebhookToken: "s3cret-path-token" }));
      add("a", { buyer: { ...invoice("a").buyer, idType: "NID" } });
      mock.buyerLookupDown.add("0089238373");
      const submission = await svc.filings.registerBulk(["a"]);
      expect((await deliver(submission.conversationId!))[0]).toMatchObject({ applied: false });
      expect(host.filing("a").status).toBe("SUBMITTING");
      expect((await deliver(submission.conversationId!, "wrong"))[0]).toMatchObject({ applied: false });
      expect((await deliver(submission.conversationId!, "s3cret-path-token"))[0]).toMatchObject({ applied: true });
      expect(host.filing("a")).toMatchObject({ status: "FAILED", lastError: { message: expect.stringMatching(/503/) } });
      expect(host.state(SYSTEM_NUMBER).inFlightConversationId).toBeNull();
    });
  });
});
