# File index

This index shows where each part lives, and where it came from in the EDR platform (origin/dev
`4e43da58b`).

EDR paths below are short for:

- **freight API:** `apps/edr-freight-api/src/`
- **types:** `packages/types/src/freight/`
- **back office:** `apps/edr-freight-web/backoffice/src/`

## Package — `src/`

| File | What it is | From EDR |
| --- | --- | --- |
| `etrade.module.ts` | `EtradeModule.forRoot / forRootAsync`; `host`, `lookupRoute` + `lookupGuard`, `actorFrom` | New. EDR provided `ETradeService` and `HttpModule` in freight API `modules/companies/companies.module.ts`. |
| `etrade.client.ts` | `EtradeClient`: `getRegistrationByTin` (S1), `getBusinessByLicence` (S2), answer reading, retries, circuit breaker, the TLS agent (insecure TLS refused for etrade.gov.et) | freight API `modules/companies/services/etrade.service.ts`: `getCompanyInfoByTin`, `getBusinessByLicenseNo`. Same paths, parameters and Referer, but TLS verified, TIN checked and encoded, a deadline, and no error text leaking out. |
| `etrade.service.ts` | `EtradeService`: `lookup`, `licencesFor`, `attach`, `recheck`, the budget charge, the cache, the lookup log | `etrade.service.ts` (`resolveCompanyData`, `listBusinessOptions`, `findBusinessOption`) and freight API `modules/companies/companies.service.ts` (`fetchETradeData`, `attachEtradeBusinessToProfile`, `resolveProfileBusiness`, `refreshProfileBusinesses`, `listEtradeBusinessesForUser`). Status and expiry checks, the snapshot rules and recheck are new. |
| `etrade.host.ts` | **The port you implement**: `EtradeHost`, `EtradeHolder`, `EtradeSaveResult`, `EtradeLookupRecord` | New. EDR wrote `company_profiles.etrade_business` through its repository directly. |
| `etrade-lookup.controller.ts` | `createEtradeLookupController(route, guard)`: guarded `POST /etrade/lookup`; `etradeHttpError`; `defaultEtradeActorFrom` | freight API `modules/companies/companies.controller.ts` (`POST /companies/fetch-etrade-info`, `@PortalCustomer()`), without the leaked error text |
| `etrade.normalize.ts` | TIN and licence-number checks, `toBusinessOption`, `normalizeRegistration`, `normalizeLicence`, `parseEtradeDate`, `licenceStanding`, `resolveCompanyName`, `usableEthiopianPhone`, `extractRegistrationData` | `etrade.service.ts` (`toBusinessOption`, `extractRegistrationData`); types `etrade.ts` (`resolveCompanyName`, `asCompanyNameSource`); freight API `common/validators/is-tin.validator.ts` (10 digits); back office `complaints/services/etradeTinService.ts` (phone preference). Dates, state and phone checks are new. |
| `etrade.selection.ts` | `selectLicence` (no silent swap), `findLicence`, `buildSnapshot`, `notListedSnapshot`, `diffSnapshots`, `isNewer` | `etrade.service.ts` `resolveCompanyData` and `findBusinessOption`; companies.service `refreshProfileBusinesses` (the diff) |
| `etrade.regions.ts` | `ETHIOPIAN_REGIONS`, `REGION_ALIASES`, `normalizeRegion` (extra aliases allowed) | types `ethiopian-regions.catalog.ts`, unchanged |
| `etrade.budget.ts` | `TinLookupBudget`: distinct TINs per actor per window, in memory | freight API `modules/companies/tin-lookup-budget.ts`, returning a boolean instead of throwing an HTTP 429 |
| `etrade.tls.ts` | `ETRADE_ISSUING_CA_PEM` (GlobalSign GCC R3 EV TLS CA 2025), `etradeCaList`, `createEtradeAgent`, `isEtradeProductionHost` | New. Replaces `new Agent({ rejectUnauthorized: false })`. |
| `etrade.options.ts` | `EtradeModuleOptions`, defaults, `ETRADE_PUBLIC_API_URL`, `ETRADE_CHECKER_REFERER`, missing-option check | The two constants are `etrade.service.ts`'s hard-coded `baseUrl` and `referer`. EDR had no options. |
| `etrade.http.ts` | `getText`: one GET with a deadline for the whole exchange and a 1 MB cap; TLS failures named | New (EDR used `@nestjs/axios` with no timeout) |
| `etrade.types.ts` | Raw S1/S2 shapes, `EtradeBusinessOption`, `EtradeRegistration`, `EtradeLicence`, `EtradeRegistrationData`, `EtradeLicenceSnapshot`, states and problems | types `etrade.ts` (`ETradeCompanyInfo`, `ETradeBusinessInfo`, `ETradeBusinessOption`, `CompanyRegistrationData`); freight API `modules/companies/dto/etrade-response.dto.ts`. The snapshot extends `ETradeBusinessOption`. |
| `etrade.errors.ts` | `EtradeError` with a kind: `CONFIG`, `INVALID`, `BUDGET`, `TIMEOUT`, `NETWORK`, `HTTP`, `API`; `isRetryable` | New |
| `index.ts` | Public exports | New |
| `*.spec.ts` | Unit tests, and HTTP tests through Nest, against the mock e-trade (137 tests); includes EDR's selection cases from `modules/companies/services/etrade-business-selection.spec.ts` and the attach rules from `modules/companies/companies.profile-etrade-business.spec.ts` | New, ported cases noted |

