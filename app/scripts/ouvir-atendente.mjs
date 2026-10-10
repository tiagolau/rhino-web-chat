// Abre a sessão do aluno de teste e fica ouvindo respostas do atendente pelo WebSocket.
// Uso: node scripts/ouvir-atendente.mjs [URL_BASE] [segundos]

const BASE = (process.argv[2] || "https://webchat.engrenatec.com.br").replace(/\/$/, "");
const SEGUNDOS = Number(process.argv[3] || 90);

const res = await fetch(`${BASE}/api/sessao`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    aluno: { id: "999100", nome: "ALUNO TESTE WEBCHAT", cpf: "529.982.247-25", email: "aluno.teste.webchat@example.com" },
    rodape: "FACULDADE IGUAÇU - FI",
  }),
});
const sessao = await res.json();
if (!res.ok) throw new Error(JSON.stringify(sessao));

const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(sessao.token)}`);
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data);
  if (d.tipo === "pronto") console.log("ouvindo por", SEGUNDOS, "s…");
  if (d.tipo === "mensagem" && d.mensagem.direcao === "atendente") {
    console.log("RESPOSTA DO ATENDENTE:", JSON.stringify(d.mensagem));
  }
};
setTimeout(() => {
  ws.close();
  process.exit(0);
}, SEGUNDOS * 1000);
