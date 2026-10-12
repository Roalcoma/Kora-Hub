// /w/:slug/finance — gastos, nómina y estados de cuenta (docs/plan-finanzas.md, ADR 0007). Solo con
// settings.finance_module y para Owner, Admin o Contable; el resto recibe 404 como si el módulo no existiera.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../platform/http.ts';
import { tx } from '../platform/workspace.ts';
import { expensesRouter } from './expenses.ts';
import { payrollRouter } from './payroll.ts';
import { bankRouter } from './bank.ts';
import { summaryRouter } from './summary.ts';

export const financeRouter = Router({ mergeParams: true });

financeRouter.use('/finance', async (req: Request, _res: Response, next: NextFunction) => {
  if (!['owner', 'admin', 'accountant'].includes(req.ws!.role)) throw new HttpError(404, 'not_found', 'No encontrado');
  const on = await tx(req, async (db) => (await db.query("select settings->>'finance_module' = 'true' as on from workspaces where id = app_ws()")).rows[0]?.on);
  if (!on) throw new HttpError(404, 'module_disabled', 'El módulo de finanzas no está activo en esta agencia');
  next();
});
financeRouter.use('/finance', expensesRouter, payrollRouter, bankRouter, summaryRouter);
