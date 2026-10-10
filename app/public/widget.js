/*
 * Rhino Webchat — widget de suporte do portal Eduno.
 *
 * Modo portal: incluído na área do aluno, lê window.eduno.aluno e o rodapé.
 *   <script src="https://webchat.engrenatec.com.br/widget.js" defer></script>
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

  // ----------------------------------------------------------------- DOM ---
  var host = document.createElement("div");
  host.id = "rhino-webchat";
  var raiz = host.attachShadow({ mode: "open" });
  raiz.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".lancador{position:fixed;right:20px;bottom:64px;z-index:1000;display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 18px;background:#1d4ed8;color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2)}" +
    ".lancador:hover{background:#1e40af}.lancador:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}" +
    ".selo{min-width:20px;height:20px;border-radius:10px;background:#dc2626;color:#fff;font-size:12px;display:none;align-items:center;justify-content:center;padding:0 6px}" +
    ".painel{position:fixed;right:20px;bottom:64px;z-index:1000;width:370px;height:560px;max-height:calc(100vh - 96px);display:none;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;color:#111827}" +
    ".painel.aberto{display:flex}" +
    ":host(.pagina){display:block}" +
    ":host(.pagina) .painel{position:static;width:100%;max-width:720px;height:100vh;height:100dvh;max-height:none;margin:0 auto;border-radius:0;display:flex}" +
    ".topo{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#1d4ed8;color:#fff}" +
    ".topo h2{margin:0;font-size:16px}.topo p{margin:2px 0 0;font-size:12px;opacity:.85}" +
    ".fechar{border:0;background:transparent;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}" +
    ".aviso{padding:6px 12px;font-size:12px;background:#fef3c7;color:#92400e;display:none}" +
    ".lista{flex:1;overflow-y:auto;padding:16px;background:#f3f4f6;display:flex;flex-direction:column;gap:8px}" +
    ".vazio{margin:auto;text-align:center;color:#6b7280;font-size:14px;max-width:260px;line-height:1.4}" +
    ".msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}" +
    ".msg.aluno{align-self:flex-end;background:#1d4ed8;color:#fff;border-bottom-right-radius:4px}" +
    ".msg.atendente{align-self:flex-start;background:#fff;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.08)}" +
    ".msg .meta{display:block;margin-top:4px;font-size:11px;opacity:.7;text-align:right}" +
    ".msg.falha{background:#fee2e2;color:#991b1b}" +
    ".opcoes{align-self:flex-start;display:flex;flex-wrap:wrap;gap:6px;max-width:90%;margin-top:-2px}" +
    ".opcao{border:1px solid #1d4ed8;border-radius:999px;padding:7px 12px;background:#fff;color:#1d4ed8;font-size:13px;cursor:pointer;text-align:left}" +
    ".opcao:hover{background:#eff6ff}.opcao:focus-visible{outline:2px solid #93c5fd}" +
    ".msg.sistema{align-self:center;max-width:90%;padding:2px 8px;background:transparent;color:#6b7280;font-size:12px;text-align:center}" +
    ".barra{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:34px;padding:4px 8px;background:#eff6ff;border-bottom:1px solid #dbeafe;font-size:12px;color:#1e3a8a}" +
    ".barra:empty{display:none}" +
    ".barra button{border:0;background:transparent;color:#1d4ed8;font-size:12px;font-weight:600;cursor:pointer;padding:5px 8px;border-radius:6px}" +
    ".barra button:hover{background:#dbeafe}.barra button.perigo{color:#b91c1c}.barra button.perigo:hover{background:#fee2e2}" +
    ".encerrado{display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px;border-top:1px solid #e5e7eb;background:#fff;font-size:14px;color:#374151}" +
    ".encerrado button{border:0;border-radius:10px;padding:10px 16px;background:#1d4ed8;color:#fff;font-size:14px;font-weight:600;cursor:pointer}" +
    ".item{display:block;width:100%;text-align:left;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;background:#fff;cursor:pointer;font-size:13px;color:#111827}" +
    ".item:hover{border-color:#93c5fd}.item strong{display:block;margin-bottom:2px}.item span{display:block;color:#6b7280;font-size:12px}" +
    ".msg img{display:block;max-width:100%;border-radius:8px;margin-bottom:4px}" +
    ".msg a{color:inherit;text-decoration:underline}" +
    ".rodape{display:flex;gap:6px;align-items:flex-end;padding:10px;border-top:1px solid #e5e7eb;background:#fff}" +
    ".rodape textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px 10px;font-size:14px;max-height:120px;min-height:40px}" +
    ".rodape textarea:focus{outline:2px solid #93c5fd;border-color:#1d4ed8}" +
    ".icone{border:0;border-radius:10px;width:40px;height:40px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center}" +
    ".anexar{background:#f3f4f6;color:#374151}.enviar{background:#1d4ed8;color:#fff}" +
    ".icone:disabled{opacity:.5;cursor:default}" +
    ".form{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}" +
    ".form label{font-size:13px;color:#374151;display:flex;flex-direction:column;gap:4px}" +
    ".form input,.form select{border:1px solid #d1d5db;border-radius:8px;padding:10px;font-size:14px}" +
    ".form button{border:0;border-radius:10px;padding:12px;background:#1d4ed8;color:#fff;font-size:15px;font-weight:600;cursor:pointer}" +
    ".form .erro{color:#b91c1c;font-size:13px;min-height:18px}" +
    ".form p{margin:0;color:#4b5563;font-size:14px;line-height:1.4}" +
    "@media (max-width:480px){.painel{right:0;bottom:0;width:100vw;height:100vh;max-height:none;border-radius:0}}" +
    "</style>" +
    '<button class="lancador" type="button" aria-label="Abrir atendimento"><span aria-hidden="true">💬</span> Suporte <span class="selo"></span></button>' +
    '<section class="painel" role="dialog" aria-label="Atendimento">' +
    '<header class="topo"><div><h2>Atendimento</h2><p class="subtitulo"></p></div><button class="fechar" type="button" aria-label="Fechar">×</button></header>' +
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
    limparCorpo();
    var form = document.createElement("form");
    form.className = "form";
    form.innerHTML =
      "<p>Para falar com a secretaria, informe seus dados de aluno.</p>" +
      '<label>Nome completo<input name="nome" required autocomplete="name"></label>' +
      '<label>CPF<input name="cpf" required inputmode="numeric" autocomplete="off" placeholder="000.000.000-00"></label>' +
      '<label>Faculdade<select name="faculdade" required><option value="">Carregando…</option></select></label>' +
      '<label>Celular (opcional)<input name="celular" inputmode="tel" autocomplete="tel" placeholder="(31) 99999-9999"></label>' +
      '<label>E-mail (opcional)<input name="email" type="email" autocomplete="email"></label>' +
      '<div class="erro" role="alert"></div><button type="submit">Iniciar atendimento</button>';
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
    limparCorpo();
    barra = document.createElement("div");
    barra.className = "barra";
    lista = document.createElement("div");
    lista.className = "lista";
    lista.setAttribute("aria-live", "polite");
    rodape = document.createElement("div");
    rodape.className = "rodape";
    rodape.innerHTML =
      '<button class="icone anexar" type="button" aria-label="Anexar arquivo">📎</button>' +
      '<input type="file" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,audio/*,video/mp4">' +
      '<textarea rows="1" placeholder="Escreva sua mensagem…" aria-label="Mensagem"></textarea>' +
      '<button class="icone enviar" type="button" aria-label="Enviar">➤</button>';
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
      vazio.textContent = "Olá" + (primeiro ? ", " + primeiro.charAt(0) + primeiro.slice(1).toLowerCase() : "") +
        "! Escreva sua dúvida e a secretaria responde por aqui.";
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
          link.textContent = "📄 " + (m.anexo.nome || "arquivo");
          div.appendChild(link);
          div.appendChild(document.createElement("br"));
        }
      }
      // Opções que não estão ativas continuam visíveis como texto.
      var corpo = i === ativas ? partes.texto : m.texto;
      if (corpo && !(m.anexo && corpo === m.anexo.nome)) div.appendChild(document.createTextNode(corpo));
      else if (!m.texto && !m.anexo) div.appendChild(document.createTextNode("📎 carregando anexo…"));
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = m.status === "enviando" ? "enviando…" : m.status === "falha" ? "não enviada" : hora(m.criadaEm);
      div.appendChild(meta);
      lista.appendChild(div);
      if (i === ativas) {
        var opcoes = document.createElement("div");
        opcoes.className = "opcoes";
        partes.opcoes.forEach(function (texto) {
          opcoes.appendChild(botao(texto, "opcao", function () { enviarOpcao(texto); }));
        });
        lista.appendChild(opcoes);
      }
    });
    lista.scrollTop = lista.scrollHeight;
  }

  // Opções de menu: linhas "▸ Opção" no fim da mensagem (o DataCrazy não manda
  // botões pela Conexão Universal; a automação escreve assim, ADR 004).
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
    for (var i = mensagens.length - 1; i >= 0; i--) {
      var m = mensagens[i];
      if (m.direcao === "sistema") continue;
      return m.direcao === "atendente" && separarOpcoes(m.texto).opcoes.length ? i : -1;
    }
    return -1;
  }

  function enviarOpcao(texto) {
    if (textarea) { textarea.value = texto; enviarTexto(); }
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
        estado.mensagens = r.mensagens.concat(pendentes);
      }
      renderizar();
    });
  }

  function novoClienteId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function despachar(payload) {
    if (estado.ws && estado.ws.readyState === 1) estado.ws.send(JSON.stringify(payload));
    else estado.filaEnvio.push(payload);
  }

  function enviarTexto() {
    var texto = textarea.value.trim();
    if (!texto) return;
    textarea.value = "";
    textarea.style.height = "auto";
    var clienteId = novoClienteId();
    inserirOuAtualizar({ clienteId: clienteId, direcao: "aluno", texto: texto, status: "enviando", criadaEm: new Date().toISOString() });
    renderizar();
    despachar({ tipo: "mensagem", texto: texto, clienteId: clienteId });
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
      document.body.appendChild(host);
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
