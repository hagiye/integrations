import { Inject, Injectable, Logger } from "@nestjs/common";
import * as https from "node:https";
import { EtradeError, isRetryable, isTlsCode } from "./etrade.errors";
import { TextResponse, getText } from "./etrade.http";
import {
  isValidLicenceNumber,
  isValidTin,
  maskTin,
  normalizeLicence,
  normalizeRegistration,
} from "./etrade.normalize";
import { ETRADE_OPTIONS, ResolvedEtradeOptions, missingEtradeOptions } from "./etrade.options";
import { createEtradeAgent, isEtradeProductionHost } from "./etrade.tls";
import type {
  EtradeLanguage,
  EtradeLicenceLookup,
  EtradeRawBusiness,
  EtradeRawRegistration,
  EtradeRegistrationLookup,
} from "./etrade.types";

/** What a call came back with, plus how it went (for a lookup log). */
export type EtradeCallResult<T> = T & { httpStatus: number; attempts: number };

export interface EtradeCallOptions {
  /** Default options.language. */
  language?: EtradeLanguage;
}

/**
 * Calls e-trade: the registration by TIN and the licence by number, with the same paths,
 * query parameters and Referer as EDR's ETradeService, and with TLS verified.
 *
 * Every TIN must be 10 digits and is sent only after that check. Answers are normalised; the
 * manager's photo and the capital figures are dropped. Usable without Nest:
 * `new EtradeClient(resolveEtradeOptions({...}))`.
 */
@Injectable()
export class EtradeClient {
  private readonly logger = new Logger("EtradeClient");
  private readonly httpsAgent: https.Agent;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(@Inject(ETRADE_OPTIONS) private readonly options: ResolvedEtradeOptions) {
    if (options.insecureTls) {
      let host = "";
      try {
        host = new URL(options.baseUrl).hostname;
      } catch {
        // An unreadable baseUrl fails on the first call.
      }
      if (isEtradeProductionHost(host)) {
        throw new EtradeError(
          "CONFIG",
          `insecureTls is refused for ${host}: TLS is verified with the bundled issuing CA instead (guide, section TLS)`,
        );
      }
      this.logger.warn("insecureTls is on: TLS verification is off for e-trade calls. Local test servers only.");
    }
    this.httpsAgent = createEtradeAgent(options);
    const missing = missingEtradeOptions(options);
    if (missing.length) {
      this.logger.warn(`e-trade is not configured (missing ${missing.join(", ")}); calls will fail until it is.`);
    }
  }

  isConfigured(): boolean {
    return missingEtradeOptions(this.options).length === 0;
  }

  /** The registration and every licence under a TIN (EDR's getCompanyInfoByTin). */
  async getRegistrationByTin(tin: string, call: EtradeCallOptions = {}): Promise<EtradeCallResult<EtradeRegistrationLookup>> {
    this.assertTin(tin);
    const language = call.language ?? this.options.language;
    const url = `${this.options.baseUrl}/Registration/GetRegistrationInfoByTin/${encodeURIComponent(tin)}/${language}`;
    const { response, attempts } = await this.send(url, tin);
    const body = this.readBody(response, "GetRegistrationInfoByTin");
    if (body === NOT_FOUND) return { found: false, httpStatus: response.status, attempts };
    const raw = body as EtradeRawRegistration;
    const answeredTin = typeof raw.Tin === "string" ? raw.Tin.trim() : "";
    const name = typeof raw.BusinessName === "string" ? raw.BusinessName.trim() : "";
    // An object with neither a TIN nor a name is e-trade's way of saying "no such TIN".
    if (!answeredTin && !name) return { found: false, httpStatus: response.status, attempts };
    if (answeredTin && answeredTin !== tin) {
      throw new EtradeError("API", "e-trade answered for another TIN", { status: response.status, code: "TIN_MISMATCH" });
    }
    return { found: true, registration: normalizeRegistration(raw, tin), httpStatus: response.status, attempts };
  }

  /** One licence's detail: status, dates, address, manager (EDR's getBusinessByLicenseNo). */
  async getBusinessByLicence(
    licenceNumber: string,
    tin: string,
    call: EtradeCallOptions = {},
  ): Promise<EtradeCallResult<EtradeLicenceLookup>> {
    this.assertTin(tin);
    if (!isValidLicenceNumber(licenceNumber)) {
      throw new EtradeError("INVALID", "licenceNumber must be 1 to 120 characters without control characters");
    }
    const wanted = licenceNumber.trim();
    const query = new URLSearchParams({ LicenseNo: wanted, Tin: tin, Lang: call.language ?? this.options.language });
    const url = `${this.options.baseUrl}/BusinessMain/GetBusinessByLicenseNo?${query.toString()}`;
    const { response, attempts } = await this.send(url, tin);
    const body = this.readBody(response, "GetBusinessByLicenseNo");
    if (body === NOT_FOUND) return { found: false, httpStatus: response.status, attempts };
    const raw = body as EtradeRawBusiness;
    const answeredLicence = typeof raw.LicenceNumber === "string" ? raw.LicenceNumber.trim() : "";
    const owner = typeof raw.OwnerTIN === "string" ? raw.OwnerTIN.trim() : "";
    const tradeName = typeof raw.TradeName === "string" ? raw.TradeName.trim() : "";
    if (!answeredLicence && !owner && !tradeName) return { found: false, httpStatus: response.status, attempts };
    if (owner && owner !== tin) {
      throw new EtradeError("API", "e-trade answered with a licence held under another TIN", {
        status: response.status,
        code: "TIN_MISMATCH",
      });
    }
    if (answeredLicence && answeredLicence !== wanted) {
      throw new EtradeError("API", "e-trade answered for another licence number", {
        status: response.status,
        code: "LICENCE_MISMATCH",
      });
    }
    const licence = normalizeLicence(raw, this.options.regionAliases);
    return {
      found: true,
      licence: { ...licence, licenceNumber: licence.licenceNumber || wanted },
      httpStatus: response.status,
      attempts,
    };
  }

