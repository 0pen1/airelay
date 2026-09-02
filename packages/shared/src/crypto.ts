import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

/**
 * Sign an HMAC-SHA256 over "<hostId>:<ts>" and return hex.
 */
export function signHmac(secret: string, hostId: string, ts: number): string {
  return createHmac('sha256', secret)
    .update(`${hostId}:${ts}`)
    .digest('hex');
}

/**
 * Verify HMAC signature and timestamp window.
 * Returns true only when |now - ts| <= windowSec AND sig matches.
 */
export function verifyHmac(
  secret: string,
  hostId: string,
  ts: number,
  sig: string,
  windowSec: number,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > windowSec) return false;
  const expected = signHmac(secret, hostId, ts);
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export interface JwtPayload {
  hostId: string;
  jti: string;
  exp: number;
}

/**
 * Sign a HS256 JWT using jose.
 */
export async function signJwt(
  hostSecret: string,
  payload: JwtPayload,
): Promise<string> {
  const secret = new TextEncoder().encode(hostSecret);
  return new SignJWT({ hostId: payload.hostId })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(payload.jti)
    .setIssuedAt()
    .setExpirationTime(payload.exp)
    .sign(secret);
}

/**
 * Verify a HS256 JWT and return the payload.
 * Throws if invalid or expired.
 */
export async function verifyJwt(
  hostSecret: string,
  token: string,
): Promise<JwtPayload> {
  const secret = new TextEncoder().encode(hostSecret);
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  if (!payload.jti || !payload.hostId) {
    throw new Error('Missing required JWT fields');
  }
  return {
    hostId: payload['hostId'] as string,
    jti: payload.jti,
    exp: payload.exp as number,
  };
}
