-- 0012 · El resto de cada comisión se paga en cuotas mensuales (ADR 0008).
-- Antes: adelanto (advance_months de 12) al ISSUE + resto a los 12 meses. Ahora: el mismo adelanto y el resto en cuotas de
-- 1/12 del total en los meses advance_months+1 … 12; la última absorbe el redondeo. `seq` ordena las cuotas de una comisión:
-- 0 = adelanto, 1..n = resto, null = chargeback.
alter table commission_installments add column seq smallint;
update commission_installments set seq = case part when 'advance' then 0 when 'remainder' then 1 end;
alter table commission_installments add constraint commission_installments_seq_check
  check ((part = 'chargeback') = (seq is null) and (part <> 'advance' or seq = 0) and (part <> 'remainder' or seq >= 1));

-- Cada resto pendiente se reemplaza por sus cuotas mensuales (las pagadas o anuladas quedan como están: legado, seq 1).
-- Mismo beneficiario, tipo, nivel y %; fechas desde el ISSUE de la venta; advance_months actual de la compañía.
-- En centavos enteros, igual que installments() en server/src/sales/commissions.ts.
create temp table _rem on commit drop as
select r.id, r.workspace_id, r.sale_id, r.beneficiary_user_id, r.kind, r.level, r.rate, r.created_at, s.issued_at, c.advance_months,
       12 - c.advance_months as n,
       (r.amount * 100)::bigint as rem_c,
       (select (sum(o.amount) * 100)::bigint from commission_installments o
         where o.sale_id = r.sale_id and o.beneficiary_user_id = r.beneficiary_user_id and o.kind = r.kind
           and o.part <> 'chargeback' and o.status <> 'void') as total_c
from commission_installments r
join sales s on s.id = r.sale_id
join carrier_products p on p.id = s.product_id
join carriers c on c.id = p.carrier_id
where r.part = 'remainder' and r.status = 'pending' and s.issued_at is not null and c.advance_months < 12;

insert into commission_installments (workspace_id, sale_id, beneficiary_user_id, kind, part, seq, level, rate, amount, due_date, created_at)
select workspace_id, sale_id, beneficiary_user_id, kind, 'remainder', row_number() over (partition by id order by k),
       level, rate, cents / 100.0, issued_at + make_interval(months => advance_months + k), created_at
from (
  select x.*, k, case when k < x.n then x.each_c else x.rem_c - x.each_c * (x.n - 1) end as cents
  from (select _rem.*, case when n > 1 then least(round(total_c / 12.0)::bigint, floor(rem_c::numeric / (n - 1))::bigint) else 0 end as each_c
        from _rem) x
  cross join generate_series(1, x.n) k
) q
where cents > 0;

delete from commission_installments where id in (select id from _rem);
