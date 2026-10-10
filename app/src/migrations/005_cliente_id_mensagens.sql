-- Correlaciona o balão otimista com a mensagem persistida antes do ack.
-- Opcional para mensagens existentes e navegadores com o widget anterior.
alter table mensagens add column cliente_id varchar(128);
