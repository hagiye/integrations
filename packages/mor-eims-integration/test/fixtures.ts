import { execFileSync } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway INSA-style pairs, generated with openssl at test time: nothing real is committed.
 * The certificate file mimics the issued format: a Subject:/Issuer: preamble, then the PEM.
 */
export interface TestPair {
  keyPem: string;
  /** The "issued file": preamble + PEM. Sent as base64 of these exact bytes. */
  certificateFile: Buffer;
  certificatePem: string;
  fingerprint256: string;
}

const cache = new Map<string, TestPair>();

export function testPair(name: string, days = 365): TestPair {
  const key = `${name}:${days}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const dir = mkdtempSync(join(tmpdir(), "eims-test-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
        "-days", String(days), "-subj", `/C=ET/O=Test Seller ${name}/CN=EIMS TEST ${name}`,
      ],
      { stdio: "ignore" },
    );
    const keyPem = readFileSync(join(dir, "key.pem"), "utf8");
    const certificatePem = readFileSync(join(dir, "cert.pem"), "utf8");
    const cert = new X509Certificate(certificatePem);
    const preamble = `Subject: ${cert.subject.replace(/\n/g, ", ")}\nIssuer: ${cert.issuer.replace(/\n/g, ", ")}\n`;
    const pair: TestPair = {
      keyPem,
      certificatePem,
      certificateFile: Buffer.from(preamble + certificatePem, "utf8"),
      fingerprint256: cert.fingerprint256,
    };
    cache.set(key, pair);
    return pair;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An EC key, which EIMS must refuse. */
export function ecKeyPem(): string {
  const dir = mkdtempSync(join(tmpdir(), "eims-test-"));
  try {
    execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(dir, "ec.pem")], { stdio: "ignore" });
    return execFileSync("openssl", ["pkcs8", "-topk8", "-nocrypt", "-in", join(dir, "ec.pem")]).toString("utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const testEncryptionKey = (): string => randomBytes(32).toString("base64");

/** MoR's own test roster TIN that resolved live (Afri Software Solutions, "Taxpayer A"). */
export const TAXPAYER_A = "0089238373";
/** Roster "Taxpayer E": MoR's buyer lookup answered 503 for it live. */
export const TAXPAYER_E = "0000018932";
export const SELLER_TIN = "0099990001";
export const SYSTEM_NUMBER = "TESTSYS001";
