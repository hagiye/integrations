# GPS trackers (GT06): integration guide

For developers putting `@edr/gps-integration` into a system, and for whoever moves EDR onto it.
EDR references are to origin/dev `4e43da58b`.

## 1. Read this first

EDR's tracker service (`apps/edr-gps-tracker`) has these problems today. The package fixes each
one, and section 14 has the detail:

1. **Anyone can crash it with 12 bytes, without logging in.** The codec reads fields at fixed
   offsets with no length check. Send protocol 0x12 with 2 bytes of content and a valid CRC,
   and `parseStream` throws a `RangeError` inside the socket's `data` listener. The Node
   process exits.
   - This was confirmed by running EDR's own codec in that listener pattern: exit code 1.
   - Docker's `restart: always` brings it back, and the attacker sends it again.
2. **It creates a device for any IMEI that connects.** `ensureDevice` inserts unknown IMEIs.
   Anyone who reaches the port can:
   - create devices without limit;
   - write position history for them;
   - or use a real tracker's IMEI to move its truck on the map and set off its alerts.

   A short login even becomes an "IMEI" with hex letters in it (`000000001473e0d`).
3. **The port is open to everyone.** docker-compose publishes `5023` on all host interfaces.
   There is no source allow list, no connection cap and no login deadline. EDR's own README says
   not to expose it, and points to an Nginx config that is not in the repo.
4. **Newer trackers lose their positions.** GT06N and newer firmware send locations as 0x22
   and alarms as 0x26. EDR logs "unsupported" once and drops every one.
5. **Resent fixes become duplicate history.** There is no unique key on (device, fix time).
   An alarm whose ack was lost comes again and is stored again.
6. **Old fixes keep raising alerts.** OVERSPEED and GEOFENCE treat the vehicle as live while any
   packet arrives. A tracker without GPS lock that still sends heartbeats keeps raising the
   overspeed from hours before.
7. **Alerts flap.** There is no cooldown: a truck at 79-81 km/h opens, notifies and resolves an
   overspeed every minute.

GT06 itself has **no authentication**: section 7.

## 2. The protocol

```
Short: 78 78 | len (1) | protocol | content | serial (2) | crc (2) | 0D 0A
Long:  79 79 | len (2) | protocol | content | serial (2) | crc (2) | 0D 0A
```

`len` counts protocol..crc. The CRC is CRC-ITU (CRC-16/X.25) over len..serial.
`Gt06FrameReader` keeps at most one partial frame between TCP reads, never more than
`maxFrameBytes`. It resyncs one byte past a bad CRC, so a real frame that starts inside a false
one is still found; EDR skipped the false frame's whole claimed length.

| Protocol | Packet | Server reply | In EDR |
| --- | --- | --- | --- |
| 0x01 | Login: 8-byte BCD terminal id (IMEI with a leading 0) | ack | yes; the id is now checked to be digits |
| 0x12 | Location: date, satellites, lat, lng, speed, course/status, LBS | none | yes |
| 0x22 | Location (GT06N): as 0x12 plus ACC, upload mode, re-upload flag, mileage | none | **no, dropped** |
| 0x13 | Heartbeat: terminal info, voltage level, GSM level, alarm/language | ack | yes |
| 0x16 | Alarm: GPS, LBS length, LBS, status | ack | yes |
| 0x26 | Alarm (GT06N): as 0x16 | ack | **no, dropped** |
| others | (0x15 string, 0x1A address, 0x8A time...) | none | logged once per connection |

The ack is the same protocol and serial with no content (`78 78 05 <protocol> <serial> <crc> 0D 0A`),
as in EDR.

Decoding details, each tested:

- **Position.** `raw / 1 800 000` degrees. Course/status bit 10 is north (else south), bit 11 is
  west (else east) and bit 12 is "positioned". The course is the low 10 bits; speed is km/h.
- **Time.** The date is the tracker's GPS clock, read as UTC, as EDR does.
  `deviceUtcOffsetMinutes` is for a unit set to local time. A month of 13 or a 31 February is
  malformed.
