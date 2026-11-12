# e-trade (Ministry of Trade): integration guide

This guide is for the team that wires `@edr/etrade-integration` into a system. It covers what the
package does, what your side must do, what has and has not been verified, and how EDR would move
onto it. The facts about EDR come from origin/dev `4e43da58b`.

## 1. Read this first

**The interface is not a published API.** The two calls EDR makes are the back end of the
Ministry of Trade and Regional Integration's public business-licence checker page:

- `https://etrade.gov.et/api/Registration/GetRegistrationInfoByTin/{tin}/en`
- `https://etrade.gov.et/api/BusinessMain/GetBusinessByLicenseNo?LicenseNo=&Tin=&Lang=en`

As far as is known there is no agreement, no credential and no service level behind them.
They also expect a Referer naming the checker page: EDR's back office logs "Referer rejected by
eTrade" when e-trade answers 417. The package keeps that request exactly as EDR sends it, so it
is a drop-in. Before production you should:

- get written permission or formal API access from the Ministry;
- switch to its address (`baseUrl`) and its credential (`headers`);
- set `referer: false`.

Until then the Ministry can change, throttle or block the calls at any time. This is also why
`ETRADE_PUBLIC_API_URL` is exported but is not a default: choosing it is a decision in your code.

**TLS is verified, and the fix for e-trade's broken chain is bundled.** EDR switched certificate
verification off for every e-trade call (`rejectUnauthorized: false`). Its comment says the
server "omits the intermediate CA cert". A check on 2026-11-12 showed the exact cause. The
server sends its own certificate, which "GlobalSign GCC R3 EV TLS CA 2025" issued, together
with a different intermediate, "GlobalSign Extended Validation CA - SHA256 - G3". Node therefore
cannot build a chain. The package bundles the right CA certificate (public, signed by GlobalSign
Root R3, valid until 2027-07-16). With it, the handshake verifies against the live host. See
section 4.

**If you run EDR**, section 13 lists what is wrong in EDR's e-trade code today. In short:

- TLS verification is off;
- calls have no timeout;
- error text leaks to customers;
- an outage looks like "TIN not found";
- a vanished licence is silently swapped for another business's;
- expired licences are accepted.

## 2. The flow

```
customer types TIN ──► lookup (budget, cache) ──► registration (S1) ──► licence list
                                     └──► licence detail (S2) for the chosen one ──► prefill
customer picks a licence for a profile ──► attach ──► S1 + S2 afresh, under the holder's own TIN
                                                  └──► snapshot ──► host.saveSnapshot (row lock)
a job, later ──► recheck ──► S1 + S2 afresh ──► new snapshot (renewed, renamed, cancelled, gone)
```

- **lookup** serves onboarding. It answers for whatever TIN was typed, so it is budgeted per
  actor and should sit behind your login. It may use the cache.
- **attach** is the trust boundary. The client sends only a licence number. The package asks
  e-trade afresh for the holder's own TIN and builds the snapshot from e-trade's answers. A
  licence held under another TIN is simply not in that list. The cache is never used.
- **recheck** keeps stored snapshots honest. A failure leaves the stored snapshot untouched
  (stale); it does not erase it.

## 3. The calls and how answers are read

