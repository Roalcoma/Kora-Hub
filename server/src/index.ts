// Monta el API. Se exporta `app` para las pruebas; main.ts lo pone a escuchar.
import express from 'express';
import { authRouter } from './platform/auth-routes.ts';
import { workspaceRouter } from './platform/workspace-routes.ts';
import { errorHandler, HttpError } from './platform/http.ts';

export const app = express();
app.set('trust proxy', 'loopback');   // detrás de Vite (dev) o Cloudflare Tunnel (piloto)
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' });
  next();
});
app.use(express.json({ limit: '1mb' }));

const api = express.Router();
api.use(authRouter);
api.use('/w/:slug', workspaceRouter);
api.use((_req, _res) => { throw new HttpError(404, 'not_found', 'Ruta no encontrada'); });
app.use('/api/v1', api);
app.use(errorHandler);
