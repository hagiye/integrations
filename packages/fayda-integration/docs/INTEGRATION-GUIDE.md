# Fayda (eSignet): integration guide

This guide is for a team putting `@edr/fayda-integration` into its own NestJS system, and for
EDR moving onto it. EDR here means the EDR platform at origin/dev `4e43da58b`.

## 1. Read this first

Fayda is reached through **eSignet**, an OpenID Connect provider run for the National ID
Program (NIDP). Your system is a relying party. The person proves themselves on eSignet's
pages, and eSignet tells your system who they are.

EDR has two copies of this integration: the freight API and the passenger API, both in
`modules/verifayda`. Both trust what comes back without checking it. **Do not copy them.** The
main problems, with details in section 14:

1. **The userinfo is not verified.** EDR splits the JWT and reads its payload; the signature
   check is a "production TODO". A plain JSON answer is accepted as well.
2. **The ID token is never read**, and no nonce is sent. The checks that tie the answer to this
   client, this session and this moment are all missing.
3. **Accounts are merged by phone or email, and handed a session.** After a VERIFY, EDR looks
   for an account with the same phone **or** email as the Fayda record. It writes the Fayda
   identity into that account, marks it `verified_by = 'fayda'`, and returns an IAM session token
   for it to whoever completed the flow. A recycled phone number, a shared family or business
   number, or an email typed at enrolment is enough to sign a stranger into someone's account.
   This is in both copies of `upsertIamUser` and `createFaydaSession`.
4. **The freight back office starts the flow in the browser with fixed values.** In
   `shared/utils/faydaOidc.ts`:
   - The PKCE `code_verifier` is a constant exported from the bundle. It is the example value
     from RFC 7636, appendix B.
   - The nonce is a constant, and the `state` values are fixed words (`complaint_flow`...).
   - It asks for `individual_id`, the national ID number, as an essential claim.

   PKCE and state then protect nothing.
5. **A session is not claimed atomically, nor bound to the browser.** Two completions can both
   pass the PENDING check. A `code` and `state` link opened by someone else completes the
   verification in their browser.

This package does the opposite on each point. What it cannot settle on its own, NIDP has to
answer; see section 12. Until NIDP confirms them, the defaults follow the OIDC standard and
the NIDP reference implementation.

## 2. The flow

```
browser            your app (FaydaService + host)              eSignet
   | POST start  ->  start(): state, nonce, PKCE verifier,
   |                 binding secret; host.createSession (PENDING)
   | <- authorize URL + Set-Cookie (binding)
   | --------------------------- GET authorize -------------->  sign in, consent
   | <-------------------------- redirect ?code&state --------
   | GET /fayda/callback (or the page POSTs /fayda/complete), with the cookie
   |                 complete(): host.claimSession(state) PENDING -> IN_PROGRESS
   |                 expiry and binding checked
   |                 ----- POST token (code, verifier, assertion) ------------>
   |                 <---- access_token, id_token ----------------------------
   |                 ----- GET JWKS (cached) --------------------------------->
   |                 ID token: signature, iss, aud, exp, iat, nonce, at_hash
   |                 ----- GET userinfo (Bearer) ----------------------------->
   |                 <---- signed JWT ----------------------------------------
   |                 userinfo: signature, same sub
   |                 host.onVerified(identity) -> links by sub
   |                 host.endSession(COMPLETED), nonce and verifier wiped
   | <- 303 to your return URL ?result=<session id>   (or JSON)
```

## 3. The calls

Everything below is sent as EDR sends it, except where marked **new**.

**Authorize** (browser redirect). The parameters go in this order:

1. `client_id`
2. `response_type=code`
3. `redirect_uri`, the channel's, exactly as registered
4. `scope`, default `openid profile email phone address`
5. `state`, 32 random bytes, base64url
6. **new:** `nonce`, 32 random bytes
7. `code_challenge`, S256 of a 64-byte verifier
8. `code_challenge_method=S256`
9. `acr_values`, default `mosip:idp:acr:generated-code`
10. `claims_locales=en am`
11. `prompt=login`, which EDR's passenger copy sends and its freight copy does not
12. `claims`

`claims` is `{"userinfo":{...each claim essential...},"id_token":{}}`. The default claim list is
EDR's: name, phone_number, email, birthdate, gender, address, nationality, picture.
`userinfoClaims` narrows it; ask only for what the use case needs. `nationality` and `picture`
are sensitive or unused in most cases.

**Token** (POST, form-encoded). The fields go in EDR's order:

