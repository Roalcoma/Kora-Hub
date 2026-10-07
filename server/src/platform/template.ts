// Plantilla "Agencia de seguros" (§3.1). Ajustable por workspace después del registro.
import type pg from 'pg';

const INSURANCE = {
  departments: ['Ventas', 'Servicio al cliente', 'Renovaciones', 'Administración'],
  lines: [['Salud', 'salud'], ['Vida', 'vida'], ['Medicare', 'medicare']] as const,
};

export async function seedWorkspace(db: pg.PoolClient, workspaceId: string, ownerId: string, template: 'insurance_agency' | 'blank') {
  if (template === 'insurance_agency') {
    for (const [i, name] of INSURANCE.departments.entries()) {
      await db.query('insert into departments (workspace_id, name, position) values ($1, $2, $3)', [workspaceId, name, i]);
    }
    for (const [i, [name, color]] of INSURANCE.lines.entries()) {
      await db.query('insert into business_lines (workspace_id, name, color, position) values ($1, $2, $3, $4)', [workspaceId, name, color, i]);
    }
  }
  // Toda agencia tiene #anuncios y #general, con plantilla o sin ella
  await db.query(
    `insert into channels (workspace_id, kind, name, topic, created_by) values
       ($1, 'announcement', 'anuncios', 'Comunicados oficiales de la agencia', $2),
       ($1, 'public', 'general', 'Conversación de toda la agencia', $2)`,
    [workspaceId, ownerId],
  );
}
