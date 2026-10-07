// Subida directa del navegador a S3/MinIO con URL prefirmada.
// Flujo: POST /files (pide URL) → PUT a uploadUrl → POST /files/:id/complete → usar fileId en mensaje/manual.
import { z } from 'zod';
import { Id } from './common.ts';

export type FileRef = {
  id: Id; name: string; mime: string; size: number;
  width: number | null; height: number | null;
  url: string; thumbUrl: string | null;   // URLs prefirmadas de vida corta
};

export const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
] as const;

export const CreateUploadBody = z.object({
  name: z.string().min(1).max(255),
  mime: z.enum(ALLOWED_MIME),
  size: z.number().int().positive(),       // el backend valida contra settings.maxFileMb y la cuota
  context: z.enum(['message', 'document', 'avatar', 'logo', 'task']),
});
export type CreateUploadResponse = { fileId: Id; uploadUrl: string; headers: Record<string, string> };
