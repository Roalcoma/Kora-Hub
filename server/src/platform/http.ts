import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';

/** Error con código HTTP y código estable para el cliente: `{ error, code }` */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const parse = <S extends z.ZodType>(schema: S, data: unknown): z.output<S> => schema.parse(data);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: err.issues[0]?.message ?? 'Datos inválidos', code: 'invalid_input', issues: err.issues });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido', code: 'invalid_json' });
  if (err?.code === '23505') return res.status(409).json({ error: 'Ya existe', code: 'conflict' });
  if (err?.code === '23503') return res.status(400).json({ error: 'Referencia inválida', code: 'invalid_reference' });
  console.error(JSON.stringify({ level: 'error', msg: err?.message, stack: err?.stack }));
  res.status(500).json({ error: 'Error interno', code: 'internal' });
};