| | Registration (S1) | Licence (S2) |
| --- | --- | --- |
| Request | `GET {baseUrl}/Registration/GetRegistrationInfoByTin/{tin}/{lang}` | `GET {baseUrl}/BusinessMain/GetBusinessByLicenseNo?LicenseNo=&Tin=&Lang=` |
| Headers | `Accept: application/json`, `Referer` (default EDR's), your `headers` | same |
| Used for | the registered name, and every licence under the TIN | one licence's status, dates, address and manager |

The TIN must be exactly 10 digits, and it is checked before anything is sent; EDR sent whatever
string it was given. The TIN is URL-encoded in the path, and the licence number goes through
`URLSearchParams` (`/` becomes `%2F`, as axios did for EDR). The language is `en` unless you
set `language: "am"`.

| Answer | Read as |
| --- | --- |
| 404, an empty body, `null` | not found |
| S1: an object with neither `Tin` nor `BusinessName` | not found (as EDR's back office reads it) |
| S2: an object with no `LicenceNumber`, `OwnerTIN` or `TradeName` | not found |
| S1 `Tin`, or S2 `OwnerTIN`, not the TIN asked | `API` `TIN_MISMATCH`: never used |
| S2 `LicenceNumber` not the one asked | `API` `LICENCE_MISMATCH` |
| 417 | `API` `REFERER_REJECTED` |
| 429 | `HTTP` `RATE_LIMITED`, not retried, `retryAfterSeconds` from `Retry-After` |
| other 4xx | `HTTP`, not retried |
| 5xx, timeout, broken connection | retried `maxRetries` times (default 1), then `HTTP`, `TIMEOUT` or `NETWORK` |
| not JSON (a maintenance page), over 1 MB | `HTTP` `NOT_JSON` / `TOO_LARGE`; the body is never put in the message |
| a TLS failure | `NETWORK` with Node's code; not retried |

After `circuitFailures` consecutive failed calls (default 5), calls fail at once with `NETWORK`
`CIRCUIT_OPEN` for `circuitOpenMs` (default 60 s). Without that, every customer would wait a
full timeout. A 404 or any other answer counts as success here.

**Normalisation:**

- Strings are trimmed and nulls become "".
- A licence without a number is dropped.
- Activities are the `SubGroups` descriptions with the "(65611)" prefix removed, empty ones
  dropped, joined with ", ". This is EDR's rule, and it survives null lists, null entries and
  null descriptions.
- The region is mapped onto EDR's list of 14 regions and city administrations (aliases and zone
  names included). One that cannot be resolved stays "", and `rawRegion` keeps e-trade's text.
- The manager is the first associate.
- The photo and the capital figures are dropped and never leave the client.

## 4. TLS

Node's `ca` option **replaces** its list of trusted roots rather than adding to it. The package
therefore builds the list as follows: Node's own roots (`tls.rootCertificates`), plus the
bundled `ETRADE_ISSUING_CA_PEM`, plus whatever you pass in `ca`.

`NODE_EXTRA_CA_CERTS` is not part of `tls.rootCertificates`. If your deployment relies on it,
for example behind a corporate proxy, pass those certificates in `ca` too.

When e-trade renews its certificate (the current one expires 2026-12-09), the issuer may
change, and the error may come back as `NETWORK` with "TLS verification of etrade.gov.et
failed". To fix it:

```bash
openssl s_client -connect etrade.gov.et:443 -servername etrade.gov.et -showcerts </dev/null \
  | awk '/BEGIN CERT/{n++} n==1{print} /END CERT/&&n==1{exit}' > leaf.pem
openssl x509 -in leaf.pem -noout -issuer -ext authorityInfoAccess     # names the issuer and its CA Issuers URL
curl -sS -o issuer.crt "<the CA Issuers URL>"
openssl x509 -inform DER -in issuer.crt -out issuer.pem                # if it came as DER
```

Check that the issuer certificate chains to a root Node already trusts. Then pass it in `ca`
(or `ETRADE_CA_PEM` in the example), and ask the Ministry to fix their chain.

`insecureTls` exists only for a local test server. The client refuses it for etrade.gov.et and
every sub-domain, so it cannot slip into production.

## 5. Licence state

| State | When |
| --- | --- |
| `CANCELLED` | e-trade gives a `CancellationDate`, whatever the status says; or the status reads cancelled, revoked or terminated |
| `SUSPENDED` | the status reads suspended |
| `EXPIRED` | the status reads active (or expired) and `validUntil` is before today in Ethiopian time (UTC+3, `dateUtcOffsetMinutes`) |
| `ACTIVE` | the status reads active and the licence is not past `validUntil`. The last day counts. `expiresInDays` says how long is left. |
| `UNKNOWN` | any other status. e-trade never published its codes, so an unknown status is not treated as valid. |
| `NOT_LISTED` | recheck only: e-trade no longer lists the licence under the TIN |

- `validUntil` comes from `RenewedToDateString` (M/D/YYYY), else from `RenewedTo` (ISO). Text
  that cannot be read leaves it null, which flags `VALID_UNTIL_UNREADABLE`.
- `statusMap` maps a lower-case `StatusDescription` (`"renewed": "ACTIVE"`) or a code
  (`"#3": "SUSPENDED"`) once the Ministry confirms them.
- On attach, any state other than ACTIVE, and an unreadable expiry, is a problem. A problem is
  refused by default; with `licenceProblems: "flag"` it is stored with `needsReview: true` and
  its `problems`.
- On recheck, problems are always stored, flagged, because that is e-trade's own record of a
  licence you already hold.

## 6. Your side: the host

**findHolder(holderId)** returns `{ id, tin, manualRegistration?, snapshot? }`, or null.

- The TIN is the company's, as stored. A placeholder (EDR mints `D`, `F` or `I` plus 9 digits) is
  not 10 digits, so attach refuses `HOLDER_TIN_INVALID` without a call.
- Set `manualRegistration` for companies that register by hand. EDR's `usesManualRegistration`
  covers co-operatives, investment-licence holders, individuals, companies with no TIN and those
  marked no-e-trade. For them attach refuses `MANUAL_REGISTRATION` without a call.

**saveSnapshot(holder, snapshot)** runs in one transaction:

1. Lock the holder's row and the company row that holds the TIN (`SELECT ... FOR UPDATE OF p, c`)
   and re-read them.
2. Gone: return `NOT_FOUND`.
3. The company's TIN is no longer `snapshot.tin`: return `TIN_CHANGED`. A snapshot then never
   sits on a company whose TIN it was not looked up under, even if the TIN was edited while
   e-trade was answering.
4. The stored snapshot's `checkedAt` is later: return `STALE` (`isNewer` does this comparison).
   Two attaches racing for one profile then leave the later answer, never the slower, earlier one.
5. Store it and return `SAVED`. Store `checkedAt` in its own column too if you want to query
   which snapshots are due a recheck.

The Postgres tests run both races against the example host. The standalone example's
`typeorm-etrade.host.ts` does all of this in plain SQL.

**chargeLookup(actor, tin)** gives a shared TIN budget (section 7). **recordLookup(record)**
is called once per call or cache hit. A record holds the call, outcome, code, duration, HTTP
status, actor and TIN, and never a body. Hash the TIN before storing it if the log is widely
shared. A plain SHA-256 of 10 digits can be reversed by trying all of them, so use a keyed hash
(HMAC), as the example does. A failure in `recordLookup` is logged and never fails the lookup.

## 7. The TIN lookup budget

A lookup returns a business's registration, licences, manager name and phone for any TIN typed,
so someone could harvest them by trying TINs. The budget counts **different** TINs per actor in
a window, with repeats free: a customer needs one TIN and a typo or two. The charge is taken
before the call, so a TIN e-trade does not know still counts. A refusal is `EtradeError`
`BUDGET`, which the lookup route answers with 429, and nothing is sent.

- With `host.chargeLookup`, your store decides, shared by every instance. The example keeps it
  in Postgres under a per-actor advisory lock. Its race test lets six lookups race for three
  slots, and it fails if the lock is removed.
- Without it, `lookupBudget` applies in process memory (default 10 per 24 h, as EDR). That
  budget resets on restart and is not shared between instances.
- `lookupBudget: false` and no `chargeLookup` means no limit. The service warns at start-up.

`attach`, `licencesFor` and `recheck` are not charged: the TIN is the holder's own, not typed
by the caller.

## 8. Cache

`lookup` reads and writes the host's cache for `cacheTtlMs` (default 10 minutes). The cache
serves the second lookup of one onboarding session, when the customer picks a licence after
typing the TIN.

- Only found answers are cached. A not-found, an empty answer or an error is never cached, so
  an outage does not stick.
- `lookup({ fresh: true })` skips the cache.
- `attach` and `recheck` never read it.
- The cache holds third parties' business data. Keep it in memory, as the example does, or
  encrypt it at rest.

## 9. The lookup route

`lookupRoute` mounts `POST /{lookupRoute}` with `{ tin, licenceNumber?, nameSource? }`. The
module refuses to build without `lookupGuard`.

The actor is read from the request by `actorFrom`. The default is `request.user.id`, else
`request.user.sub`. If there is no actor, the route answers 401.

| Answers | Status |
| --- | --- |
| the lookup result (no photo, no capital) | 200 |
| a bad TIN or licence number | 400, the package's own message |
| budget spent | 429: "Too many different TINs were checked from this account. Try again tomorrow, or enter your details by hand." |
| e-trade failed in any way | 503: "The business registry did not answer. Try again, or enter your details by hand." |

No internal detail reaches the caller: no address, TLS code, HTTP status or body.
`etradeHttpError(err)` gives your own controllers the same mapping.

## 10. Options and environment

| Option | Default | Env in the example | Notes |
| --- | --- | --- | --- |
| `baseUrl` | (required) | `ETRADE_BASE_URL` | `ETRADE_PUBLIC_API_URL` = EDR's |
| `referer` | EDR's checker URL | | `false` once you have formal access |
| `headers` | none | `ETRADE_API_KEY` | a credential, never logged |
| `language` | `en` | | `am` is untested |
| `httpTimeoutMs` | 8000 | | the whole call, connection included |
| `maxRetries` / `retryDelayMs` | 1 / 300 | | 5xx, timeout, broken connection only |
| `circuitFailures` / `circuitOpenMs` | 5 / 60000 | | 0 turns the circuit off |
| `ca` | none | `ETRADE_CA_PEM` | added to Node's roots and the bundled CA |
| `trustBundledIssuingCa` | true | | the GlobalSign CA, section 4 |
| `insecureTls` | false | | refused for etrade.gov.et |
| `cacheTtlMs` | 600000 | | 0 turns it off |
| `lookupBudget` | 10 per 24 h | | used without `host.chargeLookup` |
| `licenceProblems` | `refuse` | | `flag` stores with `needsReview` |
| `onMissingChosenLicence` | `refuse` | | `first` is EDR's silent swap |
| `statusMap` | none | | once the Ministry confirms codes |
| `regionAliases` | none | | extra spellings onto the 14 regions |
| `dateUtcOffsetMinutes` | 180 | | "today" for the expiry check |

The example also reads:

- `ETRADE_TIN_HASH_KEY`: the HMAC key for the log and the budget;
- `ETRADE_RECHECK_EVERY_MS`: how often the recheck job runs (default 6 h);
- `DATABASE_URL`, `DATABASE_SCHEMA` and `PORT`.

## 11. What was verified, and what was not

**Verified:**

- The TLS chain fix. A handshake with etrade.gov.et on 2026-11-12 failed with Node's roots
  alone (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). It passed with the bundled CA added. No API request
  was sent.
- The request shapes are EDR's: the same paths, parameters, language and Referer.
- Every rule in sections 3 and 5 to 9, by 137 unit and HTTP tests against the mock.
- The host rules, on Postgres 16 by 13 tests:
  - the row locks, the TIN-change check and the STALE rule;
  - the shared budget with its advisory lock (the race test fails without it);
  - the log with keyed hashes, the cache, and recheck.

**Not verified.** Nothing here called e-trade's API, and the shapes come from EDR's code, its
types and its e2e mock:

- What e-trade answers for an unknown TIN: EDR's mock sends 404. The package also reads an
  empty 200, `null` and `{}` as not found.
- What S2 answers when the licence exists but under another TIN (assumed 404).
- The meaning of `Status` and every `StatusDescription` other than "Active". EDR's mock uses
  status 1 "Active"; the rest is unknown, hence `UNKNOWN` and `statusMap`.
- That dates are Gregorian, with `RenewedToDateString` as M/D/YYYY and `RenewedTo` as ISO.
  This follows EDR's comment and its samples, which end in July, the Ethiopian fiscal year
  end. If e-trade ever sends Ethiopian-calendar years, every licence would read as expired;
  the attach refusal shows `validUntil`, so it would be noticed at once.
- The time zone of those dates (assumed Ethiopian, UTC+3).
- That a 417 means a missing Referer. That comes from EDR's back-office log message, not from
  a call made here.
- Whether e-trade cares about `User-Agent`. EDR sent axios's; this package sends none.
- That the first associate is the manager or legal representative.
- Rate limits, and whether cancelled licences still appear in S1.
- Amharic answers (`language: "am"`).

## 12. Going-live checklist

1. Written permission or formal API access from the Ministry. Then set `baseUrl`, `headers`
   and `referer: false`.
2. Read the issuer of e-trade's current certificate. If it is not GlobalSign GCC R3 EV TLS CA
   2025, add the new issuer with `ca` (section 4).
3. Ask the Ministry for the status codes and fill `statusMap`. Until then, decide `refuse` or
   `flag` for licences in an unknown state.
4. A shared TIN budget (`chargeLookup`) if you run more than one instance.
5. The lookup log with a keyed TIN hash, and its retention period.
6. Your auth guard on the lookup route, and an ownership check before attach. The profile must
   belong to the caller's company.
7. A recheck job, and an alert on snapshots with `needsReview`.
8. The manual route: a customer must always be able to register by hand when e-trade cannot
   answer.
9. Your product owner confirms the region list (`ETHIOPIAN_REGIONS`; SNNPR was split).

## 13. Moving EDR onto this package

### What is wrong in EDR today (origin/dev 4e43da58b)

1. **TLS verification is off for every e-trade call.**
   - Where: `companies/services/etrade.service.ts` creates `new Agent({ rejectUnauthorized: false })`.
   - Risk: anyone on the path between EDR and etrade.gov.et can answer instead of e-trade. They
     could feed EDR an invented registration, licence or manager, which EDR then stores as
     e-trade's own data.
   - Cause: the server sends the wrong intermediate, not a missing one (section 1).
   - Fix: the bundled CA (section 4) lets TLS be verified.
2. **No timeout.** `CompaniesModule` imports `HttpModule` with no options, and axios's default
   timeout is 0, meaning never. A hung e-trade holds the customer's request, and the API
   connection, indefinitely.
3. **Internal error text reaches customers.** `getCompanyInfoByTin` and `getBusinessByLicenseNo`
   throw `BadRequestException("Failed to fetch ... from eTrade: " + error.message)`. That can
   carry TLS codes, IP addresses and ports.
4. **"TIN unknown", "e-trade down" and a TLS failure all become the same 400.** The portal shows
   its not-found branch for an outage. Separately, `resolveCompanyData` swallows any error from
   the licence call and returns `businessInfo: null`, which `resolveEtradeRegistration` turns
   into "We couldn't find a business license for this TIN". An outage of the second call reads
   as "no licence".
5. **A vanished licence is silently swapped for another business's.**
   - Where: `resolveCompanyData` falls back to the TIN's first licence when the chosen one is
     not listed. `applyEtradeSourcedFields` re-verifies with it and writes that first licence's
     number, trade name, dates and address over the company's.
   - The package returns `NOT_SELECTED` instead (`onMissingChosenLicence: "first"` keeps EDR's
     behaviour).
6. **Expired and cancelled licences are accepted.**
   - Neither onboarding nor `attachEtradeBusinessToProfile` looks at the status, the
     cancellation date or the expiry.
   - The stored `etrade_business` snapshot keeps no status, check time or source.
   - It is refreshed only when a customer re-verifies their own TIN (`refreshProfileBusinesses`);
     nothing rechecks on a schedule.
7. **The TIN budget lives in process memory** (`TinLookupBudget`, EDR's own comment). Every
   deploy or restart resets it, and each replica keeps its own.
8. **The TIN is not checked inside the service.** The portal route validates it (`IsTin`), but
   `ETradeService` puts any string into the URL path unencoded. A path that passes the stored
   `company.tin` relies on `usesManualRegistration` to keep placeholder TINs (D, F, I) out.
9. **The address is hard-coded** (`https://etrade.gov.et/api`), with no config. The e2e stack
   reaches its mock by aliasing the container as etrade.gov.et.
10. **The back office calls e-trade from the browser.**
    - `complaints/services/etradeTinService.ts` and the external-portal sign-up call
      `/api/etrade/...` (`VITE_ETRADE_API_BASE`). No proxy for that path exists in the repo, so
      one must exist outside it and add the checker Referer.
    - `verifyComplaintTin` then marks the organisation `verified: true` in the browser. Anything
      the server does with that flag is a client's word. Not checked here: what the complaint API
      does with it.
11. **No record of e-trade calls.** EDR logs nothing about which TINs were looked up, by whom, or
    what e-trade answered.

### Steps

1. Install the package in apps/edr-freight-api. Replace the `ETradeService` provider, and the
   `HttpModule` it needed, with `EdrEtradeModule` from
   [examples/edr/edr-etrade-host.ts](../examples/edr/edr-etrade-host.ts).
2. `fetchETradeData` calls `etrade.lookup` (budget included). Keep the `tinTaken` check. Map
   `NOT_SELECTED` to "choose again" and `UNAVAILABLE` to a 503, not "no licence".
3. `attachEtradeBusinessToProfile` and `resolveProfileBusiness` call `etrade.attach`.
   `company_profiles.etrade_business` stays as it is; the snapshot keeps its first four keys, so
   billing's `etradeBusiness.tradeName` still reads.
4. `refreshProfileBusinesses` becomes `etrade.recheck(profile.id)` per profile. Add a scheduled
   recheck.
5. `applyEtradeSourcedFields` and `companyNameChoice` call `etrade.lookup({ fresh: true, ... })`
   with the stored licence, and refuse on `NOT_SELECTED`.
6. Start with `licenceProblems: "flag"` so nothing changes for customers on day one. Review the
   flagged snapshots, then switch to `refuse`.
7. Move the TIN budget to a shared store (`chargeLookup`), and log the calls (`recordLookup`).
8. Route the back office's browser-side lookups through the API, behind its login and the budget.
