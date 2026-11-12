# integrations

Integrations for NestJS, so other systems can use them: national ID, GPS trackers, business
licences and tax e-invoicing.

Each package under `packages/` is independent: its own `package.json`, lockfile, build and
tests. There is no workspace at the root.

| Package | What it is |
| --- | --- |
| [packages/etrade-integration](packages/etrade-integration/) | `@edr/etrade-integration`: Ministry of Trade e-trade lookups by TIN and licence number, TLS verified with the missing issuing CA bundled, a TIN lookup budget, licence snapshots refused or flagged when expired or cancelled, and no public route by default |

## Working on a package

```bash
cd packages/<name>-integration
pnpm install
pnpm run type-check
pnpm test
pnpm run build
```

Each package README explains its Postgres tests and how to install it into another app.
