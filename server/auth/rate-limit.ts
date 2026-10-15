const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

interface Failures {
  count: number;
  since: number;
}

export class LoginRateLimit {
  private readonly failures = new Map<string, Failures>();

  constructor(private readonly now: () => number = Date.now) {}

  tooMany(ip: string): boolean {
    const failures = this.activeFailures(ip);
    return failures !== undefined && failures.count >= MAX_FAILURES;
  }

  fail(ip: string): void {
    const failures = this.activeFailures(ip);
    if (failures) {
      failures.count += 1;
    } else {
      this.failures.set(ip, { count: 1, since: this.now() });
    }
  }

  success(ip: string): void {
    this.failures.delete(ip);
  }

  private activeFailures(ip: string): Failures | undefined {
    const failures = this.failures.get(ip);
    if (!failures) return undefined;
    if (this.now() - failures.since < WINDOW_MS) return failures;
    this.failures.delete(ip);
    return undefined;
  }
}
