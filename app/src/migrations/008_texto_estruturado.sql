-- Migração por conexão: primeiro preparar o mapeamento e o fluxo no CRM.
alter table faculdades add column texto_estruturado boolean not null default false;
