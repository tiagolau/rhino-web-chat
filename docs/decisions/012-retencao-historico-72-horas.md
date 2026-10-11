# 012 — Histórico local limitado a 72 horas

**Data:** 2026-10-10
**Status:** aceito

## Contexto

Após hospedar os anexos no CRM (ADR 011), Tiago pediu que o histórico de mensagens na VPS dure no máximo 72 horas. O Postgres ainda contém o espelho, referências de menus, correlação de envios e fila. Apagar linhas sem ajustar essas dependências pode bloquear a limpeza ou reiniciar o robô por considerar uma continuação como primeira mensagem.

## Decisão

- Janela fixa de 72 horas contadas de `mensagens.created_at`, em todas as direções e estados. A API de histórico, resumos, publicação por WebSocket, seleção de menu e envio ao CRM aplicam o corte independentemente da limpeza física.
- Exclusão na subida e a cada 60 segundos, em até dez lotes de mil mensagens. Em funcionamento normal, o conteúdo deixa de ser acessível aos 72h e a linha é apagada na próxima execução (até cerca de um minuto depois). Uma VPS parada ou uma falha de banco pode atrasar a execução; não prometer prazo físico exato em indisponibilidade.
- Advisory lock transacional coordena réplicas. Ordem de travas igual à do envio (aluno → atendimento → mensagens). Referências de menu usam `ON DELETE SET NULL`; notificações atualizam o atendimento depois do commit.
- Pendências de envio também expiram. Os jobs dependentes são concluídos/cancelados sem o conteúdo antigo. Um aviso novo, sem reproduzir texto/anexo vencido, informa no atendimento que a solicitação precisa ser reenviada. Não conservar mensagens não entregues indefinidamente como exceção à janela solicitada.
- Migration 012 adiciona `atendimentos.primeira_mensagem_id` (UUID sem corpo nem FK para mensagens), inicializado pelo primeiro envio existente. O envio compara esse ID, em vez de depender de linhas anteriores ainda presentes. Assim a retenção não reinicia as boas-vindas no atendimento ativo.
- Configuração de autovacuum e índices de idade/FKs permitem reutilizar espaço apagado, sem `VACUUM FULL` bloqueante. O arquivo físico do banco não necessariamente diminui a cada exclusão.
- Jobs concluídos e erros de jobs dependentes de mensagens, além dos registros de acesso, expiram após 72 horas. Erros operacionais de vínculo, encerramento e transferência de arquivos ficam preservados, pois não são histórico de mensagens e ainda precisam de resolução.
- Identidade, vínculo ao lead, estado dos atendimentos e mapeamento de URLs dos anexos continuam locais. O conteúdo já entregue fica no CRM, não é apagado dele. O webchat mostra apenas sua janela recente, sem buscar automaticamente todo o histórico antigo pela REST.
- Backups em `/root/backups/webchat` também expiram: `app/deploy/limpar-backups.sh` remove arquivos com mais de 4.320 minutos; cron específico executa a cada minuto. Não percorre backups de outros projetos.

## Alternativas Consideradas

- Só ocultar mensagens na interface: deixaria conteúdo acumulado no banco.
- Preservar todas as mensagens de atendimentos abertos ou pendentes: ultrapassaria o limite solicitado.
- Consultar o histórico inteiro no CRM a cada abertura: aumentaria a dependência do orçamento REST de 30 req/min compartilhado.
- Particionar toda a tabela: mudança maior que a necessária no volume atual. Índice de idade, lotes e autovacuum resolvem a janela móvel; reavaliar se medições futuras justificarem.
- Remover atendimentos, identidades e tokens junto com as mensagens: comprometeria sessão, vínculo e continuidade do suporte.

## Consequências

- Conteúdo e índices do espelho passam a acompanhar uma janela móvel, em vez de acumular todo o histórico. Cadastros e metadados operacionais ainda podem crescer; isso não é um teto absoluto de todo o disco da VPS.
- Deduplicação baseada nas linhas do histórico passa a ter a mesma janela de retenção. O CRM conserva seus próprios registros de mensagens.
- O aluno perde acesso ao histórico anterior às 72 horas pelo webchat; o atendente conserva acesso pelo DataCrazy. Uma pendência que não chegou ao CRM antes de expirar exige reenvio.
- Backup local também é curto. Exclusões autorizadas pela política não são desfeitas por rollback do código; evitar restaurar snapshots antigos na base ativa para não reintroduzir conteúdo vencido.

## Resultado

Testes com Postgres descartável passaram: API filtra antes da exclusão física, conteúdo vencido e acesso antigo são removidos, mensagens com 71h59 permanecem, pendência vencida gera aviso sem o corpo antigo, FKs/menus não bloqueiam, execução concorrente não duplica e continuação não reinicia o robô. Regressões de mensagens, menus, encerramento e anexos também passaram. Publicado na VPS Mapeamento com duas réplicas e migration 012 aplicada. Prova sintética confirmou que a API omite uma mensagem de 73h antes da exclusão física e mantém a recente; depois, a linha vencida foi excluída e a recente preservada. Fixtures removidas ao terminar. Uma segunda fixture vencida foi removida automaticamente pelas réplicas em 36 segundos, sem chamada manual da limpeza. Estado final da consulta: 355 mensagens locais, zero vencidas. Os seis anexos continuam no CDN, sem cópias locais. Cron de backups instalado e serviço cron ativo. Backup anterior em `/root/backups/webchat/retencao-72h-20261010-232848`, sujeito à mesma janela. Evidência em [012-retencao-producao.json](../evidencias/012-retencao-producao.json). Commit e novo deploy autorizados por Tiago.
