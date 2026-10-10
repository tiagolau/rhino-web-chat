import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@localhost/x";
process.env.SESSION_SECRET ??= "segredo-de-teste";
process.env.CPF_PEPPER ??= "pepper-de-teste";
process.env.CPF_ENC_KEY ??= "00".repeat(32);
process.env.DATACRAZY_API_TOKEN ??= "x";

const { serializarMensagem } = await import("../src/tempo-real.js");

test("eco e histórico preservam o identificador do balão antes do ack", () => {
  const m = serializarMensagem({ id: "persistida", cliente_id: "c-envio", direcao: "aluno", texto: "Olá" });
  assert.equal(m.id, "persistida");
  assert.equal(m.clienteId, "c-envio");
});

test("mensagens anteriores e de clientes antigos continuam sem correlação", () => {
  assert.equal(serializarMensagem({ id: "antiga", direcao: "aluno" }).clienteId, null);
});