  /** True while repeated failures keep calls from being sent. */
  isCircuitOpen(now = Date.now()): boolean {
    return this.openUntil > now;
  }

  private assertTin(tin: string): void {
    if (!this.isConfigured()) {
      throw new EtradeError("CONFIG", `e-trade is not configured (missing ${missingEtradeOptions(this.options).join(", ")})`);
    }
    if (!isValidTin(tin)) throw new EtradeError("INVALID", "TIN must be exactly 10 digits");
  }

  private headers(): Record<string, string> {
    return { ...this.options.headers, ...(this.options.referer ? { Referer: this.options.referer } : {}) };
  }

  /** One GET with retries for failures worth retrying, behind the circuit breaker. */
  private async send(url: string, tin: string): Promise<{ response: TextResponse; attempts: number }> {
    if (this.options.circuitFailures > 0 && this.isCircuitOpen()) {
      throw new EtradeError("NETWORK", "e-trade calls are paused after repeated failures", { code: "CIRCUIT_OPEN", attempts: 0 });
    }
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const response = await getText(url, this.headers(), { timeoutMs: this.options.httpTimeoutMs, httpsAgent: this.httpsAgent });
        if (response.status >= 500 && attempts <= this.options.maxRetries) {
          await sleep(this.options.retryDelayMs);
          continue;
        }
        if (response.status >= 500) this.failed(url, tin, `HTTP ${response.status}`);
        else this.consecutiveFailures = 0;
        return { response, attempts };
      } catch (err) {
        if (err instanceof EtradeError) err.details.attempts = attempts;
        if (isRetryable(err) && attempts <= this.options.maxRetries) {
          await sleep(this.options.retryDelayMs);
          continue;
        }
        const failure = err instanceof EtradeError ? `${err.kind}${err.details.code ? ` ${err.details.code}` : ""}` : "error";
        if (isRetryable(err) || (err instanceof EtradeError && isTlsCode(err.details.code))) this.failed(url, tin, failure);
        throw err;
      }
    }
  }

  private failed(url: string, tin: string, what: string): void {
    this.consecutiveFailures++;
    const where = url.includes("/BusinessMain/") ? "GetBusinessByLicenseNo" : "GetRegistrationInfoByTin";
    this.logger.warn(`e-trade ${where} for TIN ${maskTin(tin)} failed: ${what}`);
    if (this.options.circuitFailures > 0 && this.consecutiveFailures >= this.options.circuitFailures) {
      this.openUntil = Date.now() + this.options.circuitOpenMs;
      this.consecutiveFailures = 0;
      this.logger.error(`e-trade failed ${this.options.circuitFailures} times in a row; calls paused for ${this.options.circuitOpenMs} ms`);
    }
  }

  /** A JSON object, or NOT_FOUND for a 404, an empty body or null. Throws for anything else. */
  private readBody(response: TextResponse, where: string): Record<string, unknown> | typeof NOT_FOUND {
    const { status } = response;
    if (status === 404) return NOT_FOUND;
    if (status === 417) {
      throw new EtradeError("API", `e-trade refused ${where} (HTTP 417): it rejects calls without the checker page's Referer`, {
        status,
        code: "REFERER_REJECTED",
      });
    }
    if (status === 429) {
      const retryAfter = Number(response.headers["retry-after"]);
      throw new EtradeError("HTTP", `e-trade is limiting calls to ${where} (HTTP 429)`, {
        status,
        code: "RATE_LIMITED",
        ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
      });
    }
    if (status < 200 || status >= 300) throw new EtradeError("HTTP", `e-trade answered ${where} with HTTP ${status}`, { status });
    const text = response.text.trim();
    if (!text) return NOT_FOUND;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Only the call name goes into the message: the body may hold a third party's data.
      throw new EtradeError("HTTP", `e-trade's answer to ${where} is not JSON (HTTP ${status})`, { status, code: "NOT_JSON" });
    }
    if (parsed === null) return NOT_FOUND;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new EtradeError("API", `e-trade's answer to ${where} is not an object`, { status, code: "UNEXPECTED_SHAPE" });
    }
    return parsed as Record<string, unknown>;
  }
}

const NOT_FOUND = Symbol("NOT_FOUND");

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
