import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { EimsError, isNotConnectedCode, isTlsCode } from "./eims.errors";

export const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

export interface HttpPostOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  httpsAgent?: https.Agent;
  /** For messages: "POST /v1/register". Never a payload. */
  name: string;
}

/**
 * One POST of a body that is already a string (the signed envelope must go out byte for byte as
 * it was signed, so nothing here serializes), with one deadline for the whole exchange and a 1 MB
 * cap on the answer. Returns any status; the caller decides what it means.
 *
 * details.sent on a failure: false only when the connection never came up (DNS, refused, TLS
 * handshake, a deadline before connecting). From the moment the connection is up, MoR may have
 * read the request, and the failure is ambiguous.
 */
export function postText(url: string, body: string, options: HttpPostOptions): Promise<HttpAnswer> {
  return new Promise<HttpAnswer>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new EimsError("CONFIG", `The EIMS address for ${options.name} is not a valid URL`, { sent: false, cause: err }));
      return;
    }
    const isHttps = target.protocol === "https:";
    if (!isHttps && target.protocol !== "http:") {
      reject(new EimsError("CONFIG", "The EIMS base URL must be http or https", { sent: false }));
      return;
    }
    const payload = Buffer.from(body, "utf8");
    const transport = isHttps ? https : http;

    let settled = false;
    let connected = false;
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
        method: "POST",
        headers: { ...options.headers, "Content-Length": String(payload.length) },
        ...(isHttps && options.httpsAgent ? { agent: options.httpsAgent } : {}),
      },
      (res) => {
        connected = true;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            finish(() =>
              reject(
                new EimsError("UNKNOWN", `The answer to ${options.name} is over 1 MB`, {
                  httpStatus: res.statusCode,
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
          finish(() =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
          ),
        );
        res.on("error", (err: NodeJS.ErrnoException) =>
          finish(() =>
            reject(
              new EimsError("NETWORK", `Reading the answer to ${options.name} failed: ${err.message}`, {
                code: err.code,
                sent: true,
                cause: err,
              }),
            ),
          ),
        );
      },
    );

    req.on("socket", (socket) => {
      // A reused keep-alive socket is already up (and, for https, past its handshake).
      if (!(socket as { connecting?: boolean }).connecting) {
        connected = true;
        return;
      }
      socket.once(isHttps ? "secureConnect" : "connect", () => {
        connected = true;
      });
    });

    deadline = setTimeout(() => {
      finish(() =>
        reject(
          connected
            ? new EimsError("TIMEOUT", `No answer to ${options.name} within ${options.timeoutMs} ms`, { sent: true })
            : new EimsError("NETWORK", `Could not connect for ${options.name} within ${options.timeoutMs} ms`, {
                code: "CONNECT_TIMEOUT",
                sent: false,
              }),
        ),
      );
      req.destroy();
    }, options.timeoutMs);

    req.on("error", (err: NodeJS.ErrnoException) =>
      finish(() => {
        const tlsFailure = isTlsCode(err.code);
        const neverSent = !connected || tlsFailure || isNotConnectedCode(err.code);
        reject(
          new EimsError(
            "NETWORK",
            tlsFailure
              ? `TLS verification of ${target.hostname} failed (${err.code}). Add the issuing CA with the ca option.`
              : `${options.name} failed: ${err.message}`,
            { code: err.code, sent: !neverSent, cause: err },
          ),
        );
      }),
    );
    req.end(payload);
  });
}

/** Host names insecureTls is refused for: mor.gov.et and every sub-domain (core.mor.gov.et). */
export function isMorProductionHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "mor.gov.et" || host.endsWith(".mor.gov.et");
}

/**
 * Node's trusted CAs plus the extra ones from options.ca.
 *
 * Passing `ca` to Node replaces its trusted list instead of adding to it, so an extra CA for a
 * private test host would make every public host fail. The defaults are put back here.
 * tls.getCACertificates("default") (Node 22.15+) also carries NODE_EXTRA_CA_CERTS; older Node only
 * has its bundled roots. Without extra CAs the result is undefined and Node uses its own list.
 */
export function caWithNodeDefaults(
  extra: string | Buffer | Array<string | Buffer> | undefined,
): Array<string | Buffer> | undefined {
  const list = extra === undefined ? [] : Array.isArray(extra) ? extra : [extra];
  if (list.length === 0) return undefined;
  const getCACertificates = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
  const defaults = typeof getCACertificates === "function" ? getCACertificates("default") : tls.rootCertificates;
  return [...defaults, ...list];
}

export function createEimsAgent(settings: { ca?: string | Buffer | Array<string | Buffer>; insecureTls: boolean }): https.Agent {
  const ca = caWithNodeDefaults(settings.ca);
  return new https.Agent({
    keepAlive: true,
    rejectUnauthorized: !settings.insecureTls,
    ...(ca ? { ca } : {}),
  });
}