## Tests — `test/`

| File | What it is |
| --- | --- |
| `mock-etrade.ts` | A stand-in e-trade on 127.0.0.1 (HTTP, or HTTPS with a given certificate). It refuses requests without the checker Referer with 417, and can hang, delay, fail, send non-JSON, send huge bodies, or answer for another TIN or licence. Shapes follow EDR's `e2e/freight/etrade-mock/server.js`; all data is fictitious. |
| `tls-fixtures.ts` | Makes a throwaway root, intermediate and leaf chain with `openssl` at test time, so nothing shaped like a key is committed. |
| `fakes.ts` | `FakeEtradeHost` and `BudgetedFakeEtradeHost`: in-memory hosts that follow the saveSnapshot rules |
| `etrade.pg-spec.ts` | The standalone example on Postgres with two app instances (13 tests) |
| `jest.setup.ts` | Silences Nest's logger in tests |

## Examples

| File | What it is |
| --- | --- |
| `examples/standalone/app.module.ts` | `ExampleAppModule.forRoot`: TypeORM, `EtradeModule` with the host, the guarded lookup route, the companies controller, the recheck job |
| `examples/standalone/typeorm-etrade.host.ts` | The host in plain SQL: row locks, the TIN and STALE checks, the TIN budget in Postgres under an advisory lock, the lookup log with HMAC TIN hashes, an in-memory cache |
| `examples/standalone/create-companies.migration.ts` | `companies`, `company_profiles` (with the jsonb snapshot), `etrade_lookups`, `etrade_tin_budget`; schema-aware and idempotent |
| `examples/standalone/companies.service.ts` | Create companies and profiles; `EtradeRechecker`, the scheduled recheck |
| `examples/standalone/companies.controller.ts` | `PATCH /profiles/:id/etrade-licence` (attach), `POST /profiles/:id/etrade-recheck`, `GET /profiles/:id`, `POST /companies` |
| `examples/standalone/example-auth.guard.ts` | An example-only guard (an `x-user-id` header). Use your own. |
| `examples/standalone/main.ts` | Runs the example from env |
| `examples/edr/edr-etrade-host.ts` | **Not compiled.** EDR's host over `freight.company_profiles` and `freight.companies`, the module wiring, and the rewritten `CompaniesService` call sites |

## Docs

| File | What it is |
| --- | --- |
| `README.md` | Install and the six steps |
| `docs/INTEGRATION-GUIDE.md` | The interface's status, the calls, TLS, licence state, the host rules, budget, cache, route, options, what is verified, the going-live checklist, and moving EDR across |
| `docs/FILE-INDEX.md` | This file |
