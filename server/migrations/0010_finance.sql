-- 0010 · Finanzas: gastos (únicos y recurrentes), nómina y estados de cuenta del banco (docs/plan-finanzas.md, ADR 0007).
-- Moneda única USD; dinero en numeric(12,2) como en ventas. Rol nuevo "Contable" (accountant): Miembro fuera de
-- finanzas, Admin dentro. La conciliación banco ↔ comisiones (§6 del plan) es una fase posterior: aquí solo se
-- guarda lo necesario (compañía que paga, referencia, monto, fecha, estado de cruce).

-- ═══════════════════════════ Rol Contable y módulo ═══════════════════════════

alter table workspace_members drop constraint workspace_members_role_check;
alter table workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'lead', 'member', 'guest', 'accountant'));
alter table invitations drop constraint invitations_role_check;
alter table invitations add constraint invitations_role_check
  check (role in ('admin', 'lead', 'member', 'guest', 'accountant'));

-- Comprobantes de gastos y archivos originales de estados de cuenta van por el flujo normal de archivos
alter table files drop constraint files_context_check;
alter table files add constraint files_context_check
  check (context in ('message', 'document', 'avatar', 'logo', 'task', 'expense', 'bank_statement'));

-- Módulo activo por agencia: igual que ventas, las de seguros lo traen encendido
update workspaces set settings = settings || jsonb_build_object('finance_module', settings->>'industry' = 'insurance');
alter table workspaces alter column settings set default
  '{"max_file_mb": 25, "require_2fa": false, "weekly_summary": false, "industry": "other", "category_label": null, "sales_module": false, "finance_module": false}';

-- ═══════════════════════════ Gastos ═══════════════════════════

create table expense_categories (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  color        text not null default 'gray' check (color in ('green', 'blue', 'purple', 'orange', 'red', 'teal', 'pink', 'gray')),
  position     integer not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

-- Plantilla de gasto recurrente. El job diario genera sus ocurrencias (expenses) hasta 35 días adelante.
create table expense_schedules (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  category_id        uuid not null,
  vendor             text not null,                       -- proveedor/beneficiario: texto libre con autocompletado
  concept            text not null default '',
  amount             numeric(12,2) not null check (amount > 0),   -- estimado; un cambio aplica desde la próxima pendiente
  pay_method         text not null check (pay_method in ('card', 'ach', 'zelle', 'check', 'cash', 'other')),
  frequency          text not null check (frequency in ('daily', 'weekly', 'monthly')),
  interval_n         integer not null default 1 check (interval_n between 1 and 365),   -- cada N días/semanas/meses
  weekdays           smallint[],                          -- semanal: 0 = domingo … 6 = sábado
  month_day          smallint check (month_day between 1 and 31),   -- mensual: null = último día del mes
  business_days_only boolean not null default false,      -- diario: saltar sábados y domingos
  starts_on          date not null,
  ends_on            date,
  status             text not null default 'active' check (status in ('active', 'paused')),
  approval_status    text not null check (approval_status in ('approved', 'pending', 'rejected')),
  approved_by        uuid,                                -- quien aprobó o rechazó (null mientras está pendiente)
  approved_at        timestamptz,
  generated_until    date,                                -- hasta dónde llegó el job: la siguiente pasada sigue de ahí
  created_by         uuid not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on),
  check ((frequency = 'weekly') = (weekdays is not null and cardinality(weekdays) > 0)),
  check (weekdays is null or weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  check (frequency = 'monthly' or month_day is null),
  check (frequency = 'daily' or not business_days_only),
  check ((approval_status = 'pending') = (approved_at is null)),
  unique (workspace_id, id),
  foreign key (workspace_id, category_id) references expense_categories(workspace_id, id),
  foreign key (workspace_id, approved_by) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id)
);
create index on expense_schedules (workspace_id, status) where approval_status = 'approved';

-- Gasto único u ocurrencia de una plantilla. amount = estimado/registrado; paid_amount = lo que realmente se pagó.
create table expenses (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  schedule_id     uuid,                                   -- null = gasto único
  category_id     uuid not null,
  vendor          text not null,
  concept         text not null default '',
  due_date        date not null,
  amount          numeric(12,2) not null check (amount > 0),
  paid_amount     numeric(12,2) check (paid_amount > 0),
  paid_at         date,
  pay_method      text not null check (pay_method in ('card', 'ach', 'zelle', 'check', 'cash', 'other')),
  reference       text not null default '',
  notes           text not null default '',
  file_id         uuid,                                   -- comprobante (PDF/imagen)
  status          text not null default 'pending' check (status in ('pending', 'paid', 'skipped')),
  approval_status text not null check (approval_status in ('approved', 'pending', 'rejected')),
  approved_by     uuid,                                   -- quien aprobó o rechazó; null también si nació aprobada del job
  approved_at     timestamptz,
  created_by      uuid,                                   -- null = generada por el job desde la plantilla
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check ((status = 'paid') = (paid_at is not null and paid_amount is not null)),
  check ((approval_status = 'pending') = (approved_at is null)),
  check (schedule_id is not null or created_by is not null),
  unique (workspace_id, id),
  unique (schedule_id, due_date),                         -- el job es idempotente
  foreign key (workspace_id, schedule_id) references expense_schedules(workspace_id, id),
  foreign key (workspace_id, category_id) references expense_categories(workspace_id, id),
  foreign key (workspace_id, file_id) references files(workspace_id, id),
  foreign key (workspace_id, approved_by) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id)
);
create index on expenses (workspace_id, due_date desc);
create index on expenses (workspace_id, paid_at desc) where status = 'paid';
create index on expenses (workspace_id, due_date) where status = 'pending';            -- vencidos y próximos pagos
create index on expenses (workspace_id, category_id, due_date);
create index on expenses (workspace_id, created_at) where approval_status = 'pending';  -- bandeja de aprobación
create index on expenses (workspace_id, vendor);                                       -- filtro y autocompletado

