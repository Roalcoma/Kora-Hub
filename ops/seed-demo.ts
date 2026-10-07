// Siembra un escenario de prueba completo a través del API real (no toca la BD directo).
// Uso: con la API arriba (npm run dev:api) → node ops/seed-demo.ts
// Es idempotente a medias: si la agencia ya existe, se detiene sin duplicar.
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4300/api/v1';
const PASS = 'demo-local-12345';
const SLUG = 'agencia-piloto-seguros';

type Jar = { cookie: string; name: string; id: string };

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

// ─── Fechas ───
const day = 86400_000;
const inDays = (n: number, h = 17) => { const d = new Date(Date.now() + n * day); d.setHours(h, 0, 0, 0); return d.toISOString(); };
/** Lunes de la semana actual en Nueva York (igual que el servidor), menos `back` semanas */
function monday(back: number) {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = new Date(Date.UTC(ny.getFullYear(), ny.getMonth(), ny.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - back * 7);
  return d.toISOString().slice(0, 10);
}

// ─── Contenido Tiptap ───
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const ul = (...items: string[]) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [p(t)] })) });
const ol = (...items: string[]) => ({ type: 'orderedList', content: items.map((t) => ({ type: 'listItem', content: [p(t)] })) });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

async function main() {
  // ─── 1. Owner y agencia ───
  let owner: Jar;
  try {
    const r = await call(null, 'POST', '/auth/register', {
      name: 'Rodrigo Demo', email: 'demo@agencia-hub.test', password: PASS, locale: 'es',
      workspace: { name: 'Agencia Piloto Seguros', slug: SLUG, template: 'insurance_agency' },
    });
    owner = { cookie: r.cookie, name: 'Rodrigo', id: r.data.user.id };
  } catch (e) {
    console.error('La agencia demo ya existe (o falló el registro). Para resembrar: npm run db:down -- -v && npm run db:up && npm run migrate');
    throw e;
  }
  console.log('owner listo');

  const ws = (await call(owner, 'GET', w(''))).data;
  const dept = Object.fromEntries(ws.departments.map((d: { name: string; id: string }) => [d.name, d.id]));
  const line = Object.fromEntries(ws.lines.map((l: { name: string; id: string }) => [l.name, l.id]));

  // ─── 2. Equipo por invitación ───
  const team = [
    { key: 'ana', name: 'Ana Martínez', role: 'lead', title: 'Líder de Ventas', depts: [['Ventas', true]], lines: ['Salud', 'Medicare'] },
    { key: 'maria', name: 'María Gómez', role: 'lead', title: 'Líder de Servicio', depts: [['Servicio al cliente', true], ['Renovaciones', true]], lines: [] },
    { key: 'carlos', name: 'Carlos Pérez', role: 'member', title: 'Agente de Medicare', depts: [['Ventas', false]], lines: ['Medicare'] },
    { key: 'lucia', name: 'Lucía Fernández', role: 'member', title: 'Agente de Vida', depts: [['Ventas', false]], lines: ['Vida'] },
    { key: 'jorge', name: 'Jorge Ramírez', role: 'member', title: 'Ejecutivo de servicio', depts: [['Servicio al cliente', false], ['Renovaciones', false]], lines: [] },
    { key: 'sofia', name: 'Sofía Herrera', role: 'admin', title: 'Gerente de operaciones', depts: [['Administración', true]], lines: [] },
    { key: 'pedro', name: 'Pedro Invitado', role: 'guest', title: 'Contador externo', depts: [['Administración', false]], lines: [] },
  ] as const;

  const u: Record<string, Jar> = { owner };
  for (const m of team) {
    const email = `${m.key}@agencia-hub.test`;
    const inv = (await call(owner, 'POST', w('/invitations'), { email, role: m.role, departmentIds: [] })).data;
    const token = inv.url.split('/invite/')[1];
    const r = await call(null, 'POST', '/invitations/accept', { token, newAccount: { name: m.name, password: PASS, locale: 'es' } });
    u[m.key] = { cookie: r.cookie, name: m.name, id: r.data.user.id };
    await call(owner, 'PATCH', w(`/members/${r.data.user.id}`), {
      title: m.title,
      departments: m.depts.map(([n, isLead]) => ({ id: dept[n], isLead })),
      lineIds: m.lines.map((n) => line[n]),
    });
  }
  await call(owner, 'PATCH', w(`/members/${owner.id}`), { title: 'Dueño de la agencia', departments: [{ id: dept['Administración'], isLead: true }] });
  await call(u.carlos, 'PATCH', w('/me'), { statusText: 'Visitando clientes', statusUntil: inDays(1) });
  console.log('equipo listo');

  // ─── 3. Chat ───
  const channels = (await call(owner, 'GET', w('/channels'))).data as { id: string; name: string }[];
  const ch: Record<string, string> = Object.fromEntries(channels.map((c) => [c.name, c.id]));
  const everyone = Object.values(u).map((x) => x.id).filter((id) => id !== u.pedro.id);
  const mk = async (body: object) => (await call(owner, 'POST', w('/channels'), body)).data.id as string;
  ch.ventas = await mk({ kind: 'public', name: 'ventas', topic: 'Cierres, citas y prospectos', departmentId: dept['Ventas'], memberIds: [u.ana.id, u.carlos.id, u.lucia.id] });
  ch.medicare = await mk({ kind: 'public', name: 'medicare', topic: 'Periodo de inscripción anual (AEP): 15 oct – 7 dic', lineId: line['Medicare'], memberIds: [u.ana.id, u.carlos.id] });
  ch.servicio = await mk({ kind: 'public', name: 'servicio', topic: 'Casos de clientes y renovaciones', departmentId: dept['Servicio al cliente'], memberIds: [u.maria.id, u.jorge.id] });
  ch.gerencia = await mk({ kind: 'private', name: 'gerencia', topic: 'Solo líderes y administración', memberIds: [u.ana.id, u.maria.id, u.sofia.id] });
  for (const k of ['carlos', 'lucia', 'jorge', 'ana', 'maria', 'sofia']) await call(u[k], 'POST', w(`/channels/${ch.general}/join`)).catch(() => {});

  const say = async (who: Jar, channel: string, body: string, extra: object = {}) =>
    (await call(who, 'POST', w(`/channels/${channel}/messages`), { clientId: randomUUID(), body, ...extra })).data as { id: string };
  const react = (who: Jar, msg: string, emoji: string) => call(who, 'POST', w(`/messages/${msg}/reactions`), { emoji });

  const g1 = await say(owner, ch.general, '¡Bienvenidos a Kora! Este es el nuevo espacio de trabajo de la agencia. Aquí van conversaciones, manuales, tareas y metas.');
  await react(u.ana, g1.id, '🎉'); await react(u.carlos, g1.id, '🎉'); await react(u.maria, g1.id, '👍');
  await say(u.ana, ch.general, 'Excelente, ya no más grupos de WhatsApp para todo 😅');
  await say(u.jorge, ch.general, '¿Alguien sabe si el viernes trabajamos medio día?');
  const g4 = await say(u.sofia, ch.general, `<@${u.jorge.id}> sí, el viernes salimos a las 2:00 pm.`);
  await say(u.jorge, ch.general, 'Gracias Sofía', { parentId: g4.id });

  const v1 = await say(u.ana, ch.ventas, '**Meta de la semana:** 20 pólizas. Vamos en 12, ¡a cerrar fuerte! 💪');
  await react(u.carlos, v1.id, '🔥'); await react(u.lucia, v1.id, '🔥');
  const v2 = await say(u.carlos, ch.ventas, 'Cerré 2 pólizas de Medicare Advantage hoy con la familia Rodríguez.');
  await say(u.ana, ch.ventas, '¡Bien hecho Carlos! ¿Ya cargaste los documentos al sistema?', { parentId: v2.id });
  await say(u.carlos, ch.ventas, 'Todavía no, lo hago mañana temprano.', { parentId: v2.id });
  await say(u.ana, ch.ventas, `<@${u.lucia.id}> tienes la cita de las 3:00 con el cliente de Vida, confírmame cuando salgas.`);
  const v5 = await say(u.lucia, ch.ventas, 'El cliente pidió cotización de una póliza de vida a término 20 años por $250k. ¿Quién me ayuda con la comparativa?');
  await say(u.ana, ch.medicare, '<!channel> recuerden: el AEP arranca el 15 de octubre. Revisen el manual de Medicare antes de llamar clientes.');
  await say(u.carlos, ch.medicare, 'Entendido, ya lo estoy repasando.');
  await say(u.maria, ch.servicio, 'Tenemos 5 renovaciones que vencen esta semana. Jorge, ¿te encargas de las de Salud?');
  await say(u.jorge, ch.servicio, 'Sí, ya llamé a 3. Faltan los Méndez y la señora Torres.');
  await say(u.sofia, ch.gerencia, 'Reunión de líderes el lunes a las 9:00 para revisar los números del trimestre.');
  await say(u.ana, ch.gerencia, 'Perfecto, llevo el reporte de ventas.');

  const a1 = await say(owner, ch.anuncios, '**Nuevo proceso de verificación de identidad.** A partir del lunes, todo cliente nuevo debe enviar foto de su identificación antes de emitir la póliza. Detalles en el manual de Ventas.', { ackRequired: true, pinUntil: inDays(14) });
  for (const k of ['ana', 'maria', 'carlos']) await call(u[k], 'POST', w(`/messages/${a1.id}/ack`));
  await say(u.sofia, ch.anuncios, 'La oficina estará cerrada el lunes 13 de octubre por mantenimiento eléctrico.');
  await call(u.ana, 'POST', w(`/messages/${v1.id}/pin`), {});

  const dm = (await call(u.ana, 'POST', w('/dms'), { userIds: [owner.id] })).data.id;
  await say(u.ana, dm, 'Rodrigo, ¿puedo darle acceso a Lucía al manual de comisiones?');
  await say(owner, dm, 'Sí, adelante. Lo revisamos en la reunión del lunes.');
  const gdm = (await call(u.maria, 'POST', w('/dms'), { userIds: [u.jorge.id, u.sofia.id] })).data.id;
  await say(u.maria, gdm, '¿Coordinamos las llamadas de renovación de mañana?');
  console.log('chat listo');

  // ─── 4. Manuales ───
  const mkDoc = async (who: Jar, body: object) => (await call(who, 'POST', w('/documents'), body)).data.id as string;
  const dVentas = await mkDoc(u.ana, {
    departmentId: dept['Ventas'], title: 'Proceso de venta', content: doc(
      h(1, 'Proceso de venta'), p('Pasos que sigue todo agente desde el primer contacto hasta la emisión de la póliza.'),
      h(2, 'Etapas'), ol('Calificar al prospecto (necesidad, presupuesto, elegibilidad).', 'Agendar cita y enviar recordatorio.', 'Presentar al menos dos opciones comparadas.', 'Verificar identidad (foto de la identificación).', 'Firmar y cargar documentos el mismo día.'),
      h(2, 'Errores comunes'), ul('Prometer coberturas sin revisar la red de proveedores.', 'No dejar nota del contacto en el CRM.'),
    ),
  });
  await mkDoc(u.ana, {
    departmentId: dept['Ventas'], parentId: dVentas, lineId: line['Medicare'], title: 'Guion de llamada Medicare (AEP)', content: doc(
      h(1, 'Guion de llamada Medicare'), p('Usar durante el periodo de inscripción anual (15 de octubre al 7 de diciembre).'),
      h(2, 'Apertura'), p('"Hola, le habla [nombre] de la agencia. Le llamo porque ya abrió el periodo para revisar su plan de Medicare."'),
      h(2, 'Preguntas clave'), ul('¿Sus médicos siguen en la red de su plan?', '¿Cuánto paga hoy en medicamentos?', '¿Ha tenido cambios de salud este año?'),
    ),
  });
  await mkDoc(u.ana, {
    departmentId: dept['Ventas'], lineId: line['Vida'], title: 'Comparativa de pólizas de vida', content: doc(
      h(1, 'Comparativa de pólizas de vida'), p('Resumen para explicar al cliente la diferencia entre vida a término, vida entera e IUL.'),
      ul('A término: barata, temporal, sin valor en efectivo.', 'Vida entera: permanente, prima fija, valor en efectivo garantizado.', 'IUL: permanente, prima flexible, crecimiento ligado a un índice.'),
    ),
  });
  await mkDoc(u.maria, {
    departmentId: dept['Servicio al cliente'], title: 'Guía de atención al cliente', content: doc(
      h(1, 'Guía de atención'), p('Tiempo máximo de respuesta: 4 horas hábiles por cualquier canal.'),
      h(2, 'Escalamiento'), ol('Agente de servicio.', 'Líder de Servicio.', 'Gerencia de operaciones.'),
    ),
  });
  await mkDoc(u.maria, {
    departmentId: dept['Renovaciones'], title: 'Calendario de renovaciones', content: doc(
      h(1, 'Calendario de renovaciones'), p('Contactar al cliente 30, 15 y 5 días antes del vencimiento.'),
    ),
  });
  await mkDoc(u.sofia, {
    departmentId: dept['Administración'], title: 'Política de comisiones', content: doc(
      h(1, 'Política de comisiones'), p('Las comisiones se pagan el día 15 de cada mes, sobre pólizas emitidas y con primer pago confirmado.'),
    ),
  });
  // Segunda edición de otra persona → genera historial de versiones
  await call(owner, 'PATCH', w(`/documents/${dVentas}`), { content: doc(
    h(1, 'Proceso de venta'), p('Pasos que sigue todo agente desde el primer contacto hasta la emisión de la póliza. Actualizado con la verificación de identidad.'),
    h(2, 'Etapas'), ol('Calificar al prospecto (necesidad, presupuesto, elegibilidad).', 'Agendar cita y enviar recordatorio.', 'Presentar al menos dos opciones comparadas.', 'Verificar identidad (foto de la identificación) — obligatorio desde el lunes.', 'Firmar y cargar documentos el mismo día.'),
  ) });
  console.log('manuales listos');

  // ─── 5. Tareas ───
  const task = async (who: Jar, body: object) => (await call(who, 'POST', w('/tasks'), body)).data.id as string;
  const t1 = await task(u.ana, { departmentId: dept['Ventas'], lineId: line['Medicare'], title: 'Llamar a los 30 clientes de Medicare antes del AEP', priority: 'high', dueAt: inDays(6), assigneeIds: [u.carlos.id], checklist: ['Exportar lista de clientes', 'Llamar del 1 al 15', 'Llamar del 16 al 30', 'Registrar resultados'] });
  const t2 = await task(u.ana, { departmentId: dept['Ventas'], lineId: line['Vida'], title: 'Preparar comparativa de vida a término por $250k', description: 'Cliente de Lucía, 42 años, no fumador.', priority: 'normal', dueAt: inDays(2), assigneeIds: [u.lucia.id, u.ana.id], sourceMessageId: v5.id });
  const t3 = await task(u.carlos, { departmentId: dept['Ventas'], lineId: line['Medicare'], title: 'Cargar documentos de la familia Rodríguez', priority: 'urgent', dueAt: inDays(-1), assigneeIds: [u.carlos.id], sourceMessageId: v2.id });
  await task(u.ana, { departmentId: dept['Ventas'], title: 'Actualizar el guion de llamada con las preguntas nuevas', priority: 'low', assigneeIds: [u.ana.id] });
  const t5 = await task(u.maria, { departmentId: dept['Renovaciones'], lineId: line['Salud'], title: 'Renovar pólizas de los Méndez y de la señora Torres', priority: 'high', dueAt: inDays(3), assigneeIds: [u.jorge.id], checklist: ['Méndez', 'Torres'] });
  const t6 = await task(u.maria, { departmentId: dept['Servicio al cliente'], title: 'Responder quejas pendientes del mes', priority: 'normal', dueAt: inDays(10), assigneeIds: [u.jorge.id, u.maria.id] });
  const t7 = await task(u.sofia, { departmentId: dept['Administración'], title: 'Cerrar nómina de comisiones de septiembre', priority: 'high', dueAt: inDays(1), assigneeIds: [u.sofia.id] });
  const t8 = await task(owner, { departmentId: dept['Administración'], title: 'Contratar dos agentes nuevos para el AEP', priority: 'normal', dueAt: inDays(20), assigneeIds: [owner.id, u.sofia.id] });

  await call(u.carlos, 'PATCH', w(`/tasks/${t1}`), { status: 'doing' });
  const t1d = (await call(u.carlos, 'GET', w(`/tasks/${t1}`))).data;
  for (const it of t1d.checklist.slice(0, 2)) await call(u.carlos, 'PATCH', w(`/tasks/${t1}/checklist/${it.id}`), { done: true });
  await call(u.carlos, 'POST', w(`/tasks/${t1}/comments`), { body: 'Llevo 12 llamadas, 4 quieren cita para revisar su plan.' });
  await call(u.ana, 'POST', w(`/tasks/${t1}/comments`), { body: 'Muy bien. Prioriza a los que tienen Part D con prima alta.' });
  await call(u.lucia, 'PATCH', w(`/tasks/${t2}`), { status: 'doing' });
  await call(u.jorge, 'PATCH', w(`/tasks/${t5}`), { status: 'doing' });
  await call(u.jorge, 'POST', w(`/tasks/${t5}/comments`), { body: 'Los Méndez renuevan; la señora Torres pide cotizar otra aseguradora.' });
  await call(u.sofia, 'PATCH', w(`/tasks/${t7}`), { status: 'done' });
  await call(owner, 'PATCH', w(`/tasks/${t8}`), { status: 'todo' });
  void t3; void t6;
  console.log('tareas listas');

  // ─── 6. Metas e historial de 8 semanas ───
  const goal = async (body: object) => (await call(owner, 'POST', w('/goals'), body)).data.id as string;
  const gPol = await goal({ departmentId: dept['Ventas'], name: 'Pólizas vendidas', unit: 'pólizas', weeklyTarget: 20 });
  const gCit = await goal({ departmentId: dept['Ventas'], name: 'Citas agendadas', unit: 'citas', weeklyTarget: 40 });
  const gMed = await goal({ departmentId: dept['Ventas'], lineId: line['Medicare'], name: 'Inscripciones Medicare', unit: 'inscripciones', weeklyTarget: 8 });
  const gCas = await goal({ departmentId: dept['Servicio al cliente'], name: 'Casos resueltos', unit: 'casos', weeklyTarget: 30 });
  const gRen = await goal({ departmentId: dept['Renovaciones'], name: 'Renovaciones cerradas', unit: 'renovaciones', weeklyTarget: 15 });

  // Valores por semana, de la más vieja (7) a la anterior (1); Servicio deja la 3 sin reportar
  const hist = {
    pol: [14, 17, 21, 19, 23, 18, 22], cit: [35, 38, 44, 41, 39, 36, 42], med: [3, 4, 6, 5, 7, 6, 9],
    cas: [25, 28, 31, 29, null, 33, 27], ren: [10, 12, 15, 11, 14, 16, 13],
  };
  for (let back = 7; back >= 1; back--) {
    const i = 7 - back, wk = monday(back);
    const who = back > 1 ? owner : null;   // semanas cerradas solo las carga un Admin
    await call(who ?? u.ana, 'PUT', w('/reports'), { departmentId: dept['Ventas'], weekStart: wk, notes: back === 1 ? 'Buena semana, Carlos cerró 2 de Medicare.' : '', items: [
      { goalId: gPol, actual: hist.pol[i] }, { goalId: gCit, actual: hist.cit[i] }, { goalId: gMed, actual: hist.med[i] }] });
    if (hist.cas[i] !== null) await call(who ?? u.maria, 'PUT', w('/reports'), { departmentId: dept['Servicio al cliente'], weekStart: wk, items: [{ goalId: gCas, actual: hist.cas[i] }] });
    await call(who ?? u.maria, 'PUT', w('/reports'), { departmentId: dept['Renovaciones'], weekStart: wk, items: [{ goalId: gRen, actual: hist.ren[i] }] });
  }
  // Semana actual: solo Ventas reportó (los demás quedan "faltantes")
  await call(u.ana, 'PUT', w('/reports'), { departmentId: dept['Ventas'], weekStart: monday(0), notes: 'Parcial a mitad de semana.', items: [
    { goalId: gPol, actual: 12 }, { goalId: gCit, actual: 21 }, { goalId: gMed, actual: 4 }] });
  console.log('metas listas');

  // ─── 7. Segunda agencia para probar aislamiento ───
  await call(null, 'POST', '/auth/register', {
    name: 'Laura Otra', email: 'otra@agencia-hub.test', password: PASS, locale: 'es',
    workspace: { name: 'Otra Agencia', slug: 'otra-agencia', template: 'blank' },
  });
  console.log('segunda agencia lista\n\nListo. Contraseña de todas las cuentas: ' + PASS);
}

main().catch((e) => { console.error(e); process.exit(1); });
