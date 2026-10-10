-- 0008 · Producto por defecto de cada compañía: el que se asume cuando el mensaje de Discord no dice el producto
-- (en VFS, "$3600 NLG UPPON ISSUE OH (...)" es el IUL de NLG).
alter table carriers add column default_product_id uuid;
alter table carriers add constraint carriers_default_product_fk
  foreign key (workspace_id, default_product_id) references carrier_products(workspace_id, id);
