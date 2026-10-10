import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { pool, query, umaLinha, migrar } from "./db.js";
import { cpfValido, hashCpf, cifrar, soDigitos, normalizarCelular, emitirToken, lerToken, iguaisSeguro } from "./identidade.js";
import { listarFaculdades, faculdadePorSlug, faculdadePorRodape, invalidarCacheFaculdades } from "./faculdades.js";
import { registrar, enfileirar, iniciarConsumidor } from "./fila.js";
import { vincularLead } from "./leads.js";
import { registrarMensagemDoAluno, registrarMensagemDoAtendente, jobEnviarMensagem, jobBuscarAnexo } from "./mensagens.js";
import { adicionarConexao, iniciarOuvinte, serializarMensagem, totalConexoes } from "./tempo-real.js";

const raiz = dirname(fileURLToPath(import.meta.url));
const pastaPublica = join(raiz, "..", "public");

const TIPOS_PERMITIDOS = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "audio/mpeg", "audio/ogg", "audio/mp4", "audio/webm",
  "video/mp4",
]);

const app = Fastify({
  trustProxy: true, // atrás do Traefik: req.ip vem do X-Forwarded-For
  logger: {
    level: config.logLevel,
    // Nunca logar a query string: o WebSocket leva o token nela.
    serializers: { req: (req) => ({ method: req.method, url: req.url.split("?")[0], ip: req.ip }) },
  },
});

const origemPublica = new URL(config.publicUrl).origin;
const origemPermitida = (origem) => !origem || origem === origemPublica || config.allowedOrigins.includes(origem);

await app.register(cors, {
  origin: (origem, cb) => cb(null, origemPermitida(origem)),
  methods: ["GET", "POST"],
  allowedHeaders: ["Authorization", "Content-Type"],
});
await app.register(multipart);
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

// ------------------------------------------------------------- utilidades ---

const tokenDoHeader = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || null;

// Token válido + dispositivo ainda registrado para aquele aluno.
async function autenticar(token) {
  const sessao = lerToken(token);
  if (!sessao) return null;
  const disp = await umaLinha("select created_at from dispositivos where id = $1 and contact_id = $2", [
    sessao.dispositivo,
    sessao.contactId,
  ]);
  return disp ? { ...sessao, dispositivoDesde: disp.created_at } : null;
}

async function exigirSessao(req, reply) {
  const sessao = await autenticar(tokenDoHeader(req));
  if (!sessao) {
    reply.code(401).send({ erro: "nao_autorizado" });
    return null;
  }
  return sessao;
}

const limpar = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
const valorTemplate = (v) => (typeof v === "string" && !v.startsWith("${") ? v : null);

// --------------------------------------------------------------- públicas ---

const cacheArquivos = new Map();
async function servirEstatico(reply, arquivo, tipo) {
  if (!cacheArquivos.has(arquivo)) cacheArquivos.set(arquivo, await readFile(join(pastaPublica, arquivo)));
  return reply.type(tipo).header("Cache-Control", "public, max-age=300").send(cacheArquivos.get(arquivo));
}

app.get("/", (req, reply) => reply.redirect("/chat"));
app.get("/chat", (req, reply) => servirEstatico(reply, "chat.html", "text/html; charset=utf-8"));
app.get("/widget.js", (req, reply) => servirEstatico(reply, "widget.js", "application/javascript; charset=utf-8"));

app.get("/health", { logLevel: "warn" }, async () => {
  await query("select 1");
  return { ok: true, conexoes: totalConexoes() };
});

app.get("/api/faculdades", async () => (await listarFaculdades()).map((f) => ({ slug: f.slug, nome: f.nome })));

