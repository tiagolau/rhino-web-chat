// Cliente do DataCrazy: webhook da Conexão Universal (mensagens do aluno) e
// REST (leads). A REST tem 30 req/min por tenant, compartilhados com outras
// integrações, então toda chamada passa pelo limitador abaixo.

import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { montarPayloadWebhook } from "./payload.js";

// O Cloudflare na frente do DataCrazy barra User-Agents de biblioteca.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// ---------------------------------------------------------------- webhook ---

export async function enviarAoWebhook(faculdade, aluno, mensagem) {
  const payload = montarPayloadWebhook(aluno, mensagem, faculdade.texto_estruturado);

  const corpo = JSON.stringify(payload);
  const assinatura = createHmac("sha256", faculdade.webhook_secret).update(corpo).digest("hex");
  const res = await fetch(faculdade.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": assinatura, "User-Agent": UA },
    body: corpo,
    signal: AbortSignal.timeout(15_000),
  });
  // O DataCrazy responde 200 mesmo quando rejeita (ex.: assinatura inválida);
  // só dá para detectar falha de rede/HTTP aqui. O resto aparece na aba Logs.
  if (!res.ok) throw new Error(`webhook DataCrazy respondeu HTTP ${res.status}`);
}

// ------------------------------------------------------------------- REST ---

// Token bucket simples por processo.
const balde = { fichas: config.dcRestPorMinuto, atualizadoEm: Date.now() };
const intervaloMs = 60_000 / config.dcRestPorMinuto;

async function pegarFicha() {
  for (;;) {
    const agora = Date.now();
    balde.fichas = Math.min(config.dcRestPorMinuto, balde.fichas + (agora - balde.atualizadoEm) / intervaloMs);
    balde.atualizadoEm = agora;
    if (balde.fichas >= 1) {
      balde.fichas -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, intervaloMs * (1 - balde.fichas)));
  }
}

export class ErroRest extends Error {
  constructor(status, corpo) {
    super(`DataCrazy REST HTTP ${status}: ${String(corpo).slice(0, 300)}`);
    this.status = status;
  }
}

async function rest(metodo, caminho, corpo) {
  for (let tentativa = 0; ; tentativa++) {
    await pegarFicha();
    const res = await fetch(config.dcApiBase + caminho, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${config.dcApiToken}`,
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && tentativa < 3) {
      await new Promise((r) => setTimeout(r, 15_000 * (tentativa + 1)));
      continue;
    }
    const texto = await res.text();
    if (!res.ok) throw new ErroRest(res.status, texto);
    return texto ? JSON.parse(texto) : {};
  }
}

const qs = (params) => new URLSearchParams(params).toString();

export const buscarLeadsPorCpf = async (cpf) =>
  (await rest("GET", `/api/v1/leads?${qs({ take: "10", "filter[taxId]": cpf })}`)).data || [];

export const buscarLeads = async (termo) =>
  (await rest("GET", `/api/v1/leads?${qs({ take: "20", search: termo })}`)).data || [];

export const obterLead = (id) => rest("GET", `/api/v1/leads/${encodeURIComponent(id)}`);

// PATCH em `contacts` é aditivo: acrescenta sem apagar o WhatsApp/e-mail do lead
// (validado na PoC, ADR 002).
export const atualizarLead = (id, campos) => rest("PATCH", `/api/v1/leads/${encodeURIComponent(id)}`, campos);

export const criarLead = (dados) => rest("POST", "/api/v1/leads", dados);

// `search` com o contactId devolve a conversa daquele contato (os filtros
// `filter[...]` de conversa são ignorados pela API).
export const buscarConversas = async (termo) =>
  (await rest("GET", `/api/v1/conversations?${qs({ take: "5", search: termo })}`)).data || [];

// Devolve { messages, histories }. As mensagens do atendente trazem
// `attendant.name`/`signature`; `histories` traz entrada e transferência de
// atendente (`conversation-opened`, `attendant-added`) e `conversation-finished`.
export const conversaComHistorico = (conversaId, take = 20) =>
  rest("GET", `/api/v1/conversations/${encodeURIComponent(conversaId)}/messages?${qs({ take: String(take) })}`);

export const mensagensDaConversa = async (conversaId, take = 20) =>
  (await conversaComHistorico(conversaId, take)).messages || [];

// Anotação interna: só os atendentes veem; não passa pela Conexão Universal
// (validado em 2026-10-10).
export const enviarNotaInterna = (conversaId, texto) =>
  rest("POST", `/api/v1/conversations/${encodeURIComponent(conversaId)}/messages`, { body: texto, isInternal: true });

// Finaliza o atendimento (a "thread"). Não envia nada ao aluno pela conexão.
export const finalizarConversa = (conversaId) =>
  rest("POST", `/api/v1/conversations/${encodeURIComponent(conversaId)}/finish`);
