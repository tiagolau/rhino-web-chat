-- Id da conversa no DataCrazy, guardado na primeira vez que for preciso buscar
-- um anexo pela REST (fallback quando a conexão não tem o endpoint "Anexos").
alter table alunos add column dc_conversation_id text;
