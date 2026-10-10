// Simula o webchat: envia uma mensagem de aluno para o webhook da Conexão
// Universal do DataCrazy, assinada com HMAC-SHA256.
// Uso: node poc/send-inbound.mjs --faculdade iguacu --id 999001 --name "Aluno Teste" --text "Olá"

import { createHmac, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(join(here, ".env"));

const { values: args } = parseArgs({
  options: {
    faculdade: { type: "string", default: "iguacu" },
    id: { type: "string", default: "999001" },
    name: { type: "string", default: "Aluno Teste Webchat" },
    text: { type: "string", default: "Olá, teste do webchat" },
    "media-url": { type: "string" },
    "media-type": { type: "string" },
  },
});

const envKey = `DC_WEBHOOK_URL_${args.faculdade.toUpperCase().replace(/-/g, "_")}`;
const url = process.env[envKey];
const secret = process.env.DC_WEBHOOK_SECRET;
if (!url) throw new Error(`Defina ${envKey} em poc/.env`);
if (!secret) throw new Error("Defina DC_WEBHOOK_SECRET em poc/.env");

const payload = {
  message_id: `wc_in_${randomUUID()}`,
  contact: { id: `eduno:${args.faculdade}:${args.id}`, name: args.name },
  text: args.text,
  timestamp: Math.floor(Date.now() / 1000),
  fromMe: false,
};
if (args["media-url"]) payload.media = { url: args["media-url"], type: args["media-type"] || "image/png" };

const body = JSON.stringify(payload);
const signature = createHmac("sha256", secret).update(body).digest("hex");

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Signature": signature },
  body,
});
console.log("enviado:", body);
console.log("resposta:", res.status, await res.text());
