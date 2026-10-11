-- O protocolo de ACK pertence ao v2 adaptado; o original compartilhado não o implementa.
alter table faculdades add column confirmar_encerramento boolean not null default true;
