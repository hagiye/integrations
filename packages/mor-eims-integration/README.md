# @edr/mor-eims-integration

Ethiopia's Ministry of Revenues (MoR) e-invoicing system, **EIMS**, for NestJS. It was taken out
of the EDR platform so another system can file its invoices, credit and debit notes,
cancellations and payment receipts with MoR through a package.

| Part | What it does |
| --- | --- |
| `EimsClient` | MoR's calls, as EDR makes them. Every call, login included, carries the signed `{request, signature, certificate}` envelope (RSA, SHA-512, PKCS#1 v1.5 over the exact request bytes). Login with token caching. Every answer is classified by whether MoR **can have stored** what was sent. The exchange log is redacted. |
| `buildEimsDocument` and helpers | The MoR document, a pure function: line arithmetic at four decimals (inexact lines filed as 1 x amount), NID + TIN for every buyer (rule 7004), B2B / B2C / B2G, MoR's location codes for the buyer's address, credit and debit notes that restate the original's lines (rule 7020). Every check that can fail on your data runs **before** a number is taken. |
| `EimsFilingService` | Registration with the **durable reservation** MoR's strict sequence needs. Numbers are taken and committed before the call. A certain refusal gives them back, or adopts MoR's "expected : N". An ambiguous answer blocks the system number until `resolve()`, which verifies the IRN at MoR first. Also verify, bulk registration with a callback it does not take on trust, and the auto-submit sweep. |
| `EimsReceiptService` | Sales receipts (the Cash Receipt Voucher), one per payment, figures as of that payment, one live attempt per payment. |
| `EimsCancellationService` | Single and bulk cancel. |
| `EimsCredentialService` | The INSA key and certificate: a fixed pair from options, or stored pairs encrypted with AES-256-GCM. Rotation in **one step with no overlap**, as MoR requires, plus expiry reminders. |
| Your host | Stores the rows (filings, the sequence row, receipts, credentials) and runs transactions with row locks. The package keeps the rules. |

**Read [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md) sections 1 and 7 before filing a
real document.** A filed document cannot be edited; the sequence and the IRN chain are where
things go wrong. Section 15 lists what EDR does wrong today. [docs/FILE-INDEX.md](docs/FILE-INDEX.md)
lists every file and where it came from in EDR.

## Requirements

- Node 18.17+, NestJS 10 or 11.
- A source system registered with MoR: client id and secret, API key, your TIN, and the RSA key
  pair whose certificate INSA issued. The system number and type come from MoR's token.
- Your seller registration exactly as MoR holds it (rule 7017), and finance's tax code and rate
  for each kind of charge.
- A database with row locks. The example uses TypeORM and Postgres.
- No runtime dependencies besides Nest: signing, AES-GCM and HTTP use `node:crypto`,
  `node:http` and `node:https`. The tests need `openssl` to make throwaway certificates.

## Install

The package is private. Build it and install it from a path or a tarball:

```bash
pnpm install
pnpm run build          # writes dist/
pnpm pack               # edr-mor-eims-integration-1.0.0.tgz

# in your app
pnpm add /path/to/edr-mor-eims-integration-1.0.0.tgz
```

Or copy `src/` into your repo as a module; nothing in it depends on EDR.

## In 6 steps

### 1. Store the filing state

Next to each invoice, store what [`EimsFiling`](src/eims.types.ts) holds: its status, the IRN
(**text**, unique: a test IRN is 69 characters), the MoR document number and counter it used,
the ack date, the signed QR, the last error. Then add:

- one sequence row per MoR system number ([`EimsSystemState`](src/eims.types.ts));
- a receipts table with a partial unique index on (invoice, payment key) over SUBMITTING,
  REGISTERED and UNKNOWN rows;
- a credentials table allowing one ACTIVE row.

[examples/standalone/create-eims.migration.ts](examples/standalone/create-eims.migration.ts) has
all of it.

### 2. Implement the host

```ts
@Injectable()
export class MyEimsHost implements EimsHost {
  transaction<T>(work: (ledger: EimsLedger) => Promise<T>): Promise<T> { ... } // one DB transaction
  loadDocument(id: string): Promise<EimsDocument | null> { ... }               // the invoice as MoR should see it
  markIssued?(id: string, at: Date): Promise<void>;                            // filing is issuing
  loadReceiptSource?(id: string): Promise<EimsReceiptSource | null>;           // total + payment ledger
  nextUnfiledDocument?(q): Promise<string | null>;                             // for the sweep
  nextUnreceiptedPayment?(): Promise<{ documentId: string; paymentKey?: string } | null>;
  listCredentials?(): Promise<EimsCredentialRecord[]>;
  anyRegisteredIrn?(): Promise<string | null>;                                 // to prove a new key pair
  onEvent?(event: EimsEvent): Promise<void>;                                   // tell people
  recordExchange?(record: EimsExchangeRecord): Promise<void>;                  // the redacted log
}
```

The ledger's `lock*` methods must take a real row lock (`SELECT ... FOR UPDATE`) inside that
transaction: two API instances on one database must serialize on the sequence row. See
[examples/standalone/typeorm-eims.host.ts](examples/standalone/typeorm-eims.host.ts).

### 3. Mount the module

