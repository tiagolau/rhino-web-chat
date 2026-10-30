// ==UserScript==
// @name         Rhino Webchat no portal Eduno (teste)
// @namespace    https://github.com/tiagolau/rhino-web-chat
// @version      1.1
// @description  Injeta o widget de atendimento na área do aluno do Eduno. Só para teste no navegador de quem instalou; em produção o script entra no template do portal.
// @match        https://ava07.eduno.com.br/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  // Troque pela PUBLIC_URL do backend que vai atender o teste.
  var WEBCHAT_URL = "https://webchat.exemplo.com.br";
  // Só na área logada: o widget depende de window.eduno.aluno.
  if (window.__rhinoWebchat || !(window.eduno && window.eduno.aluno)) return;
  var s = document.createElement("script");
  s.src = WEBCHAT_URL + "/widget.js";
  s.defer = true;
  document.body.appendChild(s);
})();
