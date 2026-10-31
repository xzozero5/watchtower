import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';

const ISSUER = 'watchtower';
const AUDIENCE = 'watchtower:api';

export interface AccessClaims {
  readonly userId: string;
  readonly sessionId: string;
}

export interface VerifiedAccessClaims extends AccessClaims {
  readonly expiresAt: Date;
}

/** A random secret that is shown once (to the browser or in an email) and stored only as a hash. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex. Fast hashing is right here: the input is 256 random bits, not a password. */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison that does not throw on a length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Access JWTs (HS256, short lived), the CSRF token of a session and signed short-lived cookies. */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  private readonly csrfKey: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: ApiConfig) {
    this.key = new TextEncoder().encode(config.JWT_SECRET);
    // A separate subkey, so a CSRF token can never be replayed as anything else.
    this.csrfKey = createHmac('sha256', config.JWT_SECRET).update('watchtower:csrf:v1').digest();
  }

  async signAccessToken(
    claims: AccessClaims,
  ): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.config.ACCESS_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(claims.userId)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt };
  }

  /** Null for any invalid token: bad signature, wrong issuer or audience, expired, malformed. */
  async verifyAccessToken(token: string): Promise<VerifiedAccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const sessionId = payload.sid;
      if (typeof payload.sub !== 'string' || typeof sessionId !== 'string') return null;
      if (typeof payload.exp !== 'number') return null;
      return { userId: payload.sub, sessionId, expiresAt: new Date(payload.exp * 1000) };
    } catch {
      return null;
    }
  }

  /**
   * Signed, short-lived value for a cookie that must not be forged or tampered with (the OIDC
   * state). `purpose` keeps it from being accepted where another kind of token is expected.
   */
  async signCookieValue(
    purpose: string,
    payload: Record<string, string>,
    ttlSeconds: number,
  ): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(`watchtower:${purpose}`)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
      .sign(this.key);
  }

  async verifyCookieValue(purpose: string, value: string): Promise<Record<string, unknown> | null> {
    try {
      const { payload } = await jwtVerify(value, this.key, {
        issuer: ISSUER,
        audience: `watchtower:${purpose}`,
        algorithms: ['HS256'],
      });
      return payload;
    } catch {
      return null;
    }
  }

  /** The CSRF token of a session: an HMAC of the session id. Only a caller who read the session response knows it. */
  csrfTokenFor(sessionId: string): string {
    return createHmac('sha256', this.csrfKey).update(sessionId).digest('base64url');
  }

  isValidCsrfToken(sessionId: string, presented: string | undefined): boolean {
    return presented !== undefined && safeEqual(this.csrfTokenFor(sessionId), presented);
  }
}
