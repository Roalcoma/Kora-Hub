// Agencia de prueba "VFS prueba" para el módulo de ventas y comisiones, con los datos reales de VFS (2026-10-10):
// niveles FFL de los agentes, Lendry Labrador como dueña de agencia, tablas de la guía IUL de FFL (rev. 08/19/2024)
// y las ventas del canal #ventas de Discord del 8-9 oct 2026. Todo por el API real, como seed-demo.ts.
// Uso: con la API arriba (npm run dev:api) → node ops/seed-vfs.ts
const API = process.env.API_URL ?? 'http://localhost:4300/api/v1';
const PASS = 'demo-local-12345';
const SLUG = 'vfs-prueba';

type Jar = { cookie: string };
async function call(who: Jar | null, method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return { data: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
const w = (p: string) => `/w/${SLUG}${p}`;
const email = (name: string) => `${name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(' ').slice(0, 2).join('.')}@vfs.test`;

// Niveles de contrato FFL (lista de VFS)
const AGENTS: [string, number][] = [
  ['Hugo Montilva', 80], ['Nanishka Marie Reyes Padua', 85], ['María Carolina Ramos Garcia', 80], ['Hilda Dominguez', 80],
  ['Hector Ivan Roman Hernandez', 80], ['Katherine Karolina Mora Carrillo', 80], ['Jimmy Jakson Zambrano Arias', 80],
  ['Yomaira Ivelisse Hernandez Ayala', 80], ['Michelle Hernandez Guerra', 80], ['Sonia C Ortiz', 80], ['Jorge Luis Vera Ramirez', 80],
  ['Miguel Angel Linarez', 100], ['Veronica V Salas Castillo', 100], ['Yelitza Isamar Zambrano Arias', 85],
  ['Cesar David Diaz Alvarado', 80], ['Maryoris Zaldivar Cordero', 80], ['Juan Jair Cáceres Carvajal', 80],
];
const OWNER: [string, number] = ['Lendry Labrador', 105];

// Guía IUL de FFL, niveles 145 → 65
const LEVELS = [145, 140, 135, 130, 125, 120, 115, 110, 105, 100, 95, 90, 85, 80, 75, 70, 65];
const grid = (rates: number[]) => LEVELS.map((level, i) => ({ level, rate: rates[i]! }));
const CARRIERS = [
  { name: 'Americo', aliases: ['Americo'], product: 'Instant Decision', productAliases: ['IUL'],
    rates: [130, 125, 120, 115, 110, 105, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50] },
  { name: 'National Life Group', aliases: ['NLG', 'National'], product: 'Flex Life IUL', productAliases: ['IUL', 'Flex Life', 'Flex'],
    rates: [110, 110, 105, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 40] },
  { name: 'Mutual of Omaha', aliases: ['MOO', 'Mutual of Omaha'], product: 'IULE', productAliases: ['IUL', 'IULE'],
    rates: [130, 130, 125, 120, 115, 110, 105, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55] },
];

async function main() {
  let office: Jar;
  try {
    office = await call(null, 'POST', '/auth/register', {
      name: 'Oficina VFS', email: 'oficina@vfs.test', password: PASS, locale: 'es',
      workspace: { name: 'VFS prueba', slug: SLUG, template: 'insurance_agency' },
    });
  } catch (e) {
    console.error('La agencia "VFS prueba" ya existe (o falló el registro).');
    throw e;
  }

  // Equipo: Lendry y los 17 agentes como miembros (así se ve la vista de dueña de agencia y la de agente)
  const ids: Record<string, string> = {};
  for (const [name] of [OWNER, ...AGENTS]) {
    const inv = (await call(office, 'POST', w('/invitations'), { email: email(name), role: 'member' })).data;
    const r = await call(null, 'POST', '/invitations/accept', { token: inv.url.split('/invite/')[1], newAccount: { name, password: PASS, locale: 'es' } });
    ids[name] = r.data.user.id;
  }
  for (const [name] of AGENTS) await call(office, 'PATCH', w(`/agents/${ids[name]}`), { uplineUserId: ids[OWNER[0]] });
  console.log(`equipo listo: ${AGENTS.length} agentes bajo ${OWNER[0]}`);

  const product: Record<string, string> = {};
  const carrierId: Record<string, string> = {};
  for (const c of CARRIERS) {
    const carrier = (await call(office, 'POST', w('/carriers'), { name: c.name, aliases: c.aliases, advanceMonths: 9 })).data;
    const p = (await call(office, 'POST', w(`/carriers/${carrier.id}/products`), { name: c.product, aliases: c.productAliases })).data.products[0];
    await call(office, 'PUT', w(`/products/${p.id}/grid`), { effectiveFrom: '2024-08-19', rows: grid(c.rates) });
    // Sin producto en el mensaje = el IUL. FEX paga 5 puntos más que el IUL de la compañía en cada nivel
    await call(office, 'PATCH', w(`/carriers/${carrier.id}`), { defaultProductId: p.id });
    if (c.name !== 'National Life Group') {
      const fex = (await call(office, 'POST', w(`/carriers/${carrier.id}/products`), { name: 'FEX', aliases: ['FEX'] })).data
        .products.find((x: { name: string }) => x.name === 'FEX');
      await call(office, 'PUT', w(`/products/${fex.id}/grid`), { effectiveFrom: '2024-08-19', rows: grid(c.rates.map((r) => r + 5)) });
    }
    product[c.name] = p.id;
    carrierId[c.name] = carrier.id;
  }
  console.log('compañías y tablas listas');

  // Nivel de contrato por compañía (ADR 0006): el mismo nivel en las 3
  for (const [name, level] of [OWNER, ...AGENTS]) {
    await call(office, 'POST', w(`/agents/${ids[name]}/levels`), { carrierIds: Object.values(carrierId), level, effectiveFrom: '2026-01-01' });
  }

  // Ventas del #ventas de Discord (8-9 oct 2026), a mano. Si después se conecta el canal real, borrar estas para no duplicarlas.
  const sales = [
    { agent: 'Cesar David Diaz Alvarado', carrier: 'National Life Group', amount: 1200, client: 'Danielle Cardenas', state: 'NY', date: '2026-10-08', issued: '2026-10-08' },
    { agent: 'Nanishka Marie Reyes Padua', carrier: 'Americo', amount: 1199.88, client: 'Jose Gonzalez Valdez', state: 'OK', date: '2026-10-23', issued: null },
    { agent: 'Nanishka Marie Reyes Padua', carrier: 'Mutual of Omaha', amount: 960, client: 'Vilma', state: 'CA', date: '2026-10-09', issued: '2026-10-09' },
  ];
  for (const x of sales) {
    const s = (await call(office, 'POST', w('/sales'), {
      agentUserId: ids[x.agent], productId: product[x.carrier], amount: x.amount, clientName: x.client, clientState: x.state, expectedIssueDate: x.date,
    })).data;
    if (x.issued) await call(office, 'POST', w(`/sales/${s.id}/issue`), { issuedAt: x.issued });
  }
  console.log(`ventas listas. Entra con oficina@vfs.test (Owner), ${email(OWNER[0])} (dueña) o ${email('Cesar David')} (agente); clave ${PASS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
