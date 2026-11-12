# integrations

Integrations for NestJS, so other systems can use them: national ID, GPS trackers, business
licences and tax e-invoicing.

Each package under `packages/` is independent: its own `package.json`, lockfile, build and
tests. There is no workspace at the root.

| Package | What it is |
| --- | --- |
| [packages/etrade-integration](packages/etrade-integration/) | `@edr/etrade-integration`: Ministry of Trade e-trade lookups by TIN and licence number, TLS verified with the missing issuing CA bundled, a TIN lookup budget, licence snapshots refused or flagged when expired or cancelled, and no public route by default |
| [packages/fayda-integration](packages/fayda-integration/) | `@edr/fayda-integration`: Fayda national ID through eSignet OpenID Connect, with PKCE, nonce and a private_key_jwt client assertion, the ID token and signed userinfo verified against eSignet's keys, single-use sessions bound to the starting browser, identities linked by subject and never merged by phone or email, and signed proofs of a fresh verification |
| [packages/gps-integration](packages/gps-integration/) | `@edr/gps-integration`: GT06 (Concox) GPS trackers over TCP, registered devices only, a decoder that never throws on device input, fix checks (no fix, impossible coordinates, clock skew, duplicates, jumps), and overspeed, idle, offline and geofence alerts with a cooldown |

## Working on a package

```bash
cd packages/<name>-integration
pnpm install
pnpm run type-check
pnpm test
pnpm run build
```

Each package README explains its Postgres tests and how to install it into another app.
