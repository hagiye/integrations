# File index

Every file in the package and where it came from in EDR (`edr-platform` origin/dev
`4e43da58b`). EDR paths are under `apps/edr-freight-api/src/` unless they say otherwise.
"New" means EDR has no counterpart. Back to the [README](../README.md).

## Package — `src/`

| File | What it is | From EDR |
| --- | --- | --- |
| `eims.types.ts` | Wire types (envelope, login, register, verify, cancel, bulk, receipt) and the package's model: `EimsDocument`, `EimsBuyer`, `EimsFiling`, `EimsSystemState`, `EimsReceiptRecord`, `EimsCredentialRecord`, `EimsExchangeRecord` | `modules/eims/eims.types.ts`, `eims-registration.types.ts`, `eims-receipt.types.ts`, the interfaces of `modules/billing/eims-invoice.mapper.ts`, the entities' columns |
| `eims.errors.ts` | `EimsError`, its kinds, `definitelyNotStored`, `retryableNotStored`, the error-body reduction and description, rule extraction, buyer-lookup detection | `modules/eims/eims.errors.ts` (`DETERMINISTIC_KINDS`, `redactEimsBody`, `describe`); `sent` and retryable are new |
| `eims.http.ts` | `postText`: one POST of a pre-serialized body, one deadline, 1 MB cap, `sent` tracking; `caWithNodeDefaults`; `isMorProductionHost` | new (EDR used `@nestjs/axios`) |
| `eims.signer.ts` | `signEnvelope` (RSA-SHA512 PKCS#1 v1.5, body assembled around the signed payload), `loadRsaPrivateKey` | `modules/eims/eims-signer.service.ts`, the PEM checks of `eims-credentials.provider.ts` |
| `eims.options.ts` | Options, `resolveEimsOptions`, `missingEimsOptions`, `invalidEimsOptions` (MoR's seller patterns), `sellerDetails` | `config/eims.config.ts`, `modules/eims/eims-invoice-context.ts` (`assertEimsInvoiceConfig`, `SELLER_FORMATS`, `buildEimsSeller`) |
| `eims.redaction.ts` | Exchange-log redaction and operation names | `modules/eims/eims-exchange.redaction.ts` |
| `eims.sequence.ts` | `morExpectedSequence` (7015 / 7001 "expected : N"), `normalizeAckDate` | `modules/eims/eims-expected-sequence.util.ts`, `eims-ack-date.util.ts` |
| `eims.geo.ts` | `resolveMorGeo` (hierarchical, aliases, zone suffix, woreda number, the Addis shift), `checkGeoCodes` | `config/mor-location.resolver.ts` |
| `mor-locations.data.ts` | MoR's location master `EIMS_COUNTRY_REGION_VW`, unchanged | `config/mor-locations.data.ts` (generated there by `scripts/import-mor-locations.ts`) |
| `eims.document.ts` | `prepareDocument` (every local check), `buildEimsDocument`, `eimsLineFigures`, `eimsUnitPrice`, `morVatNumber`, `formatEimsDate` (Ethiopian time), `lineTax`, `resolveTransactionType` | `modules/billing/eims-invoice.mapper.ts`, `modules/eims/eims-invoice-context.ts` (`resolveLineTax`, `resolveEimsTransactionType`, `resolveEimsWithholding`), the pre-reservation checks of `eims-invoice-registration.service.ts` |
| `eims.memo.ts` | `memoLines`: a credit or debit note's lines restating the original as filed | `modules/billing/billing.service.ts` `issueMemo` (the restate and spread parts) |
| `eims.receipt-figures.ts` | `receiptFiguresFor` (as of a payment), `paymentKey`, `deriveModeOfPayment`, `receiptNumberFor`, the field caps | `modules/eims/eims-receipt-defaults.util.ts`, `generateReceiptNumber` of `eims-receipt.service.ts` |
| `eims.client.ts` | `EimsClient`: login, token cache, the protected calls, 401 and 67012 retries, classification, the exchange log | `modules/eims/eims-auth.service.ts`, `eims-client.service.ts`, `eims-exchange-recorder.ts` (outbound), `submit` / `queryVerify` of `eims-invoice-registration.service.ts` |
| `eims.credentials.ts` | `EimsSecretBox` (AES-256-GCM), `parseCredentialPair`, `EimsCredentialService` (key source, upload, import, activate, expiry reminders) | `modules/eims-settings/eims-crypto.service.ts`, `eims-credential.parser.ts`, `eims-credential.store.ts`, `eims-credential-rotation.service.ts`, `modules/eims/eims-credentials.provider.ts` |
| `eims.host.ts` | `EimsHost`, `EimsLedger`, `EimsEvent`, `newFiling`, `newSystemState` | new (EDR wrote its tables directly) |
| `eims.filing.service.ts` | `EimsFilingService`: register with the durable reservation, settle, persist-failure block, verify, resolve, bulk register and callback, `discardBulk`, `autoSubmitNext` | `modules/eims/eims-invoice-registration.service.ts`, `eims-bulk-registration.service.ts`, `eims-auto-submit.service.ts`, `eims-webhook.controller.ts` (inbound record) |
| `eims.receipt.service.ts` | `EimsReceiptService`: file per payment, claim, settle, `resolveReceipt`, `autoFileNext` | `modules/eims/eims-receipt.service.ts`, `eims-receipt-auto-file.service.ts` |
| `eims.cancellation.service.ts` | `EimsCancellationService`: cancel, bulk cancel, "already Canceled" as done | `modules/eims/eims-cancellation.service.ts` |
| `eims.controller.ts` | `createEimsWebhookController`: MoR's bulk callback, with and without the path token | `modules/eims/eims-webhook.controller.ts` |
| `eims.module.ts` | `EimsModule.forRoot` / `forRootAsync` | `modules/eims/eims.module.ts` |
| `index.ts` | Exports | new |
| `*.spec.ts` | Unit and HTTP tests against the mock MoR, the fake host and Nest (82 tests) | new; cases follow `eims-invoice.mapper.spec.ts`, `eims-invoice-registration.service.spec.ts`, `eims-receipt.service.spec.ts`, `eims-cancellation.service.spec.ts`, `eims-credential-rotation.service.spec.ts`, `mor-location.resolver.spec.ts` |

Not ported: the printed tax document (`modules/billing/documents/invoice-document.service.ts`
`buildMorHtml`, `mor-document.util.ts`, `eims-receipt-document.mapper.ts`), the settings page and
its service (`modules/eims-settings/eims-settings.service.ts`, the back-office pages), the seller
cache that fills blank seller fields from e-Trade (`eims-seller-cache.service.ts`), EDR's
controllers and permissions, and the location import script.

## Tests — `test/`

| File | What it is |
| --- | --- |
| `mock-mor.ts` | A mock MoR gateway with its own signature check, tokens and rules (section 13 of the guide), and one-shot failures |
| `fakes.ts` | `FakeEimsHost` (serialized transactions with rollback), `invoice()`, `optionsFor()`, `wire()` |
| `fixtures.ts` | Throwaway RSA pairs and certificates made with openssl at run time; MoR's public test-roster TINs |
| `eims.pg-spec.ts` | The standalone example on Postgres with two instances and a switchable proxy in front of the mock (14 tests) |
| `jest.setup.ts` | `reflect-metadata`, logger off |

## Examples

| File | What it is |
| --- | --- |
| `examples/standalone/create-eims.migration.ts` | Invoices with the filing columns, lines, payments, the sequence row, receipts (live partial unique index), credentials (one ACTIVE, one PENDING), exchanges, events |
| `examples/standalone/typeorm-eims.host.ts` | `EimsHost` on TypeORM and Postgres: `FOR UPDATE` locks, `ON CONFLICT` receipt claims, an advisory lock for credentials |
| `examples/standalone/invoices.service.ts` | Invoices, memos through `memoLines`, payments |
| `examples/standalone/eims-example.controller.ts` | The staff routes behind a token guard, `EimsError` to HTTP |
| `examples/standalone/eims.scheduler.ts` | The sweeps and the expiry check on timers |
| `examples/standalone/app.module.ts`, `main.ts` | The app |
| `examples/edr/edr-mor-eims-host.ts` | Not compiled: EDR's tables behind the host |

## Docs

| File | What it is |
| --- | --- |
| `README.md` | Overview, install, the steps, outcomes, tests |
| `docs/INTEGRATION-GUIDE.md` | The protocol, the host, the sequence, receipts, notes, bulk, rotation, options, live rules, what was verified, EDR's problems and the move. Builds on the guide in EDR's EIMS extract of 2026-11-03 |
| `docs/FILE-INDEX.md` | This file |
