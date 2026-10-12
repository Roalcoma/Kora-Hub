// Plantillas por rubro (plan Ola 4 §1, ADR 0005 §5). Todo es ajustable por la agencia después del registro.
// Los nombres van en el idioma del registro; los colores salen de la paleta fija CATEGORY_COLORS.
import type pg from 'pg';
import type { Industry, CategoryColor, CategoryLabel, Locale, TEMPLATES } from '@agencia-hub/contracts';

export type Template = (typeof TEMPLATES)[number];
type Seed = {
  industry: Industry;
  label: Record<Locale, CategoryLabel> | null;
  departments: Record<Locale, string[]>;
  lines: { es: string; en: string; color: CategoryColor }[];
};

const ADMIN = { es: 'Administración', en: 'Administration' };

export const SEEDS: Record<Template, Seed> = {
  insurance_agency: {
    industry: 'insurance',
    label: { es: { singular: 'Línea', plural: 'Líneas' }, en: { singular: 'Line', plural: 'Lines' } },
    departments: {
      es: ['Ventas', 'Servicio al cliente', 'Renovaciones', ADMIN.es],
      en: ['Sales', 'Customer service', 'Renewals', ADMIN.en],
    },
    lines: [
      { es: 'Salud', en: 'Health', color: 'green' },
      { es: 'Vida', en: 'Life', color: 'blue' },
      { es: 'Medicare', en: 'Medicare', color: 'purple' },
    ],
  },
  marketing_agency: {
    industry: 'marketing',
    label: { es: { singular: 'Cliente', plural: 'Clientes' }, en: { singular: 'Client', plural: 'Clients' } },
    departments: { es: ['Cuentas', 'Creatividad', 'Medios', ADMIN.es], en: ['Accounts', 'Creative', 'Media', ADMIN.en] },
    lines: [],   // cada agencia agrega sus clientes
  },
  real_estate_agency: {
    industry: 'real_estate',
    label: { es: { singular: 'Sede', plural: 'Sedes' }, en: { singular: 'Office', plural: 'Offices' } },
    departments: { es: ['Ventas', 'Alquileres', ADMIN.es], en: ['Sales', 'Rentals', ADMIN.en] },
    lines: [{ es: 'Principal', en: 'Main', color: 'orange' }],
  },
  travel_agency: {
    industry: 'travel',
    label: { es: { singular: 'Producto', plural: 'Productos' }, en: { singular: 'Product', plural: 'Products' } },
    departments: {
      es: ['Ventas', 'Operaciones', 'Atención al viajero', ADMIN.es],
      en: ['Sales', 'Operations', 'Traveler support', ADMIN.en],
    },
    lines: [
      { es: 'Vuelos', en: 'Flights', color: 'blue' },
      { es: 'Paquetes', en: 'Packages', color: 'orange' },
      { es: 'Cruceros', en: 'Cruises', color: 'teal' },
    ],
  },
  blank: { industry: 'other', label: null, departments: { es: [], en: [] }, lines: [] },
};

export async function seedWorkspace(db: pg.PoolClient, workspaceId: string, ownerId: string, template: Template, locale: Locale) {
  const seed = SEEDS[template];
  await db.query('update workspaces set settings = settings || $2 where id = $1',
    [workspaceId, { industry: seed.industry, category_label: seed.label?.[locale] ?? null, sales_module: seed.industry === 'insurance', finance_module: seed.industry === 'insurance' }]);
  if (seed.industry === 'insurance') await seedFinanceCategories(db, workspaceId, locale);
  for (const [i, name] of seed.departments[locale].entries()) {
    await db.query('insert into departments (workspace_id, name, position) values ($1, $2, $3)', [workspaceId, name, i]);
  }
  for (const [i, line] of seed.lines.entries()) {
    await db.query('insert into business_lines (workspace_id, name, color, position) values ($1, $2, $3, $4)',
      [workspaceId, line[locale], line.color, i]);
  }
  // Toda agencia tiene #anuncios y #general, con plantilla o sin ella
  await db.query(
    `insert into channels (workspace_id, kind, name, topic, created_by) values
       ($1, 'announcement', 'anuncios', 'Comunicados oficiales de la agencia', $2),
       ($1, 'public', 'general', 'Conversación de toda la agencia', $2)`,
    [workspaceId, ownerId],
  );
}

// Categorías básicas de gastos (las mismas que 0010_finance.sql da a las agencias existentes)
const FINANCE_CATEGORIES = [
  { es: 'Renta', en: 'Rent', color: 'blue' }, { es: 'Software', en: 'Software', color: 'purple' },
  { es: 'Marketing', en: 'Marketing', color: 'orange' }, { es: 'Leads', en: 'Leads', color: 'green' },
  { es: 'Servicios', en: 'Services', color: 'teal' }, { es: 'Impuestos', en: 'Taxes', color: 'red' },
  { es: 'Otros', en: 'Other', color: 'gray' },
] as const;

/**
 * Crea las categorías básicas al activar finanzas, solo si la agencia aún no tiene ninguna: reactivar el módulo
 * no duplica ni resucita las que la agencia renombró o archivó.
 */
export async function seedFinanceCategories(db: pg.PoolClient, workspaceId: string, locale: Locale = 'es') {
  await db.query(
    `insert into expense_categories (workspace_id, name, color, position)
     select $1, c.name, c.color, c.position - 1 from unnest($2::text[], $3::text[]) with ordinality as c(name, color, position)
     where not exists (select 1 from expense_categories where workspace_id = $1)
     on conflict do nothing`,
    [workspaceId, FINANCE_CATEGORIES.map((c) => c[locale]), FINANCE_CATEGORIES.map((c) => c.color)]);
}
