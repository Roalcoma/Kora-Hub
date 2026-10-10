// /w/:slug — ventas y comisiones por agente (docs/plan-comisiones.md). Solo con settings.sales_module.
// Visibilidad: Admin ve todo; un dueño de agencia ve lo suyo y lo de sus agentes directos; el resto, solo lo suyo.
// Al marcar ISSUED se congelan % y montos en commission_installments: cambiar un % después no mueve lo generado.
import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import {
  Id, CarrierBody, UpdateCarrierBody, ProductBody, UpdateProductBody, UpdateAgentProfileBody, RateBody,
  SaleBody, UpdateSaleBody, IssueSaleBody, CancelSaleBody, SalesQuery, CommissionsQuery, PayInstallmentsBody,
  type Carrier, type AgentProfile, type Sale, type SalesList, type Installment, type CommissionsList, type InboxItem,
} from '@agencia-hub/contracts';
import { HttpError, parse, sendCsv } from '../platform/http.ts';
import { tx, isAdmin, requireRole, membersOnly } from '../platform/workspace.ts';
import { audit } from '../platform/model.ts';
import { commissionShares, installments, chargebackCents, toCents } from './commissions.ts';

export const salesRouter = Router({ mergeParams: true });

const PATHS = ['/carriers', '/products', '/agents', '/sales', '/sales.csv', '/commissions', '/commissions.csv', '/sales-inbox'];
salesRouter.use(PATHS, membersOnly, async (req: Request, _res: Response, next: NextFunction) => {
  const on = await tx(req, async (db) => (await db.query("select settings->>'sales_module' = 'true' as on from workspaces where id = app_ws()")).rows[0]?.on);
  if (!on) throw new HttpError(404, 'module_disabled', 'El módulo de ventas no está activo en esta agencia');
  next();
});

// ponytail: "hoy" en Nueva York para todas las agencias, igual que las semanas de metas
const TODAY = `(now() at time zone 'America/New_York')::date`;
const day = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;   // como texto: pg pasa `date` a medianoche local y corre el día
/** Alias en minúsculas y sin acentos: así compara el lector de Discord */
export const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const aliases = (list: string[]) => [...new Set(list.map(normalize).filter(Boolean))];

// ─── Compañías y productos ───

async function listCarriers(db: pg.PoolClient, id?: string): Promise<Carrier[]> {
  const { rows } = await db.query(
    `select c.*, coalesce(json_agg(json_build_object('id', p.id, 'carrierId', p.carrier_id, 'name', p.name, 'aliases', p.aliases,
       'archivedAt', p.archived_at) order by p.name) filter (where p.id is not null), '[]') as products
     from carriers c left join carrier_products p on p.carrier_id = c.id
     where $1::uuid is null or c.id = $1 group by c.id order by c.name`, [id ?? null]);
  return rows.map((r) => ({
    id: r.id, name: r.name, aliases: r.aliases, advanceMonths: r.advance_months, archivedAt: r.archived_at?.toISOString() ?? null,
    products: r.products,
  }));
}
const oneCarrier = async (db: pg.PoolClient, id: string) => {
  const c = (await listCarriers(db, id))[0];
  if (!c) throw new HttpError(404, 'carrier_not_found', 'Compañía no encontrada');
  return c;
};
const archivedSql = (n: number) => `archived_at = case when $${n}::boolean is null then archived_at when $${n} then coalesce(archived_at, now()) else null end`;

salesRouter.get('/carriers', async (req, res) => {
  res.json(await tx(req, (db) => listCarriers(db)));
});

salesRouter.post('/carriers', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(CarrierBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    const { rows } = await db.query(
      'insert into carriers (workspace_id, name, aliases, advance_months) values (app_ws(), $1, $2, $3) returning id',
      [body.name, aliases(body.aliases), body.advanceMonths]);
    return oneCarrier(db, rows[0].id);
  }));
});

