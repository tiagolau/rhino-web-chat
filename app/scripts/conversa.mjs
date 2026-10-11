// Conversa como o aluno de teste e mostra o que chega do DataCrazy. Serve para
// testar automações (menus, botões) pela Conexão Universal.
// Uso: node scripts/conversa.mjs [URL_BASE] "mensagem 1" "mensagem 2" ...
//   Cada mensagem é enviada depois de ESPERA_MS (padrão 12 s) sem nada chegar.
//   "!encerrar" encerra o atendimento atual pelo widget.
//   "!escolher:Secretaria" seleciona a opção do menu ativo com os IDs do servidor.

const args = process.argv.slice(2);
const BASE = (args[0]?.startsWith("http") ? args.shift() : "https://webchat.engrenatec.com.br").replace(/\/$/, "");
const ESPERA_MS = Number(process.env.ESPERA_MS || 12000);

const aluno = { id: "999100", nome: "ALUNO TESTE WEBCHAT", cpf: "529.982.247-25", email: "aluno.teste.webchat@example.com", celular: "(31) 90000-0001" };
const rodape = "FACULDADE IGUAÇU - FI\nEduno EAD | HotSystems Soluções em TI Ltda";

async function api(caminho, opcoes = {}) {
  const res = await fetch(BASE + caminho, opcoes);
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${caminho} -> HTTP ${res.status} ${JSON.stringify(corpo)}`);
  return corpo;
}

const sessao = await api("/api/sessao", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aluno, rodape }) });
const auth = { Authorization: `Bearer ${sessao.token}` };
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(sessao.token)}`);
let ultimo = Date.now();
const t0 = Date.now();
const hora = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data);
  ultimo = Date.now();
  if (d.tipo === "mensagem" && d.mensagem.direcao !== "aluno") {
    const m = d.mensagem;
    console.log(`${hora()} ← [${m.direcao}] ${JSON.stringify(m.texto)}${m.anexo ? ` 📎 ${m.anexo.nome} ${m.anexo.tipo}` : ""}`);
  } else if (d.tipo === "atendimento") {
    const a = d.atendimento;
    console.log(`${hora()} ⓘ atendimento ${a.numero}: ${a.status}${a.atendente ? `, ${a.atendente}` : ""}${a.encerradoPor ? ` (por ${a.encerradoPor})` : ""}`);
  } else if (d.tipo === "erro") console.log(`${hora()} ✗ erro: ${d.erro}`);
};
await new Promise((ok) => (ws.onopen = ok));

const quieto = () => new Promise((ok) => { const ver = () => (Date.now() - ultimo >= ESPERA_MS ? ok() : setTimeout(ver, 250)); ver(); });

for (const texto of args) {
  if (texto === "!encerrar") {
    console.log(`${hora()} → (encerrar atendimento)`);
    await api("/api/atendimentos/encerrar", { method: "POST", headers: auth }).catch((e) => console.log("  ", e.message));
  } else {
    let opcao;
    let corpo = texto;
    if (texto.startsWith("!escolher:")) {
      corpo = texto.slice("!escolher:".length);
      const h = await api("/api/historico", { headers: auth });
      const menu = h.mensagens.find(m => m.id === h.atendimento?.menuId)?.menu;
      const escolhida = menu?.opcoes.find(o => o.texto === corpo);
      if (!escolhida) throw new Error(`Opção ${corpo} não está no menu ativo`);
      opcao = { menuId: menu.id, opcaoId: escolhida.id };
    }
    console.log(`${hora()} → ${JSON.stringify(texto)}`);
    ws.send(JSON.stringify({ tipo: "mensagem", texto: corpo, opcao, clienteId: `c${Date.now()}` }));
  }
  ultimo = Date.now();
  await quieto();
}
ws.close();
