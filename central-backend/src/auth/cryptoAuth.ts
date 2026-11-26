import crypto from 'node:crypto';

const PWA_PASSCODE_SALT = 'agritrack_field_phase1_salt_2026';

export type AuthRole = 'employee' | 'admin';

export interface AuthClaims {
  role: AuthRole;
  employeeId?: string;
  deviceId?: string;
  subject: string;
  iat: number;
  exp: number;
}

const RUNTIME_EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');
let warnedNonProdSecret = false;

export function assertValidSessionSecretConfig(): void {
  const configured = process.env.SESSION_SECRET?.trim() || '';
  if (process.env.NODE_ENV === 'production') {
    if (configured.length < 32) {
      throw new Error(
        'FATAL: SESSION_SECRET must be explicitly configured with at least 32 characters when NODE_ENV=production.'
      );
    }
    return;
  }
  if (configured.length < 16 && !warnedNonProdSecret) {
    warnedNonProdSecret = true;
    console.warn(
      '[central-backend] SESSION_SECRET is unset; using ephemeral in-memory secret for non-production runtime only.'
    );
  }
}

export function getSessionSecret(): string {
  assertValidSessionSecretConfig();
  const configured = process.env.SESSION_SECRET?.trim() || '';
  return configured.length >= 16 ? configured : RUNTIME_EPHEMERAL_SECRET;
}

export function hashScrypt(secret: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyScrypt(secret: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, hexDigest] = parts;
  if (!salt || !hexDigest) return false;
  const candidate = crypto.scryptSync(secret, salt, 64);
  const expected = Buffer.from(hexDigest, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export function computePwaClientDigest(plainPasscode: string): string {
  return crypto
    .createHash('sha256')
    .update(`${PWA_PASSCODE_SALT}:${plainPasscode.trim()}`)
    .digest('hex');
}

export function computeAndroidClientDigest(plainPasscode: string): string {
  return crypto
    .createHash('sha256')
    .update(plainPasscode.trim())
    .digest('hex');
}

export function generateRefreshToken(): string {
  return `agr_rt_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}

export function signAuthToken(claims: AuthClaims): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAuthToken(token: string): AuthClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthClaims;
    if (!claims.role || !claims.subject || typeof claims.exp !== 'number') {
      return null;
    }
    if (Date.now() > claims.exp) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
