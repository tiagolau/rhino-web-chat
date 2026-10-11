-- Progresso durável da transferência; URLs /f/ anteriores continuam válidas.
alter table arquivos
  add column crm_url text,
  add column sha256 text,
  add column crm_verificado_em timestamptz,
  add column crm_anexo_id text,
  add column crm_tentativa_em timestamptz,
  add column local_removido_em timestamptz;

create index arquivos_transferencia_pendente on arquivos (crm_tentativa_em, created_at)
  where local_removido_em is null;
