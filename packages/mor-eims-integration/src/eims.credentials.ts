import { KeyObject, X509Certificate, createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { EimsClient, EimsLoginResult } from "./eims.client";
import { EimsError } from "./eims.errors";
import { EimsHost } from "./eims.host";
import { ResolvedEimsOptions } from "./eims.options";
import { EimsKeyMaterial, loadRsaPrivateKey } from "./eims.signer";
import { EimsCredentialRecord } from "./eims.types";

// ── encryption at rest ───────────────────────────────────────────────────────────────────────────

const FORMAT_VERSION = "v1";

/**
 * AES-256-GCM under one 32-byte key (base64), for the private keys stored in your database.
 * Wire format v1.<iv>.<tag>.<ciphertext>, each part base64 (EDR's eims-crypto.service.ts).
 */
export class EimsSecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64.trim(), "base64");
    if (key.length !== 32) {
      throw new EimsError("CONFIG", `The EIMS encryption key must decode to 32 bytes; got ${key.length}. Generate one with: openssl rand -base64 32`, {
        sent: false,
      });
    }
    this.key = key;
  }

  encrypt(plain: Buffer | string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(typeof plain === "string" ? Buffer.from(plain, "utf8") : plain), cipher.final()]);
    return [FORMAT_VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
  }

  decrypt(payload: string): Buffer {
    const [version, iv, tag, ciphertext] = payload.split(".");
    if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) {
      throw new EimsError("CONFIG", "A stored EIMS secret has an unrecognised format", { sent: false });
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
    } catch {
      // Wrong key or tampered ciphertext: GCM refuses both the same way. The payload is never echoed.
      throw new EimsError("CONFIG", "A stored EIMS secret could not be decrypted: the encryption key differs from the one it was saved with", {
        sent: false,
      });
    }
  }
}

// ── pair parsing ─────────────────────────────────────────────────────────────────────────────────

export interface ParsedCredentialPair {
  privateKey: KeyObject;
  keyBits: number | null;
  keyFingerprintSha256: string;
  certFingerprintSha256: string;
  certSubject: string;
  certIssuer: string;
  certNotBefore: Date | null;
  certNotAfter: Date | null;
}

const PEM_CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;

/** SHA-256 as upper-case colon-separated hex, the way certificate tools print it. */
export const colonHex = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex").toUpperCase().match(/.{2}/g)!.join(":");

const toDate = (value: string): Date | null => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Check an uploaded INSA key + certificate pair offline: a PEM RSA key, a certificate whose public
 * key belongs to it, inside its validity window. The issued file carries a Subject:/Issuer:
 * preamble ahead of a PEM chain, so the first PEM block is what is parsed; the bytes themselves
 * are stored and sent untouched.
 */
