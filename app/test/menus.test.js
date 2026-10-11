import { test } from "node:test";
import assert from "node:assert/strict";
import { extrairMenu, escolherOpcao, menuDaMensagemCRM } from "../src/menus.js";

test("rótulos iguais em menus diferentes não autorizam a escolha do menu anterior", () => {
  const anterior = extrairMenu("TCC\n▸ Encerrar atendimento", "dispensa");
  const atual = extrairMenu("TCC\n▸ Encerrar atendimento", "orientacao");
  assert.throws(() => escolherOpcao(atual, { menuId: anterior.id, opcaoId: "op0" }), /não está mais disponível/);
  assert.equal(escolherOpcao(atual, { menuId: atual.id, opcaoId: "op0" }, "texto adulterado").texto, "Encerrar atendimento");
});

test("texto livre não vira opção; digitação exata continua compatível", () => {
  const menu = extrairMenu("Escolha:\n\n▸ Secretaria\n▸ Pedagógico\n", "mensagem");
  assert.equal(escolherOpcao(menu, null, "Tenho uma dúvida"), null);
  assert.equal(escolherOpcao(menu, null, " Pedagógico ").id, "op1");
  assert.equal(extrairMenu("▸ Exemplo no corpo\nResposta comum", "outra"), null);
});

test("menu encerrado e ID de opção desconhecido são recusados", () => {
  assert.throws(() => escolherOpcao(null, { menuId: "antigo", opcaoId: "op0" }), /não está mais disponível/);
  assert.throws(() => escolherOpcao(extrairMenu("▸ Secretaria", "menu"), { menuId: "menu", opcaoId: "op99" }), /Opção inválida/);
});

test("botões reais do CRM viram opções por mensagem sem alterar o texto original", () => {
  const mensagem = { received: false, isInternal: false, buttons: [
    { name: "Secretaria", description: null, url: null },
    { name: "Pedagógico", url: null }, { name: "Portal", url: "https://example.com" },
    { name: "Atendimento encerrado", url: null },
  ] };
  assert.deepEqual(menuDaMensagemCRM(mensagem, "local", true), { id: "local", opcoes: [
    { id: "op0", texto: "Secretaria" }, { id: "op1", texto: "Pedagógico" },
  ] });
  assert.equal(menuDaMensagemCRM(mensagem, "outro").opcoes.at(-1).texto, "Atendimento encerrado");
});

test("mensagens humanas, internas, recebidas e botões ambíguos não viram menus", () => {
  const mensagem = { buttons: [{ name: "Secretaria" }] };
  for (const alteracao of [{ received: true }, { isInternal: true }, { attendant: { name: "Ana" } }, { signature: "Ana" },
    { buttons: [{ name: "Mesmo" }, { name: "Mesmo" }] }, { buttons: [{ name: "" }] },
    { buttons: [{ name: "a".repeat(301) }] }, { buttons: Array(31).fill({ name: "Opção" }) },
    { buttons: [{ name: "Portal", url: "https://example.com" }] }, { buttons: null }]) {
    assert.equal(menuDaMensagemCRM({ ...mensagem, ...alteracao }, "local"), null);
  }
});
