// Conteúdo local: janela fixa de 72h. O CRM conserva o histórico recebido.
import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { publicar, publicarAtendimento } from "./tempo-real.js";

export async function limparHistorico(log) {
  let total = 0;
  for (let lote = 0; lote < 10; lote++) {
    const cliente = await pool.connect();
    let avisos = [], atendimentos = [], apagadas = 0;
    try {
      await cliente.query("begin");
      const { rows: [trava] } = await cliente.query("select pg_try_advisory_xact_lock(727012) as ok");
      if (!trava.ok) { await cliente.query("rollback"); break; }
      const { rows } = await cliente.query(
        `select id, contact_id, atendimento_id, direcao, status from mensagens
         where created_at < now() - interval '72 hours' order by created_at,id limit 1000`);
      if (rows.length) {
        const ids = rows.map(m => m.id);
        const contatos = [...new Set(rows.map(m => m.contact_id))];
        const atendimentoIds = [...new Set(rows.map(m => m.atendimento_id).filter(Boolean))];
        // Mesma ordem de travas do envio: aluno, atendimento, mensagem.
        await cliente.query("select contact_id from alunos where contact_id=any($1::text[]) order by contact_id for update", [contatos]);
        atendimentos = (await cliente.query("select id,contact_id from atendimentos where id=any($1::uuid[]) order by id for update", [atendimentoIds])).rows;
        await cliente.query(
          `update jobs set status='feito', erro='Mensagem expirada pela retenção de 72 horas', updated_at=now()
           where tipo in ('enviar_mensagem','buscar_anexo','sincronizar_menu')
           and payload->>'mensagemId'=any($1::text[])`, [ids]);
        // A exclusão zera referências aos menus antigos, inclusive em balões novos.
        apagadas = (await cliente.query("delete from mensagens where id=any($1::uuid[])", [ids])).rowCount;
        for (const a of atendimentos) {
          const pendentes = rows.filter(m => m.atendimento_id === a.id && m.direcao === 'aluno' && m.status !== 'enviada').length;
          if (!pendentes) continue;
          const id = randomUUID();
          await cliente.query(
            `insert into mensagens(id,contact_id,atendimento_id,direcao,texto,status)
             values($1,$2,$3,'sistema',$4,'aviso')`,
            [id, a.contact_id, a.id, `${pendentes === 1 ? "Uma mensagem não entregue expirou" : `${pendentes} mensagens não entregues expiraram`} após 72 horas. Reenvie sua solicitação.`]);
          avisos.push({ contactId: a.contact_id, id });
        }
      }
      // Jobs não guardam o corpo da mensagem. Limpar os já terminados/abandonados.
      await cliente.query(`delete from jobs where created_at < now()-interval '72 hours'
        and (status='feito' or (status='erro' and tipo in ('enviar_mensagem','buscar_anexo','sincronizar_menu')))`);
      await cliente.query("delete from acessos where created_at < now()-interval '72 hours'");
      await cliente.query("commit");
    } catch (err) {
      await cliente.query("rollback");
      throw err;
    } finally { cliente.release(); }
    for (const a of atendimentos) await publicarAtendimento(a.contact_id, a.id);
    for (const a of avisos) await publicar(a.contactId, a.id);
    total += apagadas;
    if (apagadas < 1000) break;
  }
  if (total) log.info({ mensagensRemovidas: total }, "histórico local expirado após 72 horas");
  return total;
}

export function iniciarRetencao(log) {
  let emCurso = false;
  const limpar = async () => {
    if (emCurso) return;
    emCurso = true;
    try { await limparHistorico(log); }
    catch (err) { log.error({ err: err.message }, "erro na retenção do histórico"); }
    finally { emCurso = false; }
  };
  void limpar();
  const timer = setInterval(limpar, 60_000);
  return () => clearInterval(timer);
}
