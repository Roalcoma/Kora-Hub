// /w/:slug — ventas y comisiones por agente (docs/plan-comisiones.md). Solo con settings.sales_module.
// Visibilidad: Admin ve todo; un dueño de agencia ve lo suyo y lo de sus agentes directos; el resto, solo lo suyo.
// El % sale del nivel de contrato del agente (FFL) cruzado con la tabla del producto, ambos vigentes a la fecha de ISSUE.
// Al marcar ISSUED se congelan nivel, % y montos en commission_installments: un ascenso después no mueve lo generado.
import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import {
  Id, CarrierBody, UpdateCarrierBody, ProductBody, UpdateProductBody, GridBody, UpdateAgentProfileBody, LevelBody,
  SaleBody, UpdateSaleBody, IssueSaleBody, CancelSaleBody, SalesQuery, CommissionsQuery, PayInstallmentsBody, DiscordFeedBody, LinkInboxAuthorBody,
  type Carrier, type AgentProfile, type Sale, type SalesList, type Installment, type CommissionsList, type InboxItem, type DiscordFeed,
} from '@agencia-hub/contracts';
import { HttpError, parse, sendCsv } from '../platform/http.ts';
import { tx, isAdmin, requireRole, membersOnly } from '../platform/workspace.ts';
import { audit } from '../platform/model.ts';
import { commissionShares, installments, chargebackCents, toCents } from './commissions.ts';
import { discordConfigured, retryInbox, snowflakeAt } from './discord.ts';

export const salesRouter = Router({ mergeParams: true });

