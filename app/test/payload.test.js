import test from "node:test";
import assert from "node:assert/strict";
import { lerTexto, montarPayloadWebhook } from "../src/payload.js";

test("callback lê text.body e mantém texto legado e anexo sem legenda", () => {
  assert.equal(lerTexto({ body: "Olá\n▸ Secretaria" }), "Olá\n▸ Secretaria");
  assert.equal(lerTexto("Olá"), "Olá");
  assert.equal(lerTexto(null), "");
  assert.equal(lerTexto({ body: "" }), "");
  for (const invalido of [{}, { body: {} }, [], 123]) assert.throws(() => lerTexto(invalido), /body string/);
});

test("webhook estrutura o texto preservando identidade, controles e anexos", () => {
  const aluno = { contact_id: "contato-teste", nome: "Aluno Teste" };
  const m = { id: "mensagem-teste", created_at: "2026-10-10T12:00:00Z", primeira: true,
    atendente: false, atendimento_id: "atendimento-teste", opcao_id: "op1",
    texto: "Secretaria", anexo_url: "https://teste.invalid/f.pdf", anexo_tipo: "application/pdf" };
  const estruturado = montarPayloadWebhook(aluno, m);
  const legado = montarPayloadWebhook(aluno, m, false);
  assert.deepEqual(estruturado.text, { body: "Secretaria" });
  assert.deepEqual({ ...estruturado, text: estruturado.text.body }, legado);
  assert.equal(estruturado.novo_atendimento, "sim");
  assert.equal(estruturado.com_atendente, "nao");
  assert.equal(estruturado.atendimento_id, m.atendimento_id);
  assert.equal(estruturado.opcao_id, "op1");
  assert.deepEqual(estruturado.media, { url: m.anexo_url, type: m.anexo_tipo });
  assert.equal(montarPayloadWebhook(aluno, { ...m, texto: "", anexo_nome: "f.pdf" }).text.body, "f.pdf");
  assert.equal(montarPayloadWebhook(aluno, { ...m, texto: "Atendimento encerrado" }).text.body, "Atendimento encerrado");
});