- **Alarm without a fix.** An SOS sent before the first fix can carry an all-zero GPS block.
  The alarm is kept with `gps: null`; only its position is dropped.
- **Malformed.** Content too short for its protocol, a terminal id that is not digits, or a
  date that is not a date gives `"malformed"` and counts toward `maxBadFrames`. It never throws.

## 3. Connections

`Gt06TcpServer` applies these, in order:

1. **Source.** `allowedSources` (IPs and CIDR ranges, IPv4 and IPv6). An IPv4 client on a
   dual-stack socket is matched as IPv4. Refused: `SOURCE_NOT_ALLOWED`.
2. **Caps.** `maxConnections` overall, `maxConnectionsPerIp` per remote IP. Refused:
   `TOO_MANY_CONNECTIONS`. The per-IP cap defaults to off, because carrier NAT puts many
   trackers behind one address.
3. **Login first.** Nothing counts before a login, and nothing is acked; EDR acked heartbeats.
   No login within `loginTimeoutMs` (30 s) gives `LOGIN_TIMEOUT`.
4. **Known device.** `findDevice` null gives `UNKNOWN_DEVICE`. If it throws, the result is
   `HOST_ERROR` and the connection is closed without an ack, so the tracker logs in again.
5. **One IMEI per connection.** A second login with another IMEI gives `IMEI_CHANGED` and the
   connection is closed. EDR switched the session over to it. The same IMEI again is re-acked.
6. **A newer connection wins.** When an IMEI logs in on a new connection, its older one is closed
   (`REPLACED`). A tracker that reconnects after a NAT drop leaves a half-open socket behind;
   EDR kept both. The cost: someone who knows the IMEI can knock the real tracker off by
   logging in. Section 7.
7. **Bad frames.** Bad CRCs, garbage runs and malformed packets above `maxBadFrames` give
   `TOO_MANY_BAD_FRAMES`.
