// Atendimentos (ADR 004). No widget, cada suporte é uma conversa separada, que
// o aluno pode encerrar. No DataCrazy o aluno continua com uma conversa só, e
// cada atendimento corresponde a uma "thread" dela.

import { randomUUID } from "node:crypto";
import { query, umaLinha } from "./db.js";
import * as dc from "./datacrazy.js";
import { enfileirar } from "./fila.js";
import { publicar, publicarAtendimento } from "./tempo-real.js";
import { faculdadePorSlug } from "./faculdades.js";
import { sincronizarMenuCRM } from "./menus-crm.js";

// Intervalo mínimo entre consultas do atendente na REST, por atendimento. A REST
// tem 30 req/min por tenant, divididos com as outras integrações do RJ Global.
const CHECAGEM_SEM_ATENDENTE_MS = 60_000;
const CHECAGEM_COM_ATENDENTE_MS = 5 * 60_000;

// Id da conversa do aluno no DataCrazy, com cache em alunos.dc_conversation_id.
export async function conversaDoAluno(contactId) {
  const aluno = await umaLinha("select dc_conversation_id from alunos where contact_id = $1", [contactId]);
  if (aluno?.dc_conversation_id) return aluno.dc_conversation_id;
  const achada = (await dc.buscarConversas(contactId)).find((c) => c.contact?.contactId === contactId);
  if (!achada) throw new Error("conversa do aluno não encontrada no DataCrazy");
  await query("update alunos set dc_conversation_id = $2 where contact_id = $1", [contactId, achada.id]);
  return achada.id;
}

// Atendimento aberto do aluno; cria o próximo se não houver.
export async function atendimentoAberto(contactId) {
  const aberto = await umaLinha("select * from atendimentos where contact_id = $1 and status = 'aberto'", [contactId]);
  if (aberto) return aberto;
  const novo = await umaLinha(
    `insert into atendimentos (id, contact_id, numero)
     values ($1, $2, coalesce((select max(numero) from atendimentos where contact_id = $2), 0) + 1)
     on conflict do nothing
     returning *`,
    [randomUUID(), contactId],
  );
  if (novo) {
    await publicarAtendimento(contactId, novo.id);
    return novo;
  }
  // Outra réplica criou no mesmo instante.
  return umaLinha("select * from atendimentos where contact_id = $1 and status = 'aberto'", [contactId]);
}

// Aviso do próprio webchat na linha do tempo do atendimento.
async function registrarAviso(atendimento, texto, quando = new Date()) {
  const id = randomUUID();
  await query(
    `insert into mensagens (id, contact_id, direcao, texto, status, atendimento_id, created_at)
     values ($1, $2, 'sistema', $3, 'aviso', $4, $5)`,
    [id, atendimento.contact_id, texto, atendimento.id, quando],
  );
  await publicar(atendimento.contact_id, id);
}

// `por`: "aluno" (botão do widget) ou "datacrazy" (atendente ou automação
// finalizou lá). Devolve o atendimento encerrado, ou null se não havia aberto.
export async function encerrarAtendimento(contactId, por) {
  const a = await umaLinha(
    `update atendimentos set status = 'encerrado', encerrado_por = $2, encerrado_em = now(), menu_mensagem_id = null
     where contact_id = $1 and status = 'aberto'
     returning *`,
    [contactId, por],
  );
  if (!a) return null;
  const aluno = await umaLinha("select faculdade from alunos where contact_id = $1", [contactId]);
  const faculdade = await faculdadePorSlug(aluno.faculdade);
  if (por === "aluno" || faculdade?.fluxo_nativo) {
    await enfileirar("finalizar_no_datacrazy", { contactId, atendimentoId: a.id, por }, { chave: a.id });
  } else {
    await query("update atendimentos set dc_encerramento_concluido_em = now() where id = $1", [a.id]);
  }
  await registrarAviso(a, por === "aluno" ? "Você encerrou este atendimento" : "Atendimento encerrado");
  await publicarAtendimento(contactId, a.id);
  return a;
}

