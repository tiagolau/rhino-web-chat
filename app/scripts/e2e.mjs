// Teste de ponta a ponta: simula o widget no portal.
// Uso: node scripts/e2e.mjs [URL_BASE]   (padrão http://localhost:3000)
// Usa um aluno fictício com o CPF de teste 529.982.247-25.

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws");

const aluno = {
  id: "999100",
  nome: "ALUNO TESTE WEBCHAT",
  cpf: "529.982.247-25",
  email: "aluno.teste.webchat@example.com",
  celular: "(31) 90000-0001",
};
const rodape = "FACULDADE IGUAÇU - FI\nEduno EAD | HotSystems Soluções em TI Ltda";

async function api(caminho, opcoes = {}) {
  const res = await fetch(BASE + caminho, opcoes);
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${caminho} -> HTTP ${res.status} ${JSON.stringify(corpo)}`);
  return corpo;
}

const sessao = await api("/api/sessao", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ aluno, rodape }),
});
console.log("sessão:", sessao.faculdade, sessao.aluno);
const auth = { Authorization: `Bearer ${sessao.token}` };

const ws = new WebSocket(`${WS}/ws?token=${encodeURIComponent(sessao.token)}`);
const recebidas = [];
const esperar = (filtro, ms = 15000) =>
  new Promise((ok, falha) => {
    const t = setTimeout(() => falha(new Error("timeout esperando mensagem do WebSocket")), ms);
    const ver = () => {
      const achada = recebidas.find(filtro);
      if (achada) {
        clearTimeout(t);
        ok(achada);
      } else setTimeout(ver, 100);
    };
    ver();
  });
ws.onmessage = (ev) => recebidas.push(JSON.parse(ev.data));
await esperar((m) => m.tipo === "pronto");
console.log("websocket: pronto");

ws.send(JSON.stringify({ tipo: "mensagem", texto: `Teste e2e ${new Date().toISOString()}`, clienteId: "t1" }));
const ack1 = await esperar((m) => m.tipo === "ack" && m.clienteId === "t1");
console.log("texto:", ack1.mensagem.status);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const fd = new FormData();
fd.append("arquivo", new Blob([png], { type: "image/png" }), "pixel-teste.png");
const arq = await api("/api/arquivos", { method: "POST", headers: auth, body: fd });
ws.send(JSON.stringify({ tipo: "mensagem", arquivo: arq.token, texto: "", clienteId: "t2" }));
const ack2 = await esperar((m) => m.tipo === "ack" && m.clienteId === "t2");
console.log("anexo:", ack2.mensagem.status, ack2.mensagem.anexo.url);

const baixado = await fetch(ack2.mensagem.anexo.url);
console.log("download do anexo:", baixado.status, baixado.headers.get("content-type"));

const { mensagens } = await api("/api/historico", { headers: auth });
console.log("histórico:", mensagens.length, "mensagens");

// Retomada só com token (modo página).
const retomada = await api("/api/sessao", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: sessao.token }),
});
console.log("retomada por token:", retomada.aluno.nome);

ws.close();
console.log("OK");
