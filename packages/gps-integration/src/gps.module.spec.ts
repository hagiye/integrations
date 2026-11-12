import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FakeGpsHost } from "../test/fakes";
import * as dev from "../test/gt06-device";
import { GpsAlertService } from "./gps.alerts.service";
import { GPS_HOST } from "./gps.host";
import { GpsListener, GpsModule } from "./gps.module";
import { GPS_OPTIONS, ResolvedGpsOptions } from "./gps.options";

@Injectable()
class TestHost extends FakeGpsHost {
  constructor() {
    super();
    this.register("359000000000001");
  }
}

describe("GpsModule", () => {
  it("opens the listener at bootstrap and closes it with the app", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GpsModule.forRoot({ options: { port: 0, bindAddress: "127.0.0.1", alerts: { scanEveryMs: 0 } }, host: TestHost })],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const port = app.get(GpsListener).address()?.port as number;
    expect(port).toBeGreaterThan(0);

    const t = await dev.SimTracker.connect(port);
    t.send(dev.login("359000000000001", 1));
    expect(await t.waitAck(0x01, 1)).toBe(true);
    const host = app.get<TestHost>(GPS_HOST);
    expect(host.connects).toHaveLength(1);

    await app.close();
    expect(await t.waitClosed()).toBe(true);
    expect(app.get(GpsListener).address()).toBeNull();
  });

  it("builds the options with forRootAsync", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GpsModule.forRootAsync({
          useFactory: async () => ({ listen: false, maxImpliedSpeedKmh: 200 }),
          host: TestHost,
        }),
      ],
    }).compile();
    const options = moduleRef.get<ResolvedGpsOptions>(GPS_OPTIONS);
    expect(options.maxImpliedSpeedKmh).toBe(200);
    expect(moduleRef.get(GpsAlertService).active).toBe(true);
    expect(moduleRef.get(GpsListener).address()).toBeNull();
  });

  it("refuses a listener without a host, in forRoot and forRootAsync", async () => {
    expect(() => GpsModule.forRoot({ options: { port: 0 } })).toThrow(/needs a host/);
    await expect(
      Test.createTestingModule({ imports: [GpsModule.forRootAsync({ useFactory: () => ({ port: 0 }) })] }).compile(),
    ).rejects.toThrow(/needs a host/);
  });

  it("gives only the options without a host and listen: false", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GpsModule.forRoot({ options: { listen: false } })] }).compile();
    expect(moduleRef.get<ResolvedGpsOptions>(GPS_OPTIONS).listen).toBe(false);
    expect(() => moduleRef.get(GpsListener)).toThrow();
  });

  it("rejects options out of range when the module is built", () => {
    expect(() => GpsModule.forRoot({ options: { listen: false, port: -1 } })).toThrow(/port/);
  });
});
