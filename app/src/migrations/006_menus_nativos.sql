-- Metadados locais dos menus; os ramos continuam na sessão do DataCrazy.
alter table mensagens add column menu jsonb;
alter table mensagens add column opcao_id text;
alter table mensagens add column menu_origem uuid references mensagens(id);
alter table atendimentos add column menu_mensagem_id uuid references mensagens(id);
alter table atendimentos add column fluxo_nativo_iniciado boolean not null default false;
alter table faculdades add column fluxo_nativo boolean not null default false;
create index mensagens_cliente_busca on mensagens (contact_id, cliente_id) where cliente_id is not null;