const PATHS = ['/carriers', '/products', '/agents', '/sales', '/sales.csv', '/commissions', '/commissions.csv', '/sales-inbox', '/discord-feed'];
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
       'archivedAt', p.archived_at, 'grids', coalesce((
         select json_agg(json_build_object('effectiveFrom', g.ef, 'rows', g.rows) order by g.ef desc)
         from (select ${day('effective_from')} as ef, json_agg(json_build_object('level', level, 'rate', rate::float) order by level desc) as rows
               from comp_grid where product_id = p.id group by effective_from) g), '[]'))
       order by p.name) filter (where p.id is not null), '[]') as products
     from carriers c left join carrier_products p on p.carrier_id = c.id
     where $1::uuid is null or c.id = $1 group by c.id order by c.name`, [id ?? null]);
  return rows.map((r) => ({
    id: r.id, name: r.name, aliases: r.aliases, advanceMonths: r.advance_months, archivedAt: r.archived_at?.toISOString() ?? null,
    products: r.products, defaultProductId: r.default_product_id,
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
    if (body.defaultProductId && !(await db.query('select 1 from carrier_products where id = $1 and carrier_id = $2', [body.defaultProductId, id])).rowCount) {
      throw new HttpError(400, 'invalid_product', 'El producto por defecto debe ser de esta compañía');
    }
    await db.query(
      `update carriers set name = coalesce($2, name), aliases = coalesce($3, aliases), advance_months = coalesce($4, advance_months),
         ${archivedSql(5)}, default_product_id = case when $6 then $7::uuid else default_product_id end where id = $1`,
      [id, body.name ?? null, body.aliases ? aliases(body.aliases) : null, body.advanceMonths ?? null, body.archived ?? null,
        body.defaultProductId !== undefined, body.defaultProductId ?? null]);
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

salesRouter.put('/products/:id/grid', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const body = parse(GridBody, req.body);
  res.json(await tx(req, async (db) => {
    const p = (await db.query('select carrier_id from carrier_products where id = $1', [id])).rows[0];
    if (!p) throw new HttpError(404, 'product_not_found', 'Producto no encontrado');
    await db.query('delete from comp_grid where product_id = $1 and effective_from = $2', [id, body.effectiveFrom]);
    await db.query(
      `insert into comp_grid (workspace_id, product_id, effective_from, level, rate)
       select app_ws(), $1, $2, x.level, x.rate from json_to_recordset($3) as x(level int, rate numeric)`,
      [id, body.effectiveFrom, JSON.stringify(body.rows)]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'product.grid_set', targetType: 'product', targetId: id, meta: body });
    return oneCarrier(db, p.carrier_id);
  }));
});

// ─── Agentes: dueño de agencia, Discord y nivel de contrato ───

async function listAgents(db: pg.PoolClient, userId: string | null): Promise<AgentProfile[]> {
  const { rows } = await db.query(
    `select m.user_id, p.upline_user_id, p.discord_user_id,
       coalesce((select json_agg(json_build_object('level', l.level, 'effectiveFrom', ${day('l.effective_from')}) order by l.effective_from desc)
                 from agent_levels l where l.user_id = m.user_id), '[]') as levels
     from workspace_members m left join agent_profiles p on p.workspace_id = m.workspace_id and p.user_id = m.user_id
     where m.workspace_id = app_ws() and m.role <> 'guest' and ($1::uuid is null or m.user_id = $1)
     order by m.joined_at`, [userId]);
  return rows.map((r) => ({
    userId: r.user_id, uplineUserId: r.upline_user_id, discordUserId: r.discord_user_id, levels: r.levels,
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
    // Sus mensajes que esperaban en la bandeja por no estar enlazado se vuelven ventas
    if (body.discordUserId) await retryInbox(db, body.discordUserId);
    return oneAgent(db, userId);
  }));
});

salesRouter.post('/agents/:userId/levels', async (req, res) => {
  requireRole(req, 'admin');
  const userId = Id.parse(req.params.userId);
  const body = parse(LevelBody, req.body);
  res.json(await tx(req, async (db) => {
    await oneAgent(db, userId);
    await db.query(
      `insert into agent_levels (workspace_id, user_id, effective_from, level, set_by) values (app_ws(), $1, $2, $3, app_user())
       on conflict (workspace_id, user_id, effective_from) do update set level = excluded.level, set_by = excluded.set_by, set_at = now()`,
      [userId, body.effectiveFrom, body.level]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'agent.level_set', targetType: 'user', targetId: userId, meta: body });
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

/** Nivel del agente y su % en el producto a la fecha de ISSUE (nivel y tabla: los más recientes con vigencia <= fecha) */
async function rateAt(db: pg.PoolClient, userId: string, productId: string, date: string) {
  const who = (await db.query('select name from users where id = $1', [userId])).rows[0]?.name ?? '';
  const lvl = (await db.query(
    'select level from agent_levels where user_id = $1 and effective_from <= $2 order by effective_from desc limit 1', [userId, date])).rows[0];
  if (!lvl) throw new HttpError(409, 'missing_level', `${who} no tiene nivel de contrato a esa fecha`);
  const { rows } = await db.query(
    `select g.rate, p.name from carrier_products p left join comp_grid g on g.product_id = p.id and g.level = $2
       and g.effective_from = (select max(effective_from) from comp_grid where product_id = p.id and effective_from <= $3)
     where p.id = $1`, [productId, lvl.level, date]);
  if (rows[0]?.rate == null) throw new HttpError(409, 'missing_rate', `La tabla de ${rows[0]?.name ?? 'este producto'} no tiene el nivel ${lvl.level} de ${who} a esa fecha`);
  return { userId, level: lvl.level as number, rate: Number(rows[0].rate) };
}

salesRouter.post('/sales/:id/issue', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const { issuedAt } = parse(IssueSaleBody, req.body);
  res.json(await tx(req, async (db) => {
    const sale = await oneSale(db, id, true);
    if (sale.status !== 'pending') throw new HttpError(409, 'sale_not_pending', 'Esta venta ya no está pendiente de ISSUE');
    const agent = await rateAt(db, sale.agentUserId, sale.productId, issuedAt);
    const upline = sale.uplineUserId ? await rateAt(db, sale.uplineUserId, sale.productId, issuedAt) : null;
    const levels = new Map([[agent.userId, agent.level], ...(upline ? [[upline.userId, upline.level] as const] : [])]);
    const { advance_months } = (await db.query('select advance_months from carriers where id = $1', [sale.carrierId])).rows[0];
    for (const i of installments(toCents(sale.amount), advance_months, commissionShares(agent, upline))) {
      await db.query(
        `insert into commission_installments (workspace_id, sale_id, beneficiary_user_id, kind, part, level, rate, amount, due_date)
         values (app_ws(), $1, $2, $3, $4, $5, $6, $7, $8::date + make_interval(months => $9))`,
        [id, i.beneficiaryUserId, i.kind, i.part, levels.get(i.beneficiaryUserId), i.rate, i.amountCents / 100, issuedAt, i.monthsAfterIssue]);
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
      `select beneficiary_user_id, kind, max(level) as level, max(rate) as rate, sum(amount) as amount from commission_installments
       where sale_id = $1 and status = 'paid' and part <> 'chargeback' group by beneficiary_user_id, kind`, [id])).rows;
    for (const p of paid) {
      const cents = chargebackCents(toCents(p.amount), chargebackPercent);
      if (cents >= 0) continue;
      await db.query(
        `insert into commission_installments (workspace_id, sale_id, beneficiary_user_id, kind, part, level, rate, amount, due_date)
         values (app_ws(), $1, $2, $3, 'chargeback', $4, $5, $6, ${TODAY})`,
        [id, p.beneficiary_user_id, p.kind, p.level, p.rate, cents / 100]);
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
    level: r.level, rate: Number(r.rate), amount: Number(r.amount), dueDate: r.due, status: r.status, paidAt: r.paid,
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
    ['Beneficiario', 'Tipo', 'Cuota', 'Agente', 'Cliente', 'Compañía', 'Producto', 'Monto venta', 'Nivel', '%', 'Comisión', 'Fecha de pago', 'Estado', 'Pagada el'],
    ...items.map((i) => [names.get(i.beneficiaryUserId), i.kind === 'direct' ? 'Directa' : 'Override', PART[i.part], names.get(i.sale.agentUserId),
      i.sale.clientName, names.get(i.sale.carrierId), names.get(i.sale.productId), i.sale.amount.toFixed(2), i.level ?? '', i.rate, i.amount.toFixed(2),
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

salesRouter.post('/sales-inbox/retry', async (req, res) => {
  requireRole(req, 'admin');
  res.json({ created: await tx(req, (db) => retryInbox(db)) });
});

salesRouter.post('/sales-inbox/:id/link', async (req, res) => {
  requireRole(req, 'admin');
  const id = Id.parse(req.params.id);
  const { userId } = parse(LinkInboxAuthorBody, req.body);
  res.json(await tx(req, async (db) => {
    const it = (await db.query('select discord_user_id from sale_inbox where id = $1', [id])).rows[0];
    if (!it) throw new HttpError(404, 'inbox_not_found', 'Ese mensaje no existe');
    // Un usuario de Discord es de un solo miembro: si estaba en otro perfil, se mueve
    await db.query('update agent_profiles set discord_user_id = null where discord_user_id = $1 and user_id <> $2', [it.discord_user_id, userId]);
    await db.query(
      `insert into agent_profiles (workspace_id, user_id, discord_user_id) values (app_ws(), $1, $2)
       on conflict (workspace_id, user_id) do update set discord_user_id = excluded.discord_user_id`, [userId, it.discord_user_id]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'agent.profile_changed', targetType: 'user', targetId: userId,
      meta: { discordUserId: it.discord_user_id } });
    return { created: await retryInbox(db, it.discord_user_id) };
  }));
});

// ─── Canal de Discord ───

async function feedState(db: pg.PoolClient): Promise<DiscordFeed> {
  const f = (await db.query('select * from discord_feeds where workspace_id = app_ws()')).rows[0];
  const { n } = (await db.query('select count(*)::int as n from sale_inbox where resolved_at is null')).rows[0];
  return { botConfigured: discordConfigured(), channelId: f?.channel_id ?? null, lastPolledAt: f?.last_polled_at?.toISOString() ?? null,
    lastError: f?.last_error ?? null, pendingInbox: n };
}

salesRouter.get('/discord-feed', async (req, res) => {
  requireRole(req, 'admin');
  res.json(await tx(req, feedState));
});

salesRouter.put('/discord-feed', async (req, res) => {
  requireRole(req, 'admin');
  const body = parse(DiscordFeedBody, req.body);
  res.json(await tx(req, async (db) => {
    // Leer desde ese día: los mensajes ya procesados no se duplican (id de mensaje único)
    await db.query(
      `insert into discord_feeds (workspace_id, channel_id, last_message_id) values (app_ws(), $1, $2)
       on conflict (workspace_id) do update set channel_id = excluded.channel_id, last_message_id = excluded.last_message_id, last_error = null`,
      [body.channelId, snowflakeAt(body.importSince)]);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'discord.connected', meta: body });
    return feedState(db);
  }));
});

salesRouter.delete('/discord-feed', async (req, res) => {
  requireRole(req, 'admin');
  await tx(req, async (db) => {
    await db.query('delete from discord_feeds where workspace_id = app_ws()');
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'discord.disconnected' });
  });
  res.status(204).end();
});

/** Nombres de miembros, compañías y productos para los CSV */
const nameMaps = (req: Request) => tx(req, async (db) => new Map<string, string>([
  ...(await db.query('select u.id, u.name from workspace_members m join users u on u.id = m.user_id where m.workspace_id = app_ws()')).rows,
  ...(await db.query('select id, name from carriers')).rows,
  ...(await db.query('select id, name from carrier_products')).rows,
].map((r) => [r.id, r.name])));