// O aluno encerrou: finaliza a thread no DataCrazy e deixa uma anotação para a
// equipe. A anotação vem depois e é opcional, para um retry não duplicá-la.
// `dc_finalizado_em` (antes e depois da chamada) identifica o eco no /evento.
export async function jobFinalizarNoDataCrazy({ contactId, atendimentoId, por = "aluno" }, log) {
  const a = await umaLinha("select * from atendimentos where id = $1", [atendimentoId]);
  if (!a || a.dc_encerramento_concluido_em) return;
  const aluno = await umaLinha("select contact_id, nome, faculdade from alunos where contact_id = $1", [contactId]);
  const faculdade = await faculdadePorSlug(aluno.faculdade);
  if (faculdade?.fluxo_nativo && faculdade.confirmar_encerramento !== false && a.fluxo_nativo_iniciado && !a.dc_sessao_limpa_em) {
    // A opção de controle existe em todos os menus, mas não é exibida ao aluno.
    // Nas esperas terminais por texto, a resposta também encerra a sessão.
    // O callback confirma o fim; HTTP 200 do webhook sozinho não é suficiente.
    await dc.enviarAoWebhook(faculdade, aluno, {
      id: `encerrar-${a.id}`, texto: "Atendimento encerrado", created_at: new Date(),
      atendimento_id: a.id, primeira: false, atendente: false,
    });
    let reconhecido = false;
    for (let tentativa = 0; tentativa < 24; tentativa++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const atual = await umaLinha("select dc_sessao_limpa_em from atendimentos where id = $1", [a.id]);
      if (atual?.dc_sessao_limpa_em) { reconhecido = true; break; }
    }
    if (!reconhecido) throw new Error("aguardando confirmação de encerramento da sessão nativa");
  }
  const conversa = await conversaDoAluno(contactId);
  const marcar = () => query("update atendimentos set dc_finalizado_em = now() where id = $1", [atendimentoId]);
  await marcar();
  await dc.finalizarConversa(conversa);
  await marcar();
  await query("update atendimentos set dc_encerramento_concluido_em = now() where id = $1", [atendimentoId]);
  if (por !== "aluno") return;
  await dc
    .enviarNotaInterna(conversa, "📌 O aluno encerrou este atendimento pelo webchat.")
    .catch((err) => log.warn({ err: err.message, contactId }, "anotação de encerramento falhou"));
}

// Chamado a cada mensagem do atendente. A consulta é feita pela fila; a chave
// do job garante uma consulta pendente por atendimento.
export async function pedirChecagemDoAtendente(atendimento) {
  const intervalo = atendimento.atendente ? CHECAGEM_COM_ATENDENTE_MS : CHECAGEM_SEM_ATENDENTE_MS;
  const desde = atendimento.atendente_checado_em ? Date.now() - new Date(atendimento.atendente_checado_em).getTime() : Infinity;
  const atrasoMs = Math.max(2000, intervalo - desde);
  await enfileirar("identificar_atendente", { atendimentoId: atendimento.id }, { chave: atendimento.id, atrasoMs });
}

// Nome do atendente que está com a conversa agora, olhando só o que aconteceu
// depois do início do atendimento. Mensagens de automação não têm `attendant`.
export function atendenteAtual({ messages = [], histories = [] }, desde) {
  const limite = new Date(desde).getTime() - 10_000;
  const eventos = [];
  for (const h of histories) {
    if (["conversation-opened", "attendant-added"].includes(h.historyCode) && h.params?.attendantName) {
      eventos.push({ quando: h.createdAt, nome: h.params.attendantName });
    }
  }
  for (const m of messages) {
    const nome = m.attendant?.name || m.signature;
    if (!m.received && !m.isInternal && nome) eventos.push({ quando: m.createdAt, nome });
  }
  const validos = eventos.filter((e) => new Date(e.quando).getTime() >= limite);
  validos.sort((a, b) => new Date(a.quando) - new Date(b.quando));
  const ultimo = validos.at(-1);
  return ultimo ? { nome: ultimo.nome, quando: ultimo.quando } : null;
}

export async function jobIdentificarAtendente({ atendimentoId, mensagemId }) {
  const a = await umaLinha("select * from atendimentos where id = $1", [atendimentoId]);
  if (!a || a.status !== "aberto") return;
  const conversa = await conversaDoAluno(a.contact_id);
  const dados = await dc.conversaComHistorico(conversa, 20);
  await query("update atendimentos set atendente_checado_em = now() where id = $1", [a.id]);
  const atual = atendenteAtual(dados, a.created_at);
  if (atual && atual.nome !== a.atendente) {
    const r = await umaLinha("update atendimentos set atendente = $2, menu_mensagem_id = null where id = $1 and status = 'aberto' returning *", [a.id, atual.nome]);
    if (!r) return;
    // Com a hora do DataCrazy, o aviso aparece antes da primeira resposta dele.
    await registrarAviso(r, `${atual.nome} está te atendendo`, new Date(atual.quando));
    await publicarAtendimento(r.contact_id, r.id);
  }
  if (mensagemId) {
    const aluno = await umaLinha("select faculdade from alunos where contact_id=$1", [a.contact_id]);
    const f = await faculdadePorSlug(aluno.faculdade);
    if (f?.menus_crm) await sincronizarMenuCRM(mensagemId, dados, f.fluxo_nativo);
  }
}

// Uma rajada agenda por mensagem, mas só a última consulta a REST. Jobs antigos
// terminam sem HTTP. A consulta também identifica o humano responsável.
export async function jobSincronizarMenu({ mensagemId }) {
  const msg = await umaLinha(
    `select m.* from mensagens m join atendimentos at on at.id=m.atendimento_id
     where m.id=$1 and at.status='aberto' and at.atendente is null and m.direcao='atendente' and m.menu is null
     and not exists (select 1 from mensagens o where o.atendimento_id=m.atendimento_id
       and o.direcao='atendente' and (o.created_at,o.id)>(m.created_at,m.id))`, [mensagemId]);
  if (!msg) return;
  const aluno = await umaLinha("select faculdade from alunos where contact_id=$1", [msg.contact_id]);
  if (!(await faculdadePorSlug(aluno.faculdade))?.menus_crm) return;
  await jobIdentificarAtendente({ atendimentoId: msg.atendimento_id, mensagemId: msg.id });
}
