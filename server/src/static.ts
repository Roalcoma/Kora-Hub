// Producción: el mismo proceso sirve la SPA (WEB_DIST, con fallback a index.html) y, si la petición llega por
// LANDING_HOST, la landing estática (LANDING_DIR). /api y /ws nunca pasan por aquí.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';

const isApi = (p: string) => p === '/api' || p.startsWith('/api/') || p === '/ws' || p.startsWith('/ws/');

// Los assets de Vite llevan hash en el nombre: caché larga. El HTML y el service worker, nunca.
const setHeaders = (res: Response, path: string) => {
  if (/[/\\]assets[/\\]/.test(path)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  else if (/\.html$|sw\.js$|manifest/.test(path)) res.setHeader('cache-control', 'no-cache');
};

/** Middleware de estáticos, o null si no hay WEB_DIST (desarrollo: Vite sirve la web). */
export function staticSite() {
  const webDist = process.env.WEB_DIST && resolve(process.env.WEB_DIST);
  if (!webDist || !existsSync(webDist)) return null;
  const landingDir = process.env.LANDING_DIR && resolve(process.env.LANDING_DIR);
  const landingHost = process.env.LANDING_HOST?.toLowerCase();
  const web = express.static(webDist, { index: false, setHeaders });
  const landing = landingDir && landingHost && existsSync(landingDir) ? express.static(landingDir, { setHeaders }) : null;

  return (req: Request, res: Response, next: NextFunction) => {
    if (isApi(req.path) || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    if (landing && req.hostname.toLowerCase() === landingHost) {
      return landing(req, res, () => res.status(404).sendFile(join(landingDir!, existsSync(join(landingDir!, '404.html')) ? '404.html' : 'index.html')));
    }
    web(req, res, () => {
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  };
}
