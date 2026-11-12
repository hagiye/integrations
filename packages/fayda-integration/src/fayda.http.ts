import * as http from "node:http";
import * as https from "node:https";
import { FaydaError, isTlsCode } from "./fayda.errors";

export const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

export interface HttpCallOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Used for https: URLs (CA list, verification). */
  httpsAgent?: https.Agent;
  /** A name for messages and logs, without query strings (they may hold a code). */
  name: string;
}

/**
 * One HTTP exchange with a single deadline (connection included) and a 1 MB cap on the answer.
 * Returns any status with its body; the caller decides what an error status means.
 *
 * Throws FaydaError TIMEOUT, NETWORK (TLS failures included, with Node's code) or HTTP (answer
 * over 1 MB). details.sent says whether the request was written out: before that, nothing can
 * have reached eSignet.
 */
export function httpCall(url: string, options: HttpCallOptions): Promise<HttpAnswer> {
  return new Promise<HttpAnswer>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new FaydaError("CONFIG", `The ${options.name} address is not a valid URL`, { cause: err }));
      return;
    }
    const isHttps = target.protocol === "https:";
    if (!isHttps && target.protocol !== "http:") {
      reject(new FaydaError("CONFIG", `The ${options.name} address must be http or https`));
      return;
    }
    const transport = isHttps ? https : http;
    const body = options.body === undefined ? undefined : Buffer.from(options.body, "utf8");

    let settled = false;
    let sent = false;
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
        method: options.method,
        headers: {
          ...(options.headers ?? {}),
          ...(body ? { "Content-Length": String(body.length) } : {}),
        },
        ...(isHttps && options.httpsAgent ? { agent: options.httpsAgent } : {}),
      },
      (res) => {
        sent = true;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            finish(() =>
              reject(
                new FaydaError("HTTP", `Answer from ${options.name} is over 1 MB`, {
                  status: res.statusCode,
                  code: "TOO_LARGE",
                  sent: true,
                }),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") })),
        );
        res.on("error", (err: NodeJS.ErrnoException) =>
          finish(() =>
            reject(new FaydaError("NETWORK", `Reading ${options.name} failed: ${err.message}`, { code: err.code, sent: true, cause: err })),
          ),
        );
      },
    );

    // "finish": the whole request was handed to the operating system, so eSignet may see it.
    req.on("finish", () => {
      sent = true;
    });

    deadline = setTimeout(() => {
      finish(() => reject(new FaydaError("TIMEOUT", `No answer from ${options.name} within ${options.timeoutMs} ms`, { sent })));
      req.destroy();
    }, options.timeoutMs);

    req.on("error", (err: NodeJS.ErrnoException) =>
      finish(() => {
        const tls = isTlsCode(err.code);
        reject(
          new FaydaError(
            "NETWORK",
            tls
              ? `TLS verification of ${target.hostname} failed (${err.code}). Add the issuing CA with the ca option.`
              : `${options.method} ${options.name} failed: ${err.message}`,
            { code: err.code, sent: tls ? false : sent, cause: err },
          ),
        );
      }),
    );
    if (body) req.write(body);
    req.end();
  });
}

/** The media type of an answer, lower case, without parameters. */
export function mediaType(headers: http.IncomingHttpHeaders): string {
  const value = headers["content-type"];
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}
