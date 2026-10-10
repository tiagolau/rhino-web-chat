# 001 — Webchat no portal Eduno via Conexão Universal do DataCrazy

**Data:** 2026-10-10
**Status:** aceito (prova de conceito validada). Itens 3 (lead), 4 (histórico) e 5 (hospedagem) revistos na ADR 002.

## Contexto

O grupo RJ Global (Facuvale, Iguaçu, Faculeste, Educaminas, FAME) usa o portal do aluno Eduno (HotSystems) e faz todo o suporte administrativo pelo WhatsApp no DataCrazy CRM, tenant `8e176de2-5471-4de9-8da7-3bfdb02d6b9e` (chave `DATACRAZY_API_KEY_RJGLOBAL`). O objetivo é oferecer um chat de suporte dentro da área do aluno, mantendo o DataCrazy como base de dados e caixa de atendimento, sem criar um segundo sistema de atendimento.

Restrições:
- **Evitar depender da HotSystems**, que é pouco flexível.
- A API Eduno não tem consulta de aluno, login nem validação de sessão (ver `docs/eduno-estrutura.md`).
- A conta do Tiago no Eduno é de aluno/parceiro, sem campo visível para script customizado.

## Decisão

1. **Canal:** cada faculdade terá uma **Conexão Universal** própria no DataCrazy, para separar as permissões de usuários no CRM. O webchat é tratado como mais uma instância, igual ao WhatsApp.
2. **Identidade no CRM:** `contactId = eduno:<slug-faculdade>:<idAluno>`. A faculdade é identificada pelo texto do rodapé `#hot-footer` do portal, e os dados do aluno vêm de `window.eduno.aluno` (`id`, `nome`, `email`, `celular`). **O CPF nunca é enviado.**
3. **Lead próprio:** a Conexão Universal **não cria lead**, só contato e conversa. O backend cria o lead pela REST (`POST /api/v1/leads`) com `contacts: [{platform: "UNIVERSAL", contactId, instanceId}]`, que o vincula à conversa.
4. **Histórico:** lido do próprio DataCrazy (`GET /api/v1/conversations/{id}/messages`), sem banco próprio.
5. **Backend obrigatório:** recebe as respostas do atendente (endpoint de envio da conexão), guarda os segredos (HMAC e API key) e as entrega ao navegador. A produção será Cloudflare Worker + Durable Object por aluno.

### Prova de conceito (`poc/`)

- `poc/receiver.mjs`: receptor local exposto por `cloudflared tunnel` (URL temporária `*.trycloudflare.com`).
- `poc/send-inbound.mjs`: simula o webchat e assina o corpo com HMAC-SHA256.
- Conexão de teste no tenant RJ Global: **"Webchat Iguaçu (teste)"**, instância `6aca6a619ab27fb81a32e33e`.

Validado de ponta a ponta:

| Etapa | Resultado |
|---|---|
| Webchat → DataCrazy com HMAC-SHA256 (hex, header `X-Signature`) | ✅ conversa criada |
| Lead criado pela REST e vinculado pelo `contactId` UNIVERSAL | ✅ lead `eb6b57c3-fb5f-4af1-bfb4-d92d44e6d28d` |
| Atendente responde no painel → receptor recebe | ✅ status `SENT` no DataCrazy |
| Variáveis `${contact.contactId}`, `${contact.name}`, `${message.body}` e `${message.id}` | ✅ todas substituídas |
| Autenticação de envio por API Key (`X-Api-Key`) | ✅ |

## Alternativas Consideradas

- **Chatwoot ou EVO CRM como caixa do webchat:** descartado porque criaria uma segunda caixa de atendimento separada do DataCrazy, onde a equipe e o histórico já estão.
- **Fundir com o lead do WhatsApp:** desnecessário (o usuário aceita lead próprio), além de arriscar mesclar o aluno errado.
- **Confiar em `window.eduno.aluno` sem verificação:** rejeitado. O objeto é editável no DevTools e permitiria falar em nome de outro aluno ou ler o histórico dele. Será usado código de verificação por WhatsApp no primeiro acesso.
- **Script no template do Eduno via HotSystems:** depende de um fornecedor pouco flexível. Fica como melhoria futura. O plano B é uma página própria de webchat, linkada no portal.
- **Injetar `<script>` por campo de conteúdo (slides, comunicados):** rejeitado, porque seria explorar uma brecha do sistema do fornecedor.

## Consequências

**Positivas**
- A equipe atende no mesmo DataCrazy, com as mesmas permissões, funis e automações.
- Não há banco de dados próprio: conversa, lead e histórico ficam no DataCrazy.
- Adicionar uma faculdade é criar uma conexão e uma linha de configuração.

**Negativas e armadilhas encontradas**
- **O webhook responde `200 {"success":true}` mesmo quando falha.** O erro só aparece na aba Logs, que guarda o histórico por 1 hora. Na PoC, tudo falhava com `INVALID_SIGNATURE` e a API não mostrava nada.
- **Campos sensíveis do formulário (Segredo de Validação e valor das Credenciais) não salvaram quando preenchidos pelo Claude no Chrome.** Precisaram ser colados à mão. Para conferir, use a REST: `GET /api/v1/instances` devolve o segredo mascarado (`99d****138`) quando está gravado.
- **O webhook bloqueia o User-Agent do Python** (403 do Cloudflare). O `fetch` do Node passa normalmente.
- **Preencher `phone` no lead cria também um contato `WHATSAPP`.** Se o aluno já for lead pelo WhatsApp da secretaria, podem surgir dois leads com o mesmo número. Decisão pendente: guardar o celular em campo personalizado, em vez de `phone`.
- **O MCP não está habilitado no tenant RJ Global.** Tudo foi feito pela REST, com limite de 30 req/min.
- **A verificação de identidade tem um risco residual:** um aluno logado que edite o JavaScript pode receber o código no próprio número. A conversa, porém, fica sempre amarrada a um telefone real.

## Próximos passos

1. Decidir como colocar o webchat no portal: script no Eduno (se surgir um campo) ou página própria linkada.
2. Backend de produção (Worker + Durable Object) com verificação por código no WhatsApp.
3. Widget/página do webchat (JavaScript puro, Shadow DOM).
4. Criar as conexões definitivas por faculdade e excluir a conexão e o lead de teste.
