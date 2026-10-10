// CPF, telefone e token do navegador.

import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export const soDigitos = (valor) => String(valor ?? "").replace(/\D/g, "");

export function cpfValido(cpf) {
  const d = soDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(d[i]) * (tamanho + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(d[tamanho])) return false;
  }
  return true;
}

export const hashCpf = (cpf) => createHmac("sha256", config.cpfPepper).update(soDigitos(cpf)).digest("hex");

export function cifrar(texto) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.cpfEncKey, iv);
  const dados = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), dados].map((b) => b.toString("base64url")).join(".");
}

export function decifrar(valor) {
  const [iv, tag, dados] = valor.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", config.cpfEncKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(dados), decipher.final()]).toString("utf8");
}

// Celular brasileiro no formato 55 + DDD + número. Devolve null se não parecer celular.
export function normalizarCelular(valor) {
  let d = soDigitos(valor);
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!d.startsWith("55") || d.length < 12 || d.length > 13) return null;
  return d;
}

// Chave de comparação que ignora o 9º dígito: DDD + 8 últimos dígitos.
export function chaveTelefone(valor) {
  const d = normalizarCelular(valor);
  return d ? d.slice(2, 4) + d.slice(-8) : null;
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const assinar = (dados) => createHmac("sha256", config.sessionSecret).update(dados).digest("base64url");

export function emitirToken({ contactId, dispositivo }) {
  const exp = Math.floor(Date.now() / 1000) + config.sessionDays * 86400;
  const corpo = b64({ c: contactId, d: dispositivo, exp });
  return `${corpo}.${assinar(corpo)}`;
}

// Devolve { contactId, dispositivo } ou null se o token for inválido ou expirado.
export function lerToken(token) {
  if (typeof token !== "string") return null;
  const [corpo, assinatura] = token.split(".");
  if (!corpo || !assinatura) return null;
  const esperado = Buffer.from(assinar(corpo));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
  try {
    const { c, d, exp } = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
    if (!c || !d || !exp || exp < Date.now() / 1000) return null;
    return { contactId: c, dispositivo: d };
  } catch {
    return null;
  }
}

export function iguaisSeguro(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
