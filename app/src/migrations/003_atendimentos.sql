-- Cada suporte é um atendimento no widget (ADR 004). No DataCrazy continua uma
-- conversa só por aluno; lá cada atendimento corresponde a uma "thread".
create table atendimentos (
  id                     uuid primary key,
  contact_id             text not null references alunos(contact_id),
  numero                 integer not null,          -- 1, 2, 3... por aluno
  status                 text not null default 'aberto' check (status in ('aberto', 'encerrado')),
  atendente              text,                      -- nome do atendente atual no DataCrazy
  atendente_checado_em   timestamptz,               -- última consulta à REST (limita o gasto)
  encerrado_por          text check (encerrado_por in ('aluno', 'datacrazy')),
  created_at             timestamptz not null default now(),
  encerrado_em           timestamptz,
  unique (contact_id, numero)
);
-- No máximo um atendimento aberto por aluno.
create unique index atendimentos_um_aberto on atendimentos (contact_id) where status = 'aberto';

alter table mensagens add column atendimento_id uuid references atendimentos(id);
create index mensagens_atendimento on mensagens (atendimento_id, created_at);

-- Avisos do próprio webchat na linha do tempo ("Fulano está te atendendo", "Atendimento encerrado").
alter table mensagens drop constraint mensagens_direcao_check;
alter table mensagens add constraint mensagens_direcao_check check (direcao in ('aluno', 'atendente', 'sistema'));

-- Mensagens anteriores a esta migration viram o atendimento nº 1, aberto.
insert into atendimentos (id, contact_id, numero, created_at)
select gen_random_uuid(), contact_id, 1, min(created_at) from mensagens group by contact_id;
update mensagens m set atendimento_id = a.id from atendimentos a where a.contact_id = m.contact_id;
