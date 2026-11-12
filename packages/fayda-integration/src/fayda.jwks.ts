import { FaydaError } from "./fayda.errors";
import type { PublicJwk } from "./fayda.jose";

export interface JwksCacheOptions {
  /** A fetched key set is used without asking again for this long. */
  cacheMs: number;
  /** At most one fetch in this window, however many unknown kids arrive. */
  minRefreshMs: number;
  /** When a fetch fails, keys this old or younger are still used. */
  maxStaleMs: number;
  now?: () => number;
}

/** Reads a JWKS document into its keys. Throws FaydaError API on anything that is not one. */
export function parseJwks(document: unknown): PublicJwk[] {
  const keys = (document as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new FaydaError("API", "The key set has no keys array", { code: "NOT_JWKS" });
  return keys.filter((k): k is PublicJwk => !!k && typeof k === "object" && typeof (k as PublicJwk).kty === "string");
}

/**
 * eSignet's published signing keys, fetched lazily and kept for cacheMs. A token whose kid is
 * not in the cache triggers one refetch (rotation), rate-limited by minRefreshMs so a stream of
 * forged kids cannot hammer eSignet. Concurrent callers share one fetch. When a fetch fails, a
 * key set younger than maxStaleMs is still used.
 */
export class JwksCache {
  private keys: PublicJwk[] | undefined;
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private inFlight: Promise<PublicJwk[]> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly fetchKeys: () => Promise<PublicJwk[]>,
    private readonly options: JwksCacheOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Candidate keys for a token: the ones with its kid, or every signing key when it has none. */
  async keysFor(kid: string | undefined): Promise<PublicJwk[]> {
    const fresh = this.keys !== undefined && this.now() - this.fetchedAt < this.options.cacheMs;
    if (fresh) {
      const found = this.pick(kid);
      if (found.length > 0) return found;
    }
    const keys = await this.refresh();
    return this.pick(kid, keys);
  }

  /** Drops the cache (tests, or after a key incident). */
  clear(): void {
    this.keys = undefined;
    this.fetchedAt = 0;
    this.lastAttemptAt = 0;
  }

  private pick(kid: string | undefined, keys = this.keys ?? []): PublicJwk[] {
    const signing = keys.filter((k) => k.use === undefined || k.use === "sig");
    return kid === undefined ? signing : signing.filter((k) => k.kid === kid);
  }

  private async refresh(): Promise<PublicJwk[]> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (this.keys !== undefined && now - this.lastAttemptAt < this.options.minRefreshMs) {
      return this.keys;
    }
    this.lastAttemptAt = now;
    this.inFlight = (async () => {
      try {
        const keys = await this.fetchKeys();
        this.keys = keys;
        this.fetchedAt = this.now();
        return keys;
      } catch (err) {
        if (this.keys !== undefined && this.now() - this.fetchedAt < this.options.maxStaleMs) return this.keys;
        throw err;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}
