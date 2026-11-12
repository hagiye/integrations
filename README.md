# integrations

Integrations for NestJS, so other systems can use them: national ID, GPS trackers, business
licences and tax e-invoicing.

Each package under `packages/` is independent: its own `package.json`, lockfile, build and
tests. There is no workspace at the root.

| Package | What it is |
| --- | --- |
| [packages/fayda-integration](packages/fayda-integration/) | `@edr/fayda-integration`: Fayda national ID through eSignet OpenID Connect, with PKCE, nonce and a private_key_jwt client assertion, the ID token and signed userinfo verified against eSignet's keys, single-use sessions bound to the starting browser, identities linked by subject and never merged by phone or email, and signed proofs of a fresh verification |

## Working on a package

```bash
cd packages/<name>-integration
pnpm install
pnpm run type-check
pnpm test
pnpm run build
```

Each package README explains its Postgres tests and how to install it into another app.
