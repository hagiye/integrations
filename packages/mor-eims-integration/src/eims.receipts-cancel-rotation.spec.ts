import { FakeEimsHost, invoice, optionsFor, wire } from "../test/fakes";
import { SYSTEM_NUMBER, testEncryptionKey, testPair } from "../test/fixtures";
import { MockMor, mockConfig } from "../test/mock-mor";

describe("receipts, cancellation and key rotation", () => {
  const first = testPair("rotation-first");
  const renewal = testPair("rotation-renewal");
  const stranger = testPair("rotation-stranger");
  let mock: MockMor;
  let host: FakeEimsHost;
  let svc: ReturnType<typeof wire>;

  beforeAll(async () => {
    mock = new MockMor(mockConfig(first.fingerprint256));
    await mock.start();
  });
  afterAll(() => mock.stop());
  beforeEach(() => {
    mock.reset();
    mock.ledger = { nextCounter: 1, nextDocumentNumber: 1, previousIrn: "" };
    mock.documents.clear();
    mock.receipts.clear();
    mock.config.issuedCertificates = [first.fingerprint256];
    mock.currentCertificate = first.fingerprint256;
    mock.retiredCertificates.clear();
    host = new FakeEimsHost();
    svc = wire(host, optionsFor(mock.url, first, { encryptionKey: testEncryptionKey() }));
  });

  async function registered(id: string, payments: Array<{ key?: string; amount: number; method?: string; reference?: string }>) {
    host.documents.set(id, invoice(id));
    host.sources.set(id, {
      documentId: id,
      number: `INV-${id}`,
      currency: "ETB",
      totalAmount: 85000,
      payments: payments.map((p, i) => ({ paidAt: new Date(Date.now() - (10 - i) * 60_000), method: "BANK_TRANSFER", ...p })),
    });
    const result = await svc.filings.register(id);
    expect(result.outcome).toBe("REGISTERED");
    return result.irn!;
  }

  describe("sales receipts", () => {
    it("files one per payment, as of that payment, in the order the money came in", async () => {
      await registered("inv1", [{ key: "p1", amount: 50000, reference: "CRV-00812" }, { key: "p2", amount: 35000 }]);
      const one = await svc.receipts.fileSalesReceipt("inv1");
      expect(one).toMatchObject({ outcome: "REGISTERED", receipt: { paymentKey: "p1", receiptNumber: "Rinv1-1" } });
      expect(one.receipt!.request).toMatchObject({
        CollectedAmount: 50000,
        ManualReceiptNumber: "CRV-00812",
        Invoices: [{ PaymentCoverage: "PARTIAL", InvoicePaidAmount: 50000, RemainingAmount: 35000, TotalAmount: 85000 }],
        TransactionDetails: { ModeOfPayment: "BANK", CollectorName: "Finance desk" },
      });
      const two = await svc.receipts.fileSalesReceipt("inv1");
      expect(two.receipt!.request).toMatchObject({ Invoices: [{ PaymentCoverage: "FULL", RemainingAmount: 0 }] });
      await expect(svc.receipts.fileSalesReceipt("inv1")).rejects.toMatchObject({ details: { code: "ALL_PAYMENTS_RECEIPTED" } });
      expect(await svc.receipts.fileSalesReceipt("inv1", { paymentKey: "p1" })).toMatchObject({ outcome: "ALREADY_FILED" });
    });

    it("lets only one of two racing attempts file a payment", async () => {
      await registered("inv2", [{ key: "p1", amount: 85000 }]);
      const results = await Promise.all([
        svc.receipts.fileSalesReceipt("inv2", { paymentKey: "p1" }),
        svc.receipts.fileSalesReceipt("inv2", { paymentKey: "p1" }),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["ALREADY_FILED", "REGISTERED"]);
      expect(mock.countCalls("/v1/receipt/sales")).toBe(1);
    });

    it("asks rather than guesses a mode, needs a collector, refuses an amount that is not the ledger's", async () => {
      await registered("inv3", [{ key: "p1", amount: 85000, method: "GATEWAY" }]);
      await expect(svc.receipts.fileSalesReceipt("inv3")).rejects.toMatchObject({ details: { code: "MODE_OF_PAYMENT_REQUIRED" } });
      await expect(svc.receipts.fileSalesReceipt("inv3", { modeOfPayment: "CARD", collectedAmount: 80000 })).rejects.toMatchObject({
        details: { code: "RECEIPT_AMOUNT_MISMATCH" },
      });
      const noCashier = wire(host, optionsFor(mock.url, first, { cashierName: "" }));
      await expect(noCashier.receipts.fileSalesReceipt("inv3", { modeOfPayment: "CARD" })).rejects.toMatchObject({ details: { code: "COLLECTOR_NAME_REQUIRED" } });
      expect(await svc.receipts.fileSalesReceipt("inv3", { modeOfPayment: "CARD" })).toMatchObject({ outcome: "REGISTERED" });
    });

    it("keeps an unanswered attempt's slot until someone resolves it", async () => {
      await registered("inv4", [{ key: "p1", amount: 85000 }]);
      mock.failNext("/v1/receipt/sales", "reset-after");
      const lost = await svc.receipts.fileSalesReceipt("inv4");
      expect(lost).toMatchObject({ outcome: "UNKNOWN", receipt: { status: "UNKNOWN" } });
      expect(await svc.receipts.fileSalesReceipt("inv4", { paymentKey: "p1" })).toMatchObject({ outcome: "ALREADY_FILED" });
      const rrn = [...mock.receipts.values()][0].rrn;
      expect(await svc.receipts.resolveReceipt("inv4", lost.receipt!.id, { rrn })).toMatchObject({ status: "REGISTERED", rrn });
    });

    it("refuses a receipt against a cancelled invoice", async () => {
      await registered("inv5", [{ key: "p1", amount: 85000 }]);
      await svc.cancellation.cancel("inv5", "1", "Issued twice");
      await expect(svc.receipts.fileSalesReceipt("inv5")).rejects.toMatchObject({ details: { code: "CANCELLED" } });
    });

    it("auto-files, and parks a payment that cannot be receipted unattended", async () => {
      await registered("inv6", [{ key: "p1", amount: 85000, method: "TELEBIRR" }]);
      expect(await svc.receipts.autoFileNext()).toMatchObject({ outcome: "PARKED", error: { code: "MODE_OF_PAYMENT_REQUIRED" } });
      expect([...host.receipts.values()][0]).toMatchObject({ status: "FAILED", paymentKey: "p1" });
      expect(await svc.receipts.autoFileNext()).toEqual({ outcome: "IDLE" });
    });
  });

  describe("cancellation", () => {
    it("cancels once, refuses a second locally, and records MoR's 'already Canceled' as done", async () => {
      const irn = await registered("c1", []);
      expect(await svc.cancellation.cancel("c1", "1", "Issued twice")).toMatchObject({ status: "CANCELLED", cancellationDate: "Sun Dec 22 21:55:03 EAT 2024" });
      await expect(svc.cancellation.cancel("c1", "1")).rejects.toMatchObject({ details: { code: "ALREADY_CANCELLED" } });

      const irn2 = await registered("c2", []);
      mock.documents.get(irn2)!.cancelled = true; // cancelled at MoR, the first answer was lost
      expect(await svc.cancellation.cancel("c2", "6")).toMatchObject({ status: "CANCELLED", cancellationDate: null });
      expect(irn).not.toBe(irn2);
      await expect(svc.cancellation.cancel("c3", "1")).rejects.toMatchObject({ details: { code: "NOT_FOUND" } });
      await expect(svc.cancellation.cancel("c1", "duplicate")).rejects.toMatchObject({ details: { code: "CANCEL_REASON" } });
    });

    it("bulk-cancels the eligible ones and reports the rest", async () => {
      await registered("b1", []);
      await registered("b2", []);
      host.documents.set("b3", invoice("b3"));
      const results = await svc.cancellation.cancelBulk([
        { documentId: "b1", reasonCode: "1" },
        { documentId: "b2", reasonCode: "1" },
        { documentId: "b3", reasonCode: "1" },
      ]);
      expect(results.map((r) => r.success)).toEqual([true, true, false]);
      expect(host.filing("b2").status).toBe("CANCELLED");
    });
  });

  describe("key rotation (yearly certificate, same system number, no overlap)", () => {
    it("activates a renewal in one step: proven with a signed verify, the old key destroyed, never two usable pairs", async () => {
      await registered("r1", []);
      const imported = await svc.credentials.importStaticPair();
      expect(imported).toMatchObject({ status: "ACTIVE" });
      mock.issue(renewal.fingerprint256);
      const pending = await svc.credentials.upload({ privateKey: renewal.keyPem, certificate: renewal.certificateFile, label: "2027 renewal" });
      expect(pending.status).toBe("PENDING");

      const activated = await svc.credentials.activate(pending.id);
      expect(activated).toMatchObject({ status: "ACTIVE", activationSystemNumber: SYSTEM_NUMBER });
      const rows = [...host.credentials.values()];
      expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
      expect(rows.find((r) => r.id === imported!.id)).toMatchObject({ status: "RETIRED", privateKeyEnc: null, replacedById: pending.id });
      expect(mock.retiredCertificates.has(first.fingerprint256)).toBe(true);
      expect(host.events.find((e) => e.type === "CREDENTIAL_ACTIVATED")?.message).toContain("signed /v1/verify accepted");

      host.documents.set("r2", invoice("r2"));
      expect(await svc.filings.register("r2")).toMatchObject({ outcome: "REGISTERED" });
      expect(mock.calls.filter((c) => c.path === "/v1/register").pop()!.certFingerprint).toBe(renewal.fingerprint256);
    });

    it("refuses a pair MoR does not accept, and refuses while a submission is in flight", async () => {
      await registered("r1", []);
      await svc.credentials.importStaticPair();
      const wrong = await svc.credentials.upload({ privateKey: stranger.keyPem, certificate: stranger.certificateFile });
      await expect(svc.credentials.activate(wrong.id)).rejects.toMatchObject({ details: { code: "ACTIVATION_CERTIFICATE_REFUSED" } });
      expect([...host.credentials.values()].find((r) => r.id === wrong.id)).toMatchObject({ status: "PENDING", lastActivationError: expect.stringMatching(/67012/) });

      mock.issue(renewal.fingerprint256);
      const pending = await svc.credentials.upload({ privateKey: renewal.keyPem, certificate: renewal.certificateFile });
      host.states.set(SYSTEM_NUMBER, { ...host.state(SYSTEM_NUMBER), inFlightDocumentId: "r9" });
      await expect(svc.credentials.activate(pending.id)).rejects.toMatchObject({ kind: "BUSY", details: { code: "ACTIVATION_BLOCKED" } });
      expect(mock.currentCertificate).toBe(first.fingerprint256);
    });

    it("lets only one of two concurrent activations through", async () => {
      await registered("r1", []);
      await svc.credentials.importStaticPair();
      mock.issue(renewal.fingerprint256);
      const pending = await svc.credentials.upload({ privateKey: renewal.keyPem, certificate: renewal.certificateFile });
      const results = await Promise.allSettled([svc.credentials.activate(pending.id), svc.credentials.activate(pending.id)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect([...host.credentials.values()].filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    });

    it("another instance still holding the retired pair catches up on MoR's 67012 and files", async () => {
      await registered("r1", []);
      await svc.credentials.importStaticPair();
      const other = wire(host, optionsFor(mock.url, first, { encryptionKey: (svc.credentials as any).options.encryptionKey }));
      await other.client.session();
      host.documents.set("warm", invoice("warm"));
      expect(await other.filings.register("warm")).toMatchObject({ outcome: "REGISTERED" }); // caches the first pair

      mock.issue(renewal.fingerprint256);
      const pending = await svc.credentials.upload({ privateKey: renewal.keyPem, certificate: renewal.certificateFile });
      await svc.credentials.activate(pending.id);

      host.documents.set("r3", invoice("r3"));
      expect(await other.filings.register("r3")).toMatchObject({ outcome: "REGISTERED" });
      const registers = mock.calls.filter((c) => c.path === "/v1/register");
      expect(registers.slice(-2).map((c) => c.certFingerprint)).toEqual([first.fingerprint256, renewal.fingerprint256]);
    });

    it("reminds 60, 30 and 7 days ahead and once after expiry, each stage once", async () => {
      await svc.credentials.importStaticPair();
      const notAfter = [...host.credentials.values()][0].certNotAfter!.getTime();
      const at = (days: number) => new Date(notAfter - days * 86_400_000 + 60_000);
      expect(await svc.credentials.checkCertificateExpiry(at(90))).toBeNull();
      expect(await svc.credentials.checkCertificateExpiry(at(45))).toMatchObject({ stage: 60 });
      expect(await svc.credentials.checkCertificateExpiry(at(44))).toBeNull();
      expect(await svc.credentials.checkCertificateExpiry(at(25))).toMatchObject({ stage: 30 });
      expect(await svc.credentials.checkCertificateExpiry(at(5))).toMatchObject({ stage: 7 });
      expect(await svc.credentials.checkCertificateExpiry(new Date(notAfter + 86_400_000))).toMatchObject({ stage: 1 });
      expect(await svc.credentials.checkCertificateExpiry(new Date(notAfter + 2 * 86_400_000))).toBeNull();
      expect(host.events.filter((e) => e.type === "CERTIFICATE_EXPIRY").map((e) => e.priority)).toEqual(["NORMAL", "NORMAL", "HIGH", "HIGH"]);
    });
  });
});
