// Mensagens do aluno (navegador -> DataCrazy) e do atendente (DataCrazy -> navegador).

import { randomUUID } from "node:crypto";
import { query, umaLinha } from "./db.js";
import { faculdadePorSlug } from "./faculdades.js";
import { enviarAoWebhook, mensagensDaConversa } from "./datacrazy.js";
import { atendimentoAberto, conversaDoAluno, pedirChecagemDoAtendente } from "./atendimentos.js";
import { enfileirar } from "./fila.js";
import { publicar } from "./tempo-real.js";
import { config } from "./config.js";

export const LIMITE_TEXTO = 4000;

async function enviarMensagemAoDataCrazy(mensagemId) {
  // `primeira`: é a primeira mensagem do aluno neste atendimento; `atendente`: um
  // humano já assumiu. A automação do DataCrazy usa os dois para saber quando
  // falar (ADR 004).
  const m = await umaLinha(
    `select m.*, a.nome, a.faculdade, at.atendente,
            not exists (select 1 from mensagens o where o.atendimento_id = m.atendimento_id and o.direcao = 'aluno'
                        and (o.created_at, o.id) < (m.created_at, m.id)) as primeira
     from mensagens m join alunos a on a.contact_id = m.contact_id
     left join atendimentos at on at.id = m.atendimento_id
     where m.id = $1`,
    [mensagemId],
  );
  if (!m || m.status === "enviada") return;
  const faculdade = await faculdadePorSlug(m.faculdade);
  if (!faculdade) throw new Error(`faculdade ${m.faculdade} inativa ou inexistente`);
  await enviarAoWebhook(faculdade, { contact_id: m.contact_id, nome: m.nome }, m);
  await query("update mensagens set status = 'enviada' where id = $1", [mensagemId]);
}

// Job de reenvio, para quando o envio direto falha.
export const jobEnviarMensagem = ({ mensagemId }) => enviarMensagemAoDataCrazy(mensagemId);

export async function registrarMensagemDoAluno(contactId, { texto, arquivoToken }, log) {
  texto = String(texto ?? "").trim().slice(0, LIMITE_TEXTO);
  let anexo = null;
  if (arquivoToken) {
    anexo = await umaLinha("select * from arquivos where token = $1 and contact_id = $2", [arquivoToken, contactId]);
    if (!anexo) throw new Error("arquivo não encontrado");
  }
  if (!texto && !anexo) throw new Error("mensagem vazia");

  // Depois de encerrado, a próxima mensagem abre um atendimento novo.
  const atendimento = await atendimentoAberto(contactId);
  const id = randomUUID();
  const msg = await umaLinha(
    `insert into mensagens (id, contact_id, direcao, texto, anexo_url, anexo_tipo, anexo_nome, status, atendimento_id)
     values ($1, $2, 'aluno', $3, $4, $5, $6, 'pendente', $7) returning *`,
    [
      id,
      contactId,
      texto,
      anexo ? `${config.publicUrl}/f/${anexo.token}/${encodeURIComponent(anexo.nome)}` : null,
      anexo?.mime ?? null,
      anexo?.nome ?? null,
      atendimento.id,
    ],
  );
  await publicar(contactId, id); // eco para outras abas do mesmo aluno

  try {
    await enviarMensagemAoDataCrazy(id);
    msg.status = "enviada";
  } catch (err) {
    log.warn({ err: err.message, mensagemId: id }, "envio direto falhou; vai pela fila");
    await enfileirar("enviar_mensagem", { mensagemId: id }, { chave: id, atrasoMs: 5000 });
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
  // Atendente (ou automação) escrevendo depois do encerramento abre um atendimento novo.
  const atendimento = await atendimentoAberto(contactId);
  const id = randomUUID();
  const msg = await umaLinha(
    `insert into mensagens (id, contact_id, direcao, texto, anexo_url, anexo_tipo, anexo_nome, dc_message_id, status, atendimento_id)
     values ($1, $2, 'atendente', $3, $4, $5, $6, $7, 'recebida', $8)
     on conflict (dc_message_id) do nothing
     returning *`,
    [id, contactId, String(texto ?? ""), anexoUrl || null, anexoTipo || null, anexoNome || null, dcMessageId || null, atendimento.id],
  );
  if (msg) {
    await publicar(contactId, msg.id);
    await pedirChecagemDoAtendente(atendimento);
    return msg;
  }
  return umaLinha("select * from mensagens where dc_message_id = $1", [dcMessageId]);
}
