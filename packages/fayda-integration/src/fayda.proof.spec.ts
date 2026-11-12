import { issueFaydaProof, verifyFaydaProof } from "./fayda.proof";

const SECRET = "a-proof-secret-of-at-least-32-characters!!";
const OLD = "an-older-proof-secret-of-at-least-32-chars";
const now = new Date("2026-11-12T10:00:00Z");
const issue = (over: Partial<{ sub: string; clientId: string }> = {}, secret = SECRET) =>
  issueFaydaProof({ sub: "psut-1", clientId: "client-1", sessionId: "session-1", ttlMs: 15 * 60_000, now, ...over }, secret);

describe("Fayda proofs", () => {
  it("verifies its own proof and returns the payload", () => {
    expect(verifyFaydaProof(issue(), { sub: "psut-1", clientId: "client-1", now }, [SECRET])).toEqual({
      sub: "psut-1",
      cid: "client-1",
      sid: "session-1",
      exp: Math.floor(now.getTime() / 1000) + 900,
    });
  });

  it("accepts a proof signed with a previous secret during a rotation", () => {
    expect(verifyFaydaProof(issue({}, OLD), { sub: "psut-1", clientId: "client-1", now }, [SECRET, OLD])).not.toBeNull();
    expect(verifyFaydaProof(issue({}, OLD), { sub: "psut-1", clientId: "client-1", now }, [SECRET])).toBeNull();
  });

  it("refuses another sub, another client, an expired proof, a tampered one, and junk", () => {
    const token = issue();
    expect(verifyFaydaProof(token, { sub: "psut-2", clientId: "client-1", now }, [SECRET])).toBeNull();
    expect(verifyFaydaProof(token, { sub: "psut-1", clientId: "client-2", now }, [SECRET])).toBeNull();
    expect(verifyFaydaProof(token, { sub: "psut-1", clientId: "client-1", now: new Date(now.getTime() + 16 * 60_000) }, [SECRET])).toBeNull();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "psut-2", cid: "client-1", sid: "s", exp: 9e9 })).toString("base64url");
    expect(verifyFaydaProof(`${forged}.${mac}`, { sub: "psut-2", clientId: "client-1", now }, [SECRET])).toBeNull();
    expect(verifyFaydaProof(`${body}.${mac}x`, { sub: "psut-1", clientId: "client-1", now }, [SECRET])).toBeNull();
    for (const junk of [undefined, 5, "", "a.b.c", "x".repeat(5000)]) {
      expect(verifyFaydaProof(junk, { sub: "psut-1", clientId: "client-1", now }, [SECRET])).toBeNull();
    }
    expect(verifyFaydaProof(token, { sub: "psut-1", clientId: "client-1", now }, [])).toBeNull();
  });
});
