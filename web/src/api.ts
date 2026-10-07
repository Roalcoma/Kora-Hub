// Cliente tipado a partir del contrato: api('PATCH /w/:slug/members/:userId', { params, body }) → respuesta tipada.
import type { Routes, ApiError } from '@agencia-hub/contracts';
import { i18n } from '@/i18n/index.ts';

type Params<K extends string> = K extends `${string}:${infer P}/${infer Rest}` ? P | Params<`/${Rest}`>
  : K extends `${string}:${infer P}` ? P : never;
type Opts<K extends keyof Routes> =
  ([Params<K & string>] extends [never] ? { params?: undefined } : { params: Record<Params<K & string>, string> })
  & ([Routes[K]['body']] extends [never] ? { body?: undefined } : { body: Routes[K]['body'] })
  & { query?: Record<string, string | number | boolean | undefined> };

export class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, body: ApiError) {
    super(body.error);
    this.status = status;
    this.code = body.code;
  }
}

/** Llamadas sin sesión válida (401) disparan este gancho; el router redirige al login. */
export const onUnauthenticated = { handler: () => {} };
/** Escritura rechazada porque el plan dejó la agencia en solo lectura o suspendida (403); el shell refresca el estado. */
export const onWorkspaceBlocked = { handler: (_code: string) => {} };
const BLOCKED = ['workspace_read_only', 'workspace_suspended'];

export async function api<K extends keyof Routes>(key: K, ...[opts]: {} extends Opts<K> ? [Opts<K>?] : [Opts<K>]): Promise<Routes[K]['res']> {
  const [method, template] = (key as string).split(' ') as [string, string];
  const path = template.replace(/:(\w+)/g, (_, p) => encodeURIComponent((opts?.params as Record<string, string>)[p]!));
  const qs = opts?.query
    ? `?${new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`
    : '';
  const res = await fetch(`/api/v1${path}${qs}`, {
    method,
    headers: opts?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as unknown as Routes[K]['res'];
  const data = await res.json().catch(() => ({ error: 'Respuesta inválida del servidor', code: 'bad_response' }));
  if (!res.ok) {
    if (res.status === 401 && !key.startsWith('POST /auth/')) onUnauthenticated.handler();
    // Mensaje amable en vez del genérico: quien muestre e.message ya explica qué pasa y qué hacer
    if (res.status === 403 && BLOCKED.includes(data.code)) {
      data.error = i18n.global.t(`plan.errors.${data.code}`);
      onWorkspaceBlocked.handler(data.code);
    }
    throw new RequestError(res.status, data);
  }
  return data;
}
