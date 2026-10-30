import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://x@localhost/x";
process.env.SESSION_SECRET ??= "segredo-de-teste";
process.env.CPF_PEPPER ??= "pepper-de-teste";
process.env.CPF_ENC_KEY ??= "00".repeat(32);
process.env.DATACRAZY_API_TOKEN ??= "x";

const id = await import("../src/identidade.js");

test("cpfValido aceita CPF correto e recusa errados", () => {
  assert.equal(id.cpfValido("529.982.247-25"), true);
  assert.equal(id.cpfValido("52998224725"), true);
  assert.equal(id.cpfValido("52998224724"), false);
  assert.equal(id.cpfValido("11111111111"), false);
  assert.equal(id.cpfValido("123"), false);
});

test("chaveTelefone ignora o 9º dígito e o 55", () => {
  assert.equal(id.chaveTelefone("(31) 90000-0001"), "3100000001");
  assert.equal(id.chaveTelefone("553100000001"), "3100000001");
  assert.equal(id.chaveTelefone("5531900000001"), "3100000001");
  assert.notEqual(id.chaveTelefone("5521900000001"), id.chaveTelefone("5531900000001"));
  assert.equal(id.chaveTelefone("123"), null);
});

test("cifrar e decifrar o CPF", () => {
  const c = id.cifrar("52998224725");
  assert.notEqual(c, "52998224725");
  assert.equal(id.decifrar(c), "52998224725");
});

test("token: emite, lê e recusa adulterado", () => {
  const t = id.emitirToken({ contactId: "eduno:iguacu:abc", dispositivo: "d1" });
  assert.deepEqual(id.lerToken(t), { contactId: "eduno:iguacu:abc", dispositivo: "d1" });
  const [corpo, ass] = t.split(".");
  const outro = Buffer.from(JSON.stringify({ c: "eduno:iguacu:outro", d: "d1", exp: 9e9 })).toString("base64url");
  assert.equal(id.lerToken(`${outro}.${ass}`), null);
  assert.equal(id.lerToken(`${corpo}.x`), null);
  assert.equal(id.lerToken(undefined), null);
});
