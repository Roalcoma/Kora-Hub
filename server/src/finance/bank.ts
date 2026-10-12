// /w/:slug/finance/bank — cuentas, movimientos (manuales o de CSV) y estados de cuenta (docs/plan-finanzas.md §4, ADR 0007).
// El guardián de finance/routes.ts ya filtró módulo activo y rol (Owner, Admin, Contable).
// dedupe_key lo calcula siempre el servidor; un CSV se importa como bank_statement y se deshace completo (cascade).
import { Router, type Request } from 'express';
import type pg from 'pg';
import {
  Id, BankAccountBody, UpdateBankAccountBody, CsvMapping, BankTransactionBody, UpdateBankTransactionBody,
  BankTransactionsQuery, ImportPreviewBody, ImportCommitBody, BankStatementsQuery,
  type BankAccount, type BankTransaction, type BankTransactionsList, type BankStatement, type ImportPreview, type ImportRow,
} from '@agencia-hub/contracts';
import { HttpError, parse, sendCsv } from '../platform/http.ts';
import { tx } from '../platform/workspace.ts';
import { audit } from '../platform/model.ts';
import { presign } from '../files/s3.ts';
import { toFileRef } from '../files/routes.ts';
import { toCents } from '../sales/commissions.ts';
import {
  parseCsv, detectDelimiter, parseCsvAmount, splitRecords, interpretRow, dedupeKey, suggestCarrier, type CarrierTerms,
} from './csv.ts';

export { parseCsv, detectDelimiter, parseCsvDate, parseCsvAmount, interpretRow, dedupeKey, suggestCarrier } from './csv.ts';

export const bankRouter = Router({ mergeParams: true });

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_CSV_ROWS = 5_000;
const SAMPLE_ROWS = 10;
const day = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;   // como texto: pg pasa `date` a medianoche local y corre el día

// ─── Cuentas ───

async function listAccounts(db: pg.PoolClient, id?: string): Promise<BankAccount[]> {
  const { rows } = await db.query(
    `select a.*, exists (select 1 from bank_csv_mappings m where m.account_id = a.id) as has_mapping,
       (select ${day('max(s.period_to)')} from bank_statements s where s.account_id = a.id) as last_to
     from bank_accounts a where $1::uuid is null or a.id = $1 order by a.is_active desc, a.name`, [id ?? null]);
  return rows.map((r) => ({
    id: r.id, name: r.name, bankName: r.bank_name, last4: r.last4, isActive: r.is_active, hasMapping: r.has_mapping, lastStatementTo: r.last_to,
  }));
}
const oneAccount = async (db: pg.PoolClient, id: string) => {
  const a = (await listAccounts(db, id))[0];
  if (!a) throw new HttpError(404, 'account_not_found', 'Cuenta bancaria no encontrada');
  return a;
};

bankRouter.get('/bank/accounts', async (req, res) => {
  res.json(await tx(req, (db) => listAccounts(db)));
});

bankRouter.post('/bank/accounts', async (req, res) => {
  const body = parse(BankAccountBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    const { rows } = await db.query(
      'insert into bank_accounts (workspace_id, name, bank_name, last4) values (app_ws(), $1, $2, $3) returning id',
      [body.name, body.bankName, body.last4]);
    return oneAccount(db, rows[0].id);
  }));
});

bankRouter.patch('/bank/accounts/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdateBankAccountBody, req.body);
  res.json(await tx(req, async (db) => {
    const { rowCount } = await db.query(
      `update bank_accounts set name = coalesce($2, name), bank_name = coalesce($3, bank_name),
         last4 = case when $4 then $5 else last4 end, is_active = coalesce($6, is_active) where id = $1`,
      [id, body.name ?? null, body.bankName ?? null, body.last4 !== undefined, body.last4 ?? null, body.isActive ?? null]);
    if (!rowCount) throw new HttpError(404, 'account_not_found', 'Cuenta bancaria no encontrada');
    return oneAccount(db, id);
  }));
});

// ─── Mapeo CSV por cuenta ───

const savedMapping = async (db: pg.PoolClient, accountId: string): Promise<CsvMapping | null> =>
  (await db.query('select mapping from bank_csv_mappings where account_id = $1', [accountId])).rows[0]?.mapping ?? null;

