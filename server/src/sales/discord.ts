// Lectura del canal de ventas de Discord (docs/plan-comisiones.md §1). Cada minuto pide al API REST de Discord los
// mensajes nuevos de cada canal conectado (sin dependencias: fetch + token del bot en DISCORD_BOT_TOKEN).
// Un mensaje completo y de un agente enlazado se vuelve venta pendiente; si le falta algo, va a la bandeja.
// Editar o borrar en Discord después no cambia nada: se corrige en Kora.
import type pg from 'pg';
import { adminPool, withWorkspace } from '../db.ts';
import { alert } from '../ops/alert.ts';
import { parseSale, looksLikeSale, type CatalogCarrier, type Problem } from './parse.ts';

export const discordConfigured = () => !!process.env.DISCORD_BOT_TOKEN;

type DiscordMessage = {
  id: string; type: number; content: string; timestamp: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
};

/** Primer id de Discord ("snowflake") de un día a medianoche de Nueva York: leer desde esa fecha */
export function snowflakeAt(day: string): string {
  // Medianoche de NY = 04:00 o 05:00 UTC según horario de verano: se toma 04:00 y a lo sumo entra una hora del día anterior
  const ms = Date.parse(`${day}T04:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Fecha inválida: ${day}`);
  return ((BigInt(ms) - 1420070400000n) << 22n).toString();
}
const nyDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function catalog(db: pg.PoolClient): Promise<CatalogCarrier[]> {
  return (await db.query(
    `select c.id, c.name, c.aliases, c.default_product_id as "defaultProductId", coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'aliases', p.aliases))
       filter (where p.id is not null), '[]') as products
     from carriers c left join carrier_products p on p.carrier_id = c.id and p.archived_at is null
     where c.archived_at is null group by c.id`)).rows;
}

/** Interpreta un mensaje: venta completa → `sale`; incompleta → `problems` (con lo que sí se entendió) */
async function interpret(db: pg.PoolClient, cat: CatalogCarrier[], content: string, discordUserId: string, postedAt: string) {
  const parsed = parseSale(content, nyDay(postedAt), cat);
  const agent = (await db.query(
    `select p.user_id from agent_profiles p join workspace_members m on m.workspace_id = p.workspace_id and m.user_id = p.user_id and m.is_active
     where p.discord_user_id = $1`, [discordUserId])).rows[0]?.user_id as string | undefined;
  const problems: Problem[] = [...parsed.problems, ...(agent ? [] : ['agent' as const])];
  const { problems: _, ignore, ...fields } = parsed;
  return { fields: { ...fields, agentUserId: agent }, problems, ignore };
}

async function createSale(db: pg.PoolClient, f: Awaited<ReturnType<typeof interpret>>['fields'], messageId: string) {
  const { rows } = await db.query(
    `insert into sales (workspace_id, agent_user_id, product_id, amount, client_name, client_state, expected_issue_date, source, discord_message_id)
     values (app_ws(), $1, $2, $3, $4, $5, $6, 'discord', $7) on conflict (workspace_id, discord_message_id) do nothing returning id`,
    [f.agentUserId, f.productId, f.amount, f.clientName, f.clientState ?? null, f.expectedIssueDate, messageId]);
  return rows[0]?.id as string | undefined;
}

/** Procesa un mensaje del canal dentro del workspace (RLS). Idempotente por id de mensaje. */
export async function ingestMessage(db: pg.PoolClient, m: DiscordMessage, cat?: CatalogCarrier[]) {
  if (m.author.bot || ![0, 19].includes(m.type) || !looksLikeSale(m.content)) return 'ignored';
  const { fields, problems, ignore } = await interpret(db, cat ?? await catalog(db), m.content, m.author.id, m.timestamp);
  if (ignore) return 'ignored';   // compañía o producto que la agencia no maneja
  if (!problems.length) return (await createSale(db, fields, m.id)) ? 'sale' : 'duplicate';
  await db.query(
    `insert into sale_inbox (workspace_id, discord_message_id, discord_user_id, author_name, content, posted_at, parsed, problems)
     values (app_ws(), $1, $2, $3, $4, $5, $6, $7) on conflict (workspace_id, discord_message_id) do nothing`,
    [m.id, m.author.id, m.author.global_name || m.author.username, m.content, m.timestamp, fields, problems]);
  return 'inbox';
}

