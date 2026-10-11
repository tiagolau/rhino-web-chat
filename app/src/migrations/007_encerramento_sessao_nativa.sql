-- /finish não cancela a espera do robô. O próximo atendimento aguarda o
-- reconhecimento do encerramento pela sessão e a finalização da thread.
alter table atendimentos add column dc_sessao_limpa_em timestamptz;
alter table atendimentos add column dc_encerramento_concluido_em timestamptz;
update atendimentos set dc_encerramento_concluido_em = now() where status = 'encerrado';
