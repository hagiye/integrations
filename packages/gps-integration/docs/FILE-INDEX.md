# File index

This index shows where each part lives, and where it came from in the EDR platform (origin/dev
`4e43da58b`).

EDR paths below are short for:

- **tracker:** `apps/edr-gps-tracker/`
- **freight API:** `apps/edr-freight-api/src/modules/gps-tracking/`

## Package: `src/`

| File | What it is | From EDR |
| --- | --- | --- |
| `gt06.codec.ts` | `Gt06FrameReader` (framing, CRC, resync, bounded buffer), `decodeGt06` (login, 0x12, 0x22, heartbeat, 0x16, 0x26; never throws), `buildGt06Frame`, `buildGt06Ack`, `crcItu`, `decodeGt06Imei`, status and alarm types | tracker `src/gps/gt06/gt06.codec.ts` (`crcItu`, `parseStream`, `decodeFrame`, `decodeGps`, `decodeStatus`, `decodeLbs`, `buildAck`). Same bit layout. Long frames, 0x22/0x26, length checks, BCD check, date check, one-byte resync and the alarm without a fix are new. |
| `gps.server.ts` | `Gt06TcpServer`: the listener, sessions, ordering, acks, the connection rules, backpressure, drain on close | tracker `src/gps/gt06/gt06.server.ts` (per-connection queue, idle close, keepalive, which packets are acked). Sources, caps, login deadline, known-device rule, IMEI lock, replacement, bad-frame and rate limits, pause/resume and drain are new. |
| `gps.ingest.ts` | `GpsIngestService`: checks, duplicates, jumps, replays, one `savePositions` per read, alarms once, throttled `markSeen` | tracker `src/gps/gps-ingest.service.ts` (`handleLogin`, `handleHeartbeat`, `handleFix`, the 5-minute clock-skew guard). Auto-registration removed; the rest is new. |
| `gps.validation.ts` | `checkFix`, `impliedSpeedKmh`, `JumpDetector`, `RecentFixTimes` | tracker `MAX_CLOCK_SKEW_MS` (now for every fix). The rest is new. |
| `gps.geo.ts` | `distanceM` (haversine), `isPlausibleCoordinate` | freight API `gps-alerts.rules.ts` `distanceM` |
| `gps.alerts.rules.ts` | `evaluateVehicle`, `isIdle`, `planGpsAlerts`, `mergeGpsAlertDetails`, `describeGpsAlert`, alert types | freight API `gps-alerts.rules.ts` (`evaluateDevice`, `isIdle`, `reconcile`, `alertKey`) and `gps-alerts.service.ts` (`mergeDetails`, the notification wording). The fix-age rule, hysteresis and cooldown are new. |
| `gps.alerts.service.ts` | `GpsAlertService`: one scan at a time, its own timer, open/touch/resolve/notify through the host | freight API `gps-alerts.service.ts` (`scheduledScan`, `scan`, `notifyOpened`). `@nestjs/schedule` replaced by a timer; the SQL moved to the host. |
| `gps.host.ts` | **The port you implement**: `GpsHost`, `GpsAlertInputs`, `GpsAlertToOpen`, `GpsOpenedAlert`, `GPS_HOST`, `hostHasAlerts` | New. EDR wrote its tables from the services (`gps.repository.ts`, `gps-alerts.service.ts loadSnapshots`). |
| `gps.types.ts` | `GpsDevice`, `GpsPosition`, `GpsPositionBatch`, the status, alarm, rejection and disconnect events | tracker `src/gps/entities/gps-device.entity.ts`, `gps-position.entity.ts` (the fields). Events are new. |
| `gps.options.ts` | Options, defaults, `resolveGpsOptions`, `invalidGpsOptions` (names, never values), the source allow list, `normalizeAddress`, `maskImei` | tracker `.env.example` and `gt06.server.ts` (`GT06_TCP_PORT`, `GT06_TCP_HOST`, `IDLE_MS`, `MAX_BUFFER`); freight API `gps-alerts.service.ts` `DEFAULT_THRESHOLDS`. The rest is new. |
| `gps.module.ts` | `GpsModule.forRoot / forRootAsync`, `GpsListener` (bootstrap / shutdown) | tracker `src/gps/gps.module.ts`, `src/app.module.ts`, `src/main.ts` |
| `gps.errors.ts` | `GpsError` (`CONFIG`, `INVALID`, `LISTEN`, `HOST`) | New |
| `index.ts` | Public exports | New |
| `*.spec.ts` | Unit tests: codec (the sheet's vectors, EDR's crash and resync cases), validation, options, alert rules, ingest, alert service, module, and the listener over real TCP on 127.0.0.1 | tracker `gt06.codec.spec.ts`, `gt06.server.spec.ts`, `gps-ingest.service.spec.ts`; freight API `gps-alerts.rules.spec.ts`. EDR's cases are kept, with fake sockets replaced by real ones. |

