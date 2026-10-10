import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@localhost/x";
process.env.SESSION_SECRET ??= "segredo-de-teste";
process.env.CPF_PEPPER ??= "pepper-de-teste";
process.env.CPF_ENC_KEY ??= "00".repeat(32);
process.env.DATACRAZY_API_TOKEN ??= "x";

const { atendenteAtual } = await import("../src/atendimentos.js");

const inicio = "2026-10-10T18:00:00.000Z";
const historico = (quando, code, nome) => ({ createdAt: quando, historyCode: code, params: nome ? { attendantName: nome } : {} });
const enviada = (quando, nome, extra = {}) => ({ createdAt: quando, received: false, attendant: nome ? { name: nome } : undefined, ...extra });

test("atendente: quem abriu a conversa no DataCrazy", () => {
  const r = atendenteAtual({ histories: [historico("2026-10-10T18:05:00.000Z", "conversation-opened", "Maria")] }, inicio);
  assert.deepEqual(r, { nome: "Maria", quando: "2026-10-10T18:05:00.000Z" });
});

test("atendente: transferência vale o mais recente", () => {
  const r = atendenteAtual(
    {
      histories: [
        historico("2026-10-10T18:05:00.000Z", "conversation-opened", "Maria"),
        historico("2026-10-10T18:20:00.000Z", "attendant-added", "João"),
      ],
      messages: [enviada("2026-10-10T18:10:00.000Z", "Maria")],
    },
    inicio,
  );
  assert.equal(r.nome, "João");
});

test("atendente: ignora o que é de atendimento anterior, automação e anotação", () => {
  const r = atendenteAtual(
    {
      histories: [historico("2026-10-10T17:00:00.000Z", "conversation-opened", "Antigo")],
      messages: [
        enviada("2026-10-10T18:01:00.000Z", null), // robô
        enviada("2026-10-10T18:02:00.000Z", "Nota", { isInternal: true }),
        { createdAt: "2026-10-10T18:03:00.000Z", received: true },
      ],
    },
    inicio,
  );
  assert.equal(r, null);
});

test("atendente: usa a assinatura quando a mensagem não traz attendant", () => {
  const r = atendenteAtual({ messages: [enviada("2026-10-10T18:01:00.000Z", null, { signature: "Ana" })] }, inicio);
  assert.equal(r.nome, "Ana");
});
