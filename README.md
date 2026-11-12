# integrations

Integrations for NestJS, so other systems can use them: national ID, GPS trackers, business
licences and tax e-invoicing.

Each package under `packages/` is independent: its own `package.json`, lockfile, build and
tests. There is no workspace at the root.

| Package | What it is |
| --- | --- |
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