1. `grant_type=authorization_code`
2. `code`
3. `redirect_uri`, the session's stored one, verbatim
4. `client_id`
5. `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
6. `client_assertion`
7. `code_verifier`

The client assertion is a JWT signed with your RSA key:

- **Header:** `{alg: RS256}`, as EDR's freight copy and NIDP's reference implementation send
  it. `kid` is added only with `keyId`, and `typ: JWT` only with `clientAssertion.typ`.
- **Payload:** `iss` and `sub` are the client id, `aud` is the token endpoint, plus `iat` and
  `exp`, which is 120 s later.
- **new:** a random `jti` in every assertion. Turn it off with `clientAssertion.jti: false` if
  NIDP ever refuses it.

The token call is retried once, and only when the first attempt never left the machine: a
code is single use.

**Userinfo** (GET, `Authorization: Bearer`). A signed JWT is expected. It is retried once on a
network failure or a 5xx.

**JWKS** (GET). **new**: EDR never fetched it. It is cached for 10 minutes. An unknown `kid`
triggers one refetch, at most every 30 s. A key set up to 60 minutes old is used while the
endpoint is down.

## 4. What is verified

**ID token** (OIDC Core 3.1.3.7):

| Check | Rule |
| --- | --- |
| Signature | Against the JWKS key with the token's `kid`. Algorithms in `idTokenAlgs` only (default `RS256`). `none` and every HMAC algorithm are refused outright, so the public key can never act as an HMAC secret. RSA keys under 2048 bits and keys marked `use: enc` are ignored. A `crit` header is refused. |
| `iss` | Equals `issuer` exactly. |
| `aud` | Contains `clientId`. With several audiences, `azp` must be `clientId`. |
| `exp`, `iat`, `nbf` | Within `clockSkewSeconds` (default 60). |
| `nonce` | Equals the session's, compared in constant time. Required unless `requireNonce: false`. |
| `sub` | Present. |
| `at_hash` | When present, matches the access token. |
| `acr` | Reported. Enforced against `acrValues` with `enforceAcr: true`. |

**Userinfo:** a 3-part JWT, verified like the ID token (`userinfoAlgs`). Its `sub` must equal
the ID token's. `iss` and `aud` are checked when present.

- A 5-part answer (JWE, encrypted) is refused as `JWE_NOT_SUPPORTED`. EDR never received one.
  If NIDP registers your client for encrypted userinfo, ask for signed-only.
- Plain JSON is refused unless `acceptJsonUserinfo: true`. With it, `identity.userinfoSigned` is
  false and the claims rest on TLS alone.

## 5. Sessions

| Status | Meaning |
| --- | --- |
| `PENDING` | Authorize URL issued. Waiting for the redirect. |
| `IN_PROGRESS` | Claimed by a completion. A second completion with the same state gets `FAYDA_INVALID_STATE` without eSignet being called. |
| `COMPLETED` | Verified. Nonce and verifier wiped. |
| `FAILED` | Failed or cancelled. `error_code` is the failure code. `error_description` is a fixed reason or an OAuth error code (`token:invalid_grant`, `userinfo:BAD_SIGNATURE`), never personal data. |
| `EXPIRED` | Completed after `sessionTtlMinutes` (default 10). eSignet not called. |

**Browser binding.** `start` makes a random secret and stores only its SHA-256 with the session.
It returns a `Set-Cookie` that is HttpOnly, `SameSite=Lax`, Secure, with Max-Age equal to the
session's life. The cookie is named `fayda_b_` plus 16 hex characters derived from the state, so
several verifications can run in one browser. `complete` needs the cookie, or the session fails
with `FAYDA_BINDING_MISMATCH`. This stops login CSRF: someone's own `code` and `state`, sent to a
victim, complete nothing.

Channels in `browserBinding.unboundChannels` (default `MOBILE`) skip the binding, because a
native app hands the redirect over without the cookie jar. When your SPA calls the API from
another site, set `sameSite: "None"` and send `credentials: "include"` on both calls.

## 6. Your side: the host

| Method | Rules |
| --- | --- |
| `createSession` | Store the row as given. `state` is unique. |
| `claimSession(state)` | **One atomic statement:** `UPDATE ... SET status = 'IN_PROGRESS' WHERE state = $1 AND status = 'PENDING' RETURNING *`. Return null when no row came back. Do not check expiry; the package does. A SELECT followed by an UPDATE fails the race test. |
| `endSession` | Set status, `error_code`, `error_description` and `completed_at`. Wipe `nonce` and `code_verifier`. |
| `onVerified(identity, { session, possibleMatches })` | Link by `identity.sub`, unique on your side, and upsert under a lock so two completions for one person make one row. Never link by phone or email. Return what the caller gets back. Throw `FaydaHostRefusal` to refuse. |
| `findContactMatches` | Optional. Ids of accounts with the same verified phone (E.164) or email. They reach `onVerified` as `possibleMatches`, for you to show "an account with this phone exists, sign in to it first". |
| `recordEvent` | Optional audit: START, COMPLETE_OK, COMPLETE_FAIL, INVALID_STATE. No claim values. A failure here is logged and ignored. |

**Linking rules,** following the design EDR's own SDD settles on:

- **VERIFY by a signed-in account** (`session.accountId`): attach the sub to that account. A
  sub linked to another account is refused (`FAYDA_IDENTITY_CONFLICT`). So is an account that
  already has another sub.
- **VERIFY by a guest:** store the identity without an account, or with the account it is
  already linked to by sub.
- **LOGIN:** sign in to the account linked by sub. Without a link, create a **new** account and
  link it. Joining an existing account means signing in to it first and running VERIFY from
  inside it, so the sub is attached by a proven owner.
- **The `sub`** is pairwise per client id. It means nothing under another client id, and it
  changes if your client id changes (sandbox to production). Never copy sandbox links to
  production.

## 7. Routes and handing the result over

The built-in routes are `GET {route}/callback` and `POST {route}/complete`, with `route`
defaulting to `fayda`. They need a host and Express.

- **API callback:** register `https://<api>/<prefix>/fayda/callback` as the channel's redirect
  address and set `returnUrls[channel]`. The browser is sent on with `?result=<session id>`
  or `?error=<code>`.
  - Your result page asks your API for the view of that session id, which is the
    example's `GET /fayda/results/:id`.
  - The API answers only when the binding cookie's hash matches, then clears the cookie with
    `clearBindingCookie(state)`.
  - Without return URLs, the callback answers JSON.
