import {
  EimsCancellationService,
  EimsClient,
  EimsCredentialService,
  EimsFilingService,
  EimsModuleOptions,
  EimsReceiptService,
  resolveEimsOptions,
  EimsCredentialRecord,
  EimsDocument,
  EimsEvent,
  EimsExchangeRecord,
  EimsFiling,
  EimsHost,
  EimsLedger,
  EimsReceiptRecord,
  EimsReceiptSource,
  EimsSystemState,
  newFiling,
  newSystemState,
} from "../src";

const clone = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

/**
 * An EimsHost in memory. Transactions run one at a time (standing in for row locks) and roll
 * back on a throw, as a database would.
 */
export class FakeEimsHost implements EimsHost {
  documents = new Map<string, EimsDocument>();
  filings = new Map<string, EimsFiling>();
  states = new Map<string, EimsSystemState>();
  receipts = new Map<string, EimsReceiptRecord>();
  credentials = new Map<string, EimsCredentialRecord>();
  sources = new Map<string, EimsReceiptSource>();
  events: EimsEvent[] = [];
  exchanges: EimsExchangeRecord[] = [];
  issued: Array<{ documentId: string; at: Date }> = [];
  /** Fail the next saveFiling with this status, once (to simulate a lost write). */
  failNextSaveOf: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  async transaction<T>(work: (ledger: EimsLedger) => Promise<T>): Promise<T> {
    const run = async () => {
      const snapshot = {
        filings: clone(this.filings),
        states: clone(this.states),
        receipts: clone(this.receipts),
        credentials: clone(this.credentials),
      };
      try {
        return await work(this.ledger());
      } catch (err) {
        this.filings = snapshot.filings;
        this.states = snapshot.states;
        this.receipts = snapshot.receipts;
        this.credentials = snapshot.credentials;
        throw err;
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private ledger(): EimsLedger {
    return {
      lockSystemState: async (systemNumber) => {
        if (!this.states.has(systemNumber)) this.states.set(systemNumber, newSystemState(systemNumber));
        return clone(this.states.get(systemNumber)!);
      },
      saveSystemState: async (state) => {
        this.states.set(state.systemNumber, clone(state));
      },
      lockFiling: async (documentId) => {
        if (!this.documents.has(documentId) && !this.sources.has(documentId)) return null;
        return clone(this.filings.get(documentId) ?? newFiling(documentId));
      },
      saveFiling: async (filing) => {
        if (this.failNextSaveOf && this.failNextSaveOf === filing.status) {
          this.failNextSaveOf = null;
          throw new Error("disk full");
        }
        this.filings.set(filing.documentId, clone(filing));
      },
      lockFilingsByConversation: async (conversationId) =>
        [...this.filings.values()]
          .filter((f) => f.bulkConversationId === conversationId)
          .sort((a, b) => (a.invoiceCounter ?? 0) - (b.invoiceCounter ?? 0))
          .map(clone),
      listReceipts: async (documentId) => [...this.receipts.values()].filter((r) => r.documentId === documentId).map(clone),
      insertReceipt: async (receipt) => {
        const live = [...this.receipts.values()].some(
          (r) => r.documentId === receipt.documentId && r.paymentKey === receipt.paymentKey && r.status !== "FAILED",
        );
        if (live && receipt.status !== "FAILED") return false;
        this.receipts.set(receipt.id, clone(receipt));
        return true;
      },
      saveReceipt: async (receipt) => {
        this.receipts.set(receipt.id, clone(receipt));
      },
      lockCredentials: async () => [...this.credentials.values()].map(clone),
      insertCredential: async (record) => {
        if (record.status === "ACTIVE" && [...this.credentials.values()].some((r) => r.status === "ACTIVE")) throw new Error("one ACTIVE credential only");
        this.credentials.set(record.id, clone(record));
      },
      saveCredential: async (record) => {
        if (record.status === "ACTIVE" && [...this.credentials.values()].some((r) => r.status === "ACTIVE" && r.id !== record.id)) {
          throw new Error("one ACTIVE credential only");
        }
        this.credentials.set(record.id, clone(record));
      },
    };
  }

  async loadDocument(documentId: string): Promise<EimsDocument | null> {
    return clone(this.documents.get(documentId) ?? null);
  }

  async markIssued(documentId: string, issuedAt: Date): Promise<void> {
    const doc = this.documents.get(documentId);
    if (doc) doc.issuedAt = issuedAt;
    this.issued.push({ documentId, at: issuedAt });
  }

  async loadReceiptSource(documentId: string): Promise<EimsReceiptSource | null> {
    return clone(this.sources.get(documentId) ?? null);
  }

  async nextUnfiledDocument(query: { maxAgeDays: number; now: Date }): Promise<string | null> {
    const candidates = [...this.documents.values()]
      .filter((d) => d.issuedAt && query.now.getTime() - new Date(d.issuedAt).getTime() <= query.maxAgeDays * 86_400_000)
      .filter((d) => (this.filings.get(d.id)?.status ?? "NOT_SUBMITTED") === "NOT_SUBMITTED")
      .sort((a, b) => new Date(a.issuedAt!).getTime() - new Date(b.issuedAt!).getTime());
    return candidates[0]?.id ?? null;
  }

  async nextUnreceiptedPayment(): Promise<{ documentId: string; paymentKey?: string } | null> {
    for (const source of this.sources.values()) {
      if (this.filings.get(source.documentId)?.status !== "REGISTERED") continue;
      const taken = new Set([...this.receipts.values()].filter((r) => r.documentId === source.documentId).map((r) => r.paymentKey));
      const index = source.payments.findIndex((p, i) => !taken.has(p.key ?? `#${i}`));
      if (index >= 0) return { documentId: source.documentId, paymentKey: source.payments[index].key ?? `#${index}` };
    }
    return null;
  }

  async listCredentials(): Promise<EimsCredentialRecord[]> {
    return [...this.credentials.values()].map(clone);
  }

  async anyRegisteredIrn(): Promise<string | null> {
    return [...this.filings.values()].find((f) => f.irn)?.irn ?? null;
  }

  async onEvent(event: EimsEvent): Promise<void> {
    this.events.push(event);
  }

  async recordExchange(record: EimsExchangeRecord): Promise<void> {
    this.exchanges.push(record);
  }

  state(systemNumber: string): EimsSystemState {
    return this.states.get(systemNumber) ?? newSystemState(systemNumber);
  }

  filing(documentId: string): EimsFiling {
    return this.filings.get(documentId) ?? newFiling(documentId);
  }
}

/** A filable invoice to the test roster's Taxpayer A, in Addis Ababa / Bole / Woreda 1. */
export function invoice(id: string, overrides: Partial<EimsDocument> = {}): EimsDocument {
  return {
    id,
    number: `INV-${id}`,
    type: "INV",
    issuedAt: new Date(Date.now() - 60_000),
    currency: "ETB",
    totalAmount: 85000,
    buyer: {
      kind: "company",
      legalName: "Afri Software Solutions",
      tin: "0089238373",
      vatNumber: "1234567",
      phone: "+251911000000",
      email: "accounts@example.et",
      country: "Ethiopia",
      region: "Addis Ababa",
      zone: "Bole",
      woreda: "Woreda 1",
      houseNumber: "101",
    },
    lines: [{ chargeType: "RAIL_FREIGHT", description: "40FT rail freight", quantity: 2, unitPrice: 42500, amount: 85000, basis: "PER_CONTAINER" }],
    ...overrides,
  };
}

/** Options that match the mock's configuration (mockConfig), signing with `pair`. */
export function optionsFor(
  baseUrl: string,
  pair: { keyPem: string; certificateFile: Buffer },
  overrides: Partial<import("../src").EimsModuleOptions> = {},
): import("../src").EimsModuleOptions {
  return {
    baseUrl,
    clientId: "client-test",
    clientSecret: "secret-test",
    apiKey: "apikey-test",
    tin: "0099990001",
    privateKey: pair.keyPem,
    certificate: pair.certificateFile,
    seller: {
      legalName: "Test Seller PLC",
      vatNumber: "12345678",
      phone: "+251911223344",
      email: "finance@seller.example.et",
      region: "13",
      wereda: "1100",
      city: "Addis Ababa",
    },
    tax: { code: "VATEX", ratePercent: 0 },
    cashierName: "Finance desk",
    httpTimeoutMs: 1500,
    ...overrides,
  };
}

/** The services wired the way EimsModule wires them, on a fake host. */
export function wire(host: FakeEimsHost, options: EimsModuleOptions) {
  const resolved = resolveEimsOptions(options);
  const credentials = new EimsCredentialService(resolved, host);
  const client = new EimsClient(resolved, credentials, (r) => host.recordExchange(r));
  credentials.attachClient(client);
  return {
    client,
    credentials,
    filings: new EimsFilingService(resolved, client, host, credentials),
    receipts: new EimsReceiptService(resolved, client, host),
    cancellation: new EimsCancellationService(client, host),
  };
}

