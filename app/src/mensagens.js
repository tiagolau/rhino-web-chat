// Mensagens do aluno (navegador -> DataCrazy) e do atendente (DataCrazy -> navegador).

import { randomUUID } from "node:crypto";
import { query, umaLinha, pool } from "./db.js";
import { faculdadePorSlug } from "./faculdades.js";
import { enviarAoWebhook, mensagensDaConversa, enviarNotaInterna } from "./datacrazy.js";
import { atendimentoAberto, conversaDoAluno, pedirChecagemDoAtendente } from "./atendimentos.js";
import { enfileirar } from "./fila.js";
import { publicar, publicarAtendimento } from "./tempo-real.js";
import { config } from "./config.js";
import { extrairMenu, escolherOpcao } from "./menus.js";

export const LIMITE_TEXTO = 4000;

async function enviarMensagemAoDataCrazy(mensagemId) {
  // `primeira`: é a primeira mensagem do aluno neste atendimento; `atendente`: um
  // humano já assumiu. A automação do DataCrazy usa os dois para saber quando
  // falar (ADR 004).
  const m = await umaLinha(
    `select m.*, a.nome, a.faculdade, a.lead_id, at.atendente, at.fluxo_nativo_iniciado,
            at.status as atendimento_status, at.numero as atendimento_numero,
            at.primeira_mensagem_id = m.id as primeira
     from mensagens m join alunos a on a.contact_id = m.contact_id
     left join atendimentos at on at.id = m.atendimento_id
     where m.id = $1 and m.created_at >= now() - interval '72 hours'`,
    [mensagemId],
  );
  if (!m || m.status === "enviada") return;
  if (!m.lead_id) throw new Error("aguardando vínculo do lead");
  const anterior = await umaLinha(
    `select 1 from mensagens where contact_id = $1 and direcao = 'aluno' and status <> 'enviada'
     and created_at >= now() - interval '72 hours'
     and (created_at, id) < (select created_at, id from mensagens where id = $2) limit 1`, [m.contact_id, m.id]);
  if (anterior) throw new Error("aguardando envio da mensagem anterior");
  const faculdade = await faculdadePorSlug(m.faculdade);
  if (!faculdade) throw new Error(`faculdade ${m.faculdade} inativa ou inexistente`);
  if (m.atendimento_status === "encerrado") {
    // Preservar mensagens que ficaram na fila antes do encerramento, sem
    // iniciar um robô de atendimento antigo na conversa atual.
    const conversa = await conversaDoAluno(m.contact_id);
    const marcador = `[webchat:${m.id}]`;
    const jaRegistrada = (await mensagensDaConversa(conversa, 1000))
      .some(x => x.isInternal && typeof x.body === "string" && x.body.includes(marcador));
    if (!jaRegistrada) {
      const anexo = m.anexo_url ? `\n\nAnexo: ${m.anexo_nome || "Arquivo"}\n${m.anexo_url}` : "";
      await enviarNotaInterna(conversa,
        `📌 Mensagem do aluno no atendimento ${m.atendimento_numero}, recebida pelo webchat antes do encerramento.\nHorário original: ${new Date(m.created_at).toISOString()}\n\n${m.texto}${anexo}\n\n${marcador}`);
    }
    await query("update mensagens set status = 'enviada' where id = $1", [m.id]);
    await publicar(m.contact_id, m.id);
    return;
  }
  const encerrando = await umaLinha(
    `select 1 from atendimentos where contact_id = $1 and status = 'encerrado'
     and dc_encerramento_concluido_em is null limit 1`, [m.contact_id]);
  if (encerrando) throw new Error("aguardando encerramento da sessão anterior");
  // Atendimentos automáticos que estavam abertos na migração iniciam a sessão
  // nativa na próxima mensagem, sem encerrar a conversa nem perder histórico.
  if (faculdade.fluxo_nativo && !m.fluxo_nativo_iniciado && !m.atendente) m.primeira = true;
  await enviarAoWebhook(faculdade, { contact_id: m.contact_id, nome: m.nome }, m);
  await query("update mensagens set status = 'enviada' where id = $1", [mensagemId]);
  if (faculdade.fluxo_nativo) await query("update atendimentos set fluxo_nativo_iniciado = true where id = $1", [m.atendimento_id]);
  await publicar(m.contact_id, m.id);
}

