import { KeyObject, createPrivateKey, createSign } from "node:crypto";
import { EimsError } from "./eims.errors";

/** What signs a request: the active INSA pair, or a pending one during activation. */
export interface EimsKeyMaterial {
  privateKey: KeyObject;
  /** Base64 of the certificate file's exact bytes. Never parsed or re-encoded for sending. */
  certificateBase64: string;
  /** For messages: a label and fingerprint, never key bytes. */
  label: string;
  certFingerprintSha256?: string | null;
  certNotAfter?: Date | null;
  /** The credential row, when it came from one. */
  credentialId?: string | null;
}

export interface SignedBody {
  /** The exact wire body: {"request":<payload>,"signature":"...","certificate":"..."}. */
  body: string;
  /** The compact JSON of the inner request that was signed. */
  payload: string;
}

/**
 * Sign one inner request the way MoR's guide and the live gateway require:
 *
 *  1. compact JSON of the inner request only (JSON.stringify, no spaces);
 *  2. its UTF-8 bytes;
 *  3. RSA with SHA-512 and PKCS#1 v1.5 padding (Java SHA512withRSA; not PSS);
 *  4. base64 of the raw signature;
 *  5. the certificate as base64 of its file's exact bytes, header lines included.
 *
 * The body is assembled by hand around that same payload string, so the request segment that goes
 * over the wire is byte for byte the string that was signed. The envelope itself is not signed.
 */
export function signEnvelope(material: Pick<EimsKeyMaterial, "privateKey" | "certificateBase64">, request: unknown): SignedBody {
  const payload = JSON.stringify(request);
  if (payload === undefined) throw new EimsError("INVALID", "Nothing to sign: the request is undefined", { sent: false });
  let signature: string;
  try {
    signature = createSign("RSA-SHA512").update(payload, "utf8").sign(material.privateKey, "base64");
  } catch (err) {
    throw new EimsError("CONFIG", `Signing the EIMS request failed: ${(err as Error).message}`, { sent: false, cause: err });
  }
  const body = `{"request":${payload},"signature":${JSON.stringify(signature)},"certificate":${JSON.stringify(material.certificateBase64)}}`;
  return { body, payload };
}

const PEM_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * An RSA private key from PEM text (or its bytes). Refuses, with a message that names no key
 * bytes, anything that is not a PEM RSA key: OpenSSL's own "unsupported" says nothing about
 * whether the file was truncated, double-encoded or the wrong file.
 */
export function loadRsaPrivateKey(pem: string | Buffer, source = "the private key"): KeyObject {
  const bytes = typeof pem === "string" ? Buffer.from(pem.replace(/\\n/g, "\n"), "utf8") : pem;
  if (!PEM_KEY_HEADER.test(bytes.toString("utf8", 0, 200))) {
    throw new EimsError(
      "CONFIG",
      `${source} is not a PEM private key (${bytes.length} bytes; expected a -----BEGIN ... PRIVATE KEY----- block). ` +
        "Check it is the key file itself, not base64 of it applied twice.",
      { code: "KEY_NOT_PEM", sent: false },
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(bytes);
  } catch (err) {
    throw new EimsError("CONFIG", `${source} could not be parsed: ${(err as Error).message}`, { code: "KEY_UNREADABLE", sent: false });
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new EimsError("CONFIG", `${source} is ${key.asymmetricKeyType ?? "of an unknown type"}; EIMS requires RSA`, {
      code: "KEY_NOT_RSA",
      sent: false,
    });
  }
  return key;
}
