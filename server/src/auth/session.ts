import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import type { Actor } from '../domain/rbac.js';

const secret = new TextEncoder().encode(config.sessionSecret);
export const SESSION_COOKIE = 'kando_session';

export async function signSession(actor: Actor): Promise<string> {
  return new SignJWT({ role: actor.role, orgId: actor.orgId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(actor.userId)
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlHours}h`)
    .sign(secret);
}

export async function verifySession(token: string): Promise<Actor | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      role: payload.role as Actor['role'],
      orgId: (payload.orgId as string | null) ?? null,
    };
  } catch {
    return null;
  }
}