// Job de reenvio, para quando o envio direto falha.
export const jobEnviarMensagem = ({ mensagemId }) => enviarMensagemAoDataCrazy(mensagemId);

export async function registrarMensagemDoAluno(contactId, { texto, arquivoToken, clienteId, opcao }, log) {
  texto = String(texto ?? "").trim().slice(0, LIMITE_TEXTO);
  // Correlação do balão local com o eco e o histórico; clientes antigos podem omitir.
  clienteId = typeof clienteId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(clienteId) ? clienteId : null;
  let anexo = null;
  if (arquivoToken) {
    anexo = await umaLinha("select * from arquivos where token = $1 and contact_id = $2", [arquivoToken, contactId]);
    if (!anexo) throw new Error("arquivo não encontrado");
  }
  if (!texto && !anexo && !opcao) throw new Error("mensagem vazia");

  const cliente = await pool.connect();
  let msg;
  let atendimento;
  let novoAtendimento = false;
  let mudouMenu = false;
  try {
    await cliente.query("begin");
    // A identidade também serializa a abertura e a repetição após encerramento.
    // Sem HTTP na transação; a seleção trava o atendimento entre abas/réplicas.
    await cliente.query("select contact_id from alunos where contact_id = $1 for update", [contactId]);
    if (clienteId) {
      const { rows: [repetida] } = await cliente.query(
        "select * from mensagens where contact_id = $1 and cliente_id = $2 and created_at >= now()-interval '72 hours' limit 1", [contactId, clienteId]);
      if (repetida) { await cliente.query("commit"); return repetida; }
    }
    let { rows: [atual] } = await cliente.query(
      "select * from atendimentos where contact_id = $1 and status = 'aberto' for update", [contactId]);
    if (!atual) {
      if (opcao) throw new Error("Este menu não está mais disponível. Inicie um novo atendimento.");
      const criado = await cliente.query(
        `insert into atendimentos (id, contact_id, numero)
         values ($1, $2, coalesce((select max(numero) from atendimentos where contact_id = $2), 0) + 1)
         on conflict do nothing returning *`, [randomUUID(), contactId]);
      atual = criado.rows[0];
      novoAtendimento = Boolean(atual);
      if (!atual) atual = (await cliente.query(
        "select * from atendimentos where contact_id = $1 and status = 'aberto' for update", [contactId])).rows[0];
    }
    atendimento = atual;
    if (atual.status !== "aberto") throw new Error("Atendimento encerrado. Inicie um novo atendimento.");
    let menu = null;
    if (atual.menu_mensagem_id && !atual.atendente) {
      const { rows: [origem] } = await cliente.query("select menu from mensagens where id = $1 and created_at >= now()-interval '72 hours'", [atual.menu_mensagem_id]);
      menu = origem?.menu;
    }
    const selecionada = escolherOpcao(menu, opcao, texto);
    if (selecionada) texto = selecionada.texto;
    const id = randomUUID();
    const { rows } = await cliente.query(
      `insert into mensagens (id, contact_id, direcao, texto, anexo_url, anexo_tipo, anexo_nome, status, atendimento_id,
                             cliente_id, opcao_id, menu_origem, created_at)
       values ($1, $2, 'aluno', $3, $4, $5, $6, 'pendente', $7, $8, $9, $10, clock_timestamp()) returning *`,
      [id, contactId, texto, anexo ? `${config.publicUrl}/f/${anexo.token}/${encodeURIComponent(anexo.nome)}` : null,
        anexo?.mime ?? null, anexo?.nome ?? null, atendimento.id, clienteId, selecionada?.id || null,
        selecionada ? menu.id : null]);
    msg = rows[0];
    await cliente.query("update atendimentos set primeira_mensagem_id=coalesce(primeira_mensagem_id,$2) where id=$1", [atendimento.id, msg.id]);
    if (selecionada) {
      await cliente.query("update atendimentos set menu_mensagem_id = null where id = $1", [atendimento.id]);
      mudouMenu = true;
    }
    await cliente.query("commit");
  } catch (err) {
    await cliente.query("rollback");
    throw err;
  } finally { cliente.release(); }
  await publicar(contactId, msg.id);
  if (mudouMenu || novoAtendimento) await publicarAtendimento(contactId, atendimento.id);

  try {
    await enviarMensagemAoDataCrazy(msg.id);
    msg.status = "enviada";
  } catch (err) {
    log.warn({ err: err.message, mensagemId: msg.id }, "envio direto falhou; vai pela fila");
    await enfileirar("enviar_mensagem", { mensagemId: msg.id }, { chave: msg.id, atrasoMs: 1000 });
  }
  return msg;
}

