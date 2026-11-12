# @edr/etrade-integration

Ethiopian Ministry of Trade e-trade lookups for NestJS, taken out of the EDR platform so another
system can use them as a package. It looks up a business registration by TIN, lists the trade
licences under it, and stores a verified snapshot of the licence a company or profile trades
under.

| Part | What it does |
| --- | --- |
| `EtradeClient` | The two e-trade calls EDR makes: the registration by TIN and the licence by number. Same paths, query parameters and Referer as EDR. **TLS is verified**: EDR switched verification off, and this package supplies the CA certificate that e-trade's server leaves out. Every call has a deadline, retries a failure once, and stops calling after repeated failures. |
| `EtradeService` | `lookup`: a customer's TIN lookup while onboarding. It is charged against a TIN budget, cached, and still answers with the licence list when the licence call fails. `attach`: stores a licence snapshot built from e-trade's own fresh answers under the holder's own TIN. It refuses expired, cancelled or unknown-status licences, or flags them. `recheck`: refreshes stored snapshots on a schedule. |
| Your host | Stores snapshots under a row lock. Optionally it also keeps a shared TIN budget, a lookup log and a cache. |
| Lookup route | **Off by default.** `POST /etrade/lookup` is mounted only together with your auth guard: a TIN lookup returns a business's licences and its manager's name and phone, for any TIN typed. |

**Read [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md) section 1 before using this in
production.** The address EDR calls is the back end of the Ministry's public licence-checker
page, not a published API. As far as is known there is no agreement behind it.
[docs/FILE-INDEX.md](docs/FILE-INDEX.md) lists every file and where it came from in EDR.

## Requirements

- Node 18.17+, NestJS 10 or 11.
- Access to e-trade: today, the public address `ETRADE_PUBLIC_API_URL` as EDR uses it. Once
  the Ministry issues one, use its formal address and credential instead.
- No database of its own. Your host stores the snapshots. The example uses TypeORM + Postgres.
- No runtime dependencies besides Nest: `node:http`, `node:https`, `node:tls` only.

## Install

The package is private. Build it and install it from a path or a tarball:

```bash
pnpm install
pnpm run build          # writes dist/
pnpm pack               # edr-etrade-integration-1.0.0.tgz

# in your app
pnpm add /path/to/edr-etrade-integration-1.0.0.tgz
```

Or copy `src/` into your repo as a module; nothing in it depends on EDR.

## In 6 steps

### 1. Give the licence a place to live

Add a nullable `jsonb` column to whatever trades under a licence: the company, or each of its
operational profiles (EDR: `company_profiles.etrade_business`). Do not make it unique: one
licence may back several profiles. Keep the company's TIN unique, and mark the companies that
register by hand (co-operatives, investment-licence companies) so that nothing is sent for them.

### 2. Implement the host

Two methods are needed for attach and recheck. Four optional ones add a shared budget, a log and
a cache. See [examples/standalone/typeorm-etrade.host.ts](examples/standalone/typeorm-etrade.host.ts).

```ts
@Injectable()
export class MyEtradeHost implements EtradeHost {
  findHolder(holderId: string): Promise<EtradeHolder | null> { ... }          // { id, tin, manualRegistration?, snapshot? }
  saveSnapshot(holder: EtradeHolder, snapshot: EtradeLicenceSnapshot): Promise<EtradeSaveResult> { ... }
  chargeLookup?(actor: string, tin: string): Promise<boolean>;                // shared TIN budget
  recordLookup?(record: EtradeLookupRecord): Promise<void>;                   // one row per call, no body
  readCache?(key: string): Promise<unknown | undefined>;
  writeCache?(key: string, value: unknown, ttlMs: number): Promise<void>;
}
```

`saveSnapshot` must lock the holder's row and its company's row, then re-read them. It returns
`TIN_CHANGED` if the TIN is no longer `snapshot.tin`, and `STALE` if a later snapshot is
already stored. Otherwise it saves. The guide explains why.

### 3. Mount the module

```ts
EtradeModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    baseUrl: config.get("ETRADE_BASE_URL") || ETRADE_PUBLIC_API_URL,
    ca: config.get("ETRADE_CA_PEM"),        // only if e-trade's certificate changes issuer
  }),
  host: MyEtradeHost,
  lookupRoute: "etrade/lookup",             // optional; needs lookupGuard
  lookupGuard: MyAuthGuard,
});
```

Without `host` you still get `EtradeClient` and `EtradeService.lookup`. Without `lookupRoute`
you call `lookup` from your own controller.

### 4. Look up a TIN while onboarding