async function saveMapping(db: pg.PoolClient, accountId: string, mapping: CsvMapping) {
  await db.query(
    `insert into bank_csv_mappings (workspace_id, account_id, mapping, updated_by) values (app_ws(), $1, $2, app_user())
     on conflict (workspace_id, account_id) do update set mapping = excluded.mapping, updated_by = excluded.updated_by, updated_at = now()`,
    [accountId, JSON.stringify(mapping)]);
}

bankRouter.get('/bank/accounts/:id/csv-mapping', async (req, res) => {
  const id = Id.parse(req.params.id);
  res.json(await tx(req, async (db) => {
    await oneAccount(db, id);
    return savedMapping(db, id);
  }));
});

bankRouter.put('/bank/accounts/:id/csv-mapping', async (req, res) => {
  const id = Id.parse(req.params.id);
  const mapping = parse(CsvMapping, req.body);
  res.json(await tx(req, async (db) => {
    await oneAccount(db, id);
    await saveMapping(db, id, mapping);
    return mapping;
  }));
});

// ─── Movimientos ───

const TX_COLS = `t.id, t.account_id, t.statement_id, ${day('t.posted_on')} as posted_on, t.description, t.amount, t.reference,
  t.carrier_id, t.notes, t.source, t.match_status, t.created_by, t.created_at`;
const toTransaction = (r: any): BankTransaction => ({
  id: r.id, accountId: r.account_id, statementId: r.statement_id, postedOn: r.posted_on, description: r.description,
  amount: Number(r.amount), reference: r.reference, carrierId: r.carrier_id, notes: r.notes, source: r.source,
  matchStatus: r.match_status, createdBy: r.created_by, createdAt: r.created_at.toISOString(),
});

