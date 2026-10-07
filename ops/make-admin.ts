// Da acceso al backoffice /admin a una cuenta existente (ADR 0005 §4). Nunca se otorga desde la app.
// Uso: node --env-file=.env ops/make-admin.ts <email>   (añade --revoke para quitarlo)
import pg from 'pg';

const email = process.argv[2];
const revoke = process.argv.includes('--revoke');
if (!email || email.startsWith('--')) {
  console.error('Uso: node --env-file=.env ops/make-admin.ts <email> [--revoke]');
  process.exit(1);
}

const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const user = (await adminPool.query('select id, name from users where email = $1', [email])).rows[0];
  if (!user) throw new Error(`No existe una cuenta con el email ${email}; regístrala primero`);
  if (revoke) {
    await adminPool.query('delete from platform_admins where user_id = $1', [user.id]);
  } else {
    await adminPool.query('insert into platform_admins (user_id) values ($1) on conflict do nothing', [user.id]);
  }
  await adminPool.query(
    'insert into audit_log (actor_user_id, action, target_type, target_id) values (null, $1, $2, $3)',
    [revoke ? 'platform.admin_revoked' : 'platform.admin_granted', 'user', user.id]);
  console.log(`${user.name} <${email}> ${revoke ? 'ya no es' : 'ahora es'} superadmin`);
} catch (err: any) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await adminPool.end();
}