```ts
EimsModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    clientId: config.getOrThrow("EIMS_CLIENT_ID"),
    clientSecret: config.getOrThrow("EIMS_CLIENT_SECRET"),
    apiKey: config.getOrThrow("EIMS_API_KEY"),
    tin: config.getOrThrow("EIMS_TIN"),
    encryptionKey: config.getOrThrow("EIMS_ENCRYPTION_KEY"),   // stored, rotatable pairs
    seller: { legalName: "...", vatNumber: "...", phone: "...", email: "...", region: "13", wereda: "574" },
    tax: { code: "VATEX", ratePercent: 0 },                     // finance signs this off
    cashierName: "Finance desk",
    bulkWebhookToken: config.get("EIMS_BULK_WEBHOOK_TOKEN"),
  }),
  host: MyEimsHost,
});
```

Without `host` you get only `EimsClient` (signing with `privateKey` + `certificate` from the
options). `route: false` drops MoR's bulk callback route.

### 4. File

```ts
const result = await filings.register(invoiceId);
// result.outcome: REGISTERED | ALREADY_REGISTERED | REJECTED | RETRY_LATER | UNKNOWN | PERSIST_FAILED
```

It throws only when nothing was reserved: `INVALID` (the document cannot be filed as it is),
`BUSY` (a submission in flight, or the system number blocked), `CONFIG`, or a login failure.

An `UNKNOWN` blocks the system number. Check the MoR portal, then call
`filings.resolve(invoiceId, { irn })`, which verifies the IRN at MoR first, or
`filings.resolve(invoiceId, { discard: true })`.

### 5. Receipts, notes, cancellation

```ts
await receipts.fileSalesReceipt(invoiceId);                 // the oldest payment without a receipt
const lines = memoLines(original, "CRE", { amount: 1000 }); // restate the original for rule 7020
await cancellation.cancel(invoiceId, "1", "Issued twice");
```

### 6. Run the timers, give MoR the callback URL

The package starts no timers. Call these from your scheduler:
- `filings.autoSubmitNext()` and `receipts.autoFileNext()` file one item per call;
- `credentials.checkCertificateExpiry()` runs daily.

For bulk registration, give MoR `https://<you>/<prefix>/eims/webhook/bulk-register/<bulkWebhookToken>`.

## What decides the outcome

| MoR's answer | Outcome | The numbers | The document |
| --- | --- | --- | --- |
| An IRN | `REGISTERED` | consumed; the chain moves to this IRN | `REGISTERED` |
| 400, 401 (after one re-login), 403, 406 | `REJECTED` | given back, or MoR's "expected : N" adopted | `FAILED` (fix it and file again) |
| 429; MoR unreachable before anything was sent; MoR's buyer lookup down ("BUYER_TIN ... 503") | `RETRY_LATER` | given back | back to `NOT_SUBMITTED`, `retryCount` + 1 |
| A timeout after sending, a reset, a 5xx, a 2xx without an IRN, any other status | `UNKNOWN` | kept; **the system number is blocked** | `UNKNOWN` until `resolve()` |
| An IRN that could not be saved | `PERSIST_FAILED` | kept; blocked, the IRN in the block reason | resolve with that IRN; never resend |

A refusal found locally (no TIN, an address MoR does not list, lines that do not add up, a date
older than 3 days) throws before a number is taken, and MoR is never called.

## Tests

```bash
pnpm install
pnpm run type-check
pnpm test                       # unit + HTTP tests against a mock MoR, no database needed

# Against a real, throwaway Postgres (a schema is created and dropped):
docker run -d --name mor-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55484:5432 postgres:16
MOR_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55484/postgres pnpm test:pg
docker rm -f mor-pg
```

The mock MoR ([test/mock-mor.ts](test/mock-mor.ts)) has its own code, shared with nothing it
tests. It enforces what MoR enforced live:
- the envelope on every endpoint (4001 without it);
- the signature over the exact request bytes (67004, 67012, 67013);
- the certificate rules: no overlap, a renewal's first use retires the old certificate;
- the login codes 4400, 4408 and 4410;
- the counters (7015 and 7001, with "expected : N");
- the document rules: IdType (7004), the 3-day date (7026), four-decimal line arithmetic, the seller check (7017), memo restatement (7020) and the buyer-lookup 503;
- the verify casing, "IRN already Canceled." on a repeat cancel, the receipt schema, and bulk with a callback.

It can drop an answer after storing the document, hang, or answer 429, 500, a 2xx without an
IRN, or a wrapped 406.

Keys and certificates are made with openssl when the tests run; none is committed.

The Postgres run uses two app instances on one database, with MoR behind a proxy that can be
switched off. It covers:
- the migration run twice;
- a single filing, made idempotent;
- five registrations of one invoice racing;
- two invoices racing;
- a rejection, and the "expected : N" adoption;
- MoR unreachable;
- a lost answer, the block, and resolve;
- the buyer-lookup 503;
- receipts per payment, racing;
- cancel;
- credit notes, and the 7020 refusal;
- the sweep;
- bulk with a forged and a genuine callback;
- the redacted log;
- key rotation across instances.

The gapless-numbers race test fails if the row lock on the sequence is taken out.

Nothing here called MoR itself. See the guide for what is verified and what is not.

## Examples

- [examples/standalone](examples/standalone): a complete back end on TypeORM and Postgres. It has
  invoices, memos and payments, the filing, receipt, cancellation and credential routes behind a
  staff guard, MoR's bulk callback, and the sweeps. Run it with `main.ts` (environment variables
  listed there).
- [examples/edr/edr-mor-eims-host.ts](examples/edr/edr-mor-eims-host.ts): how EDR's own tables
  would sit behind the host (not compiled).
