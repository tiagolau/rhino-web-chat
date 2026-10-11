# 011 — Anexos hospedados no CDN do DataCrazy

**Data:** 2026-10-10
**Status:** aceito

## Contexto

Tiago quer escalar o webchat sem contratar banco/storage externos e sem acumular anexos na VPS. A Conexão Universal e o endpoint público de anexos guardam URLs. Porém, o upload usado pelo painel foi identificado e validado com a chave REST do RJ Global: o arquivo realmente fica no CDN do CRM. A investigação e as provas estão em [Conexão Universal](../datacrazy-conexao-universal.md).

## Decisão

- Nova branch `feat/anexos-crm`, criada da `main` e atualizada por fast-forward com a branch que contém as mudanças já publicadas. Commit e novo deploy autorizados por Tiago.
- `ANEXOS_NO_CRM=true` habilita a transferência pela fila existente. Padrão false para permitir ativação controlada e desabilitar a integração se a rota interna mudar.
- `/api/arquivos` conserva o contrato do widget: recebe o arquivo, grava temporariamente e retorna seu token. Enfileira `transferir_arquivo`.
- O job aguarda o vínculo com o lead, envia multipart campo `file` para a rota interna `/api/crm/files/upload/file/lead-attachments?sourceId=<leadId>` e persiste a URL retornada.
- Antes de liberar a cópia local, verifica tamanho e SHA-256 do download no CDN e registra o anexo no lead pela REST (campo `fileSize` inteiro). Só então remove o arquivo local.
- Migration 011 é aditiva: URL remota, hash, horários de tentativa/verificação/remoção e ID do registro no lead. Advisory lock de sessão por token impede duas réplicas de transferirem o mesmo arquivo; nenhuma transação permanece aberta durante chamadas de rede.
- Retries reaproveitam o upload confirmado. Se a resposta do registro se perder, uma consulta por URL recupera o anexo existente antes de repetir o POST. Falha entre upload remoto e persistência da URL ainda pode deixar objeto órfão no CDN, pois a rota não forneceu contrato de idempotência.
- Uma varredura de até 20 registros/minuto recupera arquivos antigos e uploads sem job. Após esgotar as oito tentativas da fila, a varredura permite novo ciclo depois de uma hora da última tentativa.
- URLs `/f/<token>/<nome>` já enviadas ao CRM continuam funcionando: antes da verificação servem o volume; depois redirecionam ao CDN. Não reescrever o histórico ou alterar a automação original.
- Upload, consulta e registro consomem o limitador existente. O download de verificação não usa credenciais. A URL retornada precisa pertencer ao CDN configurado e ao caminho de anexos; redirecionamentos de download são recusados.
- `/admin/status` mostra anexos transferidos, cópias locais, bytes locais e cópias com mais de 72 horas. Sem descarte cego por idade: arquivos cuja transferência não foi confirmada ficam preservados e visíveis como pendência.

## Alternativas Consideradas

- R2/S3 ou banco externo: rejeitados por Tiago para evitar contratar outro armazenamento.
- Usar apenas o endpoint público `attachments`: não demonstrou hospedagem, pois devolveu a URL de origem no teste.
- Apagar tudo após 72 horas: pode perder anexos e quebrar o CRM durante indisponibilidade.
- Upload bloqueante na requisição HTTP do aluno: atrasaria o envio e dependeria do orçamento REST. A fila durável permite receber o arquivo e transferir depois.
- Apagar o espelho de mensagens nesta mudança: escopo separado, pois histórico, deduplicação e atendimentos dependem dele. O Postgres continua local.

## Consequências

- Anexos passam a usar armazenamento do CRM; em funcionamento normal, a cópia local é removida logo após a confirmação, antes de 72 horas.
- Nenhum serviço pago externo novo foi contratado. Quotas e custos do plano do próprio CRM não foram homologados; não pressupor armazenamento ilimitado.
- A rota é interna do painel, sem contrato público de estabilidade. O sinalizador permite interromper novas transferências preservando os redirecionamentos existentes.
- O volume continua necessário como área temporária/fallback, inclusive para anexos antigos ainda não transferidos. Backups anteriores também ocupam disco até sua retenção vencer.
- O banco de mensagens, metadados, acessos e jobs ainda pode crescer. Esta decisão não implementa retenção de 72 horas do banco nem garante um teto absoluto de disco durante falhas prolongadas.
- Voltar ao código anterior após remover arquivos locais quebraria as URLs migradas. Rollback deve conservar a migration e a rota `/f/` com suporte ao CDN; para interromper uploads, desabilitar `ANEXOS_NO_CRM` na versão nova.

## Resultado

Implementação concluída e validada com Postgres descartável e CRM/CDN simulados: vínculo obrigatório, upload, SHA-256/tamanho, preservação em falhas, reaproveitamento no retry, registro com resposta perdida, exclusão local idempotente, concorrência entre réplicas, migração de anexo antigo, download pelo `/f/` e upload HTTP real consumido pela fila. Testes unitários e integração de menus/encerramento também passaram. Publicado na VPS Mapeamento com `ANEXOS_NO_CRM=true`. Duas réplicas em Node 22.23.3, serviço Postgres 1/1 e migration 011 aplicada. Os quatro anexos antigos e dois uploads sintéticos (PNG e TXT) foram transferidos: seis registros concluídos, zero cópias locais e zero bytes de anexos locais no status. Os links `/f/` antigos e novos foram verificados contra o hash persistido. Evidência em [011-anexos-crm-producao.json](../evidencias/011-anexos-crm-producao.json). Dump do banco, arquivo dos anexos e configuração anterior preservados em `/root/backups/webchat/anexos-crm-20261010-231923`; imagem anterior também retida. Commit e novo deploy autorizados por Tiago.
