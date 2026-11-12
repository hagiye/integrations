import { FaydaError } from "./fayda.errors";
import type { PublicJwk } from "./fayda.jose";
import { JwksCache, parseJwks } from "./fayda.jwks";

const key = (kid: string, use?: string): PublicJwk => ({ kty: "RSA", kid, ...(use ? { use } : {}) });

describe("JwksCache", () => {
  let clock = 0;
  let calls = 0;
  let published: PublicJwk[] = [];
  let failing = false;
  const make = () =>
    new JwksCache(
      async () => {
        calls += 1;
        if (failing) throw new FaydaError("NETWORK", "down");
        return published;
      },
      { cacheMs: 600_000, minRefreshMs: 30_000, maxStaleMs: 3_600_000, now: () => clock },
    );

  beforeEach(() => {
    clock = 1_000_000;
    calls = 0;
    published = [key("a")];
    failing = false;
  });

  it("fetches once and serves from the cache", async () => {
    const cache = make();
    expect((await cache.keysFor("a")).map((k) => k.kid)).toEqual(["a"]);
    expect((await cache.keysFor("a")).map((k) => k.kid)).toEqual(["a"]);
    expect(calls).toBe(1);
  });

  it("refetches for an unknown kid (rotation), but at most once per minRefresh", async () => {
    const cache = make();
    await cache.keysFor("a");
    published = [key("b"), key("a")];
    clock += 31_000;
    expect((await cache.keysFor("b")).map((k) => k.kid)).toEqual(["b"]);
    expect(calls).toBe(2);
    expect(await cache.keysFor("forged-1")).toEqual([]);
    expect(await cache.keysFor("forged-2")).toEqual([]);
    expect(calls).toBe(2);
  });

  it("refreshes after cacheMs, and keeps stale keys while the fetch fails, up to maxStale", async () => {
    const cache = make();
    await cache.keysFor("a");
    failing = true;
    clock += 700_000;
    expect((await cache.keysFor("a")).map((k) => k.kid)).toEqual(["a"]);
    expect(calls).toBe(2);
    clock += 3_600_000;
    await expect(cache.keysFor("a")).rejects.toThrow("down");
  });

  it("shares one fetch between concurrent callers", async () => {
    const cache = make();
    await Promise.all([cache.keysFor("a"), cache.keysFor("a"), cache.keysFor(undefined)]);
    expect(calls).toBe(1);
  });

  it("offers only signing keys, and all of them for a token without kid", async () => {
    published = [key("a"), key("e", "enc"), key("b", "sig")];
    const cache = make();
    expect((await cache.keysFor(undefined)).map((k) => k.kid)).toEqual(["a", "b"]);
    expect(await cache.keysFor("e")).toEqual([]);
  });
});

describe("parseJwks", () => {
  it("reads keys and refuses documents without a keys array", () => {
    expect(parseJwks({ keys: [{ kty: "RSA" }, { nope: 1 }, null] })).toEqual([{ kty: "RSA" }]);
    expect(() => parseJwks({})).toThrow(FaydaError);
    expect(() => parseJwks(null)).toThrow(FaydaError);
  });
});