## Tests: `test/`

| File | What it is | From EDR |
| --- | --- | --- |
| `gt06-device.ts` | A simulated tracker: its own encoder and table-driven CRC, login, 0x12, 0x22, heartbeat, alarms, long frames, and a TCP client that waits for acks | tracker `src/gps/gt06/gt06.frames.ts` and `scripts/simulate.ts` (the route, split frame, concurrent logins), written apart from the decoder |
| `fakes.ts` | `FakeGpsHost` (in memory, unique device + fix time, forward-only live fix, open-alert uniqueness), `MinimalGpsHost` | New |
| `gps.pg-spec.ts` | The standalone example on Postgres over real TCP: 16 cases (README, Tests) | tracker `scripts/simulate.ts --verify` (the DB checks), as tests |
| `jest.setup.ts` | Silences Nest's logger | New |

## Examples

| File | What it is | From EDR |
| --- | --- | --- |
| `examples/standalone/app.module.ts` | `ExampleAppModule.forRoot({ databaseUrl, schema, gps })` | tracker `src/app.module.ts` |
| `examples/standalone/create-gps.migration.ts` | Vehicles, devices, positions (unique device + fix time), alarms, rejections, EDR's alert tables with the partial unique index, a notification outbox | freight API migrations `3250000000000-FreightBaseline.ts` (`gps_devices`, `gps_positions`) and `5230000000000-GpsAlerts.ts` |
| `examples/standalone/typeorm-gps.host.ts` | The host on Postgres: one-statement batch insert, forward-only live fix, EDR's idle-window queries | tracker `gps.repository.ts` (`insertIgnore`, `updateLiveFix`); freight API `gps-alerts.service.ts` (`loadSnapshots`, the open-alert insert) |
| `examples/standalone/gps-example.controller.ts` | Register a tracker, the live map, a trail | freight API `gps-tracking.controller.ts` and `gps-tracking.service.ts` (`registerDevice`, `latest`, `history`, the 5-minute online window, 200/1000 limits) |
| `examples/standalone/main.ts` | Boots it with EDR's env names | tracker `src/main.ts` |
| `examples/edr/edr-gps-host.ts` | How EDR would use the package on `freight.gps_*`. Not compiled. | New |

## EDR files not carried over

| EDR file | Why |
| --- | --- |
| tracker `Dockerfile`, `package.json`, `nest-cli.json`, `tsconfig*.json`, `src/config/database.config.ts` | EDR's monorepo build and its database wiring: your app has its own |
| freight API `gps-tracking.controller.ts`, `gps-alerts.controller.ts`, `dto/*`, `gps-tracking.repository.ts`, `entities/*` | The REST API and tables stay in the host app (the example shows the shape) |
| freight API `README.md` | Its operations notes are in guide sections 7 and 11; its device SMS commands in the README |
| `docker-compose.yaml` `gps-tracker` service | Deployment: guide section 11 |
| back office `services/gps-tracking.service.ts`, tracking pages | Front end of the REST API, not part of the integration |
