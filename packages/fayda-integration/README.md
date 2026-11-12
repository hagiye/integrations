# @edr/fayda-integration

Fayda, Ethiopia's national digital ID, for NestJS. It was taken out of the EDR platform so
another system can use it as a package. Fayda reaches relying parties through **eSignet**, an
OpenID Connect provider. The package runs the authorization code flow against it and hands
your app a person whose every claim it has verified.

| Part | What it does |
| --- | --- |
| `FaydaClient` | The eSignet calls, as EDR makes them: the authorize URL with PKCE S256 and EDR's claims request, the token call with a signed client assertion (`private_key_jwt`), and userinfo. **Unlike EDR, it verifies what comes back.** The ID token and the signed userinfo are checked against eSignet's published keys (JWKS), with RS256 only, never `none`. It checks the issuer, the audience, the expiry, the **nonce** and that the userinfo is about the ID token's subject. Every call has a deadline. |
| `FaydaService` | `start`: a session with a fresh state, nonce, PKCE verifier and browser binding, and the URL to send the browser to. `complete`: claims the session once, checks expiry and binding, exchanges the code, verifies, and hands the identity to your host. It never throws for a failed verification. It returns a code, an HTTP status and a message fit for the user. Optional signed **proofs** of a fresh verification. |
| Your host | Stores sessions and claims them atomically. It links the person **by their Fayda subject (`sub`)**. The package never links an account because a phone or an email matches; it only reports the match. |
| Callback routes | `GET /fayda/callback` (eSignet comes back to the API) and `POST /fayda/complete` (a front-end page passes `code` and `state` on). No claims or tokens are put in any URL. |

**Read [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md) section 1 before using this in
production.** It lists what EDR does wrong today. EDR trusts an unverified userinfo, merges into
existing accounts by phone or email and hands them a session token. Its back office starts the
flow with a fixed, public PKCE verifier. [docs/FILE-INDEX.md](docs/FILE-INDEX.md) lists every
file and where it came from in EDR.

## Requirements