// Abre (ou retoma) a sessão do aluno. Chamado quando ele abre o chat.
app.post("/api/sessao", async (req, reply) => {
  const { aluno = {}, rodape, faculdade: slugEscolhido, token: tokenAnterior } = req.body || {};

  // Retomada sem dados do aluno (página própria): basta o token de um dispositivo conhecido.
  if (!aluno.cpf) {
    const sessao = await autenticar(tokenAnterior);
    if (!sessao) return reply.code(401).send({ erro: "sessao_expirada" });
    const a = await umaLinha(
      "select a.nome, f.slug, f.nome as faculdade from alunos a join faculdades f on f.slug = a.faculdade where a.contact_id = $1",
      [sessao.contactId],
    );
    if (!a) return reply.code(401).send({ erro: "sessao_expirada" });
    await query("update dispositivos set last_seen_at = now() where id = $1", [sessao.dispositivo]);
    return {
      token: emitirToken({ contactId: sessao.contactId, dispositivo: sessao.dispositivo }),
      faculdade: { slug: a.slug, nome: a.faculdade },
      aluno: { nome: a.nome },
    };
  }

  const cpf = soDigitos(aluno.cpf);
  if (!cpfValido(cpf)) return reply.code(400).send({ erro: "cpf_invalido" });
  const nome = limpar(aluno.nome);
  if (!nome) return reply.code(400).send({ erro: "nome_obrigatorio" });

  const faculdade = slugEscolhido ? await faculdadePorSlug(slugEscolhido) : await faculdadePorRodape(rodape);
  if (!faculdade) {
    const faculdades = (await listarFaculdades()).map((f) => ({ slug: f.slug, nome: f.nome }));
    return reply.code(422).send({ erro: "faculdade_desconhecida", faculdades });
  }

  const cpfHash = hashCpf(cpf);
  const contactId = `eduno:${faculdade.slug}:${cpfHash.slice(0, 20)}`;
  const anterior = lerToken(tokenAnterior);

  // Anti-abuso (ADR 003): o mesmo navegador ou IP alternando entre CPFs.
  if (anterior && anterior.contactId !== contactId) {
    const { n } = await umaLinha(
      `select count(distinct cpf_hash)::int as n from acessos
       where dispositivo = $1 and cpf_hash <> $2 and created_at > now() - interval '24 hours'`,
      [anterior.dispositivo, cpfHash],
    );
    if (n >= config.limiteCpfsPorDispositivo) {
      req.log.warn({ dispositivo: anterior.dispositivo }, "dispositivo alternando entre CPFs: bloqueado");
      return reply.code(429).send({ erro: "muitas_identidades" });
    }
  }
  const { n: cpfsNoIp } = await umaLinha(
    `select count(distinct cpf_hash)::int as n from acessos
     where ip = $1 and cpf_hash <> $2 and created_at > now() - interval '1 hour'`,
    [req.ip, cpfHash],
  );
  if (cpfsNoIp >= config.limiteCpfsPorIpHora) {
    req.log.warn({ ip: req.ip }, "IP alternando entre muitos CPFs: bloqueado");
    return reply.code(429).send({ erro: "muitas_identidades" });
  }

  const registro = await umaLinha(
    `insert into alunos (contact_id, faculdade, cpf_hash, cpf_cifrado, eduno_id, nome, email, celular)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (contact_id) do update set
       nome = excluded.nome,
       email = coalesce(excluded.email, alunos.email),
       celular = coalesce(excluded.celular, alunos.celular),
       eduno_id = coalesce(excluded.eduno_id, alunos.eduno_id),
       updated_at = now()
     returning lead_id`,
    [
      contactId,
      faculdade.slug,
      cpfHash,
      cifrar(cpf),
      limpar(aluno.id, 50),
      nome,
      limpar(aluno.email)?.toLowerCase() ?? null,
      normalizarCelular(aluno.celular),
    ],
  );

  let dispositivo = null;
  if (anterior && anterior.contactId === contactId) {
    const r = await umaLinha("update dispositivos set last_seen_at = now() where id = $1 and contact_id = $2 returning id", [
      anterior.dispositivo,
      contactId,
    ]);
    dispositivo = r?.id ?? null;
  }
  if (!dispositivo) {
    dispositivo = randomUUID();
    await query("insert into dispositivos (id, contact_id) values ($1, $2)", [dispositivo, contactId]);
  }
  await query("insert into acessos (ip, dispositivo, cpf_hash) values ($1, $2, $3)", [req.ip, dispositivo, cpfHash]);

  if (!registro.lead_id) await enfileirar("vincular_lead", { contactId }, { chave: contactId });

  return {
    token: emitirToken({ contactId, dispositivo }),
    faculdade: { slug: faculdade.slug, nome: faculdade.nome },
    aluno: { nome },
  };
});

// Histórico visível neste dispositivo: só a partir da primeira vez que ele abriu o chat.
app.get("/api/historico", async (req, reply) => {
  const sessao = await exigirSessao(req, reply);
  if (!sessao) return;
  const { rows } = await query(
    `select * from (
       select * from mensagens where contact_id = $1 and created_at >= $2
       order by created_at desc limit 200
     ) t order by created_at`,
    [sessao.contactId, sessao.dispositivoDesde],
  );
  return { mensagens: rows.map(serializarMensagem) };
});

