// Contraseñas (scrypt), sesión JWT HS256 en cookie httpOnly, TOTP (RFC 6238) y rate-limit. Solo node:crypto.
import { scrypt, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import { adminPool } from '../db.ts';
import { HttpError } from './http.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [, salt, hash] = stored?.split('$') ?? [];
  if (!salt || !hash) {
    await scryptAsync(password, randomBytes(16), 64); // mismo tiempo de respuesta si el usuario no existe
    return false;
  }
  const candidate = await scryptAsync(password, Buffer.from(salt, 'base64url'), 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'base64url'));
}

/** Tokens de un solo uso (invitaciones, reset): el cliente recibe el token, la BD guarda solo su hash */
export const newToken = () => randomBytes(24).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ─── JWT ───

const SESSION_DAYS = 30;
const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET falta o tiene menos de 32 caracteres');
  return s;
};
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');

/** Claim de impersonación (ADR 0005 §4): `by` = superadmin, `ws` = workspace, `exp` = fin en segundos */
export type ImpClaim = { by: string; ws: string; exp: number };
export const IMPERSONATION_MINUTES = 30;

export function signJwt(userId: string, tokenVersion: number, imp?: ImpClaim): string {
  const exp = imp?.exp ?? Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, tv: tokenVersion, exp, ...(imp ? { imp } : {}) })}`;
  return `${body}.${sign(body)}`;
}

export function verifyJwt(token: string): { sub: string; tv: number; imp?: ImpClaim } | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const expected = Buffer.from(sign(`${h}.${p}`));
  const got = Buffer.from(s);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  return payload.exp > Date.now() / 1000 ? payload : null;
}

// ─── Cookie de sesión ───

const COOKIE = 'ah_session';

export function setSessionCookie(res: Response, userId: string, tokenVersion: number, imp?: ImpClaim) {
  res.cookie(COOKIE, signJwt(userId, tokenVersion, imp), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: imp ? imp.exp * 1000 - Date.now() : SESSION_DAYS * 86400_000, path: '/',
  });
}
export const clearSessionCookie = (res: Response) => res.clearCookie(COOKIE, { path: '/' });

function readCookie(req: Request, name: string): string | undefined {
  for (const part of req.headers.cookie?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

declare module 'express-serve-static-core' {
  interface Request { userId?: string; imp?: ImpClaim | null }
}

/** Resuelve la sesión si existe; valida token_version para que "cerrar sesión en todos" la revoque. */
export async function loadClaims(req: Request): Promise<{ userId: string; imp: ImpClaim | null } | null> {
  const token = readCookie(req, COOKIE);
  const claims = token ? verifyJwt(token) : null;
  if (!claims) return null;
  const { rows } = await adminPool.query('select token_version from users where id = $1', [claims.sub]);
  return rows[0]?.token_version === claims.tv ? { userId: claims.sub, imp: claims.imp ?? null } : null;
}

export async function loadSession(req: Request): Promise<string | null> {
  return (await loadClaims(req))?.userId ?? null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const claims = await loadClaims(req);
  if (!claims) throw new HttpError(401, 'unauthenticated', 'Inicia sesión');
  req.userId = claims.userId;
  req.imp = claims.imp;
  next();
}

/** Lo que una sesión impersonada nunca puede hacer: /admin, contraseña, 2FA, cerrar sesiones, facturación de escritura. */
export function forbidImpersonation(req: Request) {
  if (req.imp) throw new HttpError(403, 'impersonation_forbidden', 'No disponible mientras ves la cuenta como otra persona');
}

// ─── TOTP (RFC 6238: SHA-1, 6 dígitos, 30 s) ───

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  return [...randomBytes(20)].map((b) => B32[b & 31]).join('');
}
function base32Decode(s: string): Buffer {
  let bits = '';
  for (const c of s.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}
export function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** Acepta ±1 paso de reloj */
export function verifyTotp(secret: string, code: string): boolean {
  const now = Math.floor(Date.now() / 30_000);
  return [now - 1, now, now + 1].some((s) => totpCode(secret, s) === code);
}

// ─── Rate-limit ───
// ponytail: en memoria por instancia; con varias instancias pasar a una tabla o a Postgres.
const hits = new Map<string, number[]>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new HttpError(429, 'rate_limited', 'Demasiados intentos, espera unos minutos');
  recent.push(now);
  hits.set(key, recent);
}