// Fallback de anexo: sem o Endpoint Adicional "Anexos" na conexão, o DataCrazy
// manda o arquivo do atendente pelo endpoint de texto, sem as variáveis de
// anexo. Buscamos o arquivo na conversa pela REST (1–2 chamadas).
export async function jobBuscarAnexo({ mensagemId, dcMessageId, contactId }) {
  const conversa = await conversaDoAluno(contactId);
  const m = (await mensagensDaConversa(conversa)).find((x) => x.id === dcMessageId);
  if (!m) {
    // A conversa pode ter mudado: esquece o cache e deixa a fila tentar de novo.
    await query("update alunos set dc_conversation_id = null where contact_id = $1", [contactId]);
    throw new Error("mensagem ainda não aparece na conversa do DataCrazy");
  }
  const anexo = m.attachments?.[0];
  if (!anexo?.url) return;
  await query("update mensagens set anexo_url = $2, anexo_tipo = $3, anexo_nome = $4 where id = $1", [
    mensagemId,
    anexo.url,
    anexo.mimeType || null,
    anexo.fileName || null,
  ]);
  await publicar(contactId, mensagemId);
}

// Chamado pelo endpoint /dc/:slug/send. Idempotente pelo id da mensagem no DataCrazy.
export async function registrarMensagemDoAtendente(contactId, { texto, dcMessageId, anexoUrl, anexoTipo, anexoNome }) {
  if (dcMessageId) {
    const existente = await umaLinha("select * from mensagens where dc_message_id = $1", [dcMessageId]);
    if (existente) return existente;
  }
  // Atendente (ou automação) escrevendo depois do encerramento abre um atendimento novo.
  const atendimento = await atendimentoAberto(contactId);
  const id = randomUUID();
  const menu = extrairMenu(texto, id);
  const msg = await umaLinha(
    `insert into mensagens (id, contact_id, direcao, texto, anexo_url, anexo_tipo, anexo_nome, dc_message_id, status, atendimento_id, menu)
     values ($1, $2, 'atendente', $3, $4, $5, $6, $7, 'recebida', $8, $9)
     on conflict (dc_message_id) do nothing
     returning *`,
    [id, contactId, String(texto ?? ""), anexoUrl || null, anexoTipo || null, anexoNome || null, dcMessageId || null, atendimento.id, menu],
  );
  if (msg) {
    await query("update atendimentos set menu_mensagem_id = case when atendente is null then $2::uuid else null end where id = $1 and status = 'aberto'",
      [atendimento.id, menu ? msg.id : null]);
    await publicarAtendimento(contactId, atendimento.id);
    await publicar(contactId, msg.id);
    const aluno = await umaLinha("select faculdade from alunos where contact_id=$1", [contactId]);
    const faculdade = await faculdadePorSlug(aluno.faculdade);
    if (faculdade?.menus_crm && !atendimento.atendente && !menu && dcMessageId) {
      await enfileirar("sincronizar_menu", { mensagemId: msg.id }, { chave: msg.id, atrasoMs: 2000 });
    } else await pedirChecagemDoAtendente(atendimento);
    return msg;
  }
  return umaLinha("select * from mensagens where dc_message_id = $1", [dcMessageId]);
}
