import { X509Certificate, createHmac, createVerify, randomBytes, randomUUID } from "node:crypto";
import * as http from "node:http";
import { AddressInfo, Socket } from "node:net";

/**
 * A local stand-in for MoR's EIMS gateway, written apart from the package (its own signature
 * check, token, rules). It enforces what MoR enforced live:
 *
 *  - every endpoint takes {request, signature, certificate}; protected ones also a bearer token
 *    and an apikey header (code 4001 without the envelope);
 *  - the signature is checked over the exact `request` bytes of the body, RSA-SHA512 PKCS#1 v1.5,
 *    against the certificate sent (67004 wrong key, 67012 certificate refused, 67013 malformed);
 *  - no overlap: the first protected call with a newly issued certificate retires the current one;
 *  - login error codes 4400 / 4408 / 4410;
 *  - register rules: Version, DocumentNumber pattern, NatureOfSupplies, Unit list, VatNumber
 *    pattern (1023), IdType (7004), date within 3 days (7026), Qty x UnitPrice at 4 decimals,
 *    counters (7015, 7001 "expected : N"), the IRN chain, seller name (7017), buyer lookup 503,
 *    memo restatement (7020);
 *  - verify (lowercase irn), cancel ("IRN already Canceled."), bulk cancel, sales receipt schema,
 *    bulk register (202 + a callback the test delivers).
 *
 * Login does not check the signature, as observed live on 2026-09-17.
 */

export type FailMode =
  /** Hold the request until the client gives up. */
  | "timeout"
  /** Drop the connection without storing anything. */
  | "reset-before"
  /** Store the document, then drop the connection: an answer lost after acceptance. */
  | "reset-after"
  | "500"
  | "429"
  /** A 200 with no IRN in it. */
  | "no-irn"
  /** A 200 whose body says statusCode 406 (MoR wraps some answers). */
  | "wrapped-406";

export interface MockMorConfig {
  clientId: string;
  clientSecret: string;
  apiKey: string;
  tin: string;
  systemNumber: string;
  systemType: string;
  sellerLegalName: string;
  /** Fingerprints of certificates INSA issued for this system, in issue order. The first is current. */
  issuedCertificates: string[];
}

export interface StoredDocument {
  irn: string;
  request: Record<string, any>;
  documentNumber: string;
  counter: number;
  cancelled: boolean;
  cancellationDate: string | null;
}

const UNITS = ["LTR", "MTR", "101", "PCS", "ROL", "MTS", "PKG", "SET", "KLG"];
const ID_TYPES = ["NID", "KID", "SID", "WID", "PST", "DLS", "MRS"];
const MODES = ["CASH", "ADVANCE", "CREDIT", "CHEQUE", "CPO", "SWIFT", "CARD", "WIRE", "BANK", "LC"];
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

export class MockMor {
  url = "";
  private server!: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly tokenSecret = randomBytes(32);
  private readonly tokens = new Set<string>();

  /** MoR's ledger for the system number. Tests may move it. */
  ledger = { nextCounter: 1, nextDocumentNumber: 1, previousIrn: "" };
  enforceChain = true;
  documents = new Map<string, StoredDocument>();
  receipts = new Map<string, { rrn: string; request: Record<string, any> }>();
  bulkCallbacks = new Map<string, unknown[]>();
  /** Every request, in order: path, the parsed inner request, and the certificate fingerprint used. */
  calls: Array<{ path: string; request: unknown; certFingerprint: string | null; headers: http.IncomingHttpHeaders }> = [];
  /** TINs MoR's own buyer lookup cannot answer for ("BUYER_TIN ... buyer not found 503"). */
  buyerLookupDown = new Set<string>();
  /** One-shot failures by path. */
  private failures = new Map<string, FailMode[]>();
  currentCertificate: string;
  retiredCertificates = new Set<string>();
  tokenTtlSeconds = 3600;

  constructor(readonly config: MockMorConfig) {
    this.currentCertificate = config.issuedCertificates[0];
  }

  /** Make the next call(s) to `path` fail this way. */
  failNext(path: string, mode: FailMode, times = 1): void {
    const list = this.failures.get(path) ?? [];
    for (let i = 0; i < times; i++) list.push(mode);
    this.failures.set(path, list);
  }

  /** INSA issues a renewal: MoR will accept it on first use and retire the current one then. */
  issue(fingerprint: string): void {
    this.config.issuedCertificates.push(fingerprint);
  }