- **Front-end callback:** the page receives eSignet's redirect and posts `{ code, state }` (or
  `{ error, state }`) to `{route}/complete` with the cookie.
- Both answer with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, because the
  callback URL carries the code. The JSON holds `outcome`, `sessionId`, `purpose`, your host's
  `result` and the `proof`. Identity fields appear only if your host puts them in its result.
- With `route: false`, call `FaydaService.complete` from your own controller. Read the cookie
  with `readCookie(req, fayda.bindingCookieName(state))`.

Rate-limit start and complete per address and per account in front of the app. The package
does not.

## 8. Proofs

A business step that needs "this person verified just now" (EDR passenger's booking flow, UC-3
in the SDD) must not take a bare `sub`. The `sub` is stable and leaks through other answers.

With `proof.secret` set, `complete` returns `proof`: base64url(JSON) plus base64url(HMAC-SHA-256)
over `{sub, cid, sid, exp}`. `verifyProof(token, sub)` returns the payload when the proof is
signed by a current or previous secret, unexpired, and for this sub and client. Otherwise it
returns null.

- The lifetime defaults to 15 minutes (EDR passenger: 120).
- Record `payload.sid` when a step uses a proof, with a unique index, so one proof is used
  once. The example's `public_requests` does this.
- **Rotation:** put the new secret in `secret` and the old one in `previousSecrets` for one
  lifetime.

## 9. Claims and identity fields

