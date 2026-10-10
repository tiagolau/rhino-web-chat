-- Quando o webchat chamou o /finish do DataCrazy (aluno encerrou). Serve para
-- reconhecer o eco desse /finish no /dc/:slug/evento (ADR 004).
alter table atendimentos add column dc_finalizado_em timestamptz;
