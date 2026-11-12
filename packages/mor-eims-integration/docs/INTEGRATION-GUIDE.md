# MoR EIMS: integration guide

How `@edr/mor-eims-integration` files documents with Ethiopia's Ministry of Revenues, what your
host has to do, and what was and was not verified. Facts marked **(live)** were seen in real MoR
answers between August and October 2026, while EDR filed against `https://core.mor.gov.et` with
test credentials (IRNs starting `test-`). MoR's Postman collection is incomplete and in places
wrong; where the two disagree, the live answer wins.

Back to the [README](../README.md).

1. [Read this first](#1-read-this-first)
2. [How EIMS works](#2-how-eims-works)
3. [The calls](#3-the-calls)
4. [The document](#4-the-document)
5. [Credit and debit notes](#5-credit-and-debit-notes)
6. [Your side: the host](#6-your-side-the-host)
7. [The sequence: reservation, failures, resolve](#7-the-sequence-reservation-failures-resolve)
8. [Sales receipts](#8-sales-receipts)
9. [Cancellation](#9-cancellation)
10. [Bulk registration and the callback](#10-bulk-registration-and-the-callback)
11. [Key pairs and rotation](#11-key-pairs-and-rotation)
12. [Options and errors](#12-options-and-errors)
13. [MoR rules and codes seen live](#13-mor-rules-and-codes-seen-live)
14. [What was verified, and the going-live checklist](#14-what-was-verified-and-the-going-live-checklist)
15. [Moving EDR onto this package](#15-moving-edr-onto-this-package)

---

## 1. Read this first

- **A registered document cannot be edited.** Correct it with a credit or debit note, or cancel
  it. A wrong TIN or a wrong amount filed under your seller credentials is a tax record.
- **Every document carries MoR's next invoice counter, next document number and the previous
  document's IRN.** MoR refuses anything out of sequence, and moves both numbers only when it
  accepts. The hard part is not the HTTP call. It is keeping your numbers in step with MoR's
  ledger when a call times out and nobody knows whether MoR stored the document.
- **Never resend an `UNKNOWN`.** MoR may have stored it; a resend under new numbers registers a
  duplicate. The package blocks the whole system number instead, and only `resolve()` unblocks
  it. Somebody must be told (the `UNKNOWN` event is HIGH priority) and must know how to resolve.
- **Nothing is retried that could have been stored.** A 429, a connection that never came up,
  and MoR's own buyer lookup failing are retried later (RETRY_LATER). Nothing else is.
- **Turn the sweeps on only after one manual filing has worked in production**, and decide first
  what happens to old unfiled invoices: anything older than 3 days can no longer be filed (7026).

What the package changed from EDR, on purpose, is in section 15 with the reasons.

## 2. How EIMS works

- Your system is a **source system** registered with MoR. It has a system number and a type
  (POS, MAN, CRM, EFD, SYS). MoR stamps both into the access token; that copy is the authority.
- Each invoice is a JSON document. MoR checks its schema and rules and answers with an **IRN**
  and a signed QR (a base64 PNG); both belong on the printed invoice.
- Every request is signed with an RSA key whose certificate INSA issues, inside
  `{request, signature, certificate}`.
- When the customer pays, you file a **sales receipt** against the invoice's IRN (the Cash
  Receipt Voucher).
- A registered document is changed with a **credit note** (CRE) or **debit note** (DEB) that
  references it, through the same endpoint, or **cancelled**.

```
NOT_SUBMITTED --register--> SUBMITTING --IRN--------------------> REGISTERED --cancel--> CANCELLED
      ^                         |                                     |
      | RETRY_LATER             |-- certain refusal --> FAILED         +-- receipts (one per payment)
      +-------------------------|                                     +-- credit / debit notes
                                +-- no clear answer --> UNKNOWN --resolve(irn | discard)-->
```

## 3. The calls

Base URL `https://core.mor.gov.et` (option `baseUrl`).

| Endpoint | Purpose | Inner request |
| --- | --- | --- |
| `POST /auth/login` | token | `{clientId, clientSecret, apikey, tin}` |
| `POST /v1/register` | one invoice, credit or debit note | the document (section 4) |
| `POST /v1/verify` | read a document back by IRN | `{irn}`, lowercase (the answer spells it `Irn`) |
| `POST /v1/cancel` | cancel one | `{Irn, ReasonCode, Remark}`, capital `Irn` |
| `POST /v1/bulkCancel` | cancel several | an array of the same |
| `POST /v1/bulkRegister` | several documents, results by webhook | an array of documents |
| `POST /v1/receipt/sales` | a sales receipt | section 8 |

**Every endpoint, login included, takes the signed envelope (live).** The collection shows bare
bodies for verify, cancel and receipts; sent bare they answer `400 GATEWAY ERROR code=4001`,
naming `request`, `signature` and `certificate`. Login took a flat body on 2026-09-09 and
required the envelope by 2026-09-17. One call answers which it is today:

```sh
curl -s -X POST https://core.mor.gov.et/auth/login -H 'Content-Type: application/json' -d '{}'
```

**Signing** (`signEnvelope`, matching MoR's certificate guide, proven live):

1. compact JSON of the inner request only;
2. its UTF-8 bytes;
3. RSA with SHA-512 and PKCS#1 v1.5 (Java `SHA512withRSA`, not PSS);
4. base64 of the raw signature (256 bytes for RSA-2048);
5. the certificate as base64 of the **file's exact bytes**, `Subject:`/`Issuer:` lines included.

The body is assembled by hand around that same payload string, so what goes over the wire is
byte for byte what was signed. A refused signature answers 400 "Certificate Or Signature
Validation Error" with 67004 (another key), 67012 (a certificate MoR will not accept) or 67013
(malformed) **(live, on /v1/verify)**.

**Login** answers `{data: {accessToken, expiresIn, refreshToken}}`. The client reads
`systemNumber` and `systemType` out of the token (it does not verify MoR's token; it is MoR's),
checks them against `expectedSystemNumber` / `expectedSystemType` when set, caches the token
until 45 seconds before it expires, and lets concurrent callers share one login. The refresh
token is not used: one login an hour costs nothing, and whether `/auth/refresh-token` needs
signing is unknown. Login codes **(live)**: 4400 invalid credentials, 4408 wrong API key (a
trailing space did it; the options trim), 4410 wrong client id or secret.

**Protected calls** send `Authorization: Bearer <token>` and an `apikey` header. A 401 drops the
token and retries once. A 67012 retries once if the active pair changed meanwhile (another
instance rotated it; section 11). Every call has one deadline (`httpTimeoutMs`, default 30 s)
and a 1 MB cap on the answer.

## 4. The document

`buildEimsDocument(document, sequence, prepared, options)` is pure;
`prepareDocument(document, options)` runs every local check first and throws `INVALID` with a
code. The registration service calls both, `prepareDocument` before any number is taken.

| Field | Rule |
| --- | --- |
| `Version` | `"1"`; a payload without it fails the schema. |
| `TransactionType` | B2B for a company, B2C for an individual (`buyer.kind: "individual"`), B2G for `kind: "government"`. A document can override, but an individual is always B2C. |
| `BuyerDetails.IdType` / `IdNumber` | **Required on every buyer, companies included (7004, live).** Default NID with the company's own TIN, which MoR accepted; an individual files NID with their Fayda number and **no `Tin`**. |
| `BuyerDetails.Tin` | A real TIN, 10 digits by default (`buyerTinPattern`). A minted placeholder is refused: filing a TIN the buyer does not hold is worse than not filing. |
| `BuyerDetails.VatNumber` | `^[0-9]{3,25}$` (error 1023, live); anything else is sent as null, never repaired. |
| `Country`, `Region`, `City`, `Wereda` | **MoR location codes**, from MoR's own master `EIMS_COUNTRY_REGION_VW` (`mor-locations.data.ts`). MoR's "City" is the zone level. Resolved hierarchically (KERSA, GORO, BABILE and BURE exist in several zones), no fuzzy matching, a reviewed alias list (Kolfe Keraniyo is MoR's KOLFIE KERANIYO), and e-Trade's Addis shape (zone repeats the region, woreda in kebele) read one level down. Or give `buyer.geo` already resolved. |
| `DocumentDetails.DocumentNumber` | MoR's plain integer, from the sequence (`^(0\|[1-9][0-9]{0,8})$`), never your own invoice number. |
| `DocumentDetails.Date` | `dd-MM-yyyyTHH:mm:ss`, Ethiopian time (`documentUtcOffsetMinutes`, default 180), no zone. **7026: at most 3 days old**, checked before reserving. A document with no issue date is issued now when filed (`host.markIssued`), as EDR does: filing is issuing. |
| `ItemList[].Quantity` / `UnitPrice` | **MoR checks Quantity x UnitPrice at four decimals (live).** The stored rate if it multiplies out, else the amount over the quantity at 4 dp; when even that is inexact (583.94 t billed 5,153,568.04; 1,000 over 3 containers) the line is filed as **1 x amount** and an invoice's description names the billed quantity: "Bulk rail freight (583.94 t)". |
| `NatureOfSupplies` | `goods` or `service`, lowercase (`"Service"` fails the whole list). |
| `Unit` | A MoR unit (PCS by default); your own basis words fail three checks at once. |
| `TaxCode` / `TaxAmount` | Per charge type from `tax.byChargeType`, else `tax`. `TaxAmount` = PreTax x rate, 2 dp. Finance signs these off; nothing is defaulted. |
| `TotalLineAmount` / `ValueDetails` | PreTax + tax + excise per line; sums over the lines. The lines must add up to `totalAmount` (tax and excise included) or the document is refused locally. Line `Discount` is sent but not subtracted: its effect was never seen live. |
| `ValueDetails.ExchangeRate` | Required for a currency other than ETB. |
| Withholding | 0 by default, always 0 for an individual; per document through `document.withholding`. |
| `PaymentDetails` | `paymentMode` (CASH; a document can say CREDIT), `paymentTerm` IMMIDIATE, spelled as in MoR's examples. |
| `SellerDetails` | From `options.seller` and `options.tin`, exactly as MoR holds them (7017). Region and wereda are codes. |
| `SourceSystem` | System number and type from the token, the reserved counter, `cashierName`, `salesPersonName`. |

## 5. Credit and debit notes

A note goes through `/v1/register` with `type: "CRE"` or `"DEB"`, a `reason`, and the original's
IRN in `relatedIrn` (refused before reserving if the original has none). It uses the same sequence
and chain.

**Rule 7020 (live, 2026-09-17): a note must restate the original's lines.** MoR compares
`ProductDescription`, `Quantity`, `TaxCode`, `Unit` and `NatureOfSupplies` line by line, by
position; only the money may differ. A note with one made-up "Credit memo" line was refused
"Item mismatch at line 1". `memoLines(original, "CRE", spec)` builds the lines from the original
**as filed** (a collapsed original line is restated as 1 x its suffixed description) and:

- `{ amount }` spreads the amount in proportion to the original lines, the remainder on the last;
- `{ lines: [{ index, amount, quantity? }] }` amends only those lines.

A credit never exceeds what was billed. Accepted on another system's test filings: a note with
only some of the original's lines, a lower quantity, a different 4-decimal unit price, and one
credit plus one debit against the same invoice. One MoR line carries one unit price: different
amounts per container on one line file as their average.

## 6. Your side: the host

`EimsHost.transaction(work)` runs `work` in one database transaction; the `EimsLedger` it is
given reads and writes rows inside it:

| Ledger method | Must |
| --- | --- |
| `lockSystemState(systemNumber)` | `SELECT ... FOR UPDATE` the sequence row, creating it at 1 / 1 when missing (`INSERT ... ON CONFLICT DO NOTHING` first). |
| `lockFiling(documentId)` | Lock the document's filing; return a NOT_SUBMITTED one when it has none, null when the document does not exist. |
| `lockFilingsByConversation(id)` | Lock the filings of one bulk batch, in counter order. |
| `listReceipts` / `insertReceipt` / `saveReceipt` | `insertReceipt` returns **false** when your unique index on (document, payment key) over live statuses refuses it (Postgres: `ON CONFLICT ... DO NOTHING RETURNING`, so the transaction is not aborted). |
| `lockCredentials` / `insertCredential` / `saveCredential` | Lock every credential row (an empty table has nothing to lock: take an advisory lock too); back it with a unique index allowing one ACTIVE row. |

Lock order is always the sequence row, then filings, then receipts or credentials. **The
lock must be a real row lock**: two API instances on one database must serialize on the
sequence row (the Postgres test's gapless-numbers race fails without it).

Outside transactions: `loadDocument` (section 4's model), `markIssued`, `loadReceiptSource`
(total and payment ledger, oldest first), `nextUnfiledDocument` and `nextUnreceiptedPayment` for
the sweeps, `listCredentials`, `anyRegisteredIrn`, `onEvent`, `recordExchange`.

`onEvent` is how people hear about things:
- **HIGH:** `UNKNOWN`, `PERSIST_FAILED` and a callback that failed verification
  (`BULK_CALLBACK_UNTRUSTED`). Each of these stops filing, or puts something accepted at risk.
- **NORMAL:** `REJECTED`, `RETRY_LATER`, `REGISTERED` and receipt events. Tell the buyer of a
  registration (MoR checklist ADD-N001).
- `CERTIFICATE_EXPIRY`.

An event or log failure is logged and never changes an outcome.

## 7. The sequence: reservation, failures, resolve

```
TX1, committed before any call
  lock the sequence row; refuse (BUSY) if blocked or anything is in flight
  lock the filing; return ALREADY_REGISTERED if it has an IRN
  take counter and document number; advance both; record in_flight; filing SUBMITTING
the call, outside every transaction
TX2  accepted:  filing REGISTERED with IRN, ack date, QR; chain to the IRN; clear in_flight
     refused:   give both numbers back, or adopt MoR's "expected : N", but only if the row
                still holds exactly what TX1 left (a counter corrected meanwhile is not
                overwritten); clear in_flight; filing FAILED, or NOT_SUBMITTED if retryable
     unclear:   keep the numbers; set blocked_reason; filing UNKNOWN; HIGH event
```

| What happened | Kind | Stored? | Outcome |
| --- | --- | --- | --- |
| 400 | SCHEMA_VALIDATION | no | REJECTED |
| 401 after one re-login | AUTH | no | REJECTED |
| 403 | FORBIDDEN | no | REJECTED |
| 406 | RULE_VALIDATION | no | REJECTED, or RETRY_LATER when it is MoR's buyer lookup (503 in the text) |
| 429 | RATE_LIMITED | no (refused before processing) | RETRY_LATER |
| connection never came up (DNS, refused, TLS, a deadline before connecting) | NETWORK, `sent: false` | no | RETRY_LATER |
| timeout after connecting, reset, 5xx, a 2xx without an IRN, any other status | TIMEOUT / NETWORK / SERVER / UNKNOWN | **maybe** | UNKNOWN, system number blocked |
| failed while building the request | INVALID / CONFIG | no | REJECTED |
| accepted, but saving failed | PERSIST | **yes** | PERSIST_FAILED, blocked with the IRN in the reason |

**"Expected : N" (live, 2026-10-09).** A restored or new sequence row starts at 1 against a
ledger at 40; MoR's 7015 and 7001 rejections name the numbers it wants, and the next attempt uses
them. Only those two rules and only plain positive integers are read.

**Resolving.** MoR can only be asked by IRN, so a person checks the MoR portal, then:

- `resolve(id, { irn })`: verified first. The returned `Irn` must equal it **and** its
  `DocumentNumber` must be the one this document reserved, or it is refused: a transposed digit
  would mark an unfiled invoice registered and chain every later document to a stranger's IRN.
  Then REGISTERED, the chain resumes from it, the block is cleared. The QR is not recovered
  (verify does not return it).
- `resolve(id, { discard: true })`: MoR has no record. FAILED, the numbers given back, the block
  cleared.

A `PERSIST_FAILED` is resolved the same way with the IRN from the block reason or the event.
Never resend it.

**The sweep.** `autoSubmitNext()` files one document per call: the oldest NOT_SUBMITTED from
`nextUnfiledDocument` inside `maxDocumentAgeDays`. It is slow on purpose, so a misconfiguration
costs one rejection, not a burst (EDR runs it every 5 minutes).
- It pauses while the certificate is expired, the system number is blocked or something is in flight.
- A document refused locally before reserving (no TIN, a bad address) is marked FAILED, so it does not hold up the queue.
- It never picks FAILED (a person fixes it) or UNKNOWN (resolve), and it never throws.

## 8. Sales receipts

`fileSalesReceipt(invoiceId, input)` files the receipt for one payment: `input.paymentKey`, or
the oldest payment without a live receipt. That is the order MoR's `RemainingAmount` runs down in.

- **Figures as of that payment**, from the ledger: `CollectedAmount` = `InvoicePaidAmount` = that
  payment, `RemainingAmount` after it, `PaymentCoverage` FULL or PARTIAL. A caller's amount is
  only a confirmation.
- **Live schema rules (2026-09-09):**
  - `ReceiptNumber` at most 20 characters, built as R + the invoice number without INV- + -attempt;
  - `ManualReceiptNumber` at most 15 characters (finance's voucher number, or null);
  - `ModeOfPayment` one of CASH, ADVANCE, CREDIT, CHEQUE, CPO, SWIFT, CARD, WIRE, BANK, LC;
  - `CollectorName` required, and a null reads as missing (default `cashierName`);
  - currency ETB, USD or CAD.
- **The mode is derived only where it is unambiguous** (a mode finance named, a CBE bill or CAC
  Bank channel, a card, a bank or wire transfer). Mobile money and a bare GATEWAY need the
  caller to name it: guessing a tax field is worse than asking.
- **One live attempt per payment**, claimed under the invoice's lock and your unique index; the
  attempt row exists before the call, so a crash leaves UNKNOWN, not nothing. The receipt number
  is allocated under the same lock.
- A refusal is FAILED (finance retries). An unanswered attempt is UNKNOWN and keeps the payment's
  slot until `resolveReceipt(invoiceId, receiptId, { rrn } | { discard: true })`: MoR has no
  receipt lookup and no proven duplicate guard. An RRN that could not be saved goes into a HIGH
  event.
- No receipt for a cancelled or unregistered invoice.
- `autoFileNext()` files one per call. A payment that cannot be receipted unattended gets a
  FAILED row saying why, so the sweep moves on.

## 9. Cancellation

`cancel(id, reasonCode, remark)` sends `{Irn, ReasonCode, Remark}`. The reason code is MoR's
numeric code: "1" duplicate, "6" calculation error (from the collection). Cancelling touches no
counter. Check under a lock, call outside it, record under it. A second local cancel is refused
(MoR's checklist IRC-N010 wants an error). MoR's "IRN already Canceled." is recorded as done, so a
cancel whose first answer was lost can still be recorded. The success date is Java's
`Date#toString` ("Sun Dec 22 21:55:03 EAT 2024"), kept as given. `cancelBulk` refuses ineligible
documents locally and sends one call for the rest. **Not tested live since the envelope became
mandatory**: testing it means cancelling a real document.

## 10. Bulk registration and the callback

`registerBulk(ids)` reserves a contiguous block of numbers (single and bulk share the sequence and
block each other), sends one envelope around the array, and stores MoR's `conversationId`. MoR
answers 202; the results arrive later as a POST to the URL agreed with MoR out of band. The
callback array mixes `{irn, documentNumber, signedQR}`, `{ruleError, docNo}` and the batch
marker `{conversationId}` or `{conversionId}` (both spellings appear).

MoR sends no credential, so nothing in a callback is trusted on its own:
- **An acceptance is applied only after `/v1/verify` confirms** that its IRN exists and belongs
  to the document number this batch reserved. A forged callback that knows a conversation id
  cannot mark invoices registered, or chain later documents to a fake IRN.
- **A rejection is applied only when the call came with `bulkWebhookToken` in its path.**
  Register `.../eims/webhook/bulk-register/<token>` with MoR. Without the token, the rejection
  is left SUBMITTING and an event says so.
- `discardBulk(conversationId)` is the way out when a callback never comes.

Every callback is logged with the caller's address. **Bulk has not been tested against MoR.**
Within a batch, documents after the first carry an empty PreviousIrn, as EDR sends them. A
rejected item's numbers stay consumed, as EDR assumes; if MoR does not consume them, the next
filing self-corrects through "expected : N".

## 11. Key pairs and rotation

MoR and INSA confirmed: the certificate is renewed **yearly**; renewal keeps the **same system
number**, so the counters and chain carry on; no registration step; **no overlap**. Once the new
certificate is used, MoR retires the old one. So testing a new pair is using it, and testing and
switching must be one operation.

- **A fixed pair**: `privateKey` (PEM) and `certificate` (the file as issued) in the options.
- **Stored pairs**: set `encryptionKey` (32 bytes, base64; `openssl rand -base64 32`; one per
  environment, with a sealed offline copy for production).
  - `upload` checks the pair offline: PEM RSA, a certificate that belongs to the key, inside its
    validity window. It stores the pair PENDING with the key encrypted under AES-256-GCM
    (`v1.<iv>.<tag>.<ct>`, the format EDR uses).
  - `importStaticPair` moves the fixed pair into the store.
- **`activate(id)`**, one step:
  1. It refuses while a submission or bulk batch is in flight.
  2. It logs in with the active pair, or the pending one if the active certificate no longer
     works (an expired certificate must not lock you out of its own replacement).
  3. The token must name the same system number as before.
  4. It proves the pending pair with a signed, read-only `/v1/verify` of a known IRN, and
     refuses on 67xxx. If MoR cannot answer, it carries on unproven.
  5. Under the credentials lock, the pending row must still be pending and the active one
     unchanged; a concurrent activation loses. Then it retires the old row, **destroying its
     key**, and activates the new one.
  6. It installs the session it logged in with.
- **Several instances.** Each one re-reads the active row every 15 s. One that still signs with
  the retired pair gets MoR's 67012, re-reads, and retries once (a 67012 is a certain refusal).
- **`checkCertificateExpiry()`** (daily) sends one event 60, 30 and 7 days before expiry and once
  after. The sweep pauses while the certificate is expired.

## 12. Options and errors

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://core.mor.gov.et` | |
| `clientId`, `clientSecret`, `apiKey`, `tin` | required | login; trimmed |
| `privateKey`, `certificate` | | a fixed pair |
| `encryptionKey` | | enables stored pairs |
| `expectedSystemNumber`, `expectedSystemType` | | checks against the token; a mismatch is CONFIG |
| `seller` | required | `legalName`, `vatNumber`, `phone`, `email`, `region` (code), `wereda` (code), `city`, `subCity`, `houseNumber`, `locality` |
| `tax` | required | `code`, `ratePercent`, `exciseTaxValue`, `discount`, `byChargeType` |
| `transactionType` | B2B | for company buyers |
| `natureOfSupplies` | service | |
| `paymentMode`, `paymentTerm` | CASH, IMMIDIATE | |
| `unitDefault` | PCS | |
| `cashierName`, `salesPersonName` | | the cashier is also a receipt's CollectorName |
| `maxDocumentAgeDays` | 3 | rule 7026 |
| `documentUtcOffsetMinutes` | 180 | DocumentDetails.Date zone |
| `stampIssueDate` | true | issue an unissued document when it is filed |
| `buyerTinPattern` | `^[0-9]{10}$` | |
| `httpTimeoutMs` | 30000 | per call; a timeout after sending is ambiguous |
| `tokenSkewSeconds` | 45 | |
| `ca`, `insecureTls` | | extra CAs are added to Node's; insecureTls is refused for mor.gov.et |
| `bulkWebhookToken` | | section 10 |

`missingEimsOptions` and `invalidEimsOptions` name what is missing or does not match MoR's
patterns (names only, never values). Filing refuses with CONFIG until both are empty.

Errors are `EimsError` with a `kind` (section 7's table, plus `CONFIG`, `INVALID`, `BUSY`,
`PERSIST`) and `details`. The details hold:
- `httpStatus` and `body`: MoR's error fields only, never the envelope or a token;
- `rules`: the rule numbers MoR named, such as 7015 or 67012;
- `code`: a finer reason, such as BUYER_TIN_REQUIRED, GEO_MAPPING_FAILED, SYSTEM_BLOCKED,
  IN_FLIGHT or BUYER_LOOKUP_UNAVAILABLE;
- `sent`: whether the request can have reached MoR.

**The exchange log.** Every call and callback goes to `recordExchange` with the operation, the
documents, status, timing and the bodies. Credentials (`clientSecret`, `apikey`, tokens,
`password`, `privateKey`...) are replaced by `[REDACTED]`. The bearer and apikey headers are
masked. The certificate is reduced to its fingerprint and subject. The inner document and the
signature are kept whole: they are the evidence. Bodies over 512 KB are cut to a head.

## 13. MoR rules and codes seen live

| Where | Answer | Meaning |
| --- | --- | --- |
| any | 400 GATEWAY ERROR, code 4001, details naming request/signature/certificate | sent without the envelope |
| any | 400, 67004 / 67012 / 67013 | another key / certificate refused / malformed signature |
| login | 400 VALIDATION_ERROR naming the envelope fields | login wants the envelope |
| login | 401, 4400 / 4408 / 4410 | invalid credentials / API key / client id or secret |
| verify | 400 SCHEMA ERROR "required property 'irn' not found" | the inner key is lowercase `irn` |
| register | 1023 on BuyerDetails.VatNumber | 3 to 25 digits, else null |
| register | "must be the constant value 'service'" | NatureOfSupplies lowercase |
| register | Unit list, length or pattern | a MoR unit |
| register | 406, 7001 / 7015 "expected : N" | adopt N |
| register | 406, 7004 | IdType on every buyer |
| register | 406, 7017 | seller details differ from MoR's registry |
| register | 406, 7020 "Item mismatch at line N" | a note must restate the original |
| register | 406, 7026 | the date is more than 3 days old |
| register | "Error in Total Line Amount ... expected X received Y" | Quantity x UnitPrice at 4 dp; 1 x amount |
| register | "BUYER_TIN ... buyer not found 503" | MoR's own lookup failed; of the roster only 0089238373 ever resolved for EDR |
| any | 429 "Too many requests!" | refused before processing; not ambiguous |
| receipt | ReceiptNumber at most 20, ManualReceiptNumber at most 15 | |
| receipt | ModeOfPayment not in the list; CollectorName required | |
| receipt | "Currency should be ETB, USD, CAD" | |
| cancel | "IRN already Canceled." | already cancelled at MoR |

## 14. What was verified, and the going-live checklist

**Verified here** (82 unit and HTTP tests against the mock, 14 Postgres tests with two instances):
- the reservation, give-back, "expected : N" adoption, block, resolve and persist-failure paths;
- the races;
- every local refusal;
- receipts per payment;
- cancel;
- 7020 restatement;
- the sweeps;
- bulk with forged and genuine callbacks;
- key rotation across instances, including the 67012 catch-up;
- the redaction.

The mock enforces what MoR enforced live, written apart from the package. **The package itself
never called MoR.**

**From EDR's live filings, carried over unchanged:** the envelope, signing, login body and codes,
the document's field names and casing, 7004, 7015/7001, the four-decimal arithmetic, the
receipt schema, verify's casing.

**Not verified; confirm against MoR's test environment:**
- **The 503 buyer lookup.** The text was seen live, but not the HTTP status of that answer. As a
  406 it is RETRY_LATER; if MoR sends HTTP 503 it is SERVER, which is ambiguous and blocks.
- **The chain.** Whether MoR enforces PreviousIrn. The mock does.
- **A 2xx wrapping an error.** Whether MoR sends a 2xx with `statusCode` 406 inside.
- **Taxed lines.** Whether Quantity x UnitPrice is compared with PreTaxValue or TotalLineAmount
  when tax is not 0. EDR only ever filed 0%.
- **Discounts.** The effect of a line `Discount`.
- **Verify of an unknown IRN.** The status of the answer; the mock answers 404.
- **Cancel and bulk cancel since the envelope.**
- **Bulk register end to end:** the callback shape, number use and the chain within a batch.
- **Receipts.** `ReceiptDate` as ISO UTC, `ReceiptCounter` as epoch ms, whether MoR refuses a
  duplicate ReceiptNumber, and a second receipt on one IRN (`InvoicePaidAmount` taken as per
  receipt).
- **The 67012 location.** That a refused certificate on /v1/register answers 67012 in `body.code`,
  as on /v1/verify.
- **The ack date.** That `ackDate` is always ISO-like or Java `Date#toString`.

**Going live:**

- [ ] `curl -d '{}'` against /auth/login to confirm the body shape.
- [ ] Log in; the token's system number and type are the ones MoR gave you (set `expectedSystemNumber`).
- [ ] Verify an IRN MoR gave you: proves the signing on a call that changes nothing.
- [ ] Register one invoice to MoR's test buyer 0089238373; let "expected : N" correct the counters if needed; verify it.
- [ ] A credit note that restates its lines; a receipt for a partial payment, then the rest.
- [ ] A simulated timeout: UNKNOWN, the system number blocked, a HIGH event, resolve with the IRN and with discard.
- [ ] Print the invoice and the voucher; the QR codes scan.
- [ ] Read the exchange log: no secret in it.
- [ ] Production credentials, certificate and encryption key in your secret store, not in files.
- [ ] Seller details character for character as MoR holds them; finance signed off every tax code.
- [ ] Every buyer you will file for has a real TIN (or a Fayda number) and an address that resolves (`resolveMorGeo` over all of them first).
- [ ] Sweeps off until a manual filing worked in production; someone on the alert list knows how to resolve.
- [ ] The certificate's expiry on a calendar as well: yearly, no overlap.

## 15. Moving EDR onto this package

### What is wrong in EDR today (origin/dev 4e43da58b)

EDR's design is the source of this package and most of it is sound: the durable reservation,
the single list of "not stored" kinds, "expected : N", the conditional give-back, verify before
resolve, the redaction. These are the problems found while porting it.

1. **The 30-day and 7-day certificate reminders never fire.**
   `eims-credential-rotation.service.ts remindOfExpiry` picks
   `REMINDER_STAGES.find((s) => days <= s)` over [60, 30, 7]. That is 60 for any day count under
   60, and stage 60 counts as already sent from then on. Only the 60-day and the expired
   reminders ever go out. The package picks the smallest stage.
2. **`EIMS_BUYER_ID_NUMBER` puts one ID number on every buyer.** In `eims-invoice.mapper.ts` the
   rule is `IdNumber: b2cIdNumber ?? context.buyerIdNumber ?? company.tin`, and the configured
   value applies to every invoice. The package takes IdType and IdNumber per buyer.
3. **The document date is in the server's time zone.** `formatEimsDate` uses `getHours()` and
   friends, so on a UTC container `DocumentDetails.Date` is three hours behind Ethiopian time.
   The package formats in UTC+3 (`documentUtcOffsetMinutes`).
4. **A dropped connection blocks the whole system number.** `toEimsApiException` maps every "no
   response" to NETWORK, which is ambiguous, so a DNS failure or a refused connection blocks
   filing until someone resolves it. The request never left. The package tracks whether the
   connection came up: if not, RETRY_LATER with the numbers given back.
5. **429s and MoR's buyer-lookup 503 strand documents.** EDR marks them FAILED, which the sweep
   never retries, though nothing was wrong with them. The package puts them back to
   NOT_SUBMITTED.
6. **A 200 without an IRN is treated as a rejection.** `submit()` throws SCHEMA_VALIDATION,
   which is deterministic, so the numbers are given back. If MoR did store the document, the
   chain silently breaks. The package treats it as UNKNOWN.
7. **Discarding an UNKNOWN keeps its numbers consumed.** `resolveEimsRegistration` with
   `discard`, after which the next filing is refused 7015/7001 before it self-corrects. The
   package gives them back.
8. **A receipt can be filed against a cancelled invoice.** `loadRegisteredInvoice` checks only
   `eimsIrn`, which cancellation keeps. The package refuses.
9. **Two receipts can get the same ReceiptNumber.** `generateReceiptNumber` counts attempts
   outside the claim lock, so two payments of one invoice receipted at the same moment can share
   a number. The package numbers inside the lock.
10. **An accepted receipt that is not saved loses its RRN.** EDR's catch marks the row UNKNOWN,
    if it can, and the RRN survives only in the exchange log. The package keeps the slot and
    puts the RRN in a HIGH event.
11. **"IRN already Canceled." is a failure in EDR.** A cancel whose first answer was lost can
    never be recorded locally. The package records it as cancelled.
12. **Forged bulk callbacks are applied.** The bulk callback applies every `irn` item for a known
    conversation id without checking it. A forged callback can mark invoices registered under
    fake IRNs and set `previous_irn`, so every later filing chains to a fake IRN. The package
    verifies each IRN, and needs the path token for rejections.
13. **A bulk batch whose callback never comes blocks the system number for good.**
    `resolveEimsRegistration` only handles `in_flight_invoice_id`, so only a database edit frees
    it. The package has `discardBulk`.
14. **Bulk ignores a shipping-line buyer.** Its buyer checks and geography read `invoice.company`
    only, unlike single registration, so a shipping-line credit invoice in a batch fails after
    the reservation (released as LOCAL).
15. **The auto-submit pause check rarely fires.** `systemBlockReason()` reads the row by
    `cfg.systemNumber`, which is blank unless `EIMS_SYSTEM_NUMBER` is set, and ignores
    `in_flight_conversation_id`. The reservation still refuses, so this only costs log noise.
16. **Manual registration does not check rule 7026 first.** An old invoice takes a reservation
    and comes back 7026 (the numbers are returned, but it costs a MoR call). The package checks
    the age before reserving.
17. **After a rotation, other instances sign with the retired pair for up to 15 s.** The
    credential cache makes MoR answer 67012 and the invoice ends FAILED. The package re-reads and
    retries once.
18. **The conditional give-back checks only the counter.** `settleFailure` compares
    `next_invoice_counter`, not `next_document_number`. The package checks both.
19. **Taxed invoices would be refused locally.** The mapper compares the pre-tax line sum with
    the invoice total, so an invoice whose total includes VAT fails. Harmless while EDR files 0%.
    The package compares the total with tax.
20. **Line order is not guaranteed.** `invoice_lines` are read `ORDER BY created_at`, and lines
    written in one transaction share `now()`. A memo's positional 7020 comparison can therefore
    meet the lines in another order. Add a tiebreak (likely; not reproduced).

### Steps

1. Implement `EimsHost` over EDR's tables; [examples/edr/edr-mor-eims-host.ts](../examples/edr/edr-mor-eims-host.ts)
   is a sketch. Add `invoices.eims_retry_count`, and a tiebreak to the line order.
2. Build the options from `EimsSettingsService.snapshot()`. Keep `EIMS_SETTINGS_ENCRYPTION_KEY`:
   the stored-secret format is the same, so EDR's `eims_credentials` rows decrypt as they are.
3. Replace the bodies of `EimsInvoiceRegistrationService`, `EimsBulkRegistrationService`,
   `EimsReceiptService`, `EimsCancellationService` and `EimsCredentialRotationService` with calls
   to the package. Keep their controllers, permissions and DTOs. The `@Cron` jobs call
   `autoSubmitNext`, `autoFileNext` and `checkCertificateExpiry`.
4. Keep `mor-locations.data.ts` in one place: the package ships the same file.
5. Give MoR the bulk callback URL with a token, or keep bulk off; it has never run against MoR.
6. Run the going-live checklist (section 14) on MoR's test environment before production.
