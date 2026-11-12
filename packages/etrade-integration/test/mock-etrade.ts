import * as http from "node:http";
import * as https from "node:https";
import { AddressInfo, Socket } from "node:net";

/**
 * A stand-in for e-trade's two calls on 127.0.0.1, for tests. Written separately from src on
 * purpose (paths, Referer, shapes), so a request the package builds wrong fails here.
 *
 * Shapes follow EDR's e2e mock (e2e/freight/etrade-mock/server.js) and the types in
 * packages/types/src/freight/etrade.ts. The 417 without the checker Referer is what EDR's back
 * office reports from the real service. All TINs and licence numbers are fictitious.
 */

const CHECKER_REFERER = "https://etrade.gov.et/business-license-checker";

export interface MockLicence {
  licenceNumber: string;
  tradeName?: string;
  /** S1 TradesName; defaults to tradeName. */
  listTradeName?: string;
  status?: number | null;
  statusDescription?: string;
  /** M/D/YYYY. */
  renewedTo?: string;
  cancellationDate?: string | null;
  region?: string | null;
  zone?: string;
  subGroups?: Array<{ Code: number; Description: string | null } | null> | null;
  managerName?: string;
  managerPhone?: string | null;
  mobilePhone?: string;
  regularPhone?: string;
  /** Listed in S1 but S2 answers 404 for it. */
  noDetail?: boolean;
}

export interface MockCompany {
  tin: string;
  businessName: string;
  licences: MockLicence[];
}

export interface MockCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  /** "registration" or "licence" or "other". */
  call: "registration" | "licence" | "other";
}

export interface MockBehaviour {
  /** Calls that get no answer at all. */
  hang: Set<"registration" | "licence">;
  /** The next N calls (of any kind) answer this HTTP status with an empty body. */
  failNext: { status: number; count: number; headers?: Record<string, string> } | null;
  /** Answer calls with a plain-text body. */
  notJson: boolean;
  /** How an unknown TIN is answered. Default "404". */
  unknownTin: "404" | "empty" | "empty-object" | "null";
  /** S1 answers with this Tin instead of the asked one. */
  tinOverride?: string;
  /** S2 answers with this OwnerTIN. */
  ownerTinOverride?: string;
  /** S2 answers with this LicenceNumber. */
  licenceOverride?: string;
  /** Answer with a body this many bytes long. */
  hugeBody?: number;
  /** Wait this long before answering. */
  delayMs: number;
  /** Extra wait before answering the licence call for these licence numbers. */
  licenceDelayMs: Record<string, number>;
  /** Refuse requests without the checker page's Referer, as e-trade does. Default true. */
  requireReferer: boolean;
}

const freshBehaviour = (): MockBehaviour => ({
  hang: new Set(),
  failNext: null,
  notJson: false,
  unknownTin: "404",
  delayMs: 0,
  licenceDelayMs: {},
  requireReferer: true,
});

export class MockEtrade {
  readonly companies = new Map<string, MockCompany>();
  readonly calls: MockCall[] = [];
  behaviour: MockBehaviour = freshBehaviour();
  private server?: http.Server | https.Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  constructor(private readonly tls?: { key: string; cert: string }) {}

  get baseUrl(): string {
    return `${this.tls ? "https" : "http"}://127.0.0.1:${this.port}/api`;
  }

  async start(): Promise<void> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handle(req, res);
    this.server = this.tls ? https.createServer({ key: this.tls.key, cert: this.tls.cert }, handler) : http.createServer(handler);
    this.server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.on("secureConnection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  reset(): void {
    this.companies.clear();
    this.calls.length = 0;
    this.behaviour = freshBehaviour();
  }

  addCompany(company: MockCompany): MockCompany {
    this.companies.set(company.tin, company);
    return company;
  }

