import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

// keepAlive: o balanceador (VIP) do Swarm derruba em silêncio conexões TCP
// ociosas por ~15 min. Ver também o endpoint_mode dnsrr do Postgres na stack.
export const opcoesConexao = { connectionString: config.databaseUrl, keepAlive: true, keepAliveInitialDelayMillis: 10_000 };

export const pool = new pg.Pool({ ...opcoesConexao, max: 10 });

export const query = (texto, params) => pool.query(texto, params);

export async function umaLinha(texto, params) {
  const { rows } = await pool.query(texto, params);
  return rows[0] || null;
}

// Aplica as migrations pendentes. O advisory lock impede que duas réplicas
// subindo ao mesmo tempo apliquem a mesma migration.
// No Swarm o app pode subir antes do Postgres: espera até 60 s em vez de cair.
async function conectarComEspera(log) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (tentativa >= 30) throw err;
      log.warn({ err: err.message, tentativa }, "banco indisponível, tentando de novo");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function migrar(log) {
  const pasta = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const arquivos = (await readdir(pasta)).filter((f) => f.endsWith(".sql")).sort();
  const cliente = await conectarComEspera(log);
  try {
    await cliente.query("select pg_advisory_lock(727001)");
    await cliente.query("create table if not exists schema_migrations (nome text primary key, aplicada_em timestamptz not null default now())");
    const { rows } = await cliente.query("select nome from schema_migrations");
    const aplicadas = new Set(rows.map((r) => r.nome));
    for (const arquivo of arquivos) {
      if (aplicadas.has(arquivo)) continue;
      const sql = await readFile(join(pasta, arquivo), "utf8");
      await cliente.query("begin");
      try {
        await cliente.query(sql);
        await cliente.query("insert into schema_migrations (nome) values ($1)", [arquivo]);
        await cliente.query("commit");
        log.info({ migration: arquivo }, "migration aplicada");
      } catch (err) {
        await cliente.query("rollback");
        throw err;
      }
    }
  } finally {
    await cliente.query("select pg_advisory_unlock(727001)").catch(() => {});
    cliente.release();
  }
}