  countCalls(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  reset(): void {
    this.calls = [];
    this.failures.clear();
    this.buyerLookupDown.clear();
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          this.handle(req, res, Buffer.concat(chunks).toString("utf8"));
        } catch (err) {
          this.send(res, 500, { message: `mock crashed: ${(err as Error).message}` });
        }
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ── plumbing ────────────────────────────────────────────────────────────────────────────────

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  private issueToken(): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: this.config.clientId,
        systemNumber: this.config.systemNumber,
        systemType: this.config.systemType,
        exp: Math.floor(Date.now() / 1000) + this.tokenTtlSeconds,
        jti: randomUUID(),
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", this.tokenSecret).update(`${header}.${payload}`).digest("base64url");
    const token = `${header}.${payload}.${sig}`;
    this.tokens.add(token);
    return token;
  }

  /** Forget every token: the next protected call answers 401. */
  expireTokens(): void {
    this.tokens.clear();
  }

  /** The envelope's raw request segment, exactly as it travelled. */
  private rawRequestSegment(body: string): string | null {
    const head = '{"request":';
    const tail = body.lastIndexOf(',"signature":');
    if (!body.startsWith(head) || tail < head.length) return null;
    return body.slice(head.length, tail);
  }

  private certificateOf(base64: string): X509Certificate | null {
    try {
      const text = Buffer.from(base64, "base64").toString("utf8");
      const pem = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
      return pem ? new X509Certificate(pem) : null;
    } catch {
      return null;
    }
  }

  private gatewayError(res: http.ServerResponse, code: string, message: string, details: Array<{ field?: string; errorMessage: string }> = []): void {
    this.send(res, 400, { statusCode: 400, message, code, details });
  }

  private rule(res: http.ServerResponse, errors: string[]): void {
    this.send(res, 406, { statusCode: 406, message: "RULE VALIDATION ERROR", body: [{ portion: "Document", errorMessage: errors }] });
  }

  private schema(res: http.ServerResponse, errors: string[]): void {
    this.send(res, 400, { statusCode: 400, message: "SCHEMA ERROR", body: errors.map((e) => ({ message: e })) });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const path = (req.url ?? "").split("?")[0];
    let envelope: any;
    try {
      envelope = JSON.parse(body);
    } catch {
      envelope = null;
    }
    const cert = envelope?.certificate ? this.certificateOf(envelope.certificate) : null;
    this.calls.push({ path, request: envelope?.request ?? null, certFingerprint: cert?.fingerprint256 ?? null, headers: req.headers });

    const failure = this.failures.get(path)?.shift();
    if (failure === "timeout") return; // never answered
    if (failure === "reset-before") {
      req.socket.destroy();
      return;
    }
    if (failure === "500") return this.send(res, 500, { message: "Internal Server Error" });
    if (failure === "429") return this.send(res, 429, { message: "Too many requests!" });
    if (failure === "wrapped-406") {
      return this.send(res, 200, { statusCode: 406, message: "RULE VALIDATION ERROR", body: [{ portion: "BuyerDetails", errorMessage: ["7004: Id types should be one of NID"] }] });
    }

    if (path === "/auth/login") return this.login(res, envelope);

    // ── protected endpoints ─────────────────────────────────────────────────────────────────
    if (!envelope || envelope.request == null || !envelope.signature || !envelope.certificate) {
      return this.gatewayError(res, "4001", "GATEWAY ERROR", [
        { field: "request", errorMessage: "must not be null" },
        { field: "signature", errorMessage: "must not be null" },
        { field: "certificate", errorMessage: "must not be null" },
      ]);
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !this.tokens.has(auth.slice(7))) return this.send(res, 401, { message: "Unauthorized", code: "4011" });
    if (req.headers.apikey !== this.config.apiKey) return this.send(res, 401, { message: "Invalid API key", code: "4408" });
    const signatureProblem = this.checkSignature(body, envelope, cert);
    if (signatureProblem) return this.gatewayError(res, signatureProblem, "Certificate Or Signature Validation Error");

    const request = envelope.request;
    switch (path) {
      case "/v1/register":
        return this.register(res, request, failure);
      case "/v1/verify":
        return this.verify(res, request);
      case "/v1/cancel":
        return this.cancel(res, request);
      case "/v1/bulkCancel":
        return this.bulkCancel(res, request);
      case "/v1/receipt/sales":
        return this.salesReceipt(res, request, failure);
      case "/v1/bulkRegister":
        return this.bulkRegister(res, request);
      default:
        return this.send(res, 404, { message: "Not Found" });
    }
  }