  /** Calls of one kind received so far. */
  count(call: MockCall["call"]): number {
    return this.calls.filter((c) => c.call === call).length;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const reg = /^\/api\/Registration\/GetRegistrationInfoByTin\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const call: MockCall["call"] = reg ? "registration" : url.pathname === "/api/BusinessMain/GetBusinessByLicenseNo" ? "licence" : "other";
    this.calls.push({
      method: req.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      call,
    });
    if (call !== "other" && this.behaviour.hang.has(call)) return; // never answers
    if (this.behaviour.delayMs) await new Promise((r) => setTimeout(r, this.behaviour.delayMs));
    const licenceDelay = call === "licence" ? this.behaviour.licenceDelayMs[url.searchParams.get("LicenseNo") ?? ""] : 0;
    if (licenceDelay) await new Promise((r) => setTimeout(r, licenceDelay));
    if (req.method !== "GET" || call === "other") return void res.writeHead(404).end();
    if (this.behaviour.requireReferer && req.headers.referer !== CHECKER_REFERER) {
      return void res.writeHead(417, { "content-type": "text/plain" }).end("Expectation Failed");
    }
    const failure = this.behaviour.failNext;
    if (failure && failure.count > 0) {
      failure.count--;
      return void res.writeHead(failure.status, failure.headers ?? {}).end();
    }
    if (this.behaviour.notJson) return void res.writeHead(200, { "content-type": "text/html" }).end("<html>maintenance</html>");
    if (this.behaviour.hugeBody) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(`{"x":"${"a".repeat(this.behaviour.hugeBody)}"}`);
    }
    if (call === "registration") return this.registration(decodeURIComponent(reg![1]), res);
    return this.licence(url.searchParams.get("LicenseNo") ?? "", url.searchParams.get("Tin") ?? "", res);
  }

  private registration(tin: string, res: http.ServerResponse): void {
    const company = this.companies.get(tin);
    if (!company) {
      const how = this.behaviour.unknownTin;
      if (how === "404") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(how === "empty" ? "" : how === "null" ? "null" : "{}");
    }
    json(res, {
      Tin: this.behaviour.tinOverride ?? company.tin,
      LegalCondtion: "Private Limited Company",
      RegNo: "REG-TEST-0001",
      RegDate: "2020-01-01",
      BusinessName: company.businessName,
      BusinessNameAmh: "ሙከራ",
      PaidUpCapital: 100000,
      AssociateShortInfos: [],
      Businesses: company.licences.map((l, i) => ({
        MainGuid: `guid-${i}`,
        OwnerTIN: company.tin,
        DateRegistered: "1/1/2020",
        TradeNameAmh: "ሙከራ",
        TradesName: l.listTradeName ?? l.tradeName ?? company.businessName,
        LicenceNumber: l.licenceNumber,
        RenewalDate: "7/8/2025",
        RenewedFrom: "7/8/2025",
        RenewedTo: l.renewedTo ?? "7/7/2099",
        BusinessLicensingGroupMain: null,
        SubGroups: l.subGroups === undefined ? [{ Code: 72131, Description: "(72131)Freight Forwarders" }] : l.subGroups,
      })),
    });
  }

  private licence(licenceNumber: string, tin: string, res: http.ServerResponse): void {
    const company = this.companies.get(tin);
    const licence = company?.licences.find((l) => l.licenceNumber === licenceNumber);
    if (!company || !licence || licence.noDetail) return void res.writeHead(404).end();
    const renewedTo = licence.renewedTo ?? "7/7/2099";
    const [m, d, y] = renewedTo.split("/");
    json(res, {
      MainGuid: "guid",
      OwnerTIN: this.behaviour.ownerTinOverride ?? company.tin,
      DateRegistered: "1/1/2020",
      TradeName: licence.tradeName ?? company.businessName,
      LicenceNumber: this.behaviour.licenceOverride ?? licence.licenceNumber,
      Status: licence.status === undefined ? 1 : licence.status,
      StatusDescription: licence.statusDescription ?? "Active",
      Capital: 100000,
      AssociateShortInfos: [
        {
          Position: "Manager",
          ManagerName: "አበበ በቀለ",
          ManagerNameEng: licence.managerName ?? "Abebe Bekele",
          Photo: "BASE64-PHOTO-MUST-NOT-LEAK",
          MobilePhone: "52543000",
          RegularPhone: licence.managerPhone === undefined ? "0911223344" : licence.managerPhone,
        },
      ],
      AddressInfo: {
        Region: licence.region === undefined ? "ADDIS ABABA" : licence.region,
        Zone: licence.zone ?? "Zone 1",
        Woreda: "Woreda 1",
        Kebele: "01",
        HouseNo: "123",
        MobilePhone: licence.mobilePhone ?? "09        ",
        RegularPhone: licence.regularPhone ?? "",
      },
      RenewedTo: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00`,
      RenewedToDateString: renewedTo,
      RenewalDate: "7/8/2025",
      RenewedFrom: "7/8/2025",
      CancellationDate: licence.cancellationDate ?? null,
    });
  }
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** A company with two licences under one TIN, like EDR's selection spec (fictitious). */
export function twoLicenceCompany(tin = "0000000001"): MockCompany {
  return {
    tin,
    businessName: "TEST LOGISTICS AND TRADING P L C",
    licences: [
      {
        licenceNumber: "XX/AA/14/670/0000001/2017",
        tradeName: "Test Minerals Export",
        subGroups: [null, { Code: 66331, Description: "Export trade in minerals" }, { Code: 1, Description: null }],
      },
      {
        licenceNumber: "XX/AA/14/670/0000002/2007",
        tradeName: "Test Freight Forwarding",
        subGroups: [{ Code: 72131, Description: "(72131)Freight Forwarders" }],
      },
    ],
  };
}
