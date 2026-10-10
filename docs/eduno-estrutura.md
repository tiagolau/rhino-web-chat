# Estrutura do portal do aluno Eduno

**Data do levantamento:** 2026-10-10
**Alvo:** `https://ava07.eduno.com.br/inicio` (instituição: Faculdade Iguaçu; fornecedor: HotSystems Soluções em TI Ltda, produto Eduno EAD)
**Método:** inspeção somente leitura da página logada (via Claude no Chrome) + `curl -I` na rota pública. Nenhum dado sensível foi registrado neste documento.

## 1. Stack do servidor

| Item | Valor |
|---|---|
| Servidor web | nginx 1.25.3 |
| Linguagem | PHP 7.4.33 (`X-Powered-By`) |
| Framework | Laravel (cookies `XSRF-TOKEN` e `eduno_session`, ambos no padrão Laravel) |
| Autenticação | Sessão por cookie `eduno_session` (`HttpOnly`, `SameSite=Lax`, validade de 12h). Rota sem sessão responde `302` para `/login` |
| Cache | `Cache-Control: private, must-revalidate`, `pragma: no-cache` |

## 2. Front-end

- **Não é SPA.** Página renderizada no servidor, com jQuery. Não há React, Angular nem Vue, e não existe `#root`/`#app`.
- **Bibliotecas:** jQuery 3.6.0, Bootstrap 5.3.1, bootstrap-datepicker, jquery-mask, Raphael, Morris, DataTables (estado persistido em localStorage).
- **Scripts próprios (mesmo domínio):** `/js/app.js`, `/js/plataforma.js`, `/js/edunoead.js`.
- **Terceiros:** `www.gstatic.com` (Google Charts), Google Fonts (via CSS), reCAPTCHA (`_grecaptcha` no localStorage).
- **Sem chat, suporte ou analytics instalados** (Zendesk, Tawk, Crisp, Intercom, Hotjar, GA, GTM, Pixel e Clarity não encontrados). Sem iframes.
- **Navegação:** cada item de menu provavelmente recarrega a página inteira, então um script no template base roda em todas as telas.

### Layout (IDs estáveis no `body`)

| Elemento | Observação |
|---|---|
| `header#hot-header` | Cabeçalho |
| `aside#hot-sidebar` | Menu lateral (visão de aluno: Home, Meus cursos, Financeiro, Documentos, Protocolos) |
| `div#hot-content` | Conteúdo |
| `footer#hot-footer` | Rodapé fixo, 48px de altura, z-index 900 |
| `#offcanvasAjuda` | Painel lateral "Ajuda", com corpo vazio |

Camadas de z-index observadas: rodapé 900, painéis laterais 1045, modal de erro 1055. Um elemento flutuante deve usar `bottom` ≥ 64px e z-index ≤ 1000.

## 3. Script inline e objetos globais

Há um único `<script>` inline, no final do `<body>` (~1,7 KB), nenhum no `<head>`. Ele declara:

- `eduno` (contém `eduno.aluno`, ver abaixo)
- `w_statusPermitidos`
- `w_numero_cursos`
- `w_esconder`
- `oc_impressao`

Não existem `window.__CONFIG__` nem `window.env`.

### `window.eduno.aluno`

Campos disponíveis (valores omitidos de propósito): `id`, `nome`, `cpf`, `email`, `celular`.

> ⚠️ O objeto inclui **CPF**. Qualquer integração externa deve enviar somente o necessário (`id`, `nome`, `email`, e telefone se for preciso) e nunca o CPF.

## 4. Armazenamento no navegador

- **localStorage (4 chaves):** `DataTables_tabContratacoes_/contratacoes`, `DataTables_tabAlunos_/alunos`, `DataTables_tabSlides_/comunicacao/slides`, `_grecaptcha`. Nenhuma guarda dados do usuário. Os nomes sugerem que a conta usada no levantamento também acessa telas administrativas (alunos, contratações, slides).
- **sessionStorage:** `ed-popup`.
- **Cookies legíveis por JS:** apenas `XSRF-TOKEN`. A sessão é `HttpOnly`.
- Não há JWT nem chave de API em `window` ou nos storages.

## 5. Restrições de embed (CSP e frames)

- Sem `<meta http-equiv="Content-Security-Policy">` na página.
- Headers da rota pública (`/` e `/inicio`, que respondem `302` para `/login`): **sem** `Content-Security-Policy`, `X-Frame-Options` ou `frame-ancestors`.
- Teste de `fetch` em modo `no-cors` para domínio externo (`app.chatwoot.com`) passou, então `connect-src` não bloqueia terceiros.
- A página já carrega script do `gstatic.com`, o que indica que `script-src` não está restrito a `'self'`.
- **Não verificado:** headers das rotas autenticadas (podem diferir das públicas) e `script-src`/`frame-src` na prática, porque isso exige injetar um script externo.

## 6. Pontos de injeção

1. **Campo de script customizado no admin:** não encontrado nas telas visíveis. O menu administrativo não foi explorado, então a ausência não é conclusiva. Telas candidatas: configurações, tema e comunicação (`/comunicacao/slides`).
2. **Pedido ao fornecedor (HotSystems):** incluir um snippet no template base.
3. **Userscript/extensão no navegador:** o DOM aceita a injeção, mas só serve para prova de conceito, não chega aos alunos.

O painel `#offcanvasAjuda` vazio indica que o template já prevê um espaço de suporte.

## 7. API oficial Eduno (HotSystems)

Fonte: blueprint do Apiary `edunoead` (atualizado em 2026-07-09). Base `https://ava07.eduno.com.br/api`, auth pelo header `x-token` (token emitido pela HotSystems). Sucesso: `rc == "00"`. Já usada pelo `agente-vendas-global` (Faculdade Global).

| Método | Caminho | Uso |
|---|---|---|
| GET | `/areasdeinteresse` | Áreas de interesse |
| GET | `/cursos` | Catálogo |
| GET | `/cursos/detalhado` | Catálogo detalhado |
| GET | `/cursosarea/{area_id}` | Cursos por área (404 no ava07) |
| GET | `/infocurso/{curso_id}` | Detalhe do curso |
| POST | `/matricular` | Cria/atualiza matrícula por CPF |
| POST | `/confirmarmatricula` | Confirma matrícula degustação |
| POST | `/proposta/gerar` | Link de auto-matrícula |

> **Não existe endpoint de consulta de aluno** (por ID, CPF ou e-mail), nem de login, SSO ou validação de sessão. Um sistema externo não consegue confirmar pela API quem é o aluno logado no portal.

## 8. Pendências de verificação

- Headers de resposta das rotas autenticadas (DevTools → Network → documento `/inicio`).
- Menu administrativo: existência de campo de script ou HTML customizado.
- Política da HotSystems/Faculdade Iguaçu sobre scripts de terceiros (há dados pessoais, portanto LGPD).
- Identificar o `BUTTON` observado no canto inferior direito (pode ser extensão do navegador).

## 9. Conclusão

Tecnicamente a viabilidade de injetar um widget externo é alta: HTML tradicional, sem CSP restritivo aparente, sem outro chat em conflito e com identificação do aluno disponível em `window.eduno.aluno`. O que decide a viabilidade real é quem controla o template (campo no admin ou pedido à HotSystems).