  /** null when fine, else MoR's 67xxx code. Applies the no-overlap rule on first use of a renewal. */
  private checkSignature(body: string, envelope: any, cert: X509Certificate | null): string | null {
    if (!cert) return "67012";
    const fp = cert.fingerprint256;
    if (this.retiredCertificates.has(fp) || !this.config.issuedCertificates.includes(fp)) return "67012";
    const segment = this.rawRequestSegment(body);
    if (!segment || typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(envelope.signature)) return "67013";
    const signature = Buffer.from(envelope.signature, "base64");
    if (signature.length !== 256) return "67013";
    const ok = createVerify("RSA-SHA512").update(segment, "utf8").verify(cert.publicKey, signature);
    if (!ok) return "67004";
    if (fp !== this.currentCertificate) {
      // No overlap: the renewal's first use retires the certificate in use.
      this.retiredCertificates.add(this.currentCertificate);
      this.currentCertificate = fp;
    }
    return null;
  }

  private login(res: http.ServerResponse, envelope: any): void {
    if (!envelope || envelope.request == null || !envelope.signature || !envelope.certificate) {
      return this.send(res, 400, {
        status: "VALIDATION_ERROR",
        errors: [
          { field: "request", message: "must not be null" },
          { field: "signature", message: "must not be null" },
          { field: "certificate", message: "must not be null" },
        ],
      });
    }
    const r = envelope.request;
    if (r.apikey !== this.config.apiKey) return this.send(res, 401, { message: "Invalid Credentials", code: "4408" });
    if (r.clientId !== this.config.clientId || r.clientSecret !== this.config.clientSecret) {
      return this.send(res, 401, { message: "Invalid Credentials", code: "4410" });
    }
    if (r.tin !== this.config.tin) return this.send(res, 401, { message: "Invalid Credentials", code: "4400" });
    this.send(res, 200, {
      status: "SUCCESS",
      data: { accessToken: this.issueToken(), refreshToken: randomUUID(), encryptionKey: randomUUID(), expiresIn: this.tokenTtlSeconds },
    });
  }