async function oneTransaction(db: pg.PoolClient, id: string, lock = false): Promise<BankTransaction> {
  const { rows } = await db.query(`select ${TX_COLS} from bank_transactions t where t.id = $1 ${lock ? 'for update' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'transaction_not_found', 'Movimiento no encontrado');
  return toTransaction(rows[0]);
}

// Filtros comunes a la lista, sus totales y el CSV
function txWhere(q: ReturnType<typeof BankTransactionsQuery.parse>) {
  return {
    sql: `($1::date is null or t.posted_on >= $1) and ($2::date is null or t.posted_on <= $2)
      and ($3::uuid is null or t.account_id = $3) and ($4::uuid is null or t.carrier_id = $4)
      and ($5::uuid is null or t.statement_id = $5) and ($6::text is null or t.match_status = $6)
      and ($7::text is null or ($7 = 'in' and t.amount > 0) or ($7 = 'out' and t.amount < 0))
      and ($8::text is null or position(lower($8) in lower(t.description || ' ' || t.reference)) > 0)`,
    params: [q.from ?? null, q.to ?? null, q.accountId ?? null, q.carrierId ?? null, q.statementId ?? null,
      q.matchStatus ?? null, q.direction ?? null, q.q || null],
  };
}

async function queryTransactions(req: Request, q: ReturnType<typeof BankTransactionsQuery.parse>, limit: number) {
  const w = txWhere(q);
  return tx(req, async (db) => {
    const items = (await db.query(
      `select ${TX_COLS} from bank_transactions t where ${w.sql} order by t.posted_on desc, t.created_at desc, t.id limit ${limit}`,
      w.params)).rows.map(toTransaction);
    const t = (await db.query(
      `select count(*)::int as count, coalesce(sum(t.amount) filter (where t.amount > 0), 0) as inflow,
         coalesce(-sum(t.amount) filter (where t.amount < 0), 0) as outflow
       from bank_transactions t where ${w.sql}`, w.params)).rows[0];
    return { items, totals: { count: t.count, inflow: Number(t.inflow), outflow: Number(t.outflow), net: (toCents(t.inflow) - toCents(t.outflow)) / 100 } };
  });
}

bankRouter.get('/bank/transactions', async (req, res) => {
  const out: BankTransactionsList = await queryTransactions(req, parse(BankTransactionsQuery, req.query), 2_000);
  res.json(out);
});

bankRouter.get('/bank/transactions.csv', async (req, res) => {
  const { items } = await queryTransactions(req, parse(BankTransactionsQuery, req.query), 50_000);
  const names = await tx(req, async (db) => new Map<string, string>([
    ...(await db.query('select id, name from bank_accounts')).rows.map((r) => [r.id, r.name] as [string, string]),
    ...(await db.query('select id, name from carriers')).rows.map((r) => [r.id, r.name] as [string, string]),
  ]));
  // Entrada y salida en columnas aparte y en positivo: sendCsv antepone ' a lo que empieza con "-" (anti-fórmulas)
  sendCsv(res, 'movimientos-banco.csv', [
    ['Fecha', 'Cuenta', 'Descripción', 'Entrada', 'Salida', 'Referencia', 'Compañía', 'Notas', 'Origen', 'Cruce'],
    ...items.map((t) => [t.postedOn, names.get(t.accountId), t.description, t.amount > 0 ? t.amount.toFixed(2) : '',
      t.amount < 0 ? (-t.amount).toFixed(2) : '', t.reference,
      t.carrierId ? names.get(t.carrierId) : '', t.notes, t.source, t.matchStatus]),
  ]);
});

/** ¿Hay otro movimiento de la cuenta con la misma clave? (la carga manual no se bloquea, solo avisa) */
const keyExists = async (db: pg.PoolClient, accountId: string, key: string, exceptId: string | null = null) =>
  !!(await db.query('select 1 from bank_transactions where account_id = $1 and dedupe_key = $2 and ($3::uuid is null or id <> $3) limit 1',
    [accountId, key, exceptId])).rowCount;

bankRouter.post('/bank/transactions', async (req, res) => {
  const body = parse(BankTransactionBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    await oneAccount(db, body.accountId);
    const key = dedupeKey(body.postedOn, body.amount, body.reference, body.description);
    const possibleDuplicate = await keyExists(db, body.accountId, key);
    const { rows } = await db.query(
      `insert into bank_transactions (workspace_id, account_id, posted_on, description, amount, reference, carrier_id, notes, source, dedupe_key, created_by)
       values (app_ws(), $1, $2, $3, $4, $5, $6, $7, 'manual', $8, app_user()) returning id`,
      [body.accountId, body.postedOn, body.description, body.amount, body.reference, body.carrierId, body.notes, key]);
    return { ...(await oneTransaction(db, rows[0].id)), possibleDuplicate };
  }));
});

bankRouter.patch('/bank/transactions/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const body = parse(UpdateBankTransactionBody, req.body);
  res.json(await tx(req, async (db) => {
    const cur = await oneTransaction(db, id, true);
    const coreChange = body.postedOn !== undefined || body.description !== undefined || body.amount !== undefined || body.reference !== undefined;
    if (coreChange && cur.source !== 'manual') {
      throw new HttpError(400, 'imported_transaction', 'Fecha, descripción, monto y referencia solo se editan en movimientos manuales');
    }
    const next = {
      postedOn: body.postedOn ?? cur.postedOn, description: body.description ?? cur.description,
      amount: body.amount ?? cur.amount, reference: body.reference ?? cur.reference,
    };
    await db.query(
      `update bank_transactions set posted_on = $2, description = $3, amount = $4, reference = $5,
         carrier_id = case when $6 then $7::uuid else carrier_id end, notes = coalesce($8, notes),
         match_status = coalesce($9, match_status), dedupe_key = coalesce($10, dedupe_key), updated_at = now()
       where id = $1`,
      [id, next.postedOn, next.description, next.amount, next.reference, body.carrierId !== undefined, body.carrierId ?? null,
        body.notes ?? null, body.matchStatus ?? null,
        cur.source === 'manual' ? dedupeKey(next.postedOn, next.amount, next.reference, next.description) : null]);
    return oneTransaction(db, id);
  }));
});

bankRouter.delete('/bank/transactions/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const cur = await oneTransaction(db, id, true);
    if (cur.source !== 'manual') {
      throw new HttpError(400, 'imported_transaction', 'Los movimientos importados se quitan deshaciendo su estado de cuenta');
    }
    await db.query('delete from bank_transactions where id = $1', [id]);
  });
  res.status(204).end();
});

// ─── Importación CSV ───

/** Lee de MinIO el CSV subido (contexto bank_statement) y lo decodifica (UTF-8; si no lo es, Latin-1 como exportan algunos bancos) */
async function loadCsvFile(db: pg.PoolClient, fileId: string) {
  const file = (await db.query("select * from files where id = $1 and status = 'ready' and context = 'bank_statement'", [fileId])).rows[0];
  if (!file) throw new HttpError(404, 'file_not_found', 'Archivo no encontrado');
  if (Number(file.size) > MAX_CSV_BYTES) throw new HttpError(413, 'file_too_large', 'El CSV supera el límite de 2 MB');
  const s3 = await fetch(presign('GET', file.storage_key, 60));
  if (!s3.ok) throw new HttpError(502, 'storage_error', 'No se pudo leer el archivo');
  const buf = new Uint8Array(await s3.arrayBuffer());
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('latin1').decode(buf); }
  return { file, text };
}

const loadCarriers = async (db: pg.PoolClient): Promise<CarrierTerms[]> =>
  (await db.query('select id, name, aliases from carriers')).rows;
const existingKeys = async (db: pg.PoolClient, accountId: string) =>
  new Set<string>((await db.query('select distinct dedupe_key from bank_transactions where account_id = $1', [accountId])).rows.map((r) => r.dedupe_key));

/** Interpreta todas las filas con el mapeo: compañía sugerida y duplicado contra lo que ya hay en la cuenta */
async function interpret(db: pg.PoolClient, accountId: string, text: string, mapping: CsvMapping) {
  const { header, data } = splitRecords(parseCsv(text, mapping.delimiter), mapping);
  if (data.length > MAX_CSV_ROWS) throw new HttpError(413, 'too_many_rows', `El CSV supera el límite de ${MAX_CSV_ROWS} filas`);
  const [carriers, keys] = await Promise.all([loadCarriers(db), existingKeys(db, accountId)]);
  const rows: (ImportRow & { key: string | null })[] = data.map((r) => {
    const p = interpretRow(r, mapping);
    const key = p.error ? null : dedupeKey(p.postedOn!, p.amount!, p.reference, p.description);
    return { ...p, key, carrierId: p.error ? null : suggestCarrier(p.description, p.amount, carriers), duplicate: !!key && keys.has(key) };
  });
  return { header, data, rows };
}

const periodOf = (rows: ImportRow[]) => {
  const days = rows.filter((r) => !r.error).map((r) => r.postedOn!).sort();
  return days.length ? { from: days[0]!, to: days[days.length - 1]! } : null;
};

bankRouter.post('/bank/import/preview', async (req, res) => {
  const body = parse(ImportPreviewBody, req.body);
  res.json(await tx(req, async (db): Promise<ImportPreview> => {
    await oneAccount(db, body.accountId);
    const { text } = await loadCsvFile(db, body.fileId);
    const mapping = body.mapping ?? await savedMapping(db, body.accountId);
    if (!mapping) {
      // Sin mapeo: solo lo crudo para elegir columnas. La primera fila es encabezado si ninguna celda parece un monto.
      const records = parseCsv(text, detectDelimiter(text));
      const first = records[0];
      const hasHeader = !!first && first.cells.every((c) => parseCsvAmount(c) === null);
      return {
        headers: hasHeader ? first.cells.map((c) => c.trim()) : null,
        sample: records.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + SAMPLE_ROWS).map((r) => r.cells),
        mapping: null, rows: [], totals: { rows: 0, valid: 0, duplicates: 0, invalid: 0 }, period: null,
      };
    }
    const { header, data, rows } = await interpret(db, body.accountId, text, mapping);
    const invalid = rows.filter((r) => r.error).length;
    const duplicates = rows.filter((r) => r.duplicate).length;
    return {
      headers: header ? header.cells.map((c) => c.trim()) : null,
      sample: data.slice(0, SAMPLE_ROWS).map((r) => r.cells),
      mapping,
      rows: rows.map(({ key: _k, ...r }) => r),
      totals: { rows: rows.length, valid: rows.length - invalid - duplicates, duplicates, invalid },
      period: periodOf(rows),
    };
  }));
});

async function listStatements(db: pg.PoolClient, slug: string, where: { accountId?: string | null; id?: string }): Promise<BankStatement[]> {
  const { rows } = await db.query(
    `select s.id, s.account_id, ${day('s.period_from')} as period_from, ${day('s.period_to')} as period_to, s.rows_imported, s.rows_skipped,
       s.imported_by, s.imported_at, f.id as f_id, f.name as f_name, f.mime as f_mime, f.size as f_size
     from bank_statements s left join files f on f.id = s.file_id
     where ($1::uuid is null or s.account_id = $1) and ($2::uuid is null or s.id = $2)
     order by s.period_to desc, s.imported_at desc`, [where.accountId ?? null, where.id ?? null]);
  return rows.map((r) => ({
    id: r.id, accountId: r.account_id, periodFrom: r.period_from, periodTo: r.period_to,
    file: r.f_id ? toFileRef(slug, { id: r.f_id, name: r.f_name, mime: r.f_mime, size: r.f_size, width: null, height: null }) : null,
    rowsImported: r.rows_imported, rowsSkipped: r.rows_skipped, importedBy: r.imported_by, importedAt: r.imported_at.toISOString(),
  }));
}

bankRouter.post('/bank/import/commit', async (req, res) => {
  const body = parse(ImportCommitBody, req.body);
  res.status(201).json(await tx(req, async (db) => {
    await oneAccount(db, body.accountId);
    // Bloquea la cuenta: dos importaciones simultáneas del mismo archivo no se cuelan como no duplicadas
    await db.query('select 1 from bank_accounts where id = $1 for update', [body.accountId]);
    const { file, text } = await loadCsvFile(db, body.fileId);
    const { rows } = await interpret(db, body.accountId, text, body.mapping);
    const fixes = new Map((body.carriers ?? []).map((c) => [c.line, c.carrierId]));
    const valid = rows.filter((r) => !r.error);
    const toImport = valid.filter((r) => !r.duplicate);
    const skipped = valid.length - toImport.length;
    if (!toImport.length) {
      throw new HttpError(400, 'nothing_to_import', valid.length ? 'Todas las filas ya estaban en la cuenta' : 'El archivo no tiene filas válidas con este mapeo');
    }
    const period = periodOf(valid)!;
    const from = body.periodFrom ?? period.from, to = body.periodTo ?? period.to;
    if (to < from) throw new HttpError(400, 'invalid_period', 'El fin del periodo no puede ser anterior al inicio');

    const st = (await db.query(
      `insert into bank_statements (workspace_id, account_id, period_from, period_to, file_id, rows_imported, rows_skipped, imported_by)
       values (app_ws(), $1, $2, $3, $4, $5, $6, app_user()) returning id`,
      [body.accountId, from, to, file.id, toImport.length, skipped])).rows[0];
    await db.query(
      `insert into bank_transactions (workspace_id, account_id, statement_id, posted_on, description, amount, reference, carrier_id, source, dedupe_key, created_by)
       select app_ws(), $1, $2, x.posted_on, x.description, x.amount, x.reference, x.carrier_id, 'csv', x.dedupe_key, app_user()
       from json_to_recordset($3) as x(posted_on date, description text, amount numeric, reference text, carrier_id uuid, dedupe_key text)`,
      [body.accountId, st.id, JSON.stringify(toImport.map((r) => ({
        posted_on: r.postedOn, description: r.description, amount: r.amount, reference: r.reference,
        carrier_id: fixes.has(r.line) ? fixes.get(r.line) : r.carrierId, dedupe_key: r.key,
      })))]);
    if (body.saveMapping) await saveMapping(db, body.accountId, body.mapping);
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'bank.statement_imported', targetType: 'bank_statement', targetId: st.id,
      meta: { accountId: body.accountId, fileId: file.id, imported: toImport.length, skipped, invalid: rows.length - valid.length } });
    return (await listStatements(db, req.ws!.slug, { id: st.id }))[0]!;
  }));
});

// ─── Estados de cuenta ───

bankRouter.get('/bank/statements', async (req, res) => {
  const q = parse(BankStatementsQuery, req.query);
  res.json(await tx(req, (db) => listStatements(db, req.ws!.slug, { accountId: q.accountId })));
});

// Deshacer una importación: sus movimientos se van en cascada (el archivo original se conserva)
bankRouter.delete('/bank/statements/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  await tx(req, async (db) => {
    const { rows } = await db.query('delete from bank_statements where id = $1 returning account_id, rows_imported', [id]);
    if (!rows[0]) throw new HttpError(404, 'statement_not_found', 'Estado de cuenta no encontrado');
    await audit(db, { workspaceId: req.ws!.id, actor: req.userId!, action: 'bank.statement_undone', targetType: 'bank_statement', targetId: id,
      meta: { accountId: rows[0].account_id, rowsImported: rows[0].rows_imported } });
  });
  res.status(204).end();
});
