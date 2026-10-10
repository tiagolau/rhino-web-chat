// Entrega em tempo real entre réplicas. A resposta do atendente chega por HTTP
// em qualquer réplica; o NOTIFY do Postgres avisa todas, e a que tiver o
// WebSocket do aluno entrega.

import pg from "pg";
import { query, umaLinha, opcoesConexao } from "./db.js";

const CANAL = "webchat_mensagem";
const conexoes = new Map(); // contactId -> Set<WebSocket>

export function adicionarConexao(contactId, socket) {
  if (!conexoes.has(contactId)) conexoes.set(contactId, new Set());
  conexoes.get(contactId).add(socket);
  socket.on("close", () => {
    const set = conexoes.get(contactId);
    if (!set) return;
    set.delete(socket);
    if (!set.size) conexoes.delete(contactId);
  });
}

export const totalConexoes = () => [...conexoes.values()].reduce((n, s) => n + s.size, 0);

export function serializarMensagem(m) {
  return {
    id: m.id,
    clienteId: m.cliente_id || null,
    direcao: m.direcao,
    texto: m.texto,
    anexo: m.anexo_url ? { url: m.anexo_url, tipo: m.anexo_tipo, nome: m.anexo_nome } : null,
    status: m.status,
    atendimentoId: m.atendimento_id,
    criadaEm: m.created_at,
  };
}

export function serializarAtendimento(a) {
  return {
    id: a.id,
    numero: a.numero,
    status: a.status,
    atendente: a.atendente,
    encerradoPor: a.encerrado_por,
    criadoEm: a.created_at,
    encerradoEm: a.encerrado_em,
  };
}

// O payload do NOTIFY tem limite de 8 KB; mandamos só os ids.
export const publicar = (contactId, mensagemId) =>
  query("select pg_notify($1, $2)", [CANAL, JSON.stringify({ c: contactId, m: mensagemId })]);

// Mudança no atendimento (atendente, encerramento).
export const publicarAtendimento = (contactId, atendimentoId) =>
  query("select pg_notify($1, $2)", [CANAL, JSON.stringify({ c: contactId, a: atendimentoId })]);

async function entregar({ c: contactId, m: mensagemId, a: atendimentoId }) {
  const sockets = conexoes.get(contactId);
  if (!sockets?.size) return;
  let dados;
  if (atendimentoId) {
    const a = await umaLinha("select * from atendimentos where id = $1", [atendimentoId]);
    if (!a) return;
    dados = JSON.stringify({ tipo: "atendimento", atendimento: serializarAtendimento(a) });
  } else {
    const msg = await umaLinha("select * from mensagens where id = $1", [mensagemId]);
    if (!msg) return;
    dados = JSON.stringify({ tipo: "mensagem", mensagem: serializarMensagem(msg) });
  }
  for (const s of sockets) if (s.readyState === 1) s.send(dados);
}

// Cliente dedicado ao LISTEN. A conexão pode morrer em silêncio (o VIP do Swarm
// derruba TCP ocioso sem avisar), então um batimento a cada 30 s confirma que
// ela está viva e, se não estiver, reabre.
export function iniciarOuvinte(log) {
  let cliente = null;
  let parado = false;
  let reconectando = false;

  function reabrir(motivo) {
    if (parado || reconectando) return;
    reconectando = true;
    log.warn({ motivo }, "reabrindo conexão LISTEN");
    const antigo = cliente;
    cliente = null;
    antigo?.end().catch(() => {});
    setTimeout(() => {
      reconectando = false;
      conectar();
    }, 2000);
  }

  async function conectar() {
    const novo = new pg.Client({ ...opcoesConexao });
    novo.on("notification", (n) => {
      try {
        entregar(JSON.parse(n.payload)).catch((err) => log.error({ err: err.message }, "falha ao entregar mensagem"));
      } catch {}
    });
    novo.on("error", (err) => reabrir(err.message));
    novo.on("end", () => cliente === novo && reabrir("conexão encerrada"));
    try {
      await novo.connect();
      await novo.query(`listen ${CANAL}`);
      cliente = novo;
      log.info("LISTEN ativo");
    } catch (err) {
      novo.end().catch(() => {});
      reabrir(`não consegui abrir LISTEN: ${err.message}`);
    }
  }

  const batimento = setInterval(async () => {
    if (!cliente) return;
    const atual = cliente;
    const timeout = new Promise((_, falha) => setTimeout(() => falha(new Error("batimento sem resposta")), 5000));
    try {
      await Promise.race([atual.query("select 1"), timeout]);
    } catch (err) {
      if (cliente === atual) reabrir(err.message);
    }
  }, 30_000);

  conectar();
  return () => {
    parado = true;
    clearInterval(batimento);
    cliente?.end().catch(() => {});
  };
}
