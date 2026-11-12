# File index

This index shows where each part lives, and where it came from in the EDR platform (origin/dev
`4e43da58b`).

EDR paths below are short for:

- **freight API:** `apps/edr-freight-api/src/`
- **passenger API:** `apps/edr-passenger-api/src/`
- **back office:** `apps/edr-freight-web/backoffice/src/`

## Package — `src/`

| File | What it is | From EDR |
| --- | --- | --- |
| `fayda.module.ts` | `FaydaModule.forRoot / forRootAsync`; `host`, `route` | freight API `modules/verifayda/verifayda.module.ts` (TypeORM entity + controllers) |
| `fayda.options.ts` | Options, defaults, `resolveFaydaOptions`, `missingFaydaOptions` (names, never values) | freight API `config/fayda.config.ts` (env, `decodePrivateJwk`, required vars) and passenger API `config/fayda.config.ts` (proof settings). `issuer`, `jwksUri` and the verification switches are new. |
| `fayda.client.ts` | `FaydaClient`: authorize URL, client assertion, token call, ID token and userinfo verification, JWKS fetch | `verifayda.service.ts` (`buildAuthorizationUrl`, `exchangeCodeForTokens`, `fetchUserInfo`) and `utils/client-assertion.util.ts`. Same parameters and order; nonce, jti, verification, timeouts and the retry rule are new. |
| `fayda.service.ts` | `FaydaService`: `start`, `complete`, binding cookie, return URLs, proofs | `verifayda.service.ts` (`startVerification`, `completeVerification`, `markSessionFailed`, `classifyFailureReason`). The atomic claim, binding and expiry handling as an outcome are new; account handling moved to the host. |
| `fayda.host.ts` | **The port you implement**: `FaydaHost`, `FaydaSessionRecord`, `FaydaSessionEnd`, `FaydaVerifiedContext`, `FaydaHostRefusal`, `FaydaEvent` | New. EDR wrote `freight.fayda_verification_sessions` and `iam.users` from the service (`upsertIamUser`, `createFaydaSession`). |
| `fayda.controller.ts` | `createFaydaController(route)`: `GET callback`, `POST complete`; `readCookie`, `faydaResultBody` | freight API `verifayda.controller.ts` (`GET complete`) and `fayda-callback.controller.ts` (acknowledge only). This one completes. |
| `fayda.jose.ts` | JWS sign and verify on `node:crypto`, JWK import, `importPrivateKey`, `safeEqual`, `halfHash` | New. EDR used the `jose` package for signing only and verified nothing. |
| `fayda.jwks.ts` | `JwksCache`: cache, refetch on unknown kid, rate limit, stale fallback | New. |
| `fayda.tokens.ts` | `checkIdTokenClaims`, `checkUserinfoClaims` | New. |
| `fayda.claims.ts` | `readIdentityFields`, `formatAddress`, `toE164`, `toIsoDate`, `emailKey` | freight API `verifayda.service.ts` (`normalizeUserInfo`, `formatFaydaAddress`, `ADDRESS_FIELD_ORDER`) and the fallback rules of `common/phone.util.ts`; passenger API's birthdate note. |
| `fayda.pkce.ts` | Verifier, S256 challenge, random state, nonce and binding, input patterns | `utils/pkce.util.ts` (same sizes: 64-byte verifier, 32-byte state) |
| `fayda.proof.ts` | `issueFaydaProof`, `verifyFaydaProof` with rotation | passenger API `modules/traveler-identity/fayda-proof.util.ts` (same format), plus a list of secrets |
| `fayda.types.ts` | Token answer, `FaydaIdentity`, results, `FAYDA_FAILURES` (codes, statuses, messages) | `verifayda.types.ts`, `verifayda.errors.ts`, `verifayda.dto.ts` (`CompleteVerificationResultDto`); the codes are EDR's |
| `fayda.http.ts` | `httpCall`: one deadline, 1 MB cap, `sent` flag | New. EDR used global `fetch` without timeouts. |
| `fayda.tls.ts` | `createFaydaAgent`, `faydaCaList` (adds to Node's roots), `isFaydaProductionHost` | New. |
| `fayda.errors.ts` | `FaydaError` and its kinds | New. |
| `index.ts` | Public exports | |
| `*.spec.ts` | Unit and HTTP tests (9 files) | freight API `utils/pkce.util.spec.ts`, `utils/client-assertion.util.spec.ts`; passenger API `verifayda.service.spec.ts` for the cases; most cases are new |

## Tests — `test/`

| File | What it is |
| --- | --- |
| `mock-esignet.ts` | A local eSignet with its own crypto: authorize (code issuing), token (client assertion and PKCE checks), signed ID token and userinfo, JWKS, key rotation, and one-at-a-time faults. Replaces EDR's `e2e/freight/fayda-mock/server.js`, which checked nothing and answered JSON userinfo. |
| `fakes.ts` | `FakeFaydaHost`, in memory |
| `fixtures.ts` | Shared options, the mock with our client registered, a throwaway client key |
| `fayda.pg-spec.ts` | The standalone example against Postgres and the mock, two app instances |
| `jest.setup.ts` | Silences Nest's logger |

## Examples

| File | What it is |
| --- | --- |
| `examples/standalone/create-fayda.migration.ts` | accounts, `fayda_sessions`, `fayda_identities`, `fayda_results`, `fayda_audit`, `public_requests`. Schema-aware. Idempotent. |
| `examples/standalone/typeorm-fayda.host.ts` | `TypeOrmFaydaHost`: atomic claim, upsert by sub, linking rules, results for the starting browser, audit, clean-up |
| `examples/standalone/fayda-example.controller.ts` | `POST /fayda/start`, `GET /fayda/results/:id`, `POST /requests` (a proof used once) |
| `examples/standalone/app.module.ts`, `main.ts` | Wiring, env |
| `examples/edr/edr-fayda-host.ts` | EDR's freight API on the package. **Not compiled.** |

## Docs

| File | What it is |
| --- | --- |
| `README.md` | Overview, install, five steps, outcomes, tests |
| `docs/INTEGRATION-GUIDE.md` | Flow, calls, checks, host rules, options, errors, what is verified, checklist, EDR findings and steps |
| `docs/FILE-INDEX.md` | This file |