  private documentErrors(doc: any): { schema: string[]; rules: string[] } {
    const schema: string[] = [];
    const rules: string[] = [];
    if (doc?.Version !== "1") schema.push("$.Version: is missing but it is required");
    if (!/^(0|[1-9][0-9]{0,8})$/.test(String(doc?.DocumentDetails?.DocumentNumber ?? ""))) {
      schema.push("$.DocumentDetails.DocumentNumber: does not match the regex pattern ^(0|[1-9][0-9]{0,8})$");
    }
    const buyer = doc?.BuyerDetails ?? {};
    if (buyer.VatNumber != null && !/^[0-9]{3,25}$/.test(buyer.VatNumber)) {
      schema.push("1023 pattern $.BuyerDetails.VatNumber: does not match the regex pattern ^[0-9]{3,25}$");
    }
    const items: any[] = Array.isArray(doc?.ItemList) ? doc.ItemList : [];
    if (items.length === 0) schema.push("$.ItemList: must have at least 1 item");
    for (const item of items) {
      if (item.NatureOfSupplies !== "goods" && item.NatureOfSupplies !== "service") schema.push("$.ItemList: must be the constant value 'service'");
      if (!UNITS.includes(item.Unit)) schema.push(`$.ItemList.Unit: does not have a value in the enumeration ${UNITS.join(", ")}`);
    }
    if (schema.length) return { schema, rules };

    if (!ID_TYPES.includes(buyer.IdType)) rules.push("7004: Id types should be one of NID, KID, SID, WID, PST, DLS, MRS");
    const m = /^(\d{2})-(\d{2})-(\d{4})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(doc.DocumentDetails?.Date ?? ""));
    const when = m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) - 180 * 60_000 : NaN;
    if (!Number.isFinite(when) || Date.now() - when > 3 * 86_400_000) rules.push("7026: Document date should be within 3 days");
    for (const item of items) {
      const expected = r4(Number(item.Quantity) * Number(item.UnitPrice));
      if (Math.abs(expected - Number(item.PreTaxValue)) > 1e-9) {
        rules.push(`Error in Total Line Amount Item.totalLineAmount: expected ${expected} received ${item.PreTaxValue}`);
      }
    }
    if (doc.SellerDetails?.LegalName !== this.config.sellerLegalName) rules.push("7017: Seller details do not match the taxpayer registry");
    if (buyer.Tin && this.buyerLookupDown.has(buyer.Tin)) rules.push(`BUYER_TIN ${buyer.Tin} buyer not found 503`);
    if (Number(doc.SourceSystem?.InvoiceCounter) !== this.ledger.nextCounter) {
      rules.push(`7015: (id) Invoice Counter is not correct. : Invoice counter is not correct expected : ${this.ledger.nextCounter}`);
    }
    if (String(doc.DocumentDetails?.DocumentNumber) !== String(this.ledger.nextDocumentNumber)) {
      rules.push(`7001: (id) Document number error. : Document number is not in correct sequence expected : ${this.ledger.nextDocumentNumber}`);
    }
    if (this.enforceChain && (doc.ReferenceDetails?.PreviousIrn ?? "") !== this.ledger.previousIrn) {
      rules.push(`7030: Previous IRN is not correct expected : ${this.ledger.previousIrn || "(none)"}`);
    }
    const type = doc.DocumentDetails?.Type;
    if (type === "CRE" || type === "DEB") {
      const ref = this.documents.get(doc.ReferenceDetails?.RelatedDocument ?? "");
      if (!doc.DocumentDetails?.Reason) rules.push("7019: Reason is required for a debit or credit note");
      if (!ref || ref.cancelled) rules.push("7018: Referenced document not found");
      else {
        items.forEach((item, i) => {
          const r = ref.request.ItemList?.[i];
          if (
            !r ||
            r.ProductDescription !== item.ProductDescription ||
            r.TaxCode !== item.TaxCode ||
            r.Unit !== item.Unit ||
            r.NatureOfSupplies !== item.NatureOfSupplies ||
            Number(item.Quantity) > Number(r.Quantity)
          ) {
            rules.push(
              `7020: amount is not correct for Debit / Credit. : Item mismatch at line ${i + 1} | Current: Product=${item.ProductDescription}, Qty=${item.Quantity} | Reference: Product=${r?.ProductDescription}, Qty=${r?.Quantity}`,
            );
          }
        });
      }
    }
    return { schema, rules };
  }

  private accept(doc: any): StoredDocument {
    const irn = `test-${randomBytes(32).toString("hex")}`;
    const stored: StoredDocument = {
      irn,
      request: doc,
      documentNumber: String(doc.DocumentDetails.DocumentNumber),
      counter: Number(doc.SourceSystem.InvoiceCounter),
      cancelled: false,
      cancellationDate: null,
    };
    this.documents.set(irn, stored);
    this.ledger = { nextCounter: stored.counter + 1, nextDocumentNumber: Number(stored.documentNumber) + 1, previousIrn: irn };
    return stored;
  }

  private register(res: http.ServerResponse, doc: any, failure: FailMode | undefined): void {
    const { schema, rules } = this.documentErrors(doc);
    if (schema.length) return this.schema(res, schema);
    if (rules.length) return this.rule(res, rules);
    const stored = this.accept(doc);
    if (failure === "reset-after") {
      res.socket?.destroy();
      return;
    }
    if (failure === "no-irn") return this.send(res, 200, { statusCode: 200, message: "SUCCESS", body: { status: "PROCESSING" } });
    // Java's ZonedDateTime#toString drops zero seconds: sometimes there are none.
    const ack = new Date().toISOString().slice(0, 16) + "Z[Etc/UTC]";
    this.send(res, 200, {
      statusCode: 200,
      message: "SUCCESS",
      body: {
        irn: stored.irn,
        ackDate: ack,
        signedQR: Buffer.from(`QR:${stored.irn}`).toString("base64"),
        signedInvoice: "signed",
        status: "ACK",
        documentNumber: stored.documentNumber,
        errorMessage: null,
      },
    });
  }

  private verify(res: http.ServerResponse, request: any): void {
    if (!request || typeof request.irn !== "string") return this.schema(res, ["$: required property 'irn' not found"]);
    const stored = this.documents.get(request.irn);
    if (!stored) return this.send(res, 404, { statusCode: 404, message: "Document not found" });
    this.send(res, 200, {
      statusCode: 200,
      message: "SUCCESS",
      body: {
        Irn: stored.irn,
        TransactionType: stored.request.TransactionType,
        DocumentDetails: { ...stored.request.DocumentDetails, DocumentNumber: stored.documentNumber },
        BuyerDetails: stored.request.BuyerDetails,
        Version: "1",
      },
    });
  }

  private cancelOne(request: any): { ok: true; date: string } | { ok: false; message: string } {
    const stored = this.documents.get(request?.Irn ?? "");
    if (!stored) return { ok: false, message: "IRN not found." };
    if (stored.cancelled) return { ok: false, message: "IRN already Canceled." };
    stored.cancelled = true;
    stored.cancellationDate = "Sun Dec 22 21:55:03 EAT 2024";
    return { ok: true, date: stored.cancellationDate };
  }

  private cancel(res: http.ServerResponse, request: any): void {
    if (!request?.Irn || !/^[0-9]{1,3}$/.test(String(request.ReasonCode ?? ""))) return this.schema(res, ["$.Irn or $.ReasonCode invalid"]);
    const result = this.cancelOne(request);
    if (!result.ok) return this.send(res, 400, { statusCode: 400, message: result.message, code: "CANCEL" });
    this.send(res, 200, { statusCode: 200, message: "SUCCESS", body: { cancellationDate: result.date } });
  }

  private bulkCancel(res: http.ServerResponse, request: any): void {
    const items: any[] = Array.isArray(request) ? request : [];
    const body = items.map((item) => {
      const result = this.cancelOne(item);
      return result.ok ? { status: "C", Irn: item.Irn, mode: "BULK" } : { Status: "E", msg: result.message, Irn: item.Irn };
    });
    this.send(res, 200, { statusCode: 200, message: "SUCCESS", body });
  }

  private salesReceipt(res: http.ServerResponse, request: any, failure: FailMode | undefined): void {
    const schema: string[] = [];
    if (typeof request?.ReceiptNumber !== "string" || request.ReceiptNumber.length > 20) schema.push("$.ReceiptNumber: must be at most 20 characters long");
    if (request?.ManualReceiptNumber != null && String(request.ManualReceiptNumber).length > 15) {
      schema.push("$.ManualReceiptNumber: must be at most 15 characters long");
    }
    if (!MODES.includes(request?.TransactionDetails?.ModeOfPayment)) {
      schema.push(`$.TransactionDetails.ModeOfPayment: does not have a value in the enumeration [${MODES.join(", ")}]`);
    }
    if (!request?.TransactionDetails?.CollectorName) schema.push("$.TransactionDetails.CollectorName: is missing but it is required");
    if (schema.length) return this.schema(res, schema);
    if (!["ETB", "USD", "CAD"].includes(request.ReceiptCurrency)) return this.rule(res, ["Currency should be ETB, USD, CAD"]);
    const irn = request.Invoices?.[0]?.InvoiceIRN;
    const stored = this.documents.get(irn ?? "");
    if (!stored || stored.cancelled) return this.rule(res, ["Invoice IRN not found or cancelled"]);
    if (this.receipts.has(request.ReceiptNumber)) return this.rule(res, ["Receipt number already used"]);
    const rrn = randomBytes(16).toString("hex");
    this.receipts.set(request.ReceiptNumber, { rrn, request });
    if (failure === "reset-after") {
      res.socket?.destroy();
      return;
    }
    this.send(res, 200, { statusCode: 200, message: "SUCCESS", body: { status: "A", rrn, qr: Buffer.from(`RQR:${rrn}`).toString("base64") } });
  }

  private bulkRegister(res: http.ServerResponse, request: any): void {
    const docs: any[] = Array.isArray(request) ? request : [];
    const conversationId = randomUUID();
    const items: unknown[] = [];
    for (const doc of docs) {
      // Bulk chains within the batch as MoR reads it: a document after the first carries "".
      const previous = this.enforceChain;
      this.enforceChain = false;
      const { schema, rules } = this.documentErrors(doc);
      this.enforceChain = previous;
      if (schema.length || rules.length) {
        items.push({ ruleError: [{ portion: "Document", errorMessage: [...schema, ...rules] }], status: "ERROR", docNo: String(doc?.DocumentDetails?.DocumentNumber ?? "") });
        continue;
      }
      const stored = this.accept(doc);
      items.push({ irn: stored.irn, status: "ACK", documentNumber: stored.documentNumber, signedQR: Buffer.from(`QR:${stored.irn}`).toString("base64") });
    }
    items.push({ conversionId: conversationId });
    this.bulkCallbacks.set(conversationId, items);
    this.send(res, 202, { conversationId, status: 202 });
  }
}

export function mockConfig(certFingerprint: string, overrides: Partial<MockMorConfig> = {}): MockMorConfig {
  return {
    clientId: "client-test",
    clientSecret: "secret-test",
    apiKey: "apikey-test",
    tin: "0099990001",
    systemNumber: "TESTSYS001",
    systemType: "POS",
    sellerLegalName: "Test Seller PLC",
    issuedCertificates: [certFingerprint],
    ...overrides,
  };
}