salesRouter.patch('/carriers/:id', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const body = parse(UpdateCarrierBody, req.body);
  res.json(await tx(req, async (db) => {
    await db.query(
      `update carriers set name = coalesce($2, name), aliases = coalesce($3, aliases), advance_months = coalesce($4, advance_months),
         ${archivedSql(5)} where id = $1`,
      [id, body.name ?? null, body.aliases ? aliases(body.aliases) : null, body.advanceMonths ?? null, body.archived ?? null]);
    return oneCarrier(db, id);
  }));
});

salesRouter.post('/carriers/:id/products', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const body = parse(ProductBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    await oneCarrier(db, id);
    await db.query('insert into carrier_products (workspace_id, carrier_id, name, aliases) values (app_ws(), $1, $2, $3)',
      [id, body.name, aliases(body.aliases)]);
    return oneCarrier(db, id);
  }));
});

salesRouter.patch('/products/:id', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const body = parse(UpdateProductBody, req.body);
  res.json(await tx(req, async (db) => {
    const { rows } = await db.query(
      `update carrier_products set name = coalesce($2, name), aliases = coalesce($3, aliases), ${archivedSql(4)}
       where id = $1 returning carrier_id`,
      [id, body.name ?? null, body.aliases ? aliases(body.aliases) : null, body.archived ?? null]);
    if (!rows[0]) throw new HttpError(404, 'product_not_found', 'Producto no encontrado');
    return oneCarrier(db, rows[0].carrier_id);
  }));
});

// ─── Agentes: dueño de agencia, Discord y porcentajes ───

async function listAgents(db: pg.PoolClient, userId: string | null): Promise<AgentProfile[]> {
  const { rows } = await db.query(
    `select m.user_id, p.upline_user_id, p.discord_user_id,
       coalesce((select json_agg(json_build_object('productId', r.product_id, 'rate', r.rate, 'effectiveFrom', ${day('r.effective_from')})
                 order by r.product_id, r.effective_from desc)
                 from commission_rates r where r.user_id = m.user_id), '[]') as rates
     from workspace_members m left join agent_profiles p on p.workspace_id = m.workspace_id and p.user_id = m.user_id
     where m.workspace_id = app_ws() and m.role <> 'guest' and ($1::uuid is null or m.user_id = $1)
     order by m.joined_at`, [userId]);
  return rows.map((r) => ({
    userId: r.user_id, uplineUserId: r.upline_user_id, discordUserId: r.discord_user_id,
    rates: r.rates.map((x: any) => ({ ...x, rate: Number(x.rate) })),
  }));
}
const oneAgent = async (db: pg.PoolClient, userId: string) => {
  const a = (await listAgents(db, userId))[0];
  if (!a) throw new HttpError(404, 'member_not_found', 'Miembro no encontrado');
  return a;
};

salesRouter.get('/agents', async (req, res) => {
  res.json(await tx(req, (db) => listAgents(db, isAdmin(req) ? null : req.userId!)));
});

salesRouter.patch('/agents/:userId', async (req, res) => {
  requireRole(req, 'admin');
  const userId = Id.parse(req.params.userId);
  const body = parse(UpdateAgentProfileBody, req.body);
  if (body.uplineUserId === userId) throw new HttpError(400, 'self_upline', 'Un agente no puede ser su propio dueño de agencia');
  res.json(await tx(req, async (db) => {
    await oneAgent(db, userId);
    await db.query(
      `insert into agent_profiles (workspace_id, user_id, upline_user_id, discord_user_id) values (app_ws(), $1, $3, $5)
       on conflict (workspace_id, user_id) do update set
         upline_user_id = case when $2 then excluded.upline_user_id else agent_profiles.upline_user_id end,
         discord_user_id = case when $4 then excluded.discord_user_id else agent_profiles.discord_user_id end`,
      [userId, body.uplineUserId !== undefined, body.uplineUserId ?? null, body.discordUserId !== undefined, body.discordUserId ?? null]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'agent.profile_changed', targetType: 'user', targetId: userId, meta: body });
    return oneAgent(db, userId);
  }));
});

