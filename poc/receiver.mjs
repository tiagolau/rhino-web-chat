// Receptor da prova de conceito: recebe as mensagens que o DataCrazy envia
// (resposta do atendente) pela Conexão Universal e grava em logs/outbound.jsonl.
// Uso: node poc/receiver.mjs   (exponha com: cloudflared tunnel --url http://localhost:8787)

import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.loadEnvFile(join(here, ".env"));

const PORT = Number(process.env.RECEIVER_PORT || 8787);
const API_KEY = process.env.RECEIVER_API_KEY || "";
const LOG_DIR = join(here, "logs");
mkdirSync(LOG_DIR, { recursive: true });

function log(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  appendFileSync(join(LOG_DIR, "outbound.jsonl"), line + "\n");
  console.log(line);
}

function sameKey(received) {
  const a = Buffer.from(received || "");
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true });

  const match = req.url.match(/^\/dc\/([a-z0-9-]+)\/send/);
  if (req.method !== "POST" || !match) return reply(res, 404, { ok: false, error: "not found" });

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const faculdade = match[1];
    if (!sameKey(req.headers["x-api-key"])) {
      log({ faculdade, rejected: "api key inválida", headers: req.headers });
      return reply(res, 401, { ok: false, error: "unauthorized" });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    const id = `wc_out_${randomUUID()}`;
    log({ faculdade, id, path: req.url, body });
    reply(res, 200, { ok: true, id });
  });
}).listen(PORT, () => console.log(`receptor ouvindo em http://localhost:${PORT}`));
