# integrations

Integrations for NestJS, so other systems can use them: national ID, GPS trackers, business
licences and tax e-invoicing.

Each package under `packages/` is independent: its own `package.json`, lockfile, build and
tests. There is no workspace at the root.

| Package | What it is |
| --- | --- |
| [packages/mor-eims-integration](packages/mor-eims-integration/) | `@edr/mor-eims-integration`: Ministry of Revenues EIMS e-invoicing: signed login and calls, invoices and credit/debit notes with a durable gapless sequence (ambiguous answers block until resolved, never resent), sales receipts per payment, cancellation, bulk filing with a callback checked by /v1/verify, INSA key rotation without overlap, a redacted exchange log |

## Working on a package

```bash
cd packages/<name>-integration
pnpm install
pnpm run type-check
pnpm test
pnpm run build
```

Each package README explains its Postgres tests and how to install it into another app.