app.post("/api/arquivos", async (req, reply) => {
  const sessao = await exigirSessao(req, reply);
  if (!sessao) return;
  const parte = await req.file({ limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
  if (!parte) return reply.code(400).send({ erro: "arquivo_ausente" });
  if (!TIPOS_PERMITIDOS.has(parte.mimetype)) {
    parte.file.resume();
    return reply.code(415).send({ erro: "tipo_nao_permitido" });
  }

  const token = randomBytes(32).toString("base64url");
  const nome = (parte.filename || "arquivo").replace(/[\\/\x00-\x1f]/g, "_").slice(0, 150);
  await mkdir(config.filesDir, { recursive: true });
  const destino = join(config.filesDir, token);
  await pipeline(parte.file, createWriteStream(destino));
  if (parte.file.truncated) {
    await rm(destino, { force: true });
    return reply.code(413).send({ erro: "arquivo_grande", limiteMb: config.maxUploadMb });
  }
  const { size } = await stat(destino);
  await query("insert into arquivos (token, contact_id, nome, mime, tamanho) values ($1, $2, $3, $4, $5)", [
    token,
    sessao.contactId,
    nome,
    parte.mimetype,
    size,
  ]);
  return { token, nome, tipo: parte.mimetype, tamanho: size };
});

// URL permanente e impossível de adivinhar: é ela que o DataCrazy guarda.
app.get("/f/:token/:nome", async (req, reply) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) return reply.code(404).send();
  const arq = await umaLinha("select * from arquivos where token = $1", [req.params.token]);
  if (!arq) return reply.code(404).send();
  const inline = /^(image|audio|video)\//.test(arq.mime) || arq.mime === "application/pdf";
  return reply
    .header("Content-Type", arq.mime)
    .header("Content-Length", arq.tamanho)
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; sandbox")
    .header("Cache-Control", "private, max-age=86400")
    .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(arq.nome)}`)
    .send(createReadStream(join(config.filesDir, arq.token)));
});

// -------------------------------------------------------------- WebSocket ---

app.get("/ws", { websocket: true }, (socket, req) => {
  if (!origemPermitida(req.headers.origin)) {
    socket.close(4403, "origem nao permitida");
    return;
  }
  // Os handlers precisam ser registrados já, antes de qualquer await, senão
  // mensagens que chegam durante a autenticação se perdem.
  const pronto = autenticar(req.query.token);
  let fila = Promise.resolve();

  pronto.then((sessao) => {
    if (!sessao) return socket.close(4401, "nao autorizado");
    adicionarConexao(sessao.contactId, socket);
    socket.send(JSON.stringify({ tipo: "pronto" }));
  });

  // Mantém a conexão viva atrás do Traefik e detecta clientes mortos.
  let vivo = true;
  socket.on("pong", () => (vivo = true));
  const batimento = setInterval(() => {
    if (!vivo) return socket.terminate();
    vivo = false;
    socket.ping();
  }, 25_000);
  socket.on("close", () => clearInterval(batimento));

  socket.on("message", (bruto) => {
    // Processa em ordem: a ordem de envio ao DataCrazy segue a do aluno.
    fila = fila.then(async () => {
      const sessao = await pronto;
      if (!sessao) return;
      let dados;
      try {
        dados = JSON.parse(bruto.toString());
      } catch {
        return;
      }
      if (dados.tipo !== "mensagem") return;
      try {
        const msg = await registrarMensagemDoAluno(sessao.contactId, { texto: dados.texto, arquivoToken: dados.arquivo }, req.log);
        socket.send(JSON.stringify({ tipo: "ack", clienteId: dados.clienteId, mensagem: serializarMensagem(msg) }));
      } catch (err) {
        req.log.warn({ err: err.message }, "mensagem do aluno recusada");
        socket.send(JSON.stringify({ tipo: "erro", clienteId: dados.clienteId, erro: err.message }));
      }
    });
  });
});

// ------------------------------------------------- DataCrazy -> atendente ---

// Endpoint de envio da Conexão Universal de cada faculdade.
app.post("/dc/:slug/send", async (req, reply) => {
  const faculdade = await faculdadePorSlug(req.params.slug);
  if (!faculdade || !iguaisSeguro(req.headers["x-api-key"], faculdade.api_key)) {
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  }
  const b = req.body || {};
  const aluno = await umaLinha("select contact_id from alunos where contact_id = $1 and faculdade = $2", [
    b.contactId,
    faculdade.slug,
  ]);
  if (!aluno) return reply.code(404).send({ ok: false, error: "contato desconhecido" });

  const dcMessageId = valorTemplate(b.dcMessageId);
  const anexoUrl = valorTemplate(b.attachmentUrl);
  const msg = await registrarMensagemDoAtendente(aluno.contact_id, {
    texto: b.text,
    dcMessageId,
    anexoUrl,
    anexoTipo: valorTemplate(b.mimeType),
    anexoNome: valorTemplate(b.filename),
  });
  // Mensagem vazia sem anexo = arquivo que veio pelo endpoint de texto (sem "Anexos" na conexão).
  if (!anexoUrl && !String(b.text ?? "").trim() && dcMessageId) {
    await enfileirar("buscar_anexo", { mensagemId: msg.id, dcMessageId, contactId: aluno.contact_id }, { chave: dcMessageId, atrasoMs: 2000 });
  }
  return { ok: true, id: msg.id };
});

// ------------------------------------------------------------------ admin ---

async function exigirAdmin(req, reply) {
  if (!config.adminKey || !iguaisSeguro(req.headers["x-admin-key"], config.adminKey)) {
    reply.code(401).send({ erro: "nao_autorizado" });
    return false;
  }
  return true;
}

app.get("/admin/faculdades", async (req, reply) => {
  if (!(await exigirAdmin(req, reply))) return;
  const { rows } = await query("select slug, nome, rodape, instance_id, webhook_url, ativo, updated_at from faculdades order by slug");
  return rows;
});

app.post("/admin/faculdades", async (req, reply) => {
  if (!(await exigirAdmin(req, reply))) return;
  const f = req.body || {};
  for (const campo of ["slug", "nome", "rodape", "instance_id", "webhook_url", "webhook_secret", "api_key"]) {
    if (!f[campo]) return reply.code(400).send({ erro: `campo ${campo} obrigatório` });
  }
  if (!/^[a-z0-9-]+$/.test(f.slug)) return reply.code(400).send({ erro: "slug só aceita a-z, 0-9 e hífen" });
  await query(
    `insert into faculdades (slug, nome, rodape, instance_id, webhook_url, webhook_secret, api_key, ativo)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, true))
     on conflict (slug) do update set
       nome = excluded.nome, rodape = excluded.rodape, instance_id = excluded.instance_id,
       webhook_url = excluded.webhook_url, webhook_secret = excluded.webhook_secret,
       api_key = excluded.api_key, ativo = excluded.ativo, updated_at = now()`,
    [f.slug, f.nome, f.rodape, f.instance_id, f.webhook_url, f.webhook_secret, f.api_key, f.ativo ?? null],
  );
  invalidarCacheFaculdades();
  return { ok: true };
});

app.get("/admin/status", async (req, reply) => {
  if (!(await exigirAdmin(req, reply))) return;
  const [jobs, alunos, hoje] = await Promise.all([
    query("select tipo, status, count(*)::int as n from jobs group by 1, 2 order by 1, 2"),
    query("select lead_status, count(*)::int as n from alunos group by 1"),
    query("select direcao, status, count(*)::int as n from mensagens where created_at > now() - interval '24 hours' group by 1, 2"),
  ]);
  const errosRecentes = await query(
    "select id, tipo, tentativas, erro, updated_at from jobs where status = 'erro' order by updated_at desc limit 20",
  );
  return {
    conexoesNestaReplica: totalConexoes(),
    jobs: jobs.rows,
    alunos: alunos.rows,
    mensagens24h: hoje.rows,
    errosRecentes: errosRecentes.rows,
  };
});

// ----------------------------------------------------------------- subida ---

registrar("vincular_lead", ({ contactId }, log) => vincularLead(contactId, log));
registrar("enviar_mensagem", jobEnviarMensagem);
registrar("buscar_anexo", jobBuscarAnexo);

await migrar(app.log);
const pararConsumidor = iniciarConsumidor(app.log);
const pararOuvinte = iniciarOuvinte(app.log);

async function encerrar(sinal) {
  app.log.info({ sinal }, "encerrando");
  pararConsumidor();
  pararOuvinte();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);

await app.listen({ port: config.port, host: "0.0.0.0" });
