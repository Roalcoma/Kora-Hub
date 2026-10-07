// Aplica en orden las migraciones de server/migrations que aún no están en schema_migrations.
// ponytail: solo hacia adelante; una corrección es una migración nueva, no un "down".
import { readdir, readFile } from 'node:fs/promises';
import { withAdmin, adminPool } from './db.ts';

const dir = new URL('../migrations/', import.meta.url);

await withAdmin(async (db) => {
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  // Evita que dos procesos migren a la vez
  await db.query('select pg_advisory_xact_lock(4242)');
  const applied = new Set((await db.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(name)) continue;
    await db.query(await readFile(new URL(name, dir), 'utf8'));
    await db.query('insert into schema_migrations (name) values ($1)', [name]);
    console.log(`aplicada ${name}`);
  }
});
await adminPool.end();
