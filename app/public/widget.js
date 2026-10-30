/*
 * Rhino Webchat — widget de suporte do portal Eduno.
 *
 * Modo portal: incluído na área do aluno, lê window.eduno.aluno e o rodapé.
 *   <script src="https://webchat.exemplo.com.br/widget.js" defer></script>
 * Modo página: usado em /chat, pede os dados num formulário.
 *   <script src="/widget.js" data-modo="pagina" defer></script>
 *
 * Tudo fica dentro de um Shadow DOM para não colidir com o CSS/JS do portal.
 *
 * Cada suporte é um "atendimento" (ADR 004): o widget mostra só o atual, o
 * aluno pode encerrá-lo e consultar os anteriores. No DataCrazy a conversa é uma só.
 */
(function () {
  "use strict";
  if (window.__rhinoWebchat) return;
  window.__rhinoWebchat = true;

  var script = document.currentScript;
  var API = (script && script.getAttribute("data-api")) || (script ? new URL(script.src).origin : location.origin);
  var WS = API.replace(/^http/, "ws");
  var MODO = (script && script.getAttribute("data-modo")) || (window.eduno && window.eduno.aluno ? "portal" : null);
  if (!MODO) return; // fora do portal e sem modo explícito: não faz nada

  var CHAVE_TOKENS = "rhino_webchat_tokens";

  // ------------------------------------------------------------- estado ---
  var estado = {
    aberto: false,
    sessao: null, // { token, faculdade, aluno }
    atendimento: null, // { id, numero, status, atendente, ... } ou null = novo, ainda sem mensagens
    mensagens: [], // do atendimento atual: { id?, clienteId?, direcao, texto, anexo, status, atendimentoId, criadaEm }
    tela: "atual", // atual | lista | antigo
    antigo: null, // { atendimento, mensagens } quando tela = antigo
    confirmandoEncerrar: false,
    ws: null,
    tentativasWs: 0,
    naoLidas: 0,
    filaEnvio: [],
  };

  function dadosDoPortal() {
    var a = (window.eduno && window.eduno.aluno) || {};
    var rodape = document.getElementById("hot-footer");
    return {
      aluno: { id: a.id, nome: a.nome, cpf: a.cpf, email: a.email, celular: a.celular },
      rodape: rodape ? rodape.innerText : "",
    };
  }

  // Um token por aluno (computador compartilhado no polo).
  function chaveAluno() {
    if (MODO === "pagina") return "pagina";
    var a = (window.eduno && window.eduno.aluno) || {};
    return "eduno:" + (a.id || "anon");
  }
  function lerTokens() {
    try { return JSON.parse(localStorage.getItem(CHAVE_TOKENS) || "{}"); } catch (e) { return {}; }
  }
  function tokenSalvo() { return lerTokens()[chaveAluno()] || null; }
  function salvarToken(t) {
    var todos = lerTokens();
    if (t) todos[chaveAluno()] = t; else delete todos[chaveAluno()];
    try { localStorage.setItem(CHAVE_TOKENS, JSON.stringify(todos)); } catch (e) {}
  }

  function icone(tipo) {
    var formas = {
      chat: '<path d="M5 5h14v11H9l-4 4V5Z"/><path d="M9 9h6M9 12h4"/>',
      fechar: '<path d="m6 6 12 12M18 6 6 18"/>',
      enviar: '<path d="m5 12 14-7-5 14-2-7-7 0Z"/><path d="m12 12 7-7"/>',
      anexo: '<path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9"/><path d="m8 13 7-7"/>',
      arquivo: '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h4M9 13h6M9 17h4"/>'
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + formas[tipo] + '</svg>';
  }

  // ----------------------------------------------------------------- DOM ---
  var host = document.createElement("div");
  host.id = "rhino-webchat";
  var raiz = host.attachShadow({ mode: "open" });
  raiz.innerHTML =
    "<style>" +
    ":host{all:initial;--ink:#17343d;--muted:#63777b;--accent:#087f75;--line:#e0e9e7;--paper:#f6f8f6;color:var(--ink);font-family:'Avenir Next',Avenir,'Segoe UI',sans-serif}" +
    "*{box-sizing:border-box;font-family:inherit}button,input,select,textarea{font:inherit}button{cursor:pointer}button,textarea,input,select{-webkit-tap-highlight-color:transparent}button:focus-visible,a:focus-visible{outline:3px solid #37a99a;outline-offset:3px}svg{width:22px;height:22px;flex-shrink:0}button{transition:background .16s,transform .16s}button:active{transform:translateY(1px)}" +
    ".lancador{position:fixed;right:24px;bottom:64px;z-index:1000;display:flex;align-items:center;gap:10px;border:1px solid #ffffff30;border-radius:18px;padding:16px 20px;background:var(--ink);color:#fff;font-size:14px;font-weight:600;box-shadow:0 8px 28px #17343d30}.lancador:hover{background:var(--accent)}.selo{min-width:22px;height:22px;border-radius:12px;background:#c54d40;color:#fff;font-size:12px;display:none;align-items:center;justify-content:center;padding:0 6px}" +
    ".painel{position:fixed;right:24px;bottom:64px;z-index:1000;width:410px;height:640px;max-height:calc(100dvh - 96px);display:none;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:24px;box-shadow:0 20px 70px #17343d26;overflow:hidden;color:var(--ink)}.painel.aberto{display:flex;animation:entrada .22s ease-out}" +
    ":host(.pagina){display:block;width:100%;height:100%;min-height:0}:host(.pagina) .painel{position:static;width:100%;height:100%;max-height:none;border-radius:24px;display:flex;box-shadow:0 18px 60px #17343d0d}" +
    ".topo{display:flex;align-items:center;gap:12px;padding:22px 24px;border-bottom:1px solid var(--line);background:#fff}.marca{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:44px;height:44px;border-radius:15px;background:var(--ink);color:#fff}.topo h2{margin:0;font-size:16px;letter-spacing:-.3px;font-weight:650}.topo p{margin:5px 0 0;font-size:12px;line-height:1.5;color:var(--muted)}.fechar{margin-left:auto;border:0;background:var(--paper);color:var(--muted);border-radius:10px;padding:9px;display:flex}.fechar:hover{background:var(--line)}" +
    ".aviso{padding:12px 24px;font-size:13px;line-height:1.5;background:#fff3dc;color:#815218;display:none}.lista{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:24px;background:var(--paper);display:flex;flex-direction:column;gap:12px;scrollbar-width:thin;scrollbar-color:#b7cbc6 transparent}.vazio{margin:auto;text-align:center;color:var(--muted);font-size:14px;max-width:300px;line-height:1.7}.vazio .simbolo{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border:1px solid #d6e6e0;border-radius:22px;background:#eaf2ee;color:var(--accent);margin:0 auto 22px}.vazio h3{font-size:24px;font-weight:600;letter-spacing:-.6px;color:var(--ink);margin:0 0 10px}.vazio p{margin:0}" +
    ".msg{max-width:84%;padding:13px 16px;border-radius:18px;font-size:14px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.msg.aluno{align-self:flex-end;background:var(--ink);color:#fff;border-bottom-right-radius:5px}.msg.atendente{align-self:flex-start;background:#fff;border:1px solid var(--line);border-bottom-left-radius:5px}.msg .meta{display:block;margin-top:7px;font-size:10px;opacity:.7;text-align:right}.msg.falha{background:#fff0ed;color:#a83227;border:1px solid #edc8c2}.msg.sistema{align-self:center;max-width:95%;padding:6px 12px;background:#e8eeea;border-radius:8px;color:#526964;font-size:11px;text-align:center}.msg img{display:block;max-width:100%;max-height:320px;object-fit:contain;border-radius:10px;margin-bottom:6px}.msg a{color:inherit;text-decoration:underline;text-underline-offset:3px}.arquivo{display:inline-flex;align-items:center;gap:8px}" +
    ".opcoes{align-self:flex-start;display:flex;flex-wrap:wrap;gap:8px;max-width:95%;margin-top:-4px}.opcao{border:1px solid #bad5ce;border-radius:12px;padding:11px 14px;background:#fff;color:#086b63;font-size:13px;font-weight:600;text-align:left;min-height:44px}.opcao:hover{background:#e7f3ed;border-color:var(--accent)}" +
    ".barra{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px;background:#fff;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted);flex-wrap:wrap}.barra:empty{display:none}.barra button{border:0;background:transparent;color:#166e65;font-size:12px;font-weight:600;padding:10px 8px;border-radius:8px}.barra button:hover{background:#edf5f1}.barra button.perigo{color:#a43c32}.barra button.perigo:hover{background:#fff0ed}.encerrado{display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px;border-top:1px solid var(--line);background:#fff;font-size:14px;color:var(--muted)}.encerrado button,.form button{border:0;border-radius:12px;padding:15px 20px;background:var(--accent);color:#fff;font-size:14px;font-weight:600}.encerrado button:hover,.form button:hover{background:#06685f}.item{display:block;width:100%;text-align:left;border:1px solid var(--line);border-radius:16px;padding:18px;background:#fff;font-size:13px;color:var(--ink)}.item:hover{border-color:var(--accent);background:#fafffc}.item strong{display:block;margin-bottom:8px}.item span{display:block;color:var(--muted);font-size:12px;line-height:1.6}" +
    ".rodape{display:flex;gap:10px;align-items:flex-end;padding:18px;border-top:1px solid var(--line);background:#fff}.rodape textarea{flex:1;min-width:0;resize:none;border:1px solid var(--line);background:var(--paper);border-radius:14px;padding:13px 14px;font-size:14px;line-height:1.5;max-height:120px;min-height:48px;color:var(--ink)}.rodape textarea:focus,.form input:focus,.form select:focus{outline:2px solid #087f7540;outline-offset:2px;border-color:var(--accent)}.icone{border:0;border-radius:14px;width:48px;height:48px;flex-shrink:0;display:flex;align-items:center;justify-content:center}.anexar{background:var(--paper);color:var(--muted)}.anexar:hover{background:var(--line)}.enviar{background:var(--accent);color:#fff}.enviar:hover{background:#06685f}.icone:disabled,.form button:disabled{opacity:.5;cursor:wait}" +
    ".form{flex:1;overflow-y:auto;padding:28px;display:flex;flex-direction:column;gap:18px}.form-intro{margin-bottom:6px}.sobretitulo{color:var(--accent);font-size:10px;letter-spacing:1.7px;font-weight:700;text-transform:uppercase}.form h3{margin:10px 0;font-size:28px;letter-spacing:-1px;font-weight:600}.form label{font-size:12px;font-weight:600;color:var(--ink);display:flex;flex-direction:column;gap:8px}.form input,.form select{width:100%;min-width:0;border:1px solid #d6e1dd;border-radius:11px;padding:13px 14px;font-size:14px;background:#fff;color:var(--ink);min-height:48px;font-weight:400}.form input::placeholder{color:#7d8f91}.campos{display:grid;grid-template-columns:1fr 1fr;gap:16px}.form .erro{color:#aa382f;font-size:13px;line-height:1.5}.form .erro:empty{display:none}.form p{margin:0;color:var(--muted);font-size:13px;line-height:1.7}.form .privacidade{font-size:11px;text-align:center;color:#6c807d}.form button{display:flex;align-items:center;justify-content:center;gap:12px}.form .opcional{font-weight:400;color:var(--muted)}" +
    "@keyframes entrada{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}@media(max-width:600px){.painel{right:0;bottom:0;width:100%;height:100dvh;max-height:none;border-radius:0}.topo{padding:18px}.form{padding:22px;gap:16px}.campos{grid-template-columns:1fr}.lista{padding:18px}.rodape{padding:12px;gap:8px}.msg{max-width:90%}:host(.pagina) .painel{border-radius:18px}.form h3{font-size:25px}:host(.pagina.identificacao) .painel{height:auto}:host(.pagina.identificacao) .form{overflow:visible}}" +
    "</style>" +
    '<button class="lancador" type="button" aria-label="Abrir atendimento">' + icone("chat") + ' Suporte <span class="selo"></span></button>' +
    '<section class="painel" role="dialog" aria-label="Atendimento">' +
    '<header class="topo"><span class="marca">' + icone("chat") + '</span><div><h2>Atendimento ao aluno</h2><p class="subtitulo">Um espaço para resolver suas dúvidas</p></div><button class="fechar" type="button" aria-label="Fechar">' + icone("fechar") + '</button></header>' +
    '<div class="aviso" role="status"></div>' +
    '<div class="corpo" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>' +
    "</section>";

  var el = {
    lancador: raiz.querySelector(".lancador"),
    selo: raiz.querySelector(".selo"),
    painel: raiz.querySelector(".painel"),
    subtitulo: raiz.querySelector(".subtitulo"),
    fechar: raiz.querySelector(".fechar"),
    aviso: raiz.querySelector(".aviso"),
    corpo: raiz.querySelector(".corpo"),
  };

  if (MODO === "pagina") {
    host.className = "pagina";
    el.lancador.style.display = "none";
    el.fechar.style.display = "none";
  }

  function aviso(texto) {
    el.aviso.textContent = texto || "";
    el.aviso.style.display = texto ? "block" : "none";
  }

  function atualizarSelo() {
    el.selo.textContent = estado.naoLidas > 9 ? "9+" : String(estado.naoLidas);
    el.selo.style.display = estado.naoLidas ? "inline-flex" : "none";
  }

  // ---------------------------------------------------------------- HTTP ---
  function api(caminho, opcoes) {
    opcoes = opcoes || {};
    var headers = opcoes.headers || {};
    if (estado.sessao && opcoes.autenticado) headers.Authorization = "Bearer " + estado.sessao.token;
    if (opcoes.json !== undefined) {
      headers["Content-Type"] = "application/json";
      opcoes.body = JSON.stringify(opcoes.json);
    }
    return fetch(API + caminho, { method: opcoes.method || "GET", headers: headers, body: opcoes.body }).then(function (r) {
      return r.text().then(function (t) {
        var dados = t ? JSON.parse(t) : {};
        if (!r.ok) { var e = new Error(dados.erro || "http_" + r.status); e.status = r.status; e.dados = dados; throw e; }
        return dados;
      });
    });
  }

  // -------------------------------------------------------------- sessão ---
  function iniciarSessao(extra) {
    var corpo = MODO === "portal" ? dadosDoPortal() : { aluno: {} };
    extra = extra || {};
    for (var k in extra) corpo[k] = extra[k];
    corpo.token = tokenSalvo();
    return api("/api/sessao", { method: "POST", json: corpo }).then(function (s) {
      estado.sessao = s;
      salvarToken(s.token);
      atualizarCabecalho();
      return s;
    });
  }

  function mensagemErroSessao(err) {
    if (err.message === "muitas_identidades") return "Muitas tentativas com alunos diferentes neste aparelho. Tente mais tarde.";
    if (err.message === "cpf_invalido") return "Não conseguimos identificar seu CPF.";
    return "Não foi possível abrir o atendimento agora. Tente novamente em instantes.";
  }

  function abrirAtendimento(extra) {
    aviso("");
    return iniciarSessao(extra)
      .then(function () { mostrarConversa(); return carregarHistorico(); })
      .then(conectar)
      .catch(function (err) {
        if (err.status === 422 && err.dados && err.dados.faculdades) return escolherFaculdade(err.dados.faculdades, extra);
        if (err.status === 401 && MODO === "pagina") { salvarToken(null); return mostrarFormulario(); }
        aviso(mensagemErroSessao(err));
      });
  }

  // ---------------------------------------------------------------- telas ---
  function limparCorpo() { el.corpo.innerHTML = ""; }

  function escolherFaculdade(faculdades, extra) {
    limparCorpo();
    var form = document.createElement("form");
    form.className = "form";
    form.innerHTML = "<p>Não identificamos sua faculdade. Escolha abaixo:</p><label>Faculdade<select required></select></label><button type=\"submit\">Continuar</button>";
    var select = form.querySelector("select");
    faculdades.forEach(function (f) {
      var o = document.createElement("option");
      o.value = f.slug; o.textContent = f.nome; select.appendChild(o);
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var dados = extra || {};
      dados.faculdade = select.value;
      abrirAtendimento(dados);
    });
    el.corpo.appendChild(form);
  }

  function mostrarFormulario() {
    host.classList.add("identificacao");
    limparCorpo();
    var form = document.createElement("form");
    form.className = "form";
    form.innerHTML =
      '<div class="form-intro"><span class="sobretitulo">Vamos começar</span><h3>Como podemos ajudar?</h3><p>Identifique-se para conversar com a equipe da sua faculdade.</p></div>' +
      '<label>Nome completo<input name="nome" required autocomplete="name" placeholder="Seu nome completo"></label>' +
      '<div class="campos"><label>CPF<input name="cpf" required inputmode="numeric" autocomplete="off" placeholder="000.000.000-00"></label>' +
      '<label>Faculdade<select name="faculdade" required><option value="">Carregando…</option></select></label></div>' +
      '<label><span>Celular <span class="opcional">(opcional)</span></span><input name="celular" inputmode="tel" autocomplete="tel" placeholder="(31) 99999-9999"></label>' +
      '<label><span>E-mail <span class="opcional">(opcional)</span></span><input name="email" type="email" autocomplete="email" placeholder="voce@exemplo.com"></label>' +
      '<div class="erro" role="alert"></div><button type="submit">Iniciar atendimento' + icone("enviar") + '</button><p class="privacidade">Seus dados identificam seu atendimento junto à faculdade.</p>';
    var select = form.querySelector("select");
    var erro = form.querySelector(".erro");
    api("/api/faculdades").then(function (lista) {
      select.innerHTML = '<option value="">Selecione</option>';
      lista.forEach(function (f) {
        var o = document.createElement("option");
        o.value = f.slug; o.textContent = f.nome; select.appendChild(o);
      });
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var fd = new FormData(form);
      erro.textContent = "";
      var cpf = String(fd.get("cpf")).replace(/\D/g, "");
      if (cpf.length !== 11) { erro.textContent = "Confira o CPF (11 dígitos)."; return; }
      var extra = {
        aluno: { nome: fd.get("nome"), cpf: cpf, celular: fd.get("celular"), email: fd.get("email") },
        faculdade: fd.get("faculdade"),
      };
      iniciarSessao(extra)
        .then(function () { mostrarConversa(); return carregarHistorico(); })
        .then(conectar)
        .catch(function (err) { erro.textContent = mensagemErroSessao(err); });
    });
    el.corpo.appendChild(form);
  }

  var barra, lista, rodape, cartaoEncerrado, textarea, botaoEnviar, botaoAnexar, inputArquivo;

  function mostrarConversa() {
    host.classList.remove("identificacao");
    limparCorpo();
    barra = document.createElement("div");
    barra.className = "barra";
    lista = document.createElement("div");
    lista.className = "lista";
    lista.setAttribute("aria-live", "polite");
    rodape = document.createElement("div");
    rodape.className = "rodape";
    rodape.innerHTML =
      '<button class="icone anexar" type="button" aria-label="Anexar arquivo">' + icone("anexo") + '</button>' +
      '<input type="file" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,audio/*,video/mp4">' +
      '<textarea rows="1" placeholder="Escreva sua mensagem…" aria-label="Mensagem"></textarea>' +
      '<button class="icone enviar" type="button" aria-label="Enviar">' + icone("enviar") + '</button>';
    textarea = rodape.querySelector("textarea");
    botaoEnviar = rodape.querySelector(".enviar");
    botaoAnexar = rodape.querySelector(".anexar");
    inputArquivo = rodape.querySelector("input[type=file]");

    textarea.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviarTexto(); }
    });
    textarea.addEventListener("input", function () {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    });
    botaoEnviar.addEventListener("click", enviarTexto);
    botaoAnexar.addEventListener("click", function () { inputArquivo.click(); });
    inputArquivo.addEventListener("change", function () {
      if (inputArquivo.files[0]) enviarArquivo(inputArquivo.files[0]);
      inputArquivo.value = "";
    });

    cartaoEncerrado = document.createElement("div");
    cartaoEncerrado.className = "encerrado";
    cartaoEncerrado.innerHTML = "<span>Este atendimento foi encerrado.</span>" +
      '<button type="button">Iniciar novo atendimento</button>';
    cartaoEncerrado.querySelector("button").addEventListener("click", novoAtendimento);

    el.corpo.appendChild(barra);
    el.corpo.appendChild(lista);
    el.corpo.appendChild(rodape);
    el.corpo.appendChild(cartaoEncerrado);
    renderizar();
  }

  // ---------------------------------------------------------- atendimentos ---
  var ENCERRADO_RECENTE_MS = 30 * 60 * 1000;

  function encerrado() { return estado.atendimento && estado.atendimento.status === "encerrado"; }

  function botao(texto, classe, acao) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = texto;
    if (classe) b.className = classe;
    b.addEventListener("click", acao);
    return b;
  }

  function atualizarCabecalho() {
    if (!estado.sessao) return;
    var partes = [estado.sessao.faculdade.nome];
    var a = estado.atendimento;
    if (estado.tela === "atual" && a) {
      if (a.status === "encerrado") partes.push("Atendimento encerrado");
      else if (a.atendente) partes.push(a.atendente + " está te atendendo");
      else partes.push("Aguardando atendente");
    } else if (estado.tela === "antigo" && estado.antigo.atendimento) {
      partes.push("Atendimento " + estado.antigo.atendimento.numero + " de " + data(estado.antigo.atendimento.criadoEm));
    }
    el.subtitulo.textContent = partes.join(" · ");
  }

  function renderizarBarra() {
    if (!barra) return;
    barra.innerHTML = "";
    if (estado.tela !== "atual") {
      barra.appendChild(botao("← Voltar ao atendimento atual", "", voltarAoAtual));
      return;
    }
    if (estado.confirmandoEncerrar) {
      var pergunta = document.createElement("span");
      pergunta.textContent = "Encerrar este atendimento?";
      var acoes = document.createElement("span");
      acoes.appendChild(botao("Cancelar", "", function () { estado.confirmandoEncerrar = false; renderizarBarra(); }));
      acoes.appendChild(botao("Encerrar", "perigo", encerrarAtendimento));
      barra.appendChild(pergunta);
      barra.appendChild(acoes);
      return;
    }
    var a = estado.atendimento;
    var temAnteriores = a && (a.numero > 1 || a.status === "encerrado");
    barra.appendChild(temAnteriores ? botao("Atendimentos anteriores", "", mostrarLista) : document.createElement("span"));
    var temMensagens = estado.mensagens.some(function (m) { return m.id && m.direcao !== "sistema"; });
    if (a && a.status === "aberto" && temMensagens) {
      barra.appendChild(botao("Encerrar atendimento", "perigo", function () { estado.confirmandoEncerrar = true; renderizarBarra(); }));
    }
    if (!barra.querySelector("button")) barra.innerHTML = "";
  }

  function encerrarAtendimento() {
    estado.confirmandoEncerrar = false;
    api("/api/atendimentos/encerrar", { method: "POST", autenticado: true })
      .then(function (r) { aplicarAtendimento(r.atendimento); })
      .catch(function (err) {
        if (err.status === 409) return carregarHistorico();
        aviso("Não foi possível encerrar agora. Tente novamente.");
        renderizarBarra();
      });
  }

  function novoAtendimento() {
    estado.atendimento = null;
    estado.mensagens = [];
    renderizar();
    if (textarea) textarea.focus();
  }

  // Atualização do atendimento vinda da API ou do WebSocket.
  function aplicarAtendimento(a) {
    var atual = estado.atendimento;
    if (atual && atual.id === a.id) {
      estado.atendimento = Object.assign({}, atual, a);
    } else if (a.status === "aberto") {
      // Atendimento novo (aberto pelo aluno ou pelo atendente): troca a tela.
      estado.atendimento = a;
      estado.mensagens = estado.mensagens.filter(function (m) { return !m.id || m.atendimentoId === a.id; });
    } else {
      return; // encerramento de um atendimento que não está na tela
    }
    renderizar();
  }

  function mostrarLista() {
    estado.tela = "lista";
    renderizar();
    lista.innerHTML = '<div class="vazio">Carregando…</div>';
    api("/api/atendimentos", { autenticado: true }).then(function (r) {
      if (estado.tela !== "lista") return;
      lista.innerHTML = "";
      r.atendimentos.forEach(function (a) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "item";
        var titulo = document.createElement("strong");
        titulo.textContent = "Atendimento " + a.numero + " · " + data(a.criadoEm) +
          (a.status === "aberto" ? " · em andamento" : "");
        var detalhe = document.createElement("span");
        detalhe.textContent = (a.atendente ? a.atendente + " — " : "") + (a.resumo || "(sem mensagem de texto)");
        item.appendChild(titulo);
        item.appendChild(detalhe);
        item.addEventListener("click", function () {
          if (estado.atendimento && a.id === estado.atendimento.id) voltarAoAtual();
          else abrirAntigo(a.id);
        });
        lista.appendChild(item);
      });
    }).catch(function () { aviso("Não foi possível carregar os atendimentos anteriores."); });
  }

  function abrirAntigo(id) {
    api("/api/historico?atendimento=" + encodeURIComponent(id), { autenticado: true }).then(function (r) {
      estado.tela = "antigo";
      estado.antigo = r;
      renderizar();
    });
  }

  function voltarAoAtual() {
    estado.tela = "atual";
    estado.antigo = null;
    renderizar();
    carregarHistorico().catch(function () {});
  }

  // ------------------------------------------------------------ mensagens ---
  function hora(iso) {
    try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function data(iso) {
    try { return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }); } catch (e) { return ""; }
  }

  function inserirOuAtualizar(m) {
    for (var i = 0; i < estado.mensagens.length; i++) {
      var atual = estado.mensagens[i];
      if ((m.id && atual.id === m.id) || (m.clienteId && atual.clienteId === m.clienteId)) {
        estado.mensagens[i] = Object.assign({}, atual, m);
        return false;
      }
    }
    // Avisos ("Fulano está te atendendo") vêm com a hora do DataCrazy e podem
    // pertencer a um ponto anterior da conversa.
    if (m.direcao === "sistema") {
      for (var j = 0; j < estado.mensagens.length; j++) {
        var x = estado.mensagens[j];
        if (x.id && x.criadaEm > m.criadaEm) { estado.mensagens.splice(j, 0, m); return true; }
      }
    }
    estado.mensagens.push(m);
    return true;
  }

  function renderizar() {
    atualizarCabecalho();
    renderizarBarra();
    if (!lista) return;
    var tela = estado.tela;
    rodape.style.display = tela === "atual" && !encerrado() ? "" : "none";
    cartaoEncerrado.style.display = tela === "atual" && encerrado() ? "" : "none";
    if (tela === "lista") return; // conteúdo montado por mostrarLista
    var mensagens = tela === "antigo" ? estado.antigo.mensagens : estado.mensagens;
    lista.innerHTML = "";
    if (!mensagens.length) {
      var vazio = document.createElement("div");
      vazio.className = "vazio";
      var primeiro = estado.sessao ? String(estado.sessao.aluno.nome).split(" ")[0] : "";
      vazio.innerHTML = '<span class="simbolo">' + icone("chat") + '</span>';
      var saudacao = document.createElement("h3");
      saudacao.textContent = "Olá" + (primeiro ? ", " + primeiro.charAt(0) + primeiro.slice(1).toLowerCase() : "") + "!";
      vazio.appendChild(saudacao);
      var orientacao = document.createElement("p");
      orientacao.textContent = "Seu atendimento começa aqui. Envie sua dúvida para conversar com a equipe da faculdade.";
      vazio.appendChild(orientacao);
      lista.appendChild(vazio);
      return;
    }
    var ativas = indiceOpcoesAtivas(mensagens);
    mensagens.forEach(function (m, i) {
      var div = document.createElement("div");
      var partes = m.direcao === "atendente" ? separarOpcoes(m.texto) : { texto: m.texto, opcoes: [] };
      if (m.direcao === "sistema") {
        div.className = "msg sistema";
        div.textContent = m.texto + " · " + hora(m.criadaEm);
        lista.appendChild(div);
        return;
      }
      div.className = "msg " + m.direcao + (m.status === "falha" ? " falha" : "");
      if (m.anexo) {
        if (/^image\//.test(m.anexo.tipo || "")) {
          var a = document.createElement("a");
          a.href = m.anexo.url; a.target = "_blank"; a.rel = "noopener";
          var img = document.createElement("img");
          img.src = m.anexo.url; img.alt = m.anexo.nome || "imagem";
          a.appendChild(img); div.appendChild(a);
        } else {
          var link = document.createElement("a");
          link.href = m.anexo.url; link.target = "_blank"; link.rel = "noopener";
          link.className = "arquivo";
          link.innerHTML = icone("arquivo");
          link.appendChild(document.createTextNode(m.anexo.nome || "Arquivo"));
          div.appendChild(link);
          div.appendChild(document.createElement("br"));
        }
      }
      // Opções que não estão ativas continuam visíveis como texto.
      var corpo = i === ativas ? partes.texto : m.texto;
      if (m.menu && !partes.opcoes.length && i !== ativas) {
        corpo = (corpo || "") + "\n\n" + m.menu.opcoes.map(function (o) { return "▸ " + o.texto; }).join("\n");
      }
      if (corpo && !(m.anexo && corpo === m.anexo.nome)) div.appendChild(document.createTextNode(corpo));
      else if (!m.texto && !m.anexo) div.appendChild(document.createTextNode("Carregando anexo…"));
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = m.status === "enviando" ? "enviando…" : m.status === "pendente" ? "aguardando envio…" : m.status === "falha" ? "não enviada" : hora(m.criadaEm);
      div.appendChild(meta);
      lista.appendChild(div);
      if (i === ativas) {
        var opcoes = document.createElement("div");
        opcoes.className = "opcoes";
        var escolhas = m.menu ? m.menu.opcoes : partes.opcoes.map(function (texto) { return { texto: texto }; });
        escolhas.forEach(function (opcao) {
          opcoes.appendChild(botao(opcao.texto, "opcao", function () { enviarOpcao(opcao.texto, m.menu, opcao.id); }));
        });
        lista.appendChild(opcoes);
      }
    });
    lista.scrollTop = lista.scrollHeight;
  }

  // Compatibilidade com linhas "▸ Opção" (ADR 004). Menus sem marcações chegam
  // nos metadados da mensagem, recuperados pela REST do CRM (ADR 009).
  var MARCA_OPCAO = /^\s*▸\s*/;
  function separarOpcoes(texto) {
    var linhas = String(texto || "").split("\n");
    var opcoes = [];
    while (linhas.length && MARCA_OPCAO.test(linhas[linhas.length - 1])) {
      opcoes.unshift(linhas.pop().replace(MARCA_OPCAO, "").trim());
    }
    while (linhas.length && !linhas[linhas.length - 1].trim()) linhas.pop();
    return { texto: linhas.join("\n"), opcoes: opcoes };
  }

  // Opções só valem na última mensagem da conversa: depois que o aluno ou o
  // atendente escrevem, o menu anterior vira texto.
  function indiceOpcoesAtivas(mensagens) {
    if (estado.tela !== "atual" || encerrado()) return -1;
    if (estado.atendimento && estado.atendimento.atendente) return -1;
    if (estado.atendimento && typeof estado.atendimento.menuId !== "undefined") {
      for (var j = mensagens.length - 1; j >= 0; j--) {
        if (mensagens[j].id === estado.atendimento.menuId && mensagens[j].menu) return j;
      }
      return -1;
    }
    for (var i = mensagens.length - 1; i >= 0; i--) {
      var m = mensagens[i];
      if (m.direcao === "sistema") continue;
      return m.direcao === "atendente" && separarOpcoes(m.texto).opcoes.length ? i : -1;
    }
    return -1;
  }

  function enviarOpcao(texto, menu, opcaoId) {
    if (textarea) {
      textarea.value = texto;
      if (menu && estado.atendimento) estado.atendimento.menuId = null;
      enviarTexto(menu ? { menuId: menu.id, opcaoId: opcaoId } : null);
    }
  }

  // Atendimento atual: o aberto ou, se não houver, o último. Encerrado há mais
  // de 30 min não aparece: o aluno começa direto um novo.
  function carregarHistorico() {
    return api("/api/historico", { autenticado: true }).then(function (r) {
      var pendentes = estado.mensagens.filter(function (m) { return !m.id; });
      var a = r.atendimento;
      if (a && a.status === "encerrado" && Date.now() - new Date(a.encerradoEm).getTime() > ENCERRADO_RECENTE_MS) {
        estado.atendimento = null;
        estado.mensagens = pendentes;
      } else {
        estado.atendimento = a;
        // O histórico pode chegar antes do ack: reconcilia também pelo clienteId.
        estado.mensagens = r.mensagens.concat(pendentes.filter(function (p) {
          return !r.mensagens.some(function (m) { return p.clienteId && m.clienteId === p.clienteId; });
        }));
      }
      renderizar();
    });
  }

  function novoClienteId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function despachar(payload) {
    if (estado.ws && estado.ws.readyState === 1) estado.ws.send(JSON.stringify(payload));
    else estado.filaEnvio.push(payload);
  }

  function enviarTexto(opcao) {
    var texto = textarea.value.trim();
    if (!texto) return;
    textarea.value = "";
    textarea.style.height = "auto";
    var clienteId = novoClienteId();
    inserirOuAtualizar({ clienteId: clienteId, direcao: "aluno", texto: texto, status: "enviando", criadaEm: new Date().toISOString() });
    renderizar();
    despachar({ tipo: "mensagem", texto: texto, clienteId: clienteId, opcao: opcao && opcao.menuId ? opcao : null });
  }

  function enviarArquivo(arquivo) {
    var clienteId = novoClienteId();
    inserirOuAtualizar({ clienteId: clienteId, direcao: "aluno", texto: arquivo.name, status: "enviando", criadaEm: new Date().toISOString() });
    renderizar();
    var fd = new FormData();
    fd.append("arquivo", arquivo);
    api("/api/arquivos", { method: "POST", body: fd, autenticado: true })
      .then(function (r) { despachar({ tipo: "mensagem", arquivo: r.token, texto: "", clienteId: clienteId }); })
      .catch(function (err) {
        inserirOuAtualizar({ clienteId: clienteId, status: "falha",
          texto: err.message === "arquivo_grande" ? "Arquivo grande demais." : err.message === "tipo_nao_permitido" ? "Tipo de arquivo não permitido." : "Falha ao enviar o arquivo." });
        renderizar();
      });
  }

  // Mensagem que chegou pelo WebSocket (ou ack) e é de outro atendimento.
  function mensagemDeOutroAtendimento(m) {
    return m.atendimentoId && (!estado.atendimento || m.atendimentoId !== estado.atendimento.id);
  }

  // ------------------------------------------------------------ WebSocket ---
  function conectar() {
    if (!estado.sessao) return;
    if (estado.ws && estado.ws.readyState <= 1) return;
    var ws = new WebSocket(WS + "/ws?token=" + encodeURIComponent(estado.sessao.token));
    estado.ws = ws;

    ws.onmessage = function (ev) {
      var dados;
      try { dados = JSON.parse(ev.data); } catch (e) { return; }
      if (dados.tipo === "pronto") {
        estado.tentativasWs = 0;
        aviso("");
        var fila = estado.filaEnvio; estado.filaEnvio = [];
        fila.forEach(function (p) { ws.send(JSON.stringify(p)); });
      } else if (dados.tipo === "atendimento") {
        aplicarAtendimento(dados.atendimento);
      } else if (dados.tipo === "mensagem") {
        var msg = dados.mensagem;
        if (estado.tela === "antigo" && estado.antigo.atendimento && msg.atendimentoId === estado.antigo.atendimento.id) return;
        if (mensagemDeOutroAtendimento(msg)) {
          // Aviso atrasado de um atendimento já encerrado: ignora. Qualquer
          // outra mensagem só pode ser do atendimento aberto: recarrega.
          if (msg.direcao !== "sistema") carregarHistorico().catch(function () {});
          return;
        }
        var nova = inserirOuAtualizar(msg);
        if (nova && msg.direcao === "atendente" && !estado.aberto) { estado.naoLidas++; atualizarSelo(); }
        if (estado.tela === "atual") renderizar();
      } else if (dados.tipo === "ack") {
        var m = dados.mensagem; m.clienteId = dados.clienteId;
        // O ack pode chegar antes do aviso do atendimento novo.
        if (mensagemDeOutroAtendimento(m)) aplicarAtendimento({ id: m.atendimentoId, status: "aberto", numero: 0 });
        // A mensagem pode já ter chegado pelo eco (id), então junta pelos dois lados.
        estado.mensagens = estado.mensagens.filter(function (x) { return !(x.id === m.id && x.clienteId !== m.clienteId); });
        inserirOuAtualizar(m);
        renderizar();
      } else if (dados.tipo === "erro") {
        inserirOuAtualizar({ clienteId: dados.clienteId, status: "falha" });
        renderizar();
        carregarHistorico().catch(function () {});
      }
    };

    ws.onclose = function (ev) {
      if (estado.ws !== ws) return;
      estado.ws = null;
      if (ev.code === 4401) {
        // Sessão inválida: abre de novo (no portal os dados estão na página).
        salvarToken(null);
        estado.sessao = null;
        if (MODO === "portal") abrirAtendimento(); else mostrarFormulario();
        return;
      }
      aviso("Reconectando…");
      var espera = [1000, 2000, 5000, 10000, 20000][Math.min(estado.tentativasWs++, 4)];
      setTimeout(function () {
        (estado.tela === "atual" ? carregarHistorico() : Promise.resolve()).catch(function () {}).then(conectar);
      }, espera);
    };
  }

  // ------------------------------------------------------------- eventos ---
  function abrirPainel() {
    estado.aberto = true;
    estado.naoLidas = 0;
    atualizarSelo();
    el.painel.classList.add("aberto");
    el.lancador.style.display = "none";
    if (!estado.sessao) abrirAtendimento();
    else if (textarea) textarea.focus();
  }
  function fecharPainel() {
    estado.aberto = false;
    el.painel.classList.remove("aberto");
    el.lancador.style.display = "";
  }

  el.lancador.addEventListener("click", abrirPainel);
  el.fechar.addEventListener("click", fecharPainel);

  function iniciar() {
    if (MODO === "pagina") {
      (document.getElementById("chat-mount") || document.body).appendChild(host);
      estado.aberto = true;
      el.painel.classList.add("aberto");
      if (tokenSalvo()) abrirAtendimento(); else mostrarFormulario();
      return;
    }
    document.body.appendChild(host);
    // Quem já conversou antes reconecta em segundo plano para receber respostas.
    if (tokenSalvo()) abrirAtendimento();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
