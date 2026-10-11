import { pool } from "./db.js";
import { menuDaMensagemCRM } from "./menus.js";
import { publicar, publicarAtendimento } from "./tempo-real.js";

// A consulta HTTP termina antes desta transação. A mesma trava da seleção
// impede que uma resposta já consumida volte a ficar clicável.
export async function sincronizarMenuCRM(mensagemId, dados, ocultarControle) {
  const cliente = await pool.connect();
  let mudou = false;
  let msg;
  try {
    await cliente.query("begin");
    const { rows: [alvo] } = await cliente.query("select * from mensagens where id=$1", [mensagemId]);
    if (!alvo) { await cliente.query("commit"); return; }
    const { rows: [atendimento] } = await cliente.query("select * from atendimentos where id=$1 for update", [alvo.atendimento_id]);
    if (!atendimento || atendimento.status !== "aberto" || atendimento.atendente) { await cliente.query("commit"); return; }
    msg = (await cliente.query("select * from mensagens where id=$1", [mensagemId])).rows[0];
    if (!msg) { await cliente.query("commit"); return; }
    const { rows: [ultima] } = await cliente.query(
      "select id from mensagens where atendimento_id=$1 and direcao='atendente' order by created_at desc, id desc limit 1", [atendimento.id]);
    if (ultima?.id !== msg.id || msg.menu) { await cliente.query("commit"); return; }
    const origem = (dados.messages || []).find(m => m.id === msg.dc_message_id);
    if (!origem) throw new Error("mensagem do menu ainda não aparece no DataCrazy");
    const menu = menuDaMensagemCRM(origem, msg.id, ocultarControle);
    if (!menu) { await cliente.query("commit"); return; }
    await cliente.query("update mensagens set menu=$2 where id=$1", [msg.id, menu]);
    const { rows: [respondeu] } = await cliente.query(
      "select 1 from mensagens where atendimento_id=$1 and direcao='aluno' and (created_at,id)>(select created_at,id from mensagens where id=$2) limit 1",
      [atendimento.id, msg.id]);
    if (!respondeu) await cliente.query("update atendimentos set menu_mensagem_id=$2 where id=$1", [atendimento.id, msg.id]);
    await cliente.query("commit");
    mudou = true;
  } catch (err) {
    await cliente.query("rollback");
    throw err;
  } finally { cliente.release(); }
  if (mudou) {
    await publicar(msg.contact_id, msg.id);
    await publicarAtendimento(msg.contact_id, msg.atendimento_id);
  }
}
