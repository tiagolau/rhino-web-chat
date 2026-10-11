-- Estado operacional mínimo não depende da existência do primeiro balão.
alter table atendimentos add column primeira_mensagem_id uuid;
update atendimentos a set primeira_mensagem_id = (
  select id from mensagens m where m.atendimento_id=a.id and m.direcao='aluno'
  order by m.created_at, m.id limit 1
);

alter table mensagens drop constraint mensagens_menu_origem_fkey;
alter table mensagens add constraint mensagens_menu_origem_fkey
  foreign key (menu_origem) references mensagens(id) on delete set null;
alter table atendimentos drop constraint atendimentos_menu_mensagem_id_fkey;
alter table atendimentos add constraint atendimentos_menu_mensagem_id_fkey
  foreign key (menu_mensagem_id) references mensagens(id) on delete set null;

create index mensagens_retencao on mensagens (created_at, id);
create index mensagens_menu_origem on mensagens (menu_origem) where menu_origem is not null;
create index atendimentos_menu_origem on atendimentos (menu_mensagem_id) where menu_mensagem_id is not null;
create index jobs_retencao on jobs (created_at) where status in ('feito','erro');

-- Espaço apagado é reutilizado pelo Postgres, sem VACUUM FULL bloqueante.
alter table mensagens set (autovacuum_vacuum_scale_factor=0.05, autovacuum_vacuum_threshold=100);
alter table jobs set (autovacuum_vacuum_scale_factor=0.05, autovacuum_vacuum_threshold=100);
