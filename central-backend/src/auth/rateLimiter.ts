export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  reason?: string;
}

interface FailureRecord {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

interface WindowCounter {
  timestamps: number[];
}

export class AuthBruteForceProtector {
  private readonly ipWindows = new Map<string, WindowCounter>();
  private readonly accountFailures = new Map<string, FailureRecord>();

  private readonly ipWindowMs: number;
  private readonly maxIpRequests: number;
  private readonly maxAccountFailures: number;
  private readonly lockoutMs: number;

  constructor(options?: {
    ipWindowMs?: number;
    maxIpRequests?: number;
    maxAccountFailures?: number;
    lockoutMs?: number;
  }) {
    this.ipWindowMs = options?.ipWindowMs ?? 15 * 60 * 1000;
    this.maxIpRequests = options?.maxIpRequests ?? 40;
    this.maxAccountFailures = options?.maxAccountFailures ?? 5;
    this.lockoutMs = options?.lockoutMs ?? 15 * 60 * 1000;
  }

  checkIpRateLimit(bucket: string, ip: string): RateLimitCheckResult {
    const now = Date.now();
    const key = `${bucket}:${ip || 'unknown'}`;
    const existing = this.ipWindows.get(key) ?? { timestamps: [] };
    existing.timestamps = existing.timestamps.filter((ts) => now - ts < this.ipWindowMs);

    if (existing.timestamps.length >= this.maxIpRequests) {
      const oldest = existing.timestamps[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.ipWindowMs - now) / 1000));
      this.ipWindows.set(key, existing);
      return {
        allowed: false,
        retryAfterSeconds,
        reason: 'Too many authentication requests from this address. Please wait before retrying.',
      };
    }

    existing.timestamps.push(now);
    this.ipWindows.set(key, existing);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  checkAccountLockout(accountKey: string): RateLimitCheckResult {
    const now = Date.now();
    const rec = this.accountFailures.get(accountKey);
    if (!rec) return { allowed: true, retryAfterSeconds: 0 };

    if (rec.lockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        reason: 'Too many failed passcode attempts. Account login is temporarily locked.',
      };
    }

    if (now - rec.firstAttemptAt > this.lockoutMs) {
      this.accountFailures.delete(accountKey);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(accountKey: string): void {
    const now = Date.now();
    const existing = this.accountFailures.get(accountKey);
    if (!existing || now - existing.firstAttemptAt > this.lockoutMs) {
      this.accountFailures.set(accountKey, {
        count: 1,
        firstAttemptAt: now,
        lockedUntil: 0,
      });
      return;
    }

    existing.count += 1;
    if (existing.count >= this.maxAccountFailures) {
      existing.lockedUntil = now + this.lockoutMs;
    }
    this.accountFailures.set(accountKey, existing);
  }

  clearFailures(accountKey: string): void {
    this.accountFailures.delete(accountKey);
  }
}
