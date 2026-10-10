# Rhino Webchat

Chat de suporte para a área do aluno do portal **Eduno**, atendido pela equipe no **DataCrazy CRM** do grupo RJ Global (Facuvale, Iguaçu, Faculeste, Educaminas, FAME).

O aluno conversa pelo widget dentro do portal (ou pela página `/chat`). A conversa cai na mesma caixa de atendimento do DataCrazy que a secretaria já usa para o WhatsApp, vinculada ao lead do aluno, que é encontrado pelo CPF.

- **Produção:** https://webchat.engrenatec.com.br
- **Página do aluno:** https://webchat.engrenatec.com.br/chat
- **Widget no portal:** `<script src="https://webchat.engrenatec.com.br/widget.js" defer></script>`

## Como funciona

```
Portal Eduno ── widget ──► webchat-api ──(webhook HMAC)──► DataCrazy (Conexão Universal, 1 por faculdade)
                              ▲                                   │
                              └──── resposta do atendente ────────┘
```

- **Identificação:** o widget lê os dados do aluno logado no Eduno (`window.eduno.aluno`) e a faculdade pelo rodapé do portal.
- **Lead:** o backend procura o lead do aluno no DataCrazy pelo CPF (depois pelo celular) e acrescenta o canal do webchat. Só cria um lead novo se não achar.
- **Tempo real:** WebSocket com o aluno. As réplicas se coordenam pelo Postgres (`LISTEN/NOTIFY` e fila com `SKIP LOCKED`).
- **Anexos:** nos dois sentidos. Os arquivos do aluno ficam no servidor com URL secreta, porque o DataCrazy guarda só o link.

## Stack

Node 22 · Fastify · WebSocket · PostgreSQL 16 · Docker Swarm + Traefik (VPS Mapeamento) · widget em JavaScript puro com Shadow DOM.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `app/` | Backend, widget, migrations, testes e deploy |
| `docs/` | Levantamento do Eduno, referência da Conexão Universal, ADRs e passo a passo |
| `ferramentas/` | Userscript para testar o widget no portal |
| `poc/` | Prova de conceito inicial (referência) |

## Desenvolvimento

```bash
cd app
cp .env.example .env            # preencher; gerar segredos com: openssl rand -hex 32
createdb rhino_webchat          # Postgres local
npm install
npm test                        # testes unitários
node --env-file=.env src/server.js
node scripts/e2e.mjs            # teste de ponta a ponta contra http://localhost:3000
```

## Deploy

```bash
app/deploy/deploy.sh   # precisa de app/deploy/.env.production (não versionado) e da chave SSH da VPS
```

## Documentação

- [CLAUDE.md](CLAUDE.md): estado atual, próximos passos, padrões e armadilhas. **Comece por aqui.**
- [docs/faculdade-nova.md](docs/faculdade-nova.md): como ligar uma faculdade.
- [docs/decisions/](docs/decisions/): decisões de arquitetura (ADRs).
- [docs/eduno-estrutura.md](docs/eduno-estrutura.md): levantamento do portal Eduno.
- [docs/datacrazy-conexao-universal.md](docs/datacrazy-conexao-universal.md): referência da Conexão Universal.