/** Vuelve a intentar los mensajes de la bandeja (tras enlazar un agente o agregar un alias). Devuelve cuántas ventas creó. */
export async function retryInbox(db: pg.PoolClient, discordUserId?: string): Promise<number> {
  const cat = await catalog(db);
  const items = (await db.query(
    `select * from sale_inbox where resolved_at is null and ($1::text is null or discord_user_id = $1) for update`, [discordUserId ?? null])).rows;
  let created = 0;
  for (const it of items) {
    const { fields, problems, ignore } = await interpret(db, cat, it.content, it.discord_user_id, it.posted_at.toISOString());
    if (ignore) {
      await db.query('update sale_inbox set resolved_at = now(), resolved_by = app_user() where id = $1', [it.id]);
      continue;
    }
    const saleId = problems.length ? undefined : await createSale(db, fields, it.discord_message_id);
    if (saleId) {
      created++;
      await db.query('update sale_inbox set resolved_at = now(), resolved_by = app_user(), sale_id = $2 where id = $1', [it.id, saleId]);
    } else {
      await db.query('update sale_inbox set parsed = $2, problems = $3 where id = $1', [it.id, fields, problems]);
    }
  }
  return created;
}

async function fetchAfter(channelId: string, after: string): Promise<DiscordMessage[]> {
  const res = await fetch(`${process.env.DISCORD_API_URL ?? 'https://discord.com/api/v10'}/channels/${channelId}/messages?limit=100&after=${after}`, {
    headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
  });
  if (res.status === 429) return [];   // límite de Discord: se sigue en la próxima vuelta
  if (!res.ok) throw new Error(`Discord respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as DiscordMessage[]).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** Lee lo nuevo de todos los canales conectados. Un candado de Postgres evita dos lecturas a la vez. */
export async function pollDiscord() {
  if (!discordConfigured()) return;
  const lock = await adminPool.connect();
  try {
    if (!(await lock.query('select pg_try_advisory_lock(4343) as ok')).rows[0].ok) return;
    try {
      const feeds = (await lock.query('select * from discord_feeds')).rows;
      for (const feed of feeds) await pollFeed(feed);
    } finally {
      await lock.query('select pg_advisory_unlock(4343)');
    }
  } finally {
    lock.release();
  }
}

async function pollFeed(feed: { workspace_id: string; channel_id: string; last_message_id: string | null; last_error: string | null }) {
  const ctx = { workspaceId: feed.workspace_id, userId: null };
  let cursor = feed.last_message_id ?? snowflakeAt(nyDay(new Date().toISOString()));
  try {
    for (let page = 0; page < 20; page++) {   // hasta 2.000 mensajes por vuelta; el resto en la siguiente
      const batch = await fetchAfter(feed.channel_id, cursor);
      if (!batch.length) break;
      await withWorkspace(ctx, async (db) => {
        const cat = await catalog(db);
        for (const m of batch) await ingestMessage(db, m, cat);
        cursor = batch[batch.length - 1]!.id;
        await db.query('update discord_feeds set last_message_id = $1 where workspace_id = app_ws()', [cursor]);
      });
      if (batch.length < 100) break;
    }
    await withWorkspace(ctx, (db) => db.query('update discord_feeds set last_polled_at = now(), last_error = null where workspace_id = app_ws()'));
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    await withWorkspace(ctx, (db) => db.query('update discord_feeds set last_polled_at = now(), last_error = $1 where workspace_id = app_ws()', [msg]));
    if (!feed.last_error) alert(`Discord: no se pudo leer el canal de ventas del workspace ${feed.workspace_id}: ${msg}`);
  }
}

export function startDiscordPoller() {
  if (!discordConfigured()) return;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await pollDiscord(); } catch (err: any) { console.error(JSON.stringify({ level: 'error', msg: 'discord', error: err?.message })); }
    running = false;
  }, Number(process.env.DISCORD_POLL_MS ?? 60_000));
}
