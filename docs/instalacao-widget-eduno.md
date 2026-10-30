# Instalação do chat de suporte na área do aluno (Eduno)

Texto para enviar à HotSystems. Troque `https://webchat.exemplo.com.br` pela `PUBLIC_URL` do backend em produção.

## Código

Inclua esta linha no layout das páginas logadas da área do aluno, antes de `</body>`:

```html
<script src="https://webchat.exemplo.com.br/widget.js" defer></script>
```

Não é preciso configurar mais nada.

## O que o script usa da página

O portal já tem os dois itens abaixo:

- **`window.eduno.aluno`** com `id`, `nome`, `cpf`, `email` e `celular`. Se o objeto não existir, o script não faz nada. Por isso pode carregar com segurança em páginas sem aluno logado.
- **Elemento `#hot-footer`** com o nome da faculdade. É por ele que o chat identifica a faculdade do aluno.

## Comportamento

- Mostra um botão flutuante no canto da tela. No celular, o chat abre em tela cheia.
- Todo o visual fica isolado em Shadow DOM: não interfere no CSS nem no JavaScript do portal.
- Não depende de jQuery nem de outra biblioteca.
- Conecta somente ao endereço do próprio script (HTTPS e WebSocket `wss://`).

## Fase de testes

Enquanto só uma faculdade estiver ligada, peça para ativar o script **apenas no portal dela**. Se o template for o mesmo para todas as faculdades, a condição pode ser o texto do rodapé. Libere as outras à medida que as conexões forem criadas ([faculdade-nova.md](faculdade-nova.md)).

O backend precisa aceitar a origem do portal: inclua o endereço, ex.: `https://ava07.eduno.com.br`, em `ALLOWED_ORIGINS`.

## Como conferir

1. Entre na área do aluno com um aluno de teste.
2. O botão do chat deve aparecer no canto inferior da tela.
3. Envie uma mensagem. O balão deve ser confirmado e a equipe de suporte recebe a mensagem no DataCrazy.
