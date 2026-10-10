// Vínculo do aluno com um lead do DataCrazy (ADR 003). Roda uma vez por aluno,
// pela fila, porque a Conexão Universal cria contato e conversa, mas não lead.

import { query, umaLinha } from "./db.js";
import { decifrar, soDigitos, chaveTelefone } from "./identidade.js";
import * as dc from "./datacrazy.js";

const formatarCpf = (c) => `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;

// O taxId dos leads aparece como 11 dígitos (maioria), formatado, ou com 10
// dígitos quando o zero à esquerda foi perdido.
function variacoesCpf(cpf) {
  const v = [cpf, formatarCpf(cpf)];
  if (cpf.startsWith("0")) v.push(cpf.slice(1));
  return v;
}

function mesmoCpf(taxId, cpf) {
  const d = soDigitos(taxId);
  return d === cpf || (cpf.startsWith("0") && d === cpf.slice(1));
}

const maisRecente = (leads) =>
  [...leads].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];

async function procurarPorCpf(cpf) {
  for (const variacao of variacoesCpf(cpf)) {
    const achados = (await dc.buscarLeadsPorCpf(variacao)).filter((l) => mesmoCpf(l.taxId, cpf));
    if (achados.length) return achados;
  }
  return [];
}

// A busca do DataCrazy casa pelos 8 últimos dígitos; confirmamos o DDD aqui.
async function procurarPorCelular(celular) {
  const chave = chaveTelefone(celular);
  if (!chave) return [];
  const achados = await dc.buscarLeads(celular);
  return achados.filter((l) => [l.phone, l.rawPhone].some((p) => chaveTelefone(p) === chave));
}

export async function vincularLead(contactId, log) {
  const aluno = await umaLinha(
    "select a.*, f.instance_id from alunos a join faculdades f on f.slug = a.faculdade where a.contact_id = $1",
    [contactId],
  );
  if (!aluno) return;
  if (aluno.lead_id) return;

  const cpf = decifrar(aluno.cpf_cifrado);
  const contatoUniversal = { platform: "UNIVERSAL", contactId: aluno.contact_id, instanceId: aluno.instance_id };

  let lead = maisRecente(await procurarPorCpf(cpf));
  let celularEmConflito = false;

  if (!lead && aluno.celular) {
    const porCelular = await procurarPorCelular(aluno.celular);
    // Lead com o mesmo celular mas outro CPF pode ser alguém da família: não vincula.
    const compativeis = porCelular.filter((l) => !soDigitos(l.taxId) || mesmoCpf(l.taxId, cpf));
    celularEmConflito = porCelular.length > compativeis.length;
    lead = maisRecente(compativeis);
  }

  if (lead) {
    const jaTem = (lead.contacts || []).some((c) => c.platform === "UNIVERSAL" && c.contactId === aluno.contact_id);
    const campos = {};
    if (!jaTem) campos.contacts = [contatoUniversal];
    if (!soDigitos(lead.taxId)) campos.taxId = cpf;
    if (!lead.email && aluno.email) campos.email = aluno.email;
    if (Object.keys(campos).length) await dc.atualizarLead(lead.id, campos);
    await query("update alunos set lead_id = $2, lead_status = 'vinculado', updated_at = now() where contact_id = $1", [
      contactId,
      lead.id,
    ]);
    log.info({ contactId, leadId: lead.id }, "aluno vinculado a lead existente");
    return;
  }

  const novo = {
    name: aluno.nome,
    taxId: cpf,
    sourceReferral: { sourceUrl: `webchat-eduno-${aluno.faculdade}` },
    contacts: [contatoUniversal],
  };
  if (aluno.email) novo.email = aluno.email;
  // Preencher `phone` cria um contato WhatsApp no lead. Se esse celular já
  // pertence a outro lead (outro CPF), deixamos só na observação.
  if (aluno.celular && !celularEmConflito) novo.phone = aluno.celular;
  else if (aluno.celular) novo.notes = `Celular informado no portal Eduno: ${aluno.celular} (já usado por outro lead).`;

  const criado = await dc.criarLead(novo);
  await query("update alunos set lead_id = $2, lead_status = 'criado', updated_at = now() where contact_id = $1", [
    contactId,
    criado.id,
  ]);
  log.info({ contactId, leadId: criado.id }, "lead criado para o aluno");
}
