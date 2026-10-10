// Configuração das faculdades, com cache curto em memória.

import { query } from "./db.js";

const TTL_MS = 60_000;
let cache = { em: 0, lista: [] };

export const normalizarTexto = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

export async function listarFaculdades({ forcar = false } = {}) {
  if (forcar || Date.now() - cache.em > TTL_MS) {
    const { rows } = await query("select * from faculdades where ativo order by nome");
    cache = { em: Date.now(), lista: rows };
  }
  return cache.lista;
}

export async function faculdadePorSlug(slug) {
  return (await listarFaculdades()).find((f) => f.slug === slug) || null;
}

// O rodapé do portal traz o nome da faculdade ("FACULDADE IGUAÇU - FI ...").
// Ganha o trecho cadastrado mais longo contido no texto, para "FACULDADE X"
// não roubar o lugar de "FACULDADE X DO VALE".
export async function faculdadePorRodape(textoRodape) {
  const alvo = normalizarTexto(textoRodape);
  if (!alvo) return null;
  const candidatas = (await listarFaculdades()).filter((f) => alvo.includes(normalizarTexto(f.rodape)));
  candidatas.sort((a, b) => b.rodape.length - a.rodape.length);
  return candidatas[0] || null;
}

export const invalidarCacheFaculdades = () => (cache = { em: 0, lista: [] });