export function parseCredentialPair(keyPem: Buffer | string, certificate: Buffer, now = new Date()): ParsedCredentialPair {
  const privateKey = loadRsaPrivateKey(keyPem, "The private key file");
  const pem = certificate.toString("utf8").match(PEM_CERT_BLOCK)?.[0];
  if (!pem) throw new EimsError("INVALID", "The certificate file contains no -----BEGIN CERTIFICATE----- block", { code: "CERT_NOT_PEM", sent: false });
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch (err) {
    throw new EimsError("INVALID", `The certificate could not be parsed: ${(err as Error).message}`, { code: "CERT_UNREADABLE", sent: false });
  }
  if (!cert.checkPrivateKey(privateKey)) {
    throw new EimsError("INVALID", "The certificate's public key does not belong to this private key: the two files are not a pair", {
      code: "KEY_CERT_MISMATCH",
      sent: false,
    });
  }
  const notBefore = toDate(cert.validFrom);
  const notAfter = toDate(cert.validTo);
  if (notAfter && notAfter < now) {
    throw new EimsError("INVALID", `The certificate expired on ${notAfter.toISOString().slice(0, 10)}`, { code: "CERT_EXPIRED", sent: false });
  }
  if (notBefore && notBefore > now) {
    throw new EimsError("INVALID", `The certificate is not valid until ${notBefore.toISOString().slice(0, 10)}`, { code: "CERT_NOT_YET_VALID", sent: false });
  }
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return {
    privateKey,
    keyBits: privateKey.asymmetricKeyDetails?.modulusLength ?? null,
    keyFingerprintSha256: colonHex(publicDer),
    certFingerprintSha256: cert.fingerprint256,
    certSubject: cert.subject.replace(/\n/g, ", "),
    certIssuer: cert.issuer.replace(/\n/g, ", "),
    certNotBefore: notBefore,
    certNotAfter: notAfter,
  };
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────

/** Reminder stages in days before expiry; 1 is "already expired". */
const REMINDER_STAGES = [60, 30, 7] as const;
const EXPIRED_STAGE = 1;
const STALE_MS = 15_000;
const MAX_PEM_BYTES = 64 * 1024;

export interface EimsCredentialView {
  id: string;
  status: EimsCredentialRecord["status"];
  label: string;
  certFingerprintSha256: string;
  keyFingerprintSha256: string;
  certSubject: string;
  certIssuer: string;
  certNotBefore: string | null;
  certNotAfter: string | null;
  daysToExpiry: number | null;
  keyBits: number | null;
  activationSystemNumber: string | null;
  lastActivationError: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
}

const daysUntil = (date: Date | null, now = new Date()): number | null =>
  date ? Math.floor((date.getTime() - now.getTime()) / 86_400_000) : null;

const isCertificateRefusal = (err: unknown): boolean => {
  if (!(err instanceof EimsError) || !["SCHEMA_VALIDATION", "AUTH", "FORBIDDEN"].includes(err.kind)) return false;
  const code = String(err.details.body?.code ?? "");
  return code.startsWith("67") || (err.details.rules ?? []).some((r) => r.startsWith("67")) || /certificate|signature/i.test(err.message);
};

/**
 * INSA key/certificate pairs: the signer's key source, upload, activation and expiry reminders.
 *
 * The rotation contract MoR confirmed: renewals are yearly, keep the same system number, need no
 * registration step, and there is NO overlap: once the new certificate is used, MoR retires the
 * old one. So activation is one operation: prove the pending pair with a signed, read-only
 * /v1/verify (the gateway checks both halves: 67004, 67012, 67013), then, in one transaction,
 * retire the old row and destroy its key and make the new one ACTIVE. There is never a moment
 * with two usable pairs, and never a separate "test" call that would retire the pair in use.
 *
 * Without stored credentials (no encryptionKey, or nothing activated yet) the static
 * privateKey + certificate from the options sign.
 */
export class EimsCredentialService {
  private readonly logger = new Logger("EimsCredentialService");
  private readonly box: EimsSecretBox | null;
  private staticMaterial: EimsKeyMaterial | null = null;
  private active: EimsKeyMaterial | null = null;
  private activeId: string | null = null;
  private checkedAt = 0;
  private refreshing: Promise<void> | null = null;
  private client: EimsClient | null = null;

  constructor(
    private readonly options: ResolvedEimsOptions,
    private readonly host?: EimsHost,
  ) {
    this.box = options.encryptionKey ? new EimsSecretBox(options.encryptionKey) : null;
  }

  /** Set by the module once the client exists (the client needs this service to sign). */
  attachClient(client: EimsClient): void {
    this.client = client;
  }

  /** EimsKeySource: the ACTIVE stored pair when there is one, else the static pair. */
  async material(): Promise<EimsKeyMaterial> {
    if (this.box && this.host?.listCredentials && Date.now() - this.checkedAt > STALE_MS) await this.refresh();
    if (this.active) return this.active;
    if (this.activeId) {
      throw new EimsError("CONFIG", "The ACTIVE stored EIMS credential cannot be used (see the log); refusing to fall back to another key", {
        sent: false,
      });
    }
    return this.staticPair();
  }

  private staticPair(): EimsKeyMaterial {
    if (this.staticMaterial) return this.staticMaterial;
    if (!this.options.privateKey || !this.options.certificateBase64) {
      throw new EimsError(
        "CONFIG",
        "No EIMS signing pair: activate an uploaded INSA key/certificate, or set privateKey and certificate in the options",
        { sent: false },
      );
    }
    this.staticMaterial = {
      privateKey: loadRsaPrivateKey(this.options.privateKey, "options.privateKey"),
      certificateBase64: this.options.certificateBase64,
      label: "options",
      credentialId: null,
    };
    return this.staticMaterial;
  }

  /** EimsKeySource: re-read the ACTIVE row now; true when it is a different pair than before. */
  async refreshNow(): Promise<boolean> {
    if (!this.box || !this.host?.listCredentials) return false;
    const before = this.activeId;
    this.checkedAt = 0;
    await this.refresh();
    return this.activeId !== before && this.active !== null;
  }

  /** Re-read the ACTIVE row (another instance may have rotated). */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    let rows: EimsCredentialRecord[];
    try {
      rows = (await this.host?.listCredentials?.()) ?? [];
    } catch (err) {
      this.logger.warn(`EIMS credentials could not be read (${(err as Error).message}); keeping the current key`);
      this.checkedAt = Date.now();
      return;
    }
    this.checkedAt = Date.now();
    const row = rows.find((r) => r.status === "ACTIVE") ?? null;
    if (!row) {
      this.active = null;
      this.activeId = null;
      return;
    }
    if (this.active && this.activeId === row.id) return;
    this.activeId = row.id;
    try {
      this.active = this.materialFrom(row);
      this.logger.log(`EIMS signing with stored credential "${row.label}" (${row.certFingerprintSha256})`);
    } catch (err) {
      // Refusing to sign is the safe outcome: falling back could mean signing with a retired key.
      this.active = null;
      this.logger.error(`The ACTIVE EIMS credential "${row.label}" cannot be used: ${(err as Error).message}`);
    }
  }

  private materialFrom(row: EimsCredentialRecord): EimsKeyMaterial {
    if (!this.box) throw new EimsError("CONFIG", "Stored EIMS credentials need options.encryptionKey", { sent: false });
    if (!row.privateKeyEnc) throw new EimsError("CONFIG", `Credential "${row.label}" has no key (retired?)`, { sent: false });
    return {
      privateKey: loadRsaPrivateKey(this.box.decrypt(row.privateKeyEnc), `stored credential "${row.label}"`),
      certificateBase64: row.certificateBase64,
      label: row.label,
      certFingerprintSha256: row.certFingerprintSha256,
      certNotAfter: row.certNotAfter ? new Date(row.certNotAfter) : null,
      credentialId: row.id,
    };
  }

  private requireStore(): { host: EimsHost; box: EimsSecretBox } {
    if (!this.host) throw new EimsError("CONFIG", "Stored EIMS credentials need a host", { sent: false });
    if (!this.box) throw new EimsError("CONFIG", "Stored EIMS credentials need options.encryptionKey (openssl rand -base64 32)", { sent: false });
    return { host: this.host, box: this.box };
  }

  async list(): Promise<EimsCredentialView[]> {
    const { host } = this.requireStore();
    const rows = (await host.listCredentials?.()) ?? (await host.transaction((l) => l.lockCredentials()));
    return rows.map((r) => this.view(r));
  }

  /** Store a new pair as PENDING after the offline checks. A previous pending pair is retired (its key destroyed). */
  async upload(input: { privateKey: Buffer | string; certificate: Buffer | string; label?: string }): Promise<EimsCredentialView> {
    const { host, box } = this.requireStore();
    const keyBytes = typeof input.privateKey === "string" ? Buffer.from(input.privateKey, "utf8") : input.privateKey;
    const certBytes = typeof input.certificate === "string" ? Buffer.from(input.certificate, "utf8") : input.certificate;
    if (!keyBytes.length || !certBytes.length) throw new EimsError("INVALID", "Both the private key and the certificate are required", { sent: false });
    if (keyBytes.length > MAX_PEM_BYTES || certBytes.length > MAX_PEM_BYTES) {
      throw new EimsError("INVALID", "Key and certificate files must each be under 64 KB", { sent: false });
    }
    const parsed = parseCredentialPair(keyBytes, certBytes);
    const now = new Date();
    const record: EimsCredentialRecord = {
      id: randomUUID(),
      status: "PENDING",
      label: input.label?.trim() || `Uploaded ${now.toISOString().slice(0, 10)}`,
      privateKeyEnc: box.encrypt(keyBytes),
      certificateBase64: certBytes.toString("base64"),
      certFingerprintSha256: parsed.certFingerprintSha256,
      keyFingerprintSha256: parsed.keyFingerprintSha256,
      certSubject: parsed.certSubject,
      certIssuer: parsed.certIssuer,
      certNotBefore: parsed.certNotBefore,
      certNotAfter: parsed.certNotAfter,
      keyBits: parsed.keyBits,
      activationSystemNumber: null,
      lastActivationError: null,
      expiryReminderStage: 0,
      createdAt: now,
      activatedAt: null,
      retiredAt: null,
      replacedById: null,
    };
    await host.transaction(async (ledger) => {
      for (const row of await ledger.lockCredentials()) {
        if (row.status === "PENDING") {
          await ledger.saveCredential({ ...row, status: "RETIRED", privateKeyEnc: null, retiredAt: now, replacedById: record.id });
        }
      }
      await ledger.insertCredential(record);
    });
    return this.view(record);
  }

  /**
   * Bring the static options pair into the store as the ACTIVE row (once), so a deployment moves
   * from configuration to rotation starting from the pair that already works.
   */
  async importStaticPair(label = "Imported from options"): Promise<EimsCredentialView | null> {
    const { host, box } = this.requireStore();
    if (!this.options.privateKey || !this.options.certificateBase64) return null;
    const certBytes = Buffer.from(this.options.certificateBase64, "base64");
    const keyPem = this.options.privateKey.replace(/\\n/g, "\n");
    const parsed = parseCredentialPair(keyPem, certBytes);
    const now = new Date();
    const record: EimsCredentialRecord = {
      id: randomUUID(),
      status: "ACTIVE",
      label,
      privateKeyEnc: box.encrypt(keyPem),
      certificateBase64: this.options.certificateBase64,
      certFingerprintSha256: parsed.certFingerprintSha256,
      keyFingerprintSha256: parsed.keyFingerprintSha256,
      certSubject: parsed.certSubject,
      certIssuer: parsed.certIssuer,
      certNotBefore: parsed.certNotBefore,
      certNotAfter: parsed.certNotAfter,
      keyBits: parsed.keyBits,
      activationSystemNumber: this.client?.currentSystemNumber() ?? null,
      lastActivationError: null,
      expiryReminderStage: 0,
      createdAt: now,
      activatedAt: now,
      retiredAt: null,
      replacedById: null,
    };
    const inserted = await host.transaction(async (ledger) => {
      if ((await ledger.lockCredentials()).some((r) => r.status === "ACTIVE")) return false;
      await ledger.insertCredential(record);
      return true;
    });
    if (!inserted) return null;
    this.checkedAt = 0;
    return this.view(record);
  }

  /** Only a pending pair can be removed; its key is destroyed. An active pair is replaced, never removed. */
  async remove(id: string): Promise<void> {
    const { host } = this.requireStore();
    await host.transaction(async (ledger) => {
      const row = (await ledger.lockCredentials()).find((r) => r.id === id);
      if (!row) throw new EimsError("INVALID", `Credential ${id} not found`, { code: "NOT_FOUND", sent: false });
      if (row.status !== "PENDING") throw new EimsError("INVALID", "Only a pending pair can be removed", { code: "NOT_PENDING", sent: false });
      await ledger.saveCredential({ ...row, status: "RETIRED", privateKeyEnc: null, retiredAt: new Date() });
    });
  }

  /**
   * The rotation, one operation:
   *  1. refuse while a submission is in flight (the new pair would sign half a conversation);
   *  2. log in, with the active pair, else (an expired certificate must not lock you out of its
   *     own replacement) with the pending one;
   *  3. the token must name the same system number as before (a renewal keeps it);
   *  4. prove the pending pair with a signed /v1/verify of a known IRN, refusing on 67xxx;
   *  5. under the credentials lock: the pending row must still be pending and the active one
   *     unchanged (a concurrent activation loses), then retire the old (key destroyed) and
   *     activate the new;
   *  6. sign with the new pair from now on and keep the session it logged in with.
   */
  async activate(id: string): Promise<EimsCredentialView> {
    const { host } = this.requireStore();
    const client = this.client;
    if (!client) throw new EimsError("CONFIG", "Activation needs the EIMS client", { sent: false });

    const rows = (await host.listCredentials?.()) ?? (await host.transaction((l) => l.lockCredentials()));
    const pending = rows.find((r) => r.id === id);
    if (!pending) throw new EimsError("INVALID", `Credential ${id} not found`, { code: "NOT_FOUND", sent: false });
    if (pending.status !== "PENDING") {
      throw new EimsError("INVALID", `This pair is ${pending.status.toLowerCase()}, not pending`, { code: "NOT_PENDING", sent: false });
    }
    const previous = rows.find((r) => r.status === "ACTIVE") ?? null;
    const material = this.materialFrom(pending);

    let login: EimsLoginResult;
    try {
      login = await client.login({ trigger: "CREDENTIAL_ACTIVATION" });
    } catch (err) {
      try {
        login = await client.login({ trigger: "CREDENTIAL_ACTIVATION", material });
        this.logger.warn(`EIMS login with the active pair failed during activation (${(err as Error).message}); the pending pair logged in`);
      } catch {
        await this.noteActivationError(pending.id, (err as Error).message);
        throw err;
      }
    }

    const busy = await host.transaction(async (ledger) => {
      const state = await ledger.lockSystemState(login.session.systemNumber);
      if (state.inFlightDocumentId) return `a submission for document ${state.inFlightDocumentId} is in flight with MoR`;
      if (state.inFlightConversationId) return `a bulk registration (${state.inFlightConversationId}) is still being processed by MoR`;
      return null;
    });
    if (busy) throw new EimsError("BUSY", `Activation refused: ${busy}`, { code: "ACTIVATION_BLOCKED", sent: false });

    const expectedSystem = previous?.activationSystemNumber ?? client.currentSystemNumber();
    if (expectedSystem && expectedSystem !== login.session.systemNumber) {
      const message = `MoR issued a token for system ${login.session.systemNumber}, but the current pair is system ${expectedSystem}: this is not a renewal. Nothing changed.`;
      await this.noteActivationError(pending.id, message);
      throw new EimsError("INVALID", message, { code: "ACTIVATION_SYSTEM_MISMATCH", sent: false });
    }

    const proof = await this.prove(material, login);
    if (proof.outcome === "REFUSED") {
      const message = `MoR refused the new key/certificate: ${proof.detail}. Nothing changed.`;
      await this.noteActivationError(pending.id, message);
      throw new EimsError("INVALID", message, { code: "ACTIVATION_CERTIFICATE_REFUSED", sent: false });
    }

    const now = new Date();
    const activated = await host.transaction(async (ledger) => {
      const locked = await ledger.lockCredentials();
      const current = locked.find((r) => r.id === id);
      const currentActive = locked.find((r) => r.status === "ACTIVE") ?? null;
      if (!current || current.status !== "PENDING" || (currentActive?.id ?? null) !== (previous?.id ?? null)) {
        throw new EimsError("BUSY", "Another activation changed the credentials meanwhile; nothing changed here", {
          code: "ACTIVATION_RACE",
          sent: false,
        });
      }
      if (currentActive) {
        await ledger.saveCredential({ ...currentActive, status: "RETIRED", privateKeyEnc: null, retiredAt: now, replacedById: id });
      }
      const next: EimsCredentialRecord = {
        ...current,
        status: "ACTIVE",
        activatedAt: now,
        activationSystemNumber: login.session.systemNumber,
        lastActivationError: null,
      };
      await ledger.saveCredential(next);
      return next;
    });

    this.active = material;
    this.activeId = activated.id;
    this.checkedAt = Date.now();
    client.installSession(login);
    await this.emit({
      type: "CREDENTIAL_ACTIVATED",
      priority: "NORMAL",
      credentialId: activated.id,
      message:
        `EIMS signing pair rotated: ${previous ? `${previous.label} (${previous.certFingerprintSha256})` : "options pair"} -> ` +
        `${activated.label} (${activated.certFingerprintSha256}); system ${login.session.systemNumber}; proof: ${proof.detail}`,
    });
    return this.view(activated);
  }

  /** A signed /v1/verify with the pending pair. REFUSED stops the rotation; UNPROVEN does not. */
  private async prove(material: EimsKeyMaterial, login: EimsLoginResult): Promise<{ outcome: "VERIFIED" | "REFUSED" | "UNPROVEN"; detail: string }> {
    const irn = await this.host?.anyRegisteredIrn?.();
    if (!irn) return { outcome: "UNPROVEN", detail: "no registered document to verify against" };
    try {
      await this.client!.verify(irn, { material, accessToken: login.accessToken, trigger: "CREDENTIAL_ACTIVATION" });
      return { outcome: "VERIFIED", detail: "signed /v1/verify accepted by MoR" };
    } catch (err) {
      if (isCertificateRefusal(err)) return { outcome: "REFUSED", detail: (err as Error).message };
      return { outcome: "UNPROVEN", detail: (err as Error).message };
    }
  }

  private async noteActivationError(id: string, message: string): Promise<void> {
    try {
      await this.host?.transaction(async (ledger) => {
        const row = (await ledger.lockCredentials()).find((r) => r.id === id);
        if (row) await ledger.saveCredential({ ...row, lastActivationError: message.slice(0, 2000) });
      });
    } catch (err) {
      this.logger.warn(`Could not record the activation error: ${(err as Error).message}`);
    }
  }

  /**
   * Run daily: 60, 30 and 7 days before the active certificate expires, then once after it has,
   * an event (each stage once per pair). Returns the event sent, or null.
   */
  async checkCertificateExpiry(now = new Date()): Promise<{ stage: number; daysToExpiry: number } | null> {
    if (!this.host || !this.box) return null;
    return this.host.transaction(async (ledger) => {
      const active = (await ledger.lockCredentials()).find((r) => r.status === "ACTIVE");
      if (!active?.certNotAfter) return null;
      const days = daysUntil(new Date(active.certNotAfter), now)!;
      // The smallest stage the remaining days fall under (EDR picks the first, 60, for any
      // day count below 60, so its 30 and 7 day reminders never fire).
      const stage = days < 0 ? EXPIRED_STAGE : ([...REMINDER_STAGES].reverse().find((s) => days <= s) ?? 0);
      if (stage === 0) return null;
      const sent = active.expiryReminderStage;
      if (sent === EXPIRED_STAGE || (sent !== 0 && sent <= stage)) return null;
      await ledger.saveCredential({ ...active, expiryReminderStage: stage });
      const expired = stage === EXPIRED_STAGE;
      await this.emit({
        type: "CERTIFICATE_EXPIRY",
        priority: expired || stage === 7 ? "HIGH" : "NORMAL",
        credentialId: active.id,
        daysToExpiry: days,
        message: expired
          ? `The EIMS signing certificate "${active.label}" has expired: nothing can be filed until the renewed pair is activated`
          : `The EIMS signing certificate "${active.label}" expires in ${days} days (${new Date(active.certNotAfter!).toISOString().slice(0, 10)}): request the renewal from INSA`,
      });
      return { stage, daysToExpiry: days };
    });
  }

  /** Why the active pair cannot sign right now (expired), or null. */
  async expiryBlockReason(now = new Date()): Promise<string | null> {
    try {
      const material = await this.material();
      if (material.certNotAfter && material.certNotAfter.getTime() < now.getTime()) {
        return `the EIMS signing certificate "${material.label}" expired on ${material.certNotAfter.toISOString().slice(0, 10)}`;
      }
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  private async emit(event: Parameters<NonNullable<EimsHost["onEvent"]>>[0]): Promise<void> {
    try {
      await this.host?.onEvent?.(event);
    } catch (err) {
      this.logger.warn(`EIMS event ${event.type} could not be delivered: ${(err as Error).message}`);
    }
  }

  view(row: EimsCredentialRecord): EimsCredentialView {
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      id: row.id,
      status: row.status,
      label: row.label,
      certFingerprintSha256: row.certFingerprintSha256,
      keyFingerprintSha256: row.keyFingerprintSha256,
      certSubject: row.certSubject,
      certIssuer: row.certIssuer,
      certNotBefore: iso(row.certNotBefore),
      certNotAfter: iso(row.certNotAfter),
      daysToExpiry: daysUntil(row.certNotAfter ? new Date(row.certNotAfter) : null),
      keyBits: row.keyBits,
      activationSystemNumber: row.activationSystemNumber,
      lastActivationError: row.lastActivationError,
      activatedAt: iso(row.activatedAt),
      retiredAt: iso(row.retiredAt),
    };
  }
}
