/**
 * How many DIFFERENT TINs one actor may look up in a window (EDR's TinLookupBudget).
 *
 * A lookup returns a business's registration, its licences and its manager's name and phone,
 * for any TIN typed. A customer needs their own TIN, a typo or two, and the same TIN again
 * while choosing a licence, so repeats are free and only new TINs count. Enumerating TINs is
 * the opposite: every request is a new one. The charge is taken before the call, so a TIN
 * e-trade does not know still counts.
 *
 * In-process memory: lost on restart and not shared between instances. A host with more than
 * one instance implements EtradeHost.chargeLookup over a shared store instead (the standalone
 * example does it in Postgres).
 */
export class TinLookupBudget {
  private readonly windows = new Map<string, { tins: Set<string>; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True when the lookup may go ahead (and is now counted); false when the budget is spent. */
  charge(actor: string, tin: string, now = Date.now()): boolean {
    let window = this.windows.get(actor);
    if (!window || window.resetAt <= now) {
      window = { tins: new Set(), resetAt: now + this.windowMs };
      this.windows.set(actor, window);
    }
    if (window.tins.has(tin)) return true;
    if (window.tins.size >= this.limit) return false;
    window.tins.add(tin);
    // Expired windows of other actors are dropped now and then, so memory does not grow forever.
    if (this.windows.size > 10_000) {
      for (const [key, value] of this.windows) if (value.resetAt <= now) this.windows.delete(key);
    }
    return true;
  }
}
