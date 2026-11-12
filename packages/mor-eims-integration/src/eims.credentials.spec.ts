import { createVerify } from "node:crypto";
import { ecKeyPem, testEncryptionKey, testPair } from "../test/fixtures";
import { EimsSecretBox, loadRsaPrivateKey, parseCredentialPair, signEnvelope } from "./index";

describe("signing (RSA-SHA512, PKCS#1 v1.5, over the exact request bytes)", () => {
  const pair = testPair("signer");
  const material = { privateKey: loadRsaPrivateKey(pair.keyPem), certificateBase64: pair.certificateFile.toString("base64") };

  it("sends the request segment byte for byte as it was signed", () => {
    const request = { irn: "test-1", amount: 100.5, text: "ዋጋ / price" };
    const { body, payload } = signEnvelope(material, request);
    expect(payload).toBe(JSON.stringify(request));
    expect(body.startsWith(`{"request":${payload},"signature":"`)).toBe(true);
    const envelope = JSON.parse(body);
    expect(Buffer.from(envelope.signature, "base64")).toHaveLength(256);
    expect(envelope.certificate).toBe(pair.certificateFile.toString("base64"));
    const segment = body.slice('{"request":'.length, body.lastIndexOf(',"signature":'));
    const publicKey = require("node:crypto").createPublicKey(pair.keyPem);
    expect(createVerify("RSA-SHA512").update(segment, "utf8").verify(publicKey, envelope.signature, "base64")).toBe(true);
  });

  it("refuses keys that are not PEM RSA, naming no key bytes", () => {
    expect(() => loadRsaPrivateKey(ecKeyPem())).toThrow(/requires RSA/);
    expect(() => loadRsaPrivateKey(Buffer.from(pair.keyPem).toString("base64"))).toThrow(/not a PEM private key/);
  });
});

describe("stored pairs", () => {
  it("encrypts at rest with AES-256-GCM and refuses a wrong key or a tampered value", () => {
    const box = new EimsSecretBox(testEncryptionKey());
    const sealed = box.encrypt("private key bytes");
    expect(sealed).toMatch(/^v1\./);
    expect(box.decrypt(sealed).toString()).toBe("private key bytes");
    expect(() => new EimsSecretBox(testEncryptionKey()).decrypt(sealed)).toThrow(/differs from the one it was saved with/);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => box.decrypt(parts.join("."))).toThrow(/could not be decrypted/);
    expect(() => new EimsSecretBox("c2hvcnQ=")).toThrow(/32 bytes/);
  });

  it("checks a pair offline: preamble skipped, key and certificate must match, validity window", () => {
    const a = testPair("pair-a");
    const b = testPair("pair-b");
    const parsed = parseCredentialPair(a.keyPem, a.certificateFile);
    expect(parsed).toMatchObject({ keyBits: 2048, certFingerprintSha256: a.fingerprint256 });
    expect(parsed.certSubject).toContain("EIMS TEST pair-a");
    expect(() => parseCredentialPair(a.keyPem, b.certificateFile)).toThrow(/not a pair/);
    expect(() => parseCredentialPair(a.keyPem, a.certificateFile, new Date(Date.now() + 2 * 365 * 86_400_000))).toThrow(/expired/);
    expect(() => parseCredentialPair(a.keyPem, Buffer.from("Subject: x\n"))).toThrow(/no -----BEGIN CERTIFICATE/);
  });
});