-- ═══════════════════════════ Nómina ═══════════════════════════

-- Calendario de pago. semimonthly = días 15 y último del mes (fijo). weekly/biweekly toman el ciclo de anchor_date
-- (una fecha de pago cualquiera del ciclo); monthly paga el día pay_day (null = último día del mes).
create table payroll_calendars (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,
  frequency    text not null check (frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  anchor_date  date,
  pay_day      smallint check (pay_day between 1 and 31),
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  check ((frequency in ('weekly', 'biweekly')) = (anchor_date is not null)),
  check (frequency = 'monthly' or pay_day is null),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

-- Persona en nómina: no necesita usuario de Kora; se enlaza a uno solo si cobra comisión de ventas.
create table payroll_people (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  name          text not null,
  email         citext,
  phone         text,
  job_title     text,
  user_id       uuid,
  calendar_id   uuid not null,
  pay_method    text not null check (pay_method in ('ach', 'zelle', 'check', 'cash')),
  account_last4 text check (account_last4 ~ '^\d{4}$'),
  hired_on      date,
  terminated_on date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (terminated_on is null or hired_on is null or terminated_on >= hired_on),
  unique (workspace_id, id),
  unique (workspace_id, user_id),                         -- un usuario, una persona en nómina
  foreign key (workspace_id, user_id) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, calendar_id) references payroll_calendars(workspace_id, id)
);
create index on payroll_people (workspace_id, calendar_id) where is_active;

-- Componentes de pago con vigencia: un aumento es una fila nueva (cerrar la anterior con effective_to).
-- amount: sueldo/bono/deducción fija por periodo, o tarifa por hora. rate: % (de ventas ISSUE o del bruto).
create table payroll_components (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  person_id      uuid not null,
  kind           text not null check (kind in ('salary', 'hourly', 'sales_commission', 'sales_percent', 'bonus',
                                               'deduction_fixed', 'deduction_percent')),
  label          text not null default '',               -- "Adelanto", "Seguro médico"…
  amount         numeric(12,2) check (amount > 0),
  rate           numeric(6,3) check (rate > 0 and rate <= 100),
  effective_from date not null,
  effective_to   date,
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  check ((kind in ('salary', 'hourly', 'bonus', 'deduction_fixed')) = (amount is not null)),
  check ((kind in ('sales_percent', 'deduction_percent')) = (rate is not null)),
  unique (workspace_id, id),
  foreign key (workspace_id, person_id) references payroll_people(workspace_id, id) on delete cascade
);
create index on payroll_components (person_id, effective_from);

create table payroll_runs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  calendar_id  uuid not null,
  period_start date not null,
  period_end   date not null,
  pay_date     date not null,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  notes        text not null default '',
  approved_by  uuid,
  approved_at  timestamptz,
  paid_at      date,                                      -- toda la corrida pagada (última línea pagada)
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  check (period_end >= period_start),
  check ((status = 'draft') = (approved_at is null)),
  check ((status = 'paid') = (paid_at is not null)),
  unique (workspace_id, id),
  unique (workspace_id, calendar_id, period_start),       -- una corrida por periodo y calendario
  foreign key (workspace_id, calendar_id) references payroll_calendars(workspace_id, id),
  foreign key (workspace_id, approved_by) references workspace_members(workspace_id, user_id),
  foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id)
);
create index on payroll_runs (workspace_id, pay_date desc);

-- Una línea por persona. En borrador se recalcula; al aprobar queda congelada (breakdown incluido).
create table payroll_lines (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id       uuid not null,
  person_id    uuid not null,
  hours        numeric(7,2) check (hours >= 0),           -- solo si tiene componente por hora
  gross        numeric(12,2) not null default 0,
  deductions   numeric(12,2) not null default 0 check (deductions >= 0),
  net          numeric(12,2) not null default 0,
  breakdown    jsonb not null default '[]',               -- [{kind, label, amount, detail}] congelado al aprobar
  pay_method   text not null check (pay_method in ('ach', 'zelle', 'check', 'cash')),   -- copia al calcular
  paid_at      date,
  reference    text not null default '',
  check (net = gross - deductions),
  unique (workspace_id, id),
  unique (run_id, person_id),
  foreign key (workspace_id, run_id) references payroll_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references payroll_people(workspace_id, id)
);
create index on payroll_lines (workspace_id, paid_at desc) where paid_at is not null;
create index on payroll_lines (person_id);