salesRouter.post('/agents/:userId/rates', async (req, res) => {
  requireRole(req, 'admin');
  const userId = Id.parse(req.params.userId);
  const body = parse(RateBody, req.body);
  res.json(await tx(req, async (db) => {
    await oneAgent(db, userId);
    await db.query(
      `insert into commission_rates (workspace_id, user_id, product_id, effective_from, rate, set_by)
       values (app_ws(), $1, $2, $3, $4, app_user())
       on conflict (workspace_id, user_id, product_id, effective_from) do update set rate = excluded.rate, set_by = excluded.set_by, set_at = now()`,
      [userId, body.productId, body.effectiveFrom, body.rate]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'agent.rate_set', targetType: 'user', targetId: userId, meta: body });
    return oneAgent(db, userId);
  }));
});

// ─── Ventas ───

/** Condición de visibilidad sobre el agente de la venta (alias `s`) */
const visibleSale = (req: Request) => isAdmin(req) ? 'true' :
  `(s.agent_user_id = app_user() or exists (select 1 from agent_profiles ap where ap.user_id = s.agent_user_id and ap.upline_user_id = app_user()))`;

const SALE_COLS = `s.*, p.carrier_id, ap.upline_user_id, ${day('s.expected_issue_date')} as expected, ${day('s.issued_at')} as issued,
  (s.status = 'pending' and s.expected_issue_date < ${TODAY}) as overdue`;
const SALE_FROM = `sales s join carrier_products p on p.id = s.product_id
  left join agent_profiles ap on ap.workspace_id = s.workspace_id and ap.user_id = s.agent_user_id`;

const toSale = (r: any): Sale => ({
  id: r.id, agentUserId: r.agent_user_id, uplineUserId: r.upline_user_id, carrierId: r.carrier_id, productId: r.product_id,
  amount: Number(r.amount), clientName: r.client_name, clientState: r.client_state,
  expectedIssueDate: r.expected, issuedAt: r.issued, status: r.status, overdue: r.overdue,
  source: r.source, notes: r.notes, createdAt: r.created_at.toISOString(),
});

async function querySales(req: Request, q: ReturnType<typeof SalesQuery.parse>): Promise<Sale[]> {
  return tx(req, async (db) => (await db.query(
    `select ${SALE_COLS} from ${SALE_FROM}
     where ${visibleSale(req)}
       and ($1::date is null or s.expected_issue_date >= $1) and ($2::date is null or s.expected_issue_date <= $2)
       and ($3::uuid is null or s.agent_user_id = $3) and ($4::uuid is null or p.carrier_id = $4)
       and ($5::uuid is null or s.product_id = $5) and ($6::text is null or s.status = $6)
       and ($7::boolean is null or (s.status = 'pending' and s.expected_issue_date < ${TODAY}) = $7)
     order by s.expected_issue_date desc, s.created_at desc limit 2000`,
    [q.from ?? null, q.to ?? null, q.agentUserId ?? null, q.carrierId ?? null, q.productId ?? null, q.status ?? null, q.overdue ?? null],
  )).rows.map(toSale));
}

