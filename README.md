# integrations

Integrations for NestJS, so other systems can use them: national ID, GPS trackers, business
licences and tax e-invoicing.

Each package under `packages/` is independent: its own `package.json`, lockfile, build and
tests. There is no workspace at the root.

| Package | What it is |
| --- | --- |

## Working on a package

```bash
cd packages/<name>-integration
pnpm install
pnpm run type-check
pnpm test
pnpm run build
```

Each package README explains its Postgres tests and how to install it into another app.
