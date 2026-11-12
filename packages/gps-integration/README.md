# @edr/gps-integration

GPS trackers for NestJS, taken out of the EDR platform so another system can use them as a
package. It covers GT06 (Concox) trackers, the cheap vehicle trackers that talk raw binary
over TCP. The package runs the TCP listener, decodes the protocol and checks every fix. It
hands your app clean batches of positions and raises tracking alerts.

| Part | What it does |
| --- | --- |
| `Gt06FrameReader`, `decodeGt06` | The protocol: 0x7878 and 0x7979 frames, CRC-ITU, login, location (0x12 and the newer 0x22), heartbeat, alarms (0x16, 0x26), and the server's acks. Pure, and it **never throws on device input**. A 12-byte frame took EDR's ingester process down; here it is just "malformed". |
| `Gt06TcpServer` | The listener. It enforces source allow lists and connection caps, needs a login within a deadline, and only accepts **registered devices** (EDR auto-registered any IMEI). One IMEI per connection, and a newer connection replaces an older one. Bad-frame and rate limits apply; the socket is paused while your host catches up. Shutdown drains what is queued. |
| `GpsIngestService` | Checks each fix: no fix, impossible coordinates, clock skew, replay age. It drops duplicates, flags **impossible jumps** as suspect, and calls your host once per TCP read. Alarms are delivered once. |
| `GpsAlertService` | EDR's tracking alerts: overspeed, idle, offline and geofence (keep in / keep out). It scans on a timer, opens, touches and resolves through your host, and notifies with a **cooldown**, so a truck at the speed limit does not notify every minute. |
| Your host | Finds devices by IMEI and stores positions with a unique (device, fix time) key. It moves the live position only forward in time, and keeps the alerts. |

**Read [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md) section 1 before using this in
production.** It lists what is wrong in EDR's tracker service today. Anyone who reaches the
port can crash it with 12 bytes, without logging in. It creates a device for any IMEI that
connects. Newer trackers' 0x22 positions are thrown away. [docs/FILE-INDEX.md](docs/FILE-INDEX.md)
lists every file and where it came from in EDR.

GT06 has **no authentication**: a tracker proves nothing but an IMEI. Run the port behind a
firewall or the SIM provider's APN VPN, and set `allowedSources`. Guide section 7 has the rest.

## Requirements

- Node 18.17+, NestJS 10 or 11.
- Trackers that speak GT06 (Concox GT06, GT06N, and the many clones), pointed at your host and
  port by SMS (`SERVER,1,gps.example.com,5023,0#`).
- A TCP port the trackers can reach, routed at layer 4 (an L4 load balancer or Nginx `stream`),
  never through an HTTP proxy.
- No database of its own. Your host stores devices, positions and alerts. The example uses
  TypeORM and Postgres.
- No runtime dependencies besides Nest: `node:net` and `node:crypto` only.

## Install

The package is private. Build it and install it from a path or a tarball:

```bash
pnpm install
pnpm run build          # writes dist/
pnpm pack               # edr-gps-integration-1.0.0.tgz

# in your app
pnpm add /path/to/edr-gps-integration-1.0.0.tgz
```

Or copy `src/` into your repo as a module; nothing in it depends on EDR.

## In 5 steps

### 1. Store devices and positions

You need:

- a **devices** table keyed by IMEI (unique), with the live fix and a soft delete;
- a **positions** table with a **unique (device, fix time)** key. It is what makes a resent
  fix a no-op; EDR's table has none.

The example's migration ([create-gps.migration.ts](examples/standalone/create-gps.migration.ts))
has both, plus alarms, rejections and EDR's alert tables. Register trackers through your own
admin flow. The package never creates a device.

### 2. Implement the host

Two methods are required. The rest are optional. See
[examples/standalone/typeorm-gps.host.ts](examples/standalone/typeorm-gps.host.ts).

```ts
@Injectable()
export class MyGpsHost implements GpsHost {
  findDevice(imei: string, connection: GpsConnectionInfo): Promise<GpsDevice | null> { ... }
  savePositions(batch: GpsPositionBatch): Promise<number | void> { ... }
  markSeen?(device: GpsDevice, seenAt: Date): Promise<void>;          // last_seen_at, for OFFLINE
  onStatus?(event: GpsStatusEvent): Promise<void>;                     // battery, GSM, ACC
  onAlarm?(event: GpsAlarmEvent): Promise<void>;                       // SOS, power cut, fence
  onConnect?(device, connection): Promise<void>;
  onDisconnect?(event: GpsDisconnectEvent): Promise<void>;
  onRejected?(event: GpsRejectionEvent): Promise<void>;                // unknown IMEI, source, rate...
  // alerts: all four, or none
  loadAlertInputs?(q): Promise<GpsAlertInputs>;
  openAlert?(a): Promise<string | null>;
  touchAlert?(u): Promise<void>;
  resolveAlert?(u): Promise<void>;
  notifyAlert?(a: GpsOpenedAlert): Promise<void>;
}
```