- Node 18.17+, NestJS 10 or 11, Express (the built-in routes use Express's response).
- A relying-party registration with NIDP (the Fayda programme). It gives you:
  - the client id;
  - the issuer, the authorize, token, userinfo and JWKS addresses;
  - one registered redirect address per channel.

  You register the public half of your RSA key with them.
- No database of its own. Your host stores sessions and identities. The example uses TypeORM
  and Postgres.
- No runtime dependencies besides Nest: the JOSE work is done with `node:crypto`, and HTTP
  with `node:http` and `node:https`.

## Install

The package is private. Build it and install it from a path or a tarball:

```bash
pnpm install
pnpm run build          # writes dist/
pnpm pack               # edr-fayda-integration-1.0.0.tgz

# in your app
pnpm add /path/to/edr-fayda-integration-1.0.0.tgz
```

Or copy `src/` into your repo as a module; nothing in it depends on EDR.

## In 5 steps

### 1. Store sessions and identities

Two tables are enough (see
[examples/standalone/create-fayda.migration.ts](examples/standalone/create-fayda.migration.ts)):

- **Sessions:** one row per started verification, with `state` **unique**. The nonce and the
  code verifier are wiped when the session ends.
- **Identities:** one row per Fayda subject, with `sub` **unique**, linked to at most one
  account.

### 2. Implement the host

```ts
@Injectable()
export class MyFaydaHost implements FaydaHost<MyResult> {
  createSession(session: FaydaSessionRecord): Promise<void> { ... }          // INSERT, status PENDING
  claimSession(state: string): Promise<FaydaSessionRecord | null> { ... }    // UPDATE ... SET status = 'IN_PROGRESS'
                                                                             //   WHERE state = $1 AND status = 'PENDING' RETURNING *
  endSession(id: string, end: FaydaSessionEnd): Promise<void> { ... }        // set status, wipe nonce and code_verifier
  onVerified(identity: FaydaIdentity, ctx: FaydaVerifiedContext): Promise<MyResult> { ... }  // link by identity.sub
  findContactMatches?(identity: FaydaIdentity): Promise<string[]>;           // reported only, never linked
  recordEvent?(event: FaydaEvent): Promise<void>;                            // audit, no claim values
}
```

`claimSession` must be one atomic update: of two completions racing on one state, only one may
get the row. In `onVerified`, link by `identity.sub` and nothing else. Throw
`new FaydaHostRefusal(code, message, status)` to refuse, for example when the sub is already
linked to another account.

### 3. Mount the module

```ts
FaydaModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    clientId: config.getOrThrow("FAYDA_CLIENT_ID"),
    issuer: config.getOrThrow("FAYDA_ISSUER"),
    authorizationEndpoint: config.getOrThrow("FAYDA_AUTHORIZATION_ENDPOINT"),
    tokenEndpoint: config.getOrThrow("FAYDA_TOKEN_ENDPOINT"),
    userinfoEndpoint: config.getOrThrow("FAYDA_USERINFO_ENDPOINT"),
    jwksUri: config.getOrThrow("FAYDA_JWKS_URI"),
    privateKey: config.getOrThrow("FAYDA_PRIVATE_KEY_BASE64"),   // JWK, base64 JWK, or PEM
    redirectUris: {
      WEB: config.getOrThrow("FAYDA_WEB_REDIRECT_URI"),
      MOBILE: config.getOrThrow("FAYDA_REDIRECT_URI"),
    },
    proof: { secret: config.getOrThrow("FAYDA_PROOF_SECRET") },  // optional
  }),
  host: MyFaydaHost,
});
```

The app refuses to start with a missing or unsafe option and names it. That includes an
unreadable key, plain http to a non-local host, and `insecureTls` for a `fayda.et` host. Without
`host` you get only `FaydaClient`. `route: false` drops the built-in routes.

### 4. Start a verification

```ts
const started = await fayda.start({ purpose: "VERIFY", channel: "WEB", accountId: user?.id ?? null });
if (started.browserBinding) res.setHeader("Set-Cookie", started.browserBinding.setCookie);
return { authorizationUrl: started.authorizationUrl };   // the browser goes there
```

The binding cookie ties the session to the browser that started it. A `code` and `state` link
sent to someone else then completes nothing. Native-app channels (`MOBILE` by default) are not
bound.

### 5. Let eSignet come back

There are two ways, one per channel:

- **To the API.** The channel's redirect address is `https://<api>/<prefix>/fayda/callback`.
  The package completes the verification and sends the browser to
  `returnUrls[channel].success` with `?result=<session id>`, or to `.failure` with
  `?error=<code>`. Your result page reads the verified view by session id, for the browser
  holding the cookie only.
- **To a front-end page.** The page posts `{ code, state }` to `/<prefix>/fayda/complete`
  with the cookie and gets JSON back.

## What decides the outcome

| What happened | Result | Session |
| --- | --- | --- |
| ID token signature, issuer, audience, expiry, nonce valid; userinfo signature valid and same `sub` | `VERIFIED`, your `onVerified` result | `COMPLETED` |
| State unknown, used, or claimed by a racing request | `FAYDA_INVALID_STATE` (400), eSignet not called | unchanged |
| Session older than `sessionTtlMinutes` | `FAYDA_SESSION_EXPIRED` (400), eSignet not called | `EXPIRED` |
| No or wrong binding cookie | `FAYDA_BINDING_MISMATCH` (400), eSignet not called | `FAILED` |
| eSignet's error redirect (cancelled, denied) | `FAYDA_AUTH_ERROR` (400) | `FAILED` |
| Token call refused or unreachable | `FAYDA_TOKEN_EXCHANGE_FAILED` (502) | `FAILED` |
| ID token missing, unsigned, wrong key, issuer, audience, nonce, expired | `FAYDA_TOKEN_INVALID` (502) | `FAILED` |
| Userinfo unsigned, wrong key, encrypted, other `sub`, or unreachable | `FAYDA_USERINFO_FAILED` (502) | `FAILED` |
| Your host refuses | your code and status (for example `FAYDA_IDENTITY_CONFLICT`, 409) | `FAILED` |

## Tests

```bash
pnpm install
pnpm run type-check
pnpm test                       # unit + HTTP tests against a mock eSignet, no database needed

# Against a real, throwaway Postgres (a schema is created and dropped):
docker run -d --name fayda-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55482:5432 postgres:16
FAYDA_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55482/postgres pnpm test:pg
docker rm -f fayda-pg
```

The mock eSignet ([test/mock-esignet.ts](test/mock-esignet.ts)) has its own crypto, so it shares
no code with what it tests:

- It makes its RSA keys at start.
- It checks our client assertion against the registered public key, and checks PKCE.
- It answers with a signed ID token and a signed JWT userinfo.

It can break one thing at a time:

- a wrong nonce, audience or issuer;
- `alg: none`, or HMAC with the public key;
- a userinfo signed by a stranger, about someone else, plain JSON, or encrypted;
- an error status;
- a key rotation.

No key in the repository is real: every key is generated when the tests run. The Postgres run
uses two app instances on one database. It covers:

- the full flow;
- a replay;
- two completions racing on one state;
- two sessions of one person at once;
- expiry;
- forged or mismatched tokens;
- the browser binding;
- no merge by phone or email;
- linking and conflicts;
- proofs used once.

The race test fails if the claim is made non-atomic.

Nothing here called eSignet itself. See the guide for what is verified and what is not.

## Examples

- [examples/standalone/](examples/standalone/): a complete verification back end with
  sessions, accounts, identities, results, an audit log and a proof-taking step in Postgres. It
  is compiled and used by the Postgres tests.
- [examples/edr/edr-fayda-host.ts](examples/edr/edr-fayda-host.ts): how EDR's freight API would
  sit on the package over `freight.fayda_verification_sessions` and `iam.users`, without the
  phone and email merge. **Not compiled here**: it imports EDR code.
