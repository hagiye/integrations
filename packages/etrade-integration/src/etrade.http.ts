import * as http from "node:http";
import * as https from "node:https";
import { EtradeError, isTlsCode } from "./etrade.errors";

export const MAX_BODY_BYTES = 1024 * 1024;

export interface TextResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body as text. May be empty: e-trade answers some unknown TINs with an empty 200. */
  text: string;
}

export interface GetOptions {
  timeoutMs: number;
  /** Used for https: URLs (CA list, verification). */
  httpsAgent?: https.Agent;
}

/**
 * GET a URL and read the whole answer as text, with one deadline for the whole exchange and a
 * 1 MB cap. Returns any status with its body (the caller decides what a 404 or an empty body
 * means). Throws EtradeError TIMEOUT, NETWORK (TLS failures included, with Node's code), or
 * HTTP when the answer is over 1 MB.
 */
export function getText(url: string, headers: Record<string, string>, options: GetOptions): Promise<TextResponse> {
  return new Promise<TextResponse>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new EtradeError("CONFIG", "baseUrl does not make a valid URL", { cause: err }));
      return;
    }
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const where = endpointName(target);

    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn();
    };

    const req = transport.request(
      target,
      {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        ...(isHttps && options.httpsAgent ? { agent: options.httpsAgent } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            finish(() =>
              reject(new EtradeError("HTTP", `Answer from ${where} is over 1 MB`, { status: res.statusCode, code: "TOO_LARGE" })),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(() =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
          ),
        );
        res.on("error", (err: NodeJS.ErrnoException) =>
          finish(() => reject(new EtradeError("NETWORK", `Reading ${where} failed: ${err.message}`, { code: err.code, cause: err }))),
        );
      },
    );

    deadline = setTimeout(() => {
      finish(() => reject(new EtradeError("TIMEOUT", `No answer from ${where} within ${options.timeoutMs} ms`)));
      req.destroy();
    }, options.timeoutMs);

    req.on("error", (err: NodeJS.ErrnoException) =>
      finish(() => {
        const tls = isTlsCode(err.code);
        reject(
          new EtradeError(
            "NETWORK",
            tls
              ? `TLS verification of ${target.hostname} failed (${err.code}). See the guide, section TLS: add the issuing CA with the ca option.`
              : `GET ${where} failed: ${err.message}`,
            { code: err.code, cause: err },
          ),
        );
      }),
    );
    req.end();
  });
}

/** The call's name without its TIN or licence number, for messages and logs. */
export function endpointName(target: URL): string {
  if (target.pathname.includes("/Registration/GetRegistrationInfoByTin/")) return "GetRegistrationInfoByTin";
  if (target.pathname.endsWith("/BusinessMain/GetBusinessByLicenseNo")) return "GetBusinessByLicenseNo";
  return target.pathname;
}