-- Bonos o deducciones puntuales de una corrida para una persona (no se repiten en la siguiente)
create table payroll_adjustments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  run_id       uuid not null,
  person_id    uuid not null,
  kind         text not null check (kind in ('bonus', 'deduction')),
  label        text not null,
  amount       numeric(12,2) not null check (amount > 0),
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, run_id) references payroll_runs(workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references payroll_people(workspace_id, id),
  foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id)
);
create index on payroll_adjustments (run_id, person_id);

-- ═══════════════════════════ Banco ═══════════════════════════

create table bank_accounts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  name         text not null,                            -- "Chase operativa"
  bank_name    text not null default '',
  last4        text check (last4 ~ '^\d{4}$'),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

-- Mapeo de columnas del CSV de cada cuenta: el mes siguiente se importa sin volver a configurar
create table bank_csv_mappings (
  workspace_id uuid not null,
  account_id   uuid not null,
  mapping      jsonb not null,                           -- forma en shared/contracts (CsvMapping)
  updated_by   uuid not null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, account_id),
  foreign key (workspace_id, account_id) references bank_accounts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, updated_by) references workspace_members(workspace_id, user_id)
);

-- Cada importación de CSV: se puede deshacer completa (borra sus movimientos en cascada)
create table bank_statements (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  account_id    uuid not null,
  period_from   date not null,
  period_to     date not null,
  file_id       uuid,                                    -- archivo original
  rows_imported integer not null default 0,
  rows_skipped  integer not null default 0,              -- duplicados omitidos
  imported_by   uuid not null,
  imported_at   timestamptz not null default now(),
  check (period_to >= period_from),
  unique (workspace_id, id),
  foreign key (workspace_id, account_id) references bank_accounts(workspace_id, id),
  foreign key (workspace_id, file_id) references files(workspace_id, id),
  foreign key (workspace_id, imported_by) references workspace_members(workspace_id, user_id)
);
create index on bank_statements (account_id, period_from desc);

create table bank_transactions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  account_id   uuid not null,
  statement_id uuid,                                     -- null = carga manual
  posted_on    date not null,
  description  text not null default '',
  amount       numeric(12,2) not null check (amount <> 0),   -- + entrada / − salida
  reference    text not null default '',
  carrier_id   uuid,                                     -- compañía que paga (sugerida por alias, corregible)
  notes        text not null default '',
  source       text not null check (source in ('manual', 'csv')),
  match_status text not null default 'unmatched' check (match_status in ('unmatched', 'matched', 'ignored')),
  -- Clave de duplicado que calcula el servidor: fecha|monto|referencia (o descripción normalizada si no hay
  -- referencia). No es única: el mismo CSV puede listar dos movimientos idénticos legítimos (ADR 0007).
  dedupe_key   text not null,
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((source = 'csv') = (statement_id is not null)),
  unique (workspace_id, id),
  foreign key (workspace_id, account_id) references bank_accounts(workspace_id, id),
  foreign key (workspace_id, statement_id) references bank_statements(workspace_id, id) on delete cascade,
  foreign key (workspace_id, carrier_id) references carriers(workspace_id, id),
  foreign key (workspace_id, created_by) references workspace_members(workspace_id, user_id)
);
create index on bank_transactions (workspace_id, posted_on desc);
create index on bank_transactions (account_id, posted_on desc);
create index on bank_transactions (account_id, dedupe_key);
create index on bank_transactions (statement_id);
create index on bank_transactions (workspace_id, carrier_id, posted_on) where carrier_id is not null;
create index on bank_transactions (workspace_id, posted_on) where match_status = 'unmatched';

-- ═══════════════════════════ RLS y grants ═══════════════════════════

do $$
declare t text;
begin
  foreach t in array array['expense_categories', 'expense_schedules', 'expenses', 'payroll_calendars', 'payroll_people',
                           'payroll_components', 'payroll_runs', 'payroll_lines', 'payroll_adjustments',
                           'bank_accounts', 'bank_csv_mappings', 'bank_statements', 'bank_transactions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
    execute format('grant select, insert, update, delete on %I to agencia_app', t);
  end loop;
end $$;

-- Categorías básicas para las agencias que ya traen el módulo encendido (el backend las crea al activarlo después)
insert into expense_categories (workspace_id, name, color, position)
select w.id, c.name, c.color, c.position
from workspaces w
cross join (values ('Renta', 'blue', 0), ('Software', 'purple', 1), ('Marketing', 'orange', 2), ('Leads', 'green', 3),
                   ('Servicios', 'teal', 4), ('Impuestos', 'red', 5), ('Otros', 'gray', 6)) as c(name, color, position)
where w.settings->>'finance_module' = 'true'
on conflict do nothing;