| Field | From | Notes |
| --- | --- | --- |
| `sub` | `sub` | The key to link by. Not the national ID number. |
| `fullName`, `nameEn`, `nameAm` | `name`, `name#en`, `name#am` | `name`, else English, else Amharic. |
| `gender`, `genderEn`, `genderAm` | `gender#en`, `gender#am`, `gender` | |
| `birthdate` | `birthdate` | Read as ISO `yyyy-MM-dd` from `yyyy/MM/dd` (what EDR's passenger copy says eSignet sends) or `yyyy-MM-dd`. Anything else is left out; the raw value stays in `claims`. |
| `phoneE164`, `phoneRaw` | `phone_number` (or `#en`, `#am`, `phone`) | E.164 only for Ethiopian mobiles (`+2519`, `+2517`), Djibouti mobiles (`+25377`), or a number already carrying `+` with 8 to 15 digits. Otherwise raw only: never used to reach or match anyone. |
| `email` | `email` | Trimmed, as sent. Often empty in the register. |
| `addressEn`, `addressAm` | `address#en`, `address#am` | `formatted#<locale>` if present, else the parts joined in EDR's order (house number, kebele, woreda, city, sub-city, zone, region, postal code, country). A plain string is taken as is. |
| `picture`, `nationality` | as named | Sensitive: store only where a use case needs it. |
| `acr`, `authTime` | ID token | |
| `claims` | the verified userinfo | Everything, for fields not read above. |

Store only what a business rule needs. Never log claim values, tokens, the code, the verifier,
the assertion or keys: the package logs session ids and failure codes only.

## 10. Options and environment

| Option | Env (EDR's names where they exist) | Default |
| --- | --- | --- |
| `enabled` | `FAYDA_ENABLED` | true |
| `clientId` | `FAYDA_CLIENT_ID` | required |
| `issuer` | `FAYDA_ISSUER` (**new**) | required |
| `authorizationEndpoint` | `FAYDA_AUTHORIZATION_ENDPOINT` | required |
| `tokenEndpoint` | `FAYDA_TOKEN_ENDPOINT` | required, also the assertion's `aud` |
| `userinfoEndpoint` | `FAYDA_USERINFO_ENDPOINT` | required |
| `jwksUri` | `FAYDA_JWKS_URI` (**new**) | required |
| `privateKey` | `FAYDA_PRIVATE_KEY_BASE64` | required: JWK, JWK JSON, base64 of the JWK, or PEM; RSA, 2048 bits or more |
| `keyId` | `FAYDA_PRIVATE_KEY_ID` | none |
| `redirectUris` | `FAYDA_REDIRECT_URI` (MOBILE), `FAYDA_WEB_REDIRECT_URI` (WEB), `FAYDA_PORTAL_REDIRECT_URI` (PORTAL) | required |
| `defaultChannel` | | WEB, else the first |
| `returnUrls` | | none (the callback answers JSON) |
| `scope` | `FAYDA_SCOPE` | `openid profile email phone address` |
| `acrValues` | `FAYDA_ACR_VALUES` | `mosip:idp:acr:generated-code` |
| `claimsLocales` | `FAYDA_CLAIMS_LOCALES` | `en am` |
| `userinfoClaims` | | EDR's eight |
| `prompt` | | `login` |
| `sessionTtlMinutes` | `FAYDA_SESSION_TTL_MINUTES` | 10 |
| `clockSkewSeconds` | | 60 |
| `idTokenAlgs`, `userinfoAlgs` | | `["RS256"]` |
| `requireIdToken`, `requireNonce` | | true |
| `enforceAcr` | | false |
| `acceptJsonUserinfo` | | false |
| `clientAssertion` | | `{alg: RS256, typ: false, jti: true, lifetimeSeconds: 120}` |
| `httpTimeoutMs` | `FAYDA_HTTP_TIMEOUT_MS` | 10000 (JWKS: at most 5000) |
| `jwksCacheMinutes`, `jwksMinRefreshSeconds`, `jwksMaxStaleMinutes` | | 10, 30, 60 |
| `ca` | | none; added to Node's roots, not replacing them |
| `insecureTls` | | false; refused for `fayda.et` hosts |
| `browserBinding` | | `{unboundChannels: ["MOBILE"], cookiePrefix: "fayda_b_", cookiePath: "/", secureCookie: true, sameSite: "Lax"}` |
| `proof` | `FAYDA_PROOF_SECRET`, `FAYDA_PROOF_TTL_MINUTES` | off; secret at least 32 characters, ttl 15 |

Endpoints must be https, except on localhost.

## 11. Errors

`complete` returns `FAILED` with one of these, or your host's own refusal code:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `FAYDA_DISABLED` | 503 | `enabled: false` |
| `FAYDA_AUTH_ERROR` | 400 | eSignet's error redirect: cancelled, denied |
| `FAYDA_MISSING_PARAMETERS` | 400 | no code or state, or a malformed code |
| `FAYDA_INVALID_STATE` | 400 | unknown, used or racing state; logged as a security event |
| `FAYDA_SESSION_EXPIRED` | 400 | |
| `FAYDA_BINDING_MISMATCH` | 400 | another browser |
| `FAYDA_TOKEN_EXCHANGE_FAILED` | 502 | token call refused or unreachable |
| `FAYDA_TOKEN_INVALID` | 502 | ID token failed a check |
| `FAYDA_USERINFO_FAILED` | 502 | userinfo failed or unreachable |
| `FAYDA_INTERNAL_ERROR` | 500 | your host threw something else |

The codes match EDR's where EDR had them, so EDR's front ends keep working. The message is fit
for the user. `reason` is for logs only.

## 12. What was verified, and what was not

**Verified here, against the mock eSignet and Postgres 16:**

- Every check in section 4, each failing on its own.
- The atomic claim: the race test fails if `claimSession` is made a SELECT then an UPDATE.
- The binding, expiry, replay, the upsert, the linking rules, proofs, and key rotation.
- The mock checks the client assertion's signature, `iss`, `sub`, `aud`, `exp`, its lifetime
  and a unique `jti`, and checks PKCE S256.

**Not verified.** Nothing here called eSignet. Each of these is an item for NIDP:

1. The issuer value and the JWKS address for your client. EDR never configured either. The
   mock's paths follow eSignet's usual layout and are not a promise.
2. That eSignet signs the ID token and the userinfo with RS256 keys published in that JWKS.
3. That the ID token carries the `nonce` sent at authorize. If it does not, `requireNonce: false`
   is the fallback, and the ID token is then not tied to the session.
4. That userinfo comes as a signed JWT (`application/jwt`), not JSON and not JWE. EDR's code
   handles both JSON and a 3-part JWT, so either may have been seen.
5. That a `jti` in the client assertion is accepted. NIDP's reference sends none; RFC 7523 allows it.
6. That `prompt=login` is honoured. EDR's passenger copy relies on it.
7. The `birthdate` format (`yyyy/MM/dd` per EDR's comment, `yyyy-MM-dd` in EDR's mocks), and the
   shape of `address#en` (an object of `*#en` parts per EDR's freight comment, a string in EDR's
   e2e mock).
8. The acr values enabled for your client, token and code lifetimes, rate limits.

## 13. Going-live checklist

- [ ] Registered with NIDP: client id, every channel's exact redirect address, scopes, claims,
      acr. Your public key registered, the private key in a secret manager.
- [ ] `FAYDA_ISSUER` and `FAYDA_JWKS_URI` from NIDP. A first sandbox verification completes with
      `requireNonce` on and `acceptJsonUserinfo` off. If it does not, read `reason` in the log
      before relaxing anything.
- [ ] `sessions.state` unique; `identities.sub` unique; `claimSession` one atomic UPDATE.
- [ ] No code path links or signs in an account found by phone or email.
- [ ] Binding cookie set on start. Cross-site SPAs use `sameSite: "None"` and
      `credentials: "include"`.
- [ ] Return URLs per channel, or a front-end page posting to `/fayda/complete`. The result page
      checks the cookie.
- [ ] Proof secret set where a step takes a proof. The step records `sid` once.
- [ ] Rate limits on start and complete. An alert on `FAYDA_INVALID_STATE` and
      `FAYDA_TOKEN_INVALID` rates.
- [ ] Claims asked for: only what the use case needs. A retention period per stored claim.
- [ ] A daily job deletes closed sessions past retention (the example's `purgeSessions`).
- [ ] No test bypass reachable in production.

## 14. Moving EDR onto this package

### What is wrong in EDR today (origin/dev 4e43da58b)

Both APIs, `modules/verifayda/verifayda.service.ts`:

1. **Unverified userinfo.** `fetchUserInfo` base64-decodes the JWT payload; the code comment
   calls signature verification a "production TODO". `application/json` is accepted as is.
2. **No ID token checks.** `id_token` is typed but never read, so `iss`, `aud`, `exp` and
   `at_hash` are not checked either.
3. **No nonce.** `buildAuthorizationUrl` sends none.
4. **Merge by phone or email, plus a session token.** `upsertIamUser`, step 2, finds `iam.users`
   by `phone_number = $1 OR email = $2`. It merges the Fayda metadata into that account and sets
   `verified_by = 'fayda'`. `completeVerification` then calls `createFaydaSession` for that
   account and returns `token` and `refreshToken` to the caller. The session's own `iam_user_id`,
   the signed-in user who started, is stored but never compared.
5. **Non-atomic session use.** `findOne` then a status check, and the session is marked
   COMPLETED only at the end. Two completions both pass. The second one then fails at eSignet,
   because the code is single use.
6. **No browser binding.** Any browser holding `code` and `state` completes the session.
7. **Error detail goes out.** A failed token call throws
   `Fayda token endpoint returned <status>: <body>` as a 502 message. That message goes to the
   client and into `error_description`.
8. **Failures to store are hidden.** `upsertIamUser` swallows database errors and the result
   still says `verified: true` (`userDataSaved: false`).
9. **No timeouts** on the three `fetch` calls.
10. **Freight only:** `DEV_BYPASS` as the code returns a canned verified identity whenever
    `ENV` is `dev` or `staging`. That is safe only while `ENV` is never set so on an
    internet-facing stack.
11. **Passenger only:**
    - `standardizePhoneNumber` prefixes `+` to any digits: the freight copy's comment
      documents the damage.
    - `address#en` is read as a string.
    - Throttling of the controller is commented out.

Elsewhere in EDR:

12. **Back office** `apps/edr-freight-web/backoffice/src/shared/utils/faydaOidc.ts` builds its
    own authorize URL in the browser:
    - The constant `FAYDA_CODE_VERIFIER` is `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`, the
      RFC 7636 example, and its challenge.
    - The nonce `g4DEuje5Fx57Vb64dO4oqLHXGT8L8G7g` is constant.
    - The states are fixed words such as `complaint_flow` and `ptOO76SD`.
    - It asks for `individual_id`, the national ID number, as essential.
    - The code then goes to `registerWithFayda({ code })` (`shared/services/authService.ts`,
      the IAM sign-in and sign-up calls), and is exchanged outside this repository. The browser
      sends only the code, so the side that exchanges it can only be using the same public
      constant as the verifier.

    Anyone can therefore complete PKCE for these flows, and state is not a CSRF token there.
13. **Passenger bookings.** `modules/bookings/bookings.service.ts`, around lines 1949 and 1978,
    calls the deprecated stub `verifyNationalId`. With `VERIFAYDA_ENABLED` off, which is the
    default, the stub answers `verified: true` with `mock: true` and the name "Mock Passenger".
    These two call sites ignore `mock`. Every national-ID passenger of a signed-in booking is
    stored as `verifaydaVerified` under that name. `guest-booking.service.ts` (around line 1201)
    does check `mock`. The stub's enabled path posts the national ID number to
    `VERIFAYDA_API_URL` (default `https://api.verifayda.gov.et/v2`), which is not the eSignet flow.
14. **Passenger proofs.** `FAYDA_PROOF_SECRET` is empty by default, so no proofs are issued.
    While `FAYDA_PROOF_REQUIRED` is false, its default, a booking accepts a bare `sub` verified
    in the last `FAYDA_PROOF_FALLBACK_MINUTES` (120). By EDR's own comment, that `sub` leaks
    through public booking and ticket answers.

**The two copies compared.** The package takes the better half of each:

- **From the passenger copy:** `prompt=login`, and the redirect address stored on the session
  and reused at the token call.
- **From the freight copy:** the address formatting, the phone handling, and the header without
  `typ`, as in NIDP's reference.
- **Passenger only, not taken:** it picks the WEB host from the request's Origin, against
  an allow-list. The package takes channels from configuration instead: register each domain
  as its own channel.

### Steps

1. Ask NIDP for the issuer and JWKS address (section 12). Set `FAYDA_ISSUER` and
   `FAYDA_JWKS_URI`.
2. Add the columns in [examples/edr/edr-fayda-host.ts](../examples/edr/edr-fayda-host.ts):
   `nonce`, `redirect_uri`, `browser_binding_hash`, `metadata`, plus statuses `IN_PROGRESS` and
   `EXPIRED`. Add a unique index on `iam.users ((metadata->>'sub'))`.
3. Put `EdrFreightFaydaHost` in place of `VerifaydaService`'s OIDC half, with `route: false`, and
   keep EDR's routes (`/fayda/verification/start`, `/fayda/verification/complete`) on top of
   `FaydaService`. The failure codes are EDR's, so the front ends keep working.
4. Drop step 2 of `upsertIamUser`. A contact match becomes `possibleAccountMatch` in the
   answer. The front end asks the person to sign in to that account and verify from there.
5. Set the binding cookie in `start` and send it with `complete`. The SPAs call the API cross
   site, so use `sameSite: "None"` and `credentials: "include"`.
6. Move the back office's complaint and external-portal flows onto `start`, so the API makes the
   state, nonce and verifier. Remove `faydaOidc.ts`'s constants and the `individual_id` claim.
7. Passenger: the same host shape over Prisma's `FaydaVerificationSession`. Set
   `FAYDA_PROOF_SECRET` and `FAYDA_PROOF_REQUIRED=true`. Make `bookings.service.ts` respect `mock`.
