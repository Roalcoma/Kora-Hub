// Cliente S3 mínimo (MinIO): URLs prefirmadas SigV4 con node:crypto, sin SDK.
// Solo el backend habla con S3; el navegador sube y descarga a través de la API (ADR 0004).
import { createHash, createHmac } from 'node:crypto';

const cfg = () => ({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:59000',
  bucket: process.env.S3_BUCKET ?? 'agencia-hub',
  accessKey: process.env.S3_ACCESS_KEY ?? '',
  secretKey: process.env.S3_SECRET_KEY ?? '',
  region: process.env.S3_REGION ?? 'us-east-1',
});

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
// RFC 3986: encodeURIComponent deja sin codificar !'()* y S3 exige codificarlos
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** URL prefirmada (query string) para `method` sobre `key` (o el bucket si key es ''). */
export function presign(method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string, expiresSec = 300, now = new Date()): string {
  const c = cfg();
  const url = new URL(c.endpoint);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${c.region}/s3/aws4_request`;
  const path = `/${c.bucket}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${c.accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec)],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([k, v]) => `${enc(k!)}=${enc(v!)}`).sort().join('&');
  const canonical = [method, path, query, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${c.secretKey}`, date), c.region), 's3'), 'aws4_request');
  return `${url.origin}${path}?${query}&X-Amz-Signature=${hmac(kSigning, toSign).toString('hex')}`;
}

/** Crea el bucket si no existe (idempotente). */
export async function ensureBucket() {
  const res = await fetch(presign('PUT', ''), { method: 'PUT' });
  if (!res.ok && res.status !== 409) throw new Error(`No se pudo crear el bucket S3: ${res.status} ${await res.text()}`);
}
