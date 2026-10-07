// Monta el API. Se exporta `app` para las pruebas; main.ts lo pone a escuchar.
import express from 'express';
import { authRouter } from './platform/auth-routes.ts';
import { workspaceRouter } from './platform/workspace-routes.ts';
import { requireAuth } from './platform/auth.ts';
import { workspaceContext } from './platform/workspace.ts';
import { chatRouter } from './chat/routes.ts';
import { filesRouter } from './files/routes.ts';
import { pushRouter } from './notifications/routes.ts';
import { docsRouter } from './docs/routes.ts';
import { tasksRouter } from './tasks/routes.ts';
import { goalsRouter } from './goals/routes.ts';
import { billingRouter, stripeWebhook } from './billing/routes.ts';
import { errorHandler, HttpError } from './platform/http.ts';

export const app = express();
app.set('trust proxy', 'loopback');   // detrás de Vite (dev) o Cloudflare Tunnel (piloto)
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' });
  next();
});
// Webhook de Stripe con el cuerpo crudo (la firma se calcula sobre los bytes exactos): antes de express.json
app.post('/api/v1/webhooks/stripe', express.raw({ type: () => true, limit: '1mb' }), stripeWebhook);
app.use(express.json({ limit: '1mb' }));

const api = express.Router();
api.use(authRouter);
api.use(pushRouter);

// Todo lo que vive bajo un workspace: sesión + membresía validada + contexto RLS
const ws = express.Router({ mergeParams: true });
ws.use(requireAuth, workspaceContext);
ws.use(workspaceRouter);
ws.use(billingRouter);
ws.use(chatRouter);
ws.use('/files', filesRouter);
ws.use(docsRouter, tasksRouter, goalsRouter);
api.use('/w/:slug', ws);

api.use((_req, _res) => { throw new HttpError(404, 'not_found', 'Ruta no encontrada'); });
app.use('/api/v1', api);
app.use(errorHandler);
