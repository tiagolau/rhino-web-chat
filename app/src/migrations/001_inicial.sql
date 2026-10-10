-- Configuração por faculdade: uma Conexão Universal do DataCrazy para cada.
create table faculdades (
  slug            text primary key,
  nome            text not null,
  rodape          text not null,           -- trecho do texto de #hot-footer que identifica a faculdade
  instance_id     text not null,           -- id da instância (conexão) no DataCrazy
  webhook_url     text not null,           -- URL de recebimento gerada pelo DataCrazy
  webhook_secret  text not null,           -- segredo HMAC-SHA256 da aba Recebimento
  api_key         text not null,           -- valor da credencial apiKey (DataCrazy -> nós)
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table alunos (
  contact_id   text primary key,           -- eduno:<slug>:<hash do CPF>
  faculdade    text not null references faculdades(slug),
  cpf_hash     text not null,
  cpf_cifrado  text not null,
  eduno_id     text,
  nome         text not null,
  email        text,
  celular      text,
  lead_id      text,
  lead_status  text not null default 'pendente',  -- pendente | vinculado | criado | erro
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index alunos_cpf_hash on alunos (cpf_hash);

-- Navegador que já abriu o chat de um aluno. O histórico anterior só aparece
-- em dispositivo conhecido (ADR 003).
create table dispositivos (
  id            uuid primary key,
  contact_id    text not null references alunos(contact_id),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index dispositivos_contact on dispositivos (contact_id);

-- Registro de aberturas de sessão, para detectar troca de CPF por IP/dispositivo.
create table acessos (
  id          bigserial primary key,
  ip          text,
  dispositivo uuid,
  cpf_hash    text not null,
  created_at  timestamptz not null default now()
);
create index acessos_ip on acessos (ip, created_at);
create index acessos_dispositivo on acessos (dispositivo, created_at);

-- Espelho das mensagens: o histórico sai daqui, nunca da REST do DataCrazy.
create table mensagens (
  id             uuid primary key,
  contact_id     text not null references alunos(contact_id),
  direcao        text not null check (direcao in ('aluno', 'atendente')),
  texto          text not null default '',
  anexo_url      text,
  anexo_tipo     text,
  anexo_nome     text,
  dc_message_id  text unique,
  status         text not null,             -- aluno: pendente | enviada | erro ; atendente: recebida
  created_at     timestamptz not null default now()
);
create index mensagens_contact on mensagens (contact_id, created_at);

-- Arquivos enviados pelos alunos. O DataCrazy guarda só a URL, então o arquivo
-- precisa existir enquanto a conversa existir.
create table arquivos (
  token       text primary key,
  contact_id  text not null references alunos(contact_id),
  nome        text not null,
  mime        text not null,
  tamanho     integer not null,
  created_at  timestamptz not null default now()
);

-- Fila de trabalhos (SELECT ... FOR UPDATE SKIP LOCKED).
create table jobs (
  id           bigserial primary key,
  tipo         text not null,
  chave        text,                         -- deduplicação (ex.: contact_id do vínculo de lead)
  payload      jsonb not null default '{}',
  tentativas   integer not null default 0,
  executar_em  timestamptz not null default now(),
  status       text not null default 'pendente',  -- pendente | executando | feito | erro
  erro         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index jobs_fila on jobs (status, executar_em);
create unique index jobs_unico on jobs (tipo, chave) where chave is not null and status in ('pendente', 'executando');
