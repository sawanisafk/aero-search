/**
 * Per-host politeness gate (ARCHITECTURE §7: "per-host politeness delay"
 * before each fetch; robots.txt crawl-delay overrides the default). Time is
 * injected so tests are deterministic and the orchestrator can compute exact
 * sleep durations instead of busy-waiting.
 */

export class HostScheduler {
  private readonly nextDue = new Map<string, number>();
  private readonly delays = new Map<string, number>();

  constructor(private readonly defaultDelayMs: number) {
    if (defaultDelayMs < 0) throw new Error('default delay must be >= 0');
  }

  /** Robots crawl-delay override, in milliseconds. */
  setDelay(host: string, delayMs: number): void {
    this.delays.set(host, Math.max(0, delayMs));
  }

  delayFor(host: string): number {
    return this.delays.get(host) ?? this.defaultDelayMs;
  }

  isDue(host: string, now: number): boolean {
    return this.msUntilDue(host, now) === 0;
  }

  msUntilDue(host: string, now: number): number {
    const due = this.nextDue.get(host);
    return due === undefined ? 0 : Math.max(0, due - now);
  }

  /** Call after a fetch completes: the host is next due after its delay. */
  markFetched(host: string, now: number): void {
    this.nextDue.set(host, now + this.delayFor(host));
  }
}