async function oneSale(db: pg.PoolClient, id: string, lock = false): Promise<Sale> {
  const { rows } = await db.query(`select ${SALE_COLS} from ${SALE_FROM} where s.id = $1 ${lock ? 'for update of s' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'sale_not_found', 'Venta no encontrada');
  return toSale(rows[0]);
}

salesRouter.get('/sales', async (req, res) => {
  const items = await querySales(req, parse(SalesQuery, req.query));
  const sum = (f: (s: Sale) => boolean) => items.filter(f).reduce((t, s) => t + toCents(s.amount), 0) / 100;
  const out: SalesList = {
    items,
    totals: { count: items.length, amount: sum(() => true), issued: sum((s) => s.status === 'issued'), pending: sum((s) => s.status === 'pending') },
  };
  res.json(out);
});

salesRouter.get('/sales.csv', async (req, res) => {
  const items = await querySales(req, parse(SalesQuery, req.query));
  const names = await nameMaps(req);
  sendCsv(res, 'ventas.csv', [
    ['Agente', 'Dueño de agencia', 'Compañía', 'Producto', 'Monto', 'Cliente', 'Estado (US)', 'Fecha esperada', 'ISSUE', 'Estado', 'Origen'],
    ...items.map((s) => [names.get(s.agentUserId), s.uplineUserId ? names.get(s.uplineUserId) : '', names.get(s.carrierId), names.get(s.productId),
      s.amount.toFixed(2), s.clientName, s.clientState ?? '', s.expectedIssueDate, s.issuedAt ?? '', s.status, s.source]),
  ]);
});

salesRouter.post('/sales', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(SaleBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    const inbox = body.inboxId ? (await db.query('select * from sale_inbox where id = $1 and resolved_at is null for update', [body.inboxId])).rows[0] : null;
    if (body.inboxId && !inbox) throw new HttpError(404, 'inbox_not_found', 'Ese mensaje ya se resolvió o no existe');
    const { rows } = await db.query(
      `insert into sales (workspace_id, agent_user_id, product_id, amount, client_name, client_state, expected_issue_date, notes,
         source, discord_message_id, created_by)
       values (app_ws(), $1, $2, $3, $4, $5, $6, $7, $8, $9, app_user()) returning id`,
      [body.agentUserId, body.productId, body.amount, body.clientName, body.clientState, body.expectedIssueDate, body.notes,
        inbox ? 'discord' : 'manual', inbox?.discord_message_id ?? null]);
    if (inbox) await db.query('update sale_inbox set resolved_at = now(), resolved_by = app_user(), sale_id = $2 where id = $1', [inbox.id, rows[0].id]);
    return oneSale(db, rows[0].id);
  }));
});

salesRouter.patch('/sales/:id', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const body = parse(UpdateSaleBody, req.body);
  res.json(await tx(req, async (db) => {
    const before = await oneSale(db, id, true);
    if (before.status !== 'pending') throw new HttpError(409, 'sale_not_pending', 'Solo se editan ventas pendientes de ISSUE');
    await db.query(
      `update sales set agent_user_id = coalesce($2, agent_user_id), product_id = coalesce($3, product_id), amount = coalesce($4, amount),
         client_name = coalesce($5, client_name), client_state = case when $6 then $7 else client_state end,
         expected_issue_date = coalesce($8, expected_issue_date), notes = coalesce($9, notes), updated_at = now()
       where id = $1`,
      [id, body.agentUserId ?? null, body.productId ?? null, body.amount ?? null, body.clientName ?? null,
        body.clientState !== undefined, body.clientState ?? null, body.expectedIssueDate ?? null, body.notes ?? null]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'sale.edited', targetType: 'sale', targetId: id, meta: body });
    return oneSale(db, id);
  }));
});

/** % vigente del agente en el producto a la fecha de ISSUE (el más reciente con vigencia <= fecha) */
async function rateAt(db: pg.PoolClient, userId: string, productId: string, date: string): Promise<number | null> {
  const { rows } = await db.query(
    `select rate from commission_rates where user_id = $1 and product_id = $2 and effective_from <= $3
     order by effective_from desc limit 1`, [userId, productId, date]);
  return rows[0] ? Number(rows[0].rate) : null;
}

salesRouter.post('/sales/:id/issue', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const { issuedAt } = parse(IssueSaleBody, req.body);
  res.json(await tx(req, async (db) => {
    const sale = await oneSale(db, id, true);
    if (sale.status !== 'pending') throw new HttpError(409, 'sale_not_pending', 'Esta venta ya no está pendiente de ISSUE');
    const who = async (uid: string) => (await db.query('select name from users where id = $1', [uid])).rows[0]?.name ?? '';

    const agentRate = await rateAt(db, sale.agentUserId, sale.productId, issuedAt);
    if (agentRate == null) throw new HttpError(409, 'missing_rate', `${await who(sale.agentUserId)} no tiene porcentaje para este producto a esa fecha`);
    let upline: { userId: string; rate: number } | null = null;
    if (sale.uplineUserId) {
      const r = await rateAt(db, sale.uplineUserId, sale.productId, issuedAt);
      if (r == null) throw new HttpError(409, 'missing_rate', `${await who(sale.uplineUserId)} (dueño de agencia) no tiene porcentaje para este producto a esa fecha`);
      upline = { userId: sale.uplineUserId, rate: r };
    }
    const { advance_months } = (await db.query('select advance_months from carriers where id = $1', [sale.carrierId])).rows[0];
    for (const i of installments(toCents(sale.amount), advance_months, commissionShares({ userId: sale.agentUserId, rate: agentRate }, upline))) {
      await db.query(
        `insert into commission_installments (workspace_id, sale_id, beneficiary_user_id, kind, part, rate, amount, due_date)
         values (app_ws(), $1, $2, $3, $4, $5, $6, $7::date + make_interval(months => $8))`,
        [id, i.beneficiaryUserId, i.kind, i.part, i.rate, i.amountCents / 100, issuedAt, i.monthsAfterIssue]);
    }
    await db.query("update sales set status = 'issued', issued_at = $2, updated_at = now() where id = $1", [id, issuedAt]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'sale.issued', targetType: 'sale', targetId: id, meta: { issuedAt } });
    return oneSale(db, id);
  }));
});

salesRouter.post('/sales/:id/decline', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    const sale = await oneSale(db, id, true);
    if (sale.status !== 'pending') throw new HttpError(409, 'sale_not_pending', 'Solo se rechaza una venta pendiente; si ya tuvo ISSUE, cancélala');
    await db.query("update sales set status = 'declined', updated_at = now() where id = $1", [id]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'sale.declined', targetType: 'sale', targetId: id });
    return oneSale(db, id);
  }));
});

salesRouter.post('/sales/:id/cancel', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const { chargebackPercent } = parse(CancelSaleBody, req.body);
  res.json(await tx(req, async (db) => {
    const sale = await oneSale(db, id, true);
    if (sale.status !== 'issued') throw new HttpError(409, 'sale_not_issued', 'Solo se cancela una venta con ISSUE; si está pendiente, recházala');
    // Lo no pagado se anula; sobre lo ya pagado la compañía descuenta el % indicado
    await db.query("update commission_installments set status = 'void' where sale_id = $1 and status = 'pending'", [id]);
    const paid = (await db.query(
      `select beneficiary_user_id, kind, max(rate) as rate, sum(amount) as amount from commission_installments
       where sale_id = $1 and status = 'paid' and part <> 'chargeback' group by beneficiary_user_id, kind`, [id])).rows;
    for (const p of paid) {
      const cents = chargebackCents(toCents(p.amount), chargebackPercent);
      if (cents >= 0) continue;
      await db.query(
        `insert into commission_installments (workspace_id, sale_id, beneficiary_user_id, kind, part, rate, amount, due_date)
         values (app_ws(), $1, $2, $3, 'chargeback', $4, $5, ${TODAY})`,
        [id, p.beneficiary_user_id, p.kind, p.rate, cents / 100]);
    }
    await db.query("update sales set status = 'cancelled', updated_at = now() where id = $1", [id]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'sale.cancelled', targetType: 'sale', targetId: id, meta: { chargebackPercent } });
    return oneSale(db, id);
  }));
});

// ─── Comisiones ───

async function queryInstallments(req: Request, q: ReturnType<typeof CommissionsQuery.parse>): Promise<Installment[]> {
  // El agente ve solo sus cuotas (no el override que su venta le deja al dueño); el dueño ve además las de sus agentes
  const visible = isAdmin(req) ? 'true' : `(i.beneficiary_user_id = app_user()
    or exists (select 1 from agent_profiles ap where ap.user_id = s.agent_user_id and ap.upline_user_id = app_user()))`;
  return tx(req, async (db) => (await db.query(
    `select i.*, ${day('i.due_date')} as due, ${day('i.paid_at')} as paid, s.agent_user_id, s.product_id, p.carrier_id,
       s.client_name, s.amount as sale_amount, ${day('s.issued_at')} as issued, s.status as sale_status
     from commission_installments i join sales s on s.id = i.sale_id join carrier_products p on p.id = s.product_id
     where ${visible}
       and ($1::date is null or i.due_date >= $1) and ($2::date is null or i.due_date <= $2)
       and ($3::uuid is null or i.beneficiary_user_id = $3) and ($4::text is null or i.status = $4)
     order by i.due_date, s.client_name, i.kind limit 5000`,
    [q.from ?? null, q.to ?? null, q.beneficiaryUserId ?? null, q.status ?? null],
  )).rows.map((r) => ({
    id: r.id, saleId: r.sale_id, beneficiaryUserId: r.beneficiary_user_id, kind: r.kind, part: r.part,
    rate: Number(r.rate), amount: Number(r.amount), dueDate: r.due, status: r.status, paidAt: r.paid,
    sale: { agentUserId: r.agent_user_id, carrierId: r.carrier_id, productId: r.product_id, clientName: r.client_name,
      amount: Number(r.sale_amount), issuedAt: r.issued, status: r.sale_status },
  })));
}

salesRouter.get('/commissions', async (req, res) => {
  const items = await queryInstallments(req, parse(CommissionsQuery, req.query));
  const sum = (st: string) => items.filter((i) => i.status === st).reduce((t, i) => t + toCents(i.amount), 0) / 100;
  const out: CommissionsList = { items, totals: { pending: sum('pending'), paid: sum('paid') } };
  res.json(out);
});

salesRouter.get('/commissions.csv', async (req, res) => {
  const items = await queryInstallments(req, parse(CommissionsQuery, req.query));
  const names = await nameMaps(req);
  const PART = { advance: 'Adelanto', remainder: 'Resto 12 meses', chargeback: 'Chargeback' };
  sendCsv(res, 'comisiones.csv', [
    ['Beneficiario', 'Tipo', 'Cuota', 'Agente', 'Cliente', 'Compañía', 'Producto', 'Monto venta', '%', 'Comisión', 'Fecha de pago', 'Estado', 'Pagada el'],
    ...items.map((i) => [names.get(i.beneficiaryUserId), i.kind === 'direct' ? 'Directa' : 'Override', PART[i.part], names.get(i.sale.agentUserId),
      i.sale.clientName, names.get(i.sale.carrierId), names.get(i.sale.productId), i.sale.amount.toFixed(2), i.rate, i.amount.toFixed(2),
      i.dueDate, i.status, i.paidAt ?? '']),
  ]);
});

salesRouter.post('/commissions/pay', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(PayInstallmentsBody, req.body);
  await tx(req, async (db) => {
    const { rowCount } = await db.query(
      `update commission_installments set status = case when $2::date is null then 'pending' else 'paid' end, paid_at = $2
       where id = any($1) and status <> 'void'`, [body.ids, body.paidAt]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'commission.paid', meta: { ...body, updated: rowCount } });
  });
  res.status(204).end();
});

// ─── Bandeja de Discord ───

salesRouter.get('/sales-inbox', async (req, res) => {
  requireRole(req, 'admin');
  res.json(await tx(req, async (db) => (await db.query(
    'select * from sale_inbox where resolved_at is null order by posted_at desc limit 500')).rows.map((r): InboxItem => ({
    id: r.id, discordUserId: r.discord_user_id, authorName: r.author_name, content: r.content, postedAt: r.posted_at.toISOString(),
    parsed: r.parsed, problems: r.problems,
  }))));
});

salesRouter.post('/sales-inbox/:id/dismiss', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const { rowCount } = await db.query('update sale_inbox set resolved_at = now(), resolved_by = app_user() where id = $1 and resolved_at is null', [id]);
    if (!rowCount) throw new HttpError(404, 'inbox_not_found', 'Ese mensaje ya se resolvió o no existe');
  });
  res.status(204).end();
});

/** Nombres de miembros, compañías y productos para los CSV */
const nameMaps = (req: Request) => tx(req, async (db) => new Map<string, string>([
  ...(await db.query('select u.id, u.name from workspace_members m join users u on u.id = m.user_id where m.workspace_id = app_ws()')).rows,
  ...(await db.query('select id, name from carriers')).rows,
  ...(await db.query('select id, name from carrier_products')).rows,
].map((r) => [r.id, r.name])));