- `findDevice` returns null for an IMEI you do not know, or have deleted. The connection is
  closed without an ack.
- `savePositions` inserts with `ON CONFLICT (device, fix time) DO NOTHING`. It moves the live
  fix to `batch.latest` only if that is newer
  (`WHERE last_fix_at IS NULL OR last_fix_at <= :fixTime`). If it throws, nothing is acked.
- `openAlert` returns null when an open alert with the same vehicle, kind and geofence exists.
  A partial unique index does it, as in EDR.

### 3. Mount the module

```ts
GpsModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    port: Number(config.get("GT06_TCP_PORT") ?? 5023),
    bindAddress: config.get("GT06_TCP_HOST") ?? "0.0.0.0",
    allowedSources: (config.get("GT06_ALLOWED_SOURCES") ?? "").split(",").filter(Boolean),
  }),
  host: MyGpsHost,
});
```

The listener opens at application bootstrap and closes on shutdown (`app.enableShutdownHooks()`).
`listen: false` keeps the codec, ingest and alerts without a listener. That is for an API
process that only reads, or for feeding `GpsIngestService` from another transport. Without a
`host`, only the pure parts are there.

### 4. Point the trackers at it

By SMS to each tracker's SIM; the syntax varies by firmware, so check your unit's sheet:

```
APN,<apn>#
SERVER,1,gps.example.com,5023,0#
GPRSON,1#
TIMER,10#
RESET#
```

Then register the tracker's IMEI (printed on the unit) in your devices table. Until then its
logins are refused, and `onRejected` reports `UNKNOWN_DEVICE`.

### 5. Read the positions

Positions land in your tables. The live map is your devices table's live fix; a trail is your
positions table where `positioned AND NOT suspect`. With the alert methods in place,
`GpsAlertService` scans every minute. Call `scan()` yourself for a test or a cron of your own.

## What decides the outcome

| A packet from a tracker | What happens |
| --- | --- |
| Login, IMEI the host knows | Acked; `onConnect`; anything else on the connection now counts |
| Login, IMEI unknown or deleted | No ack, connection closed, `onRejected UNKNOWN_DEVICE` |
| Login with another IMEI on a logged-in connection | Closed, `IMEI_CHANGED` |
| Anything before a login | Dropped, not acked; no login within `loginTimeoutMs` closes it |
| Location, checks pass | Stored; the newest trusted one becomes `batch.latest` |
| Location without satellite lock, at 0,0, out of range, from the future, older than 7 days, or already stored | Dropped, counted (`NO_FIX`, `IMPOSSIBLE_COORDINATES`, `FUTURE`, `TOO_OLD`, `DUPLICATE`) |
| Location implying more than 300 km/h from the last trusted fix | Stored with `suspect: true`; never `latest` |
| Heartbeat | `onStatus`, then acked |
| Alarm | Its fix stored, `onAlarm` (once, even if resent), `onStatus`, then acked |
| Bad CRC, garbage, malformed content | Dropped; more than `maxBadFrames` closes the connection |
| Host throws | No ack: the tracker sends it again |

## Tests

```bash
pnpm test        # unit tests: codec, rules, ingest, a real TCP listener on 127.0.0.1

# Against a real, throwaway Postgres (a schema is created and dropped):
docker run -d --name gps-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55483:5432 postgres:16
GPS_TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55483/postgres pnpm test:pg
docker rm -f gps-pg
```

`test:pg` boots the standalone example with its listener on 127.0.0.1 and drives it with the
simulated tracker in [test/gt06-device.ts](test/gt06-device.ts). The simulator has its own
encoder and CRC, written apart from the package's decoder. The tests cover:

- login and positions stored, an unknown IMEI refused, a deleted tracker;
- bad CRC, nothing before login, duplicates (including across a second instance: the
  database's unique key);
- frames split across TCP reads, replays and the live fix, a jump stored as suspect;
- two connections for one IMEI, a batch of 200 fixes, an SOS alarm;
- an overspeed opened once and reopened quietly within the cooldown, a geofence exit, and two
  instances scanning at once (one alert: the partial unique index).

## Examples

- [examples/standalone](examples/standalone): a complete Nest app on TypeORM + Postgres. It runs
  the GT06 listener, the host, the migration and a small admin API: register a tracker, the
  live map, a vehicle's trail. `main.ts` reads EDR's env names (`GT06_TCP_PORT`, `GT06_TCP_HOST`).
- [examples/edr/edr-gps-host.ts](examples/edr/edr-gps-host.ts): how EDR's `apps/edr-gps-tracker`
  and freight API would use the package on their `freight.gps_*` tables. Not compiled here.
