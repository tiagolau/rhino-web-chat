// O CRM hospeda o arquivo; a VPS mantém a cópia até verificar e registrar o anexo.
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { pool, query } from "./db.js";
import { enfileirar } from "./fila.js";
import { subirArquivoNoCrm, validarUrlDoCdn, listarAnexosDoLead, anexarArquivoAoLead } from "./datacrazy.js";

export const hashArquivo = (conteudo) => createHash("sha256").update(conteudo).digest("hex");

export async function verificarArquivoNoCdn(url, tamanho, hash) {
  validarUrlDoCdn(url);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }, redirect: "error", signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok || !res.body) throw new Error(`download de verificação HTTP ${res.status}`);
  let bytes = 0;
  const digest = createHash("sha256");
  for await (const parte of res.body) {
    bytes += parte.length;
    if (bytes > tamanho) throw new Error("anexo do CDN excede o tamanho original");
    digest.update(parte);
  }
  if (bytes !== tamanho || digest.digest("hex") !== hash) throw new Error("anexo do CDN diverge do arquivo original");
}

export async function jobTransferirArquivo({ token }, log) {
  if (!config.anexosNoCrm) return;
  const cliente = await pool.connect();
  let travado = false;
  let descartarConexao = false;
  try {
    // Trava de sessão: não manter transação aberta durante chamadas de rede.
    const { rows: [trava] } = await cliente.query("select pg_try_advisory_lock(hashtextextended($1, 727011)) as ok", [token]);
    travado = trava.ok;
    if (!travado) throw new Error("transferência do arquivo em outra réplica");
    const { rows: [arq] } = await cliente.query(
      "select f.*, a.lead_id from arquivos f join alunos a on a.contact_id=f.contact_id where f.token=$1", [token]);
    if (!arq || arq.local_removido_em) return;
    await cliente.query("update arquivos set crm_tentativa_em=now() where token=$1", [token]);
    if (!arq.lead_id) throw new Error("aguardando vínculo do lead para transferir arquivo");
    const caminho = join(config.filesDir, arq.token);
    if (!arq.crm_url) {
      const conteudo = await readFile(caminho);
      if (conteudo.length !== arq.tamanho) throw new Error("arquivo local diverge do tamanho registrado");
      arq.sha256 = hashArquivo(conteudo);
      arq.crm_url = await subirArquivoNoCrm(arq.lead_id, conteudo, arq.nome, arq.mime);
      // Guardar a URL antes das próximas etapas para reaproveitá-la no retry.
      await cliente.query("update arquivos set crm_url=$2, sha256=$3 where token=$1", [token, arq.crm_url, arq.sha256]);
    }
    if (!arq.crm_verificado_em) {
      await verificarArquivoNoCdn(arq.crm_url, arq.tamanho, arq.sha256);
      await cliente.query("update arquivos set crm_verificado_em=now() where token=$1", [token]);
    }
    if (!arq.crm_anexo_id) {
      // Se o POST anterior foi aceito mas sua resposta se perdeu, não duplicar.
      const existente = (await listarAnexosDoLead(arq.lead_id)).find(a => a.attachmentUrl === arq.crm_url);
      const registro = existente || await anexarArquivoAoLead(arq.lead_id, {
        attachmentUrl: arq.crm_url, fileName: arq.nome, fileSize: arq.tamanho,
        description: "Arquivo enviado pelo aluno no webchat.",
      });
      if (!registro.id) throw new Error("CRM não confirmou o registro do anexo");
      await cliente.query("update arquivos set crm_anexo_id=$2 where token=$1", [token, registro.id]);
    }
    // O /f/ já resolve para o CDN. Se o processo cair após rm, retry é seguro.
    await rm(caminho, { force: true });
    await cliente.query("update arquivos set local_removido_em=now() where token=$1", [token]);
    log.info({ arquivo: hashArquivo(Buffer.from(token)).slice(0, 12) }, "anexo transferido e cópia local removida");
  } finally {
    if (travado) {
      try { await cliente.query("select pg_advisory_unlock(hashtextextended($1, 727011))", [token]); }
      catch { descartarConexao = true; }
    }
    cliente.release(descartarConexao);
  }
}

// Recupera anexos antigos, uploads sem job e erros esgotados, sem apagar pendências.
export async function agendarTransferencias() {
  if (!config.anexosNoCrm) return;
  const { rows } = await query(
    `select token from arquivos where local_removido_em is null
     and (crm_tentativa_em is null or crm_tentativa_em < now() - interval '1 hour')
     order by crm_tentativa_em nulls first, created_at limit 20`);
  for (const arq of rows) await enfileirar("transferir_arquivo", { token: arq.token }, { chave: arq.token });
}

export function iniciarTransferencias(log) {
  const agendar = () => agendarTransferencias().catch(err => log.error({ err: err.message }, "erro ao agendar anexos do CRM"));
  void agendar();
  const timer = setInterval(agendar, 60_000);
  return () => clearInterval(timer);
}