8. **Rate.** Frames above `maxPacketsPerMinute` are dropped; twice that gives `RATE_LIMITED`.
9. **Backpressure.** Packets run one at a time per connection, in arrival order (EDR's rule).
   When `maxPendingPackets` are waiting for the host, the socket is paused until half have
   gone. EDR's queue had no limit.
10. **Idle.** Silent for `idleTimeoutMs` (10 min, as EDR) gives `IDLE`.
11. **Shutdown.** `close()` stops accepting and closes every connection. It waits up to `drainMs`
    for what was queued; EDR dropped it.

Every refusal calls `onRejected` with the reason, the remote address and the IMEI, if one was
sent. Packets already queued on a connection that is replaced, idle or shut down are still
stored. Those on a rejected connection are not.

## 4. Positions

For each location (and each alarm's fix), `GpsIngestService`:

1. **Checks it** (`checkFix`), dropping:
   - no satellite lock (`NO_FIX`, unless `storeUnpositioned`; EDR stored them at 0,0);
   - 0,0 or out of range (`IMPOSSIBLE_COORDINATES`);
   - more than `maxFutureSkewMinutes` ahead (`FUTURE`; EDR applied this to the live fix only and
     still stored the fix);
   - older than `maxFixAgeMinutes` (`TOO_OLD`; EDR had no limit).
2. **Drops a duplicate**: a fix time already taken for this device, in memory, the last 256 per
   device. Your unique key is the real guard; a second instance or a restart relies on it.
3. **Checks for a jump.** It compares the fix with the last trusted one. If the implied speed
   is above `maxImpliedSpeedKmh` (300), the fix is stored with `suspect: true` and
   `impliedSpeedKmh`. Three suspect fixes in a row that agree with each other mean the old
   anchor was the bad one, so the newest becomes the anchor. `GpsDevice.lastFix` seeds this
   after a restart.
4. **Marks replays.** A fix is a replay when the 0x22 re-upload flag says so, or when it is
   older than one already taken.
5. **Calls `savePositions` once per TCP read**, with all the read's fixes and `latest`: the
   newest positioned, non-suspect one. If it throws, the fixes are forgotten so their resend
   gets through.

`markSeen` runs at most once per `seenThrottleMs` per device, for any valid packet, including
a dropped no-fix location. EDR wrote `last_seen_at` on every packet, with three writes per fix.

## 5. Alarms and status

An alarm is handled in this order:

1. its fix is stored (as `source: "ALARM"`);
2. `onAlarm` runs, with the alarm type, the code, the status and the stored position;
3. `onStatus` runs;
4. the alarm is acked.

If the tracker resends it (the ack was lost), the fix is a duplicate and `onAlarm` is **not**
called again. If the first `onAlarm` threw, it is called on the resend. Alarm types:
`SOS`, `POWER_CUT`, `SHOCK`, `FENCE_IN`, `FENCE_OUT`, `NORMAL`, `UNKNOWN` (from the alarm byte).
`Gt06Status` decodes the terminal-information bits:

- relay cut, GPS tracking, the terminal alarm (SOS, low battery, power cut, shock);
- charging, ACC (ignition), defense;
- the voltage level (0-6) and the GSM level (0-4).

## 6. Your side: the host

| Method | Rule |
| --- | --- |
| `findDevice(imei)` | Registered and not deleted, or null. **Never insert here.** Return `vehicleId` (copied onto positions) and the live fix as `lastFix`. |
| `savePositions(batch)` | One transaction: insert with `ON CONFLICT (device_id, fix_time) DO NOTHING`, then `UPDATE devices SET last_* = latest WHERE id = :id AND (last_fix_at IS NULL OR last_fix_at <= :fixTime)`. Keep `suspect` rows out of maps, trails and alerts. |
| `markSeen` | `last_seen_at = GREATEST(last_seen_at, :seenAt)`: OFFLINE reads it. |
| `onStatus`, `onAlarm` | Store; a throw means no ack and a resend. |
| `onConnect`, `onDisconnect` | Optional state. On `REPLACED` the tracker is already back on a new connection. |
| `onRejected` | Audit, or a security alert when `UNKNOWN_DEVICE` or `IMEI_CHANGED` repeat. Its errors are swallowed. |
| Alert methods | Section 8. |

[examples/standalone/typeorm-gps.host.ts](../examples/standalone/typeorm-gps.host.ts) does all
of it on Postgres.

## 7. Security

GT06 has no authentication, encryption or signature. A connection proves only that it knows an
IMEI, and IMEIs are printed on the unit and on its box. So:

- **Network.** Do not publish the port to the internet. Put it behind:
  - a firewall that admits only the SIM provider's APN address pool;
  - or, better, the provider's private APN with a VPN to your network.

  Set `allowedSources` to the same ranges as a second layer.
- **Registered devices only** (default, the host decides). This alone stops device and history
  flooding.
- **Jump detection** (default 300 km/h) keeps a spoofed position from becoming the live fix or
  feeding alerts. A spoofer who sends believable positions near the real truck still gets
  through: only the network stops that.
- **Rate, bad-frame and connection limits** (defaults on) cap what one connection can cost.
- **Logs mask the IMEI** (`3590*******0001`), since knowing it is all a spoofer needs.
  `logFullImei: true` turns that off. EDR logged full IMEIs.
- **Watch `onRejected`.** Repeated `UNKNOWN_DEVICE`, `IMEI_CHANGED` or `REPLACED` for one IMEI
  from different addresses means someone is trying.

## 8. Alerts

`GpsAlertService.scan(now)` runs every `alerts.scanEveryMs` (EDR: a cron every minute),
one at a time per process:

1. **Load.** `loadAlertInputs({ now, resolvedSince })` returns:
   - thresholds;
   - active geofences;
   - one snapshot per vehicle with a tracker: on a trip or not, last seen, the live fix, and the
     trusted fixes of the idle window;
   - open alerts;
   - alerts resolved within the cooldown.
2. **Evaluate.** `evaluateVehicle` applies EDR's rules:

   | Kind | Raised when |
   | --- | --- |
   | `OFFLINE` | On a trip and silent longer than `offlineMinutes` (15). |
   | `OVERSPEED` | The live fix's speed is above `overspeedKmh` (80), on or off a trip. |
   | `IDLE` | On a trip and below 3 km/h for the whole `idleMinutes` (30), proven by a stopped fix at or before the window start. |
   | `GEOFENCE` | On a trip, and inside a `KEEP_OUT` circle or outside a `KEEP_IN` one. Each fence is its own alert. |

   A silent tracker's last fix raises nothing but OFFLINE. **New:** OVERSPEED and GEOFENCE also
   need the live fix itself to be fresh (`alerts.fixMaxAgeMinutes`, default `offlineMinutes`).
3. **Plan.** `planGpsAlerts` opens, touches (keeping the worst speed) and resolves. **New:**
   - an alert is resolved only after its condition has been gone `resolveAfterMinutes`
     (default 0, as EDR);
   - a condition back within `cooldownMinutes` (default 15) of being resolved opens a new alert
     without notifying.
4. **Apply.** `openAlert` returns null when another instance opened it first, through the
   partial unique index on open alerts, as in EDR. The pg-spec shows that without the index two
   scans open two alerts. `notifyAlert` gets a ready title and body worded as EDR's; its errors
   are logged, not retried.

Keep the alert API (settings, geofences, list) in your app, as EDR's freight API does. The
package holds the rules, not the screens.

## 9. Options and environment

| Option | EDR env | Default | Notes |
| --- | --- | --- | --- |
| `listen` | | true | false: no listener (an API process that only reads) |
| `port` | `GT06_TCP_PORT` | 5023 | 0: any free port (tests) |
| `bindAddress` | `GT06_TCP_HOST` | 0.0.0.0 | an IP; behind a firewall (section 7) |
| `allowedSources` | (new) `GT06_ALLOWED_SOURCES` in the example | any | IPs and CIDRs |
| `maxConnections` | | 10000 | |
| `maxConnectionsPerIp` | | 0 (off) | carrier NAT |
| `idleTimeoutMs` | | 600000 | EDR's 10 minutes |
| `loginTimeoutMs` | | 30000 | new |
| `maxFrameBytes` | | 1024 | a short frame is at most 260 bytes |
| `maxBadFrames` | | 10 | new |
| `maxPacketsPerMinute` | | 240 | per connection; covers a burst of buffered replays |
| `maxPendingPackets` | | 500 | backpressure |
| `deviceUtcOffsetMinutes` | | 0 | GT06 sends UTC |
| `storeUnpositioned` | | false | EDR: true (flagged) |
| `maxFutureSkewMinutes` | | 5 | EDR's live-fix guard, now for every fix |
| `maxFixAgeMinutes` | | 10080 | 7 days of replay |
| `maxImpliedSpeedKmh` | | 300 | 0 turns jump detection off |
| `seenThrottleMs` | | 30000 | |
| `logFullImei` | | false | |
| `alerts.enabled` | | true | needs the four alert methods |
| `alerts.scanEveryMs` | | 60000 | 0: only when you call `scan()` |
| `alerts.resolveAfterMinutes` | | 0 | |
| `alerts.cooldownMinutes` | | 15 | 0: as EDR |
| `alerts.fixMaxAgeMinutes` | | offlineMinutes | |
| `alerts.defaultThresholds` | (DB row in EDR) | 80 / 30 / 15 | when the host returns none |

`resolveGpsOptions` refuses out-of-range values at start-up and names them, never their
values. A bad `allowedSources` entry is named by its position.

## 10. Errors

`GpsError` kinds:

- `CONFIG`: options, or a listener without a host;
- `INVALID`: bad input from your own code;
- `LISTEN`: the port could not be bound, with `details.code` such as `EADDRINUSE` or `EACCES`;
- `HOST`: kept for callers that wrap host errors.

Errors from the host during packet handling are logged, and the packet is not acked.

## 11. Deployment

- **Layer 4 only.** GT06 is raw TCP with no Host header and no SNI, so HTTP proxies and ALBs
  cannot route it. Use an L4 load balancer (an AWS NLB) or Nginx `stream`:

  ```nginx
  stream {
    upstream gt06 { server 127.0.0.1:5023; }
    server {
      listen 5023;
      allow 10.20.0.0/16;   # the APN pool
      deny all;
      proxy_pass gt06;
      proxy_timeout 15m;    # longer than idleTimeoutMs
    }
  }
  ```

  Behind such a proxy every connection comes from the proxy's address. Do the source filtering
  in the proxy, and leave `maxConnectionsPerIp` at 0. Use the PROXY protocol only if you also
  parse it; this package does not.
- **Ports.** A non-root process cannot bind below 1024. Map the host port to 5023 in the
  container, as EDR's compose file does.
- **Replicas.** Each tracker holds one long connection, so N replicas behind an L4 balancer work.
  Duplicates across replicas are stopped by your unique key, and alerts by the partial unique
  index. Run the alert scan in one place or in all; both are safe.
- **Shutdown.** Call `app.enableShutdownHooks()` so `close()` drains the queues.

## 12. What was verified, and what was not

Verified here:

- **Unit tests** (codec, rules, validation, ingest, module, and a real TCP listener on
  127.0.0.1): the sheet's login, ack and location vectors; a table-driven CRC written apart from
  the decoder; every short frame of every handled protocol decoding without a throw.
- **Postgres tests** (postgres:16) on the standalone example over real TCP: the list in the
  README's Tests section, and the open-alert index shown necessary by removing it.
- **EDR's crash**: EDR's own codec run under its listener pattern, exit code 1. EDR's parser
  losing a real frame inside a false one's claim: reproduced.

Not verified: no real tracker was connected.

- **0x22 and 0x26 layouts**: from the public Concox GT06N sheet, not from a captured frame.
  Check one from your units.
- **The time base.** UTC is assumed, as EDR assumed it. Some units can be set to local time
  (`GMT,E,3#`); check one fix against a known time.
- **The LBS length byte** in alarms counts itself (9). EDR assumed so too.
- **Alarm codes beyond 0x00-0x05** (Concox adds overspeed, displacement, low battery and
  more): reported as `UNKNOWN` with the raw `alarmCode`.
- **Whether your firmware wants a reply to 0x8A time requests** or 0x80 commands: not sent.
- **That trackers resend an alarm after a missing ack**, and how often.

## 13. Going-live checklist

- [ ] The port is reachable only from the APN pool or VPN (test from outside: refused).
- [ ] `allowedSources` matches the same ranges.
- [ ] Every tracker's IMEI is registered; `onRejected` shows no `UNKNOWN_DEVICE` from your fleet.
- [ ] The positions table has a unique (device, fix time) key; the live-fix update moves only forward.
- [ ] One captured 0x12 (and 0x22, if your units send it) decodes to the position shown on the unit's own app or SMS reply.
- [ ] Fix times match the wall clock (UTC).
- [ ] An SOS from a test unit lands in `onAlarm` once, and is acked.
- [ ] `maxPacketsPerMinute` covers your units' replay burst after a coverage gap.
- [ ] Alerts: thresholds set, one geofence tested, notifications reach a person, the cooldown fits.
- [ ] Shutdown hooks are on; a deploy does not lose queued fixes.
- [ ] Logs do not carry full IMEIs, unless you chose `logFullImei`.

## 14. Moving EDR onto this package

### What is wrong in EDR today (origin/dev 4e43da58b)

Tracker service, `apps/edr-gps-tracker`:

1. **Remote crash.** In `gt06.codec.ts`, `decodeFrame`, `decodeGps`, `decodeLbs` and
   `decodeStatus` read at fixed offsets with no length check. `Gt06Server.onData` calls
   `parseStream` synchronously in the `data` listener, so a `RangeError` is uncaught and the
   process exits.
   - Reproduced with frame `7878 07 12 0000 0001 <crc> 0D0A`.
   - A 30-byte alarm does the same.
   - No login is needed.
2. **Auto-registration.** In `gps-ingest.service.ts`, `ensureDevice` inserts any unknown IMEI;
   the freight API README calls this a feature ("no manual step"). With 1, any client can:
   - create devices and history;
   - pose as a real tracker.
3. **IMEI not validated.** `decodeImei` keeps hex as is, so a 3-byte login decodes from the
   serial and CRC bytes into an "IMEI" like `000000001473e0d`, which is then auto-registered.
4. **One connection, many IMEIs.** In `gt06.server.ts`, `handle` sets `session.imei` on every
   login, so a connection can switch IMEIs.
5. **No exposure limits.**
   - docker-compose publishes `${GT06_TCP_PORT:-5023}:5023` on every host interface.
   - The listener has no source allow list, no connection cap, no login deadline (only the
     10-minute idle timeout), no rate or bad-frame limit, and no queue limit.
   - The freight API README's Nginx `stream` example (`infrastructure/nginx/gps-stream.conf`)
     is not in the repo.
6. **0x22 and 0x26 dropped.** Locations and alarms from GT06N and newer firmware are logged
   "unsupported" once per connection and discarded; EDR's README says so.
7. **A bad CRC loses the next frame.** `parseStream` skips a CRC-failed frame by its claimed
   length, so a real frame starting inside a false claim is lost (reproduced).
8. **Duplicates.** `freight.gps_positions` has no unique key on (device_id, gps_time), only an
   index. A resent alarm or fix is stored again.
9. **History without limits.** No-fix packets are stored at 0,0 (flagged). A fix far in the
   future is kept in history; only the live fix is guarded. There is no age limit for replays.
10. **Write load.** `handleFix` does three statements per fix: device update, live-fix update and
    position insert. Every packet writes `last_seen_at`.
11. **Full IMEIs in logs**: "Auto-registering", "Ignoring GPS tracker", "Closing idle".
12. **Shutdown drops queued packets.** `onModuleDestroy` destroys sockets without waiting.
13. **Heartbeats are acked before a login**, which keeps unidentified connections alive.

Alerts, freight API `modules/gps-tracking/gps-alerts.*`:

14. **Stale-fix alerts.** `evaluateDevice` judges "live" by `lastSeenAt` (any packet).
    OVERSPEED and GEOFENCE then use `lastSpeed` and `lastLat/lastLng` of a fix that may be hours
    old.
15. **Flapping.** `reconcile` resolves at the first scan without the condition and reopens at the
    next, with a new notification each time. There is no cooldown or hysteresis.
16. **Spikes and spoofs feed the alerts**: there is no jump check, so one bad fix sets the live
    position.

### Steps

1. **Tracker service.** Replace `GpsModule`, `GpsIngestService` and `Gt06Server` in
   `apps/edr-gps-tracker` with `GpsModule.forRoot` and an EDR host
   ([examples/edr/edr-gps-host.ts](../examples/edr/edr-gps-host.ts)) on the same `freight` tables.
   Keep `GT06_TCP_PORT` and `GT06_TCP_HOST`.
2. **Migration** (freight API owns the schema):
   - Delete duplicate positions, keeping the earliest id per (device_id, gps_time).
   - Add `UNIQUE (device_id, gps_time)`, and `suspect boolean NOT NULL DEFAULT false`,
     `implied_speed_kmh int`, `replay boolean NOT NULL DEFAULT false` to `freight.gps_positions`.
3. **Register before switching.** Every IMEI that EDR auto-registered and that belongs to the
   fleet must have a row with a vehicle. Review the rest (unknown IMEIs, hex IMEIs) and delete
   them.
4. **Close the port.** Bind compose's publish to the interface the L4 proxy or VPN uses (for
   example `"10.0.0.5:5023:5023"`) and filter sources there. Set `GT06_ALLOWED_SOURCES`.
5. **Alerts.**
   - Move `GpsAlertsService.scan` onto `GpsAlertService`, with the freight API host methods
     reading the same queries.
   - Keep the controller, settings and geofence CRUD as they are.
   - Notifications go through `notifyAlert` to the notification inbox, as now.
6. **Readers.** In `GpsTrackingService.history` and the live map, filter `AND NOT suspect`.
7. **Logs.** Rely on the masked IMEIs; grep for `UNKNOWN_DEVICE` in `onRejected`'s output instead of
   "Auto-registering".