```ts
const result = await etrade.lookup({ tin, licenceNumber, actor: user.id, nameSource });
if (!result.found) { /* e-trade does not know this TIN: offer the manual route */ }
else if (result.licenceDetail === "RESOLVED") { /* prefill the form from result.data */ }
else { /* NO_LICENCES, NOT_SELECTED (choose again), NOT_FOUND, UNAVAILABLE: result.businesses is still there */ }
```

`actor` is charged against the TIN budget: 10 different TINs per actor per 24 hours by
default, with repeats free. Checking whether the TIN is already registered is your database's
job (EDR's `tinTaken`).

### 5. Attach the licence the customer picked

```ts
const attached = await etrade.attach({ holderId: profile.id, licenceNumber, actor: user.id });
// ATTACHED | FLAGGED (stored, needsReview) | REFUSED with a reason; nothing else is stored
```

Only the licence number comes from the client. The package looks the licence up afresh under
the holder's own TIN, so another business's licence is simply not in the list.

### 6. Recheck stored licences

Call `etrade.recheck(holderId)` from a job, for example every 30 days and as the expiry nears.
The example runs it every 6 hours for licences last checked over 30 days ago. Renewals,
renamed licences, cancellations and licences that vanished all land in the snapshot, flagged.

## What decides the outcome

| `attach` sees | Outcome |
| --- | --- |
| The licence is listed under the holder's TIN, its status reads active, and it has not expired | `ATTACHED` |
| Expired, cancelled, suspended, an unknown status, or no detail at e-trade | `REFUSED` (default) or `FLAGGED` with `licenceProblems: "flag"` |
| Not listed under the holder's TIN | `REFUSED`, `LICENCE_NOT_LISTED` |
| A manual registration, a placeholder TIN, or an unknown holder | `REFUSED`, and nothing is sent to e-trade |
| e-trade is down or slow | throws `EtradeError` (`TIMEOUT`, `NETWORK`, `HTTP`); nothing is stored |
| The TIN changed meanwhile, or a later snapshot is already stored | `REFUSED`, `TIN_CHANGED` or `STALE` |

| e-trade answers | The package reads it as |
| --- | --- |
| 404, an empty body, `null`, or an object with neither `Tin` nor `BusinessName` | not found |
| 417 | `API` `REFERER_REJECTED`: e-trade wants the checker page's Referer |
| 429 | `HTTP` `RATE_LIMITED`, not retried, `retryAfterSeconds` passed on |
| 5xx, timeout, broken connection | retried once, then `HTTP`, `TIMEOUT` or `NETWORK` |
| An answer for another TIN or licence | `API` `TIN_MISMATCH` or `LICENCE_MISMATCH` |

## Tests

```bash
pnpm install
pnpm run type-check
pnpm test                       # unit + HTTP tests against a mock e-trade, no database needed

# Against a real, throwaway Postgres (a schema is created and dropped):
docker run -d --name etrade-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55481:5432 postgres:16
ETRADE_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55481/postgres pnpm test:pg
docker rm -f etrade-pg
```

The mock e-trade ([test/mock-etrade.ts](test/mock-etrade.ts)) answers both calls in the shapes
EDR reads. It refuses requests without the checker Referer (417), and it can hang, fail, delay or
answer for the wrong TIN. The TLS tests build a throwaway certificate chain with `openssl`
and serve it without its intermediate, the way etrade.gov.et does. Without `openssl` they skip.
The Postgres run covers:

- the migration;
- the guarded lookup, its log (keyed TIN hashes, no plain TINs) and its cache;
- a TIN budget shared by two app instances, including six lookups racing it (this fails if the
  advisory lock is removed);
- attach and every refusal;
- e-trade down and e-trade slow;
- two attaches racing, five attaches on one row lock, and a TIN changed mid-attach;
- recheck, from the endpoint and from the scheduled job.

Nothing here called e-trade's API itself. The one live check was a TLS handshake with
etrade.gov.et on 2026-11-12, which proved the bundled CA completes its chain. See the guide for
what is verified and what is not.

## Examples

- [examples/standalone/](examples/standalone/): a complete onboarding back end. It has
  companies with profiles, the guarded lookup, attach and recheck endpoints, a lookup log and a
  TIN budget in Postgres, and a scheduled recheck. It is compiled and used by the Postgres tests.
- [examples/edr/edr-etrade-host.ts](examples/edr/edr-etrade-host.ts): how EDR's freight API
  would plug in, over `company_profiles.etrade_business`, with its call sites rewritten. **Not
  compiled here**: it imports EDR code.
