// Fila de trabalhos no Postgres. Cada réplica consome com SKIP LOCKED, então
// duas réplicas nunca pegam o mesmo job.

import { query, umaLinha } from "./db.js";

const MAX_TENTATIVAS = 8;
const handlers = new Map();

export const registrar = (tipo, fn) => handlers.set(tipo, fn);

// `chave` deduplica: um segundo job com o mesmo tipo+chave pendente é ignorado.
export async function enfileirar(tipo, payload = {}, { chave = null, atrasoMs = 0 } = {}) {
  await query(
    `insert into jobs (tipo, chave, payload, executar_em)
     values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
     on conflict do nothing`,
    [tipo, chave, payload, String(atrasoMs)],
  );
}

async function pegarProximo() {
  return umaLinha(
    `update jobs set status = 'executando', tentativas = tentativas + 1, updated_at = now()
     where id = (
       select id from jobs
       where status = 'pendente' and executar_em <= now()
       order by id
       for update skip locked
       limit 1
     )
     returning *`,
  );
}

async function executar(job, log) {
  const fn = handlers.get(job.tipo);
  try {
    if (!fn) throw new Error(`tipo de job desconhecido: ${job.tipo}`);
    await fn(job.payload, log);
    await query("update jobs set status = 'feito', erro = null, updated_at = now() where id = $1", [job.id]);
  } catch (err) {
    const desistir = job.tentativas >= MAX_TENTATIVAS;
    // Backoff exponencial: 10s, 20s, 40s ... até ~21 min.
    const atraso = Math.min(10_000 * 2 ** (job.tentativas - 1), 1_280_000);
    await query(
      `update jobs set status = $2, erro = $3, executar_em = now() + ($4 || ' milliseconds')::interval, updated_at = now()
       where id = $1`,
      [job.id, desistir ? "erro" : "pendente", String(err.message).slice(0, 1000), String(atraso)],
    );
    log[desistir ? "error" : "warn"]({ job: job.id, tipo: job.tipo, tentativa: job.tentativas, err: err.message }, "job falhou");
  }
}

export function iniciarConsumidor(log) {
  let parado = false;
  (async () => {
    while (!parado) {
      try {
        const job = await pegarProximo();
        if (job) await executar(job, log);
        else await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        log.error({ err: err.message }, "erro no consumidor da fila");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  // Jobs que ficaram "executando" porque a réplica morreu no meio voltam para a fila.
  const resgate = setInterval(() => {
    query(
      "update jobs set status = 'pendente', updated_at = now() where status = 'executando' and updated_at < now() - interval '5 minutes'",
    ).catch((err) => log.error({ err: err.message }, "erro ao resgatar jobs"));
  }, 60_000);

  return () => {
    parado = true;
    clearInterval(resgate);
  };
}
