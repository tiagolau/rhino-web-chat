// Retenção em Postgres descartável, API/WebSocket reais e CRM simulado.
import pg from 'pg';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const adminUrl=process.env.POSTGRES_TEST_ADMIN_URL || 'postgresql://localhost/postgres';
const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
const banco=`webchat_retencao_${Date.now()}`;await admin.query(`create database ${banco}`);
const dbUrl=new URL(adminUrl);dbUrl.pathname='/'+banco;
const recebidas=[];
const crm=createServer(async(req,res)=>{let body='';for await(const p of req)body+=p;recebidas.push(JSON.parse(body||'{}'));res.setHeader('Content-Type','application/json');res.end('{}');});
await new Promise(r=>crm.listen(0,'127.0.0.1',r));const crmBase=`http://127.0.0.1:${crm.address().port}`;
Object.assign(process.env,{DATABASE_URL:dbUrl.href,SESSION_SECRET:'teste',CPF_PEPPER:'teste',CPF_ENC_KEY:'ab'.repeat(32),DATACRAZY_API_TOKEN:'teste',DC_REST_PER_MINUTE:'10000',ANEXOS_NO_CRM:'false'});
const log={info(){},warn(){},error(){}};let db,api,trava;
try{
 db=await import('../src/db.js');await db.migrar(log);
 const {limparHistorico}=await import('../src/retencao.js');
 const {registrarMensagemDoAluno:enviar,jobEnviarMensagem}=await import('../src/mensagens.js');
 const {emitirToken}=await import('../src/identidade.js');
 await db.query(`insert into faculdades(slug,nome,rodape,instance_id,webhook_url,webhook_secret,api_key,fluxo_nativo,texto_estruturado)
 values('teste','Teste','Teste','instancia',$1,'segredo','chave',true,true)`,[crmBase]);
 await db.query(`insert into alunos(contact_id,faculdade,cpf_hash,cpf_cifrado,nome,lead_id)values('aluno','teste','hash','cifra','Aluno fictício','lead')`);
 const atendimento=randomUUID(),menu=randomUUID(),pendente=randomUUID(),resposta=randomUUID(),quase=randomUUID(),primeira=randomUUID();
 await db.query(`insert into atendimentos(id,contact_id,numero,fluxo_nativo_iniciado,primeira_mensagem_id)values($1,'aluno',1,true,$2)`,[atendimento,primeira]);
 async function mensagem(id,direcao,status,idade,texto){await db.query(`insert into mensagens(id,contact_id,atendimento_id,direcao,status,texto,created_at)
 values($1,'aluno',$2,$3,$4,$5,now()-($6::text)::interval)`,[id,atendimento,direcao,status,texto,idade]);}
 await mensagem(primeira,'aluno','enviada','80 hours','conteudo antigo entregue');
 await mensagem(menu,'atendente','recebida','74 hours','menu antigo');
 await mensagem(pendente,'aluno','pendente','73 hours','conteudo pendente antigo');
 await mensagem(resposta,'aluno','enviada','1 hour','mensagem recente');
 await mensagem(quase,'aluno','enviada','71 hours 59 minutes','ainda no prazo');
 await db.query('update atendimentos set menu_mensagem_id=$2 where id=$1',[atendimento,menu]);
 await db.query('update mensagens set menu_origem=$2 where id=$1',[resposta,menu]);
 await db.query(`insert into jobs(tipo,chave,payload,executar_em,created_at)values('enviar_mensagem',$1,$2,now()+interval '1 year',now()-interval '73 hours')`,[pendente,{mensagemId:pendente}]);
 await db.query(`insert into jobs(tipo,status,payload,created_at)values('finalizar_no_datacrazy','erro','{}',now()-interval '80 hours')`);
 await db.query(`insert into acessos(ip,cpf_hash,created_at)values('teste','hash',now()-interval '73 hours')`);
 // Mesmo antes da exclusão física, a API e o envio não expõem dados fora da janela.
 await jobEnviarMensagem({mensagemId:pendente});assert.equal(recebidas.length,0);
 trava=await db.pool.connect();await trava.query('select pg_advisory_lock(727012)');
 const porta=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const base=`http://127.0.0.1:${porta}`;
 const dispositivo=randomUUID();await db.query(`insert into dispositivos(id,contact_id,created_at)values($1,'aluno',now()-interval '90 hours')`,[dispositivo]);
 const auth={Authorization:'Bearer '+emitirToken({contactId:'aluno',dispositivo})};
 api=spawn(process.execPath,['src/server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(porta),PUBLIC_URL:base,LOG_LEVEL:'silent'},stdio:['ignore','pipe','pipe']});
 let healthy=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(healthy);
 const historico=await(await fetch(base+'/api/historico',{headers:auth})).json();
 assert.deepEqual(new Set(historico.mensagens.map(m=>m.id)),new Set([resposta,quase]));
 const lista=await(await fetch(base+'/api/atendimentos',{headers:auth})).json();assert.equal(lista.atendimentos[0].resumo,'ainda no prazo');
 assert.equal((await db.umaLinha('select count(*)::int as n from mensagens')).n,5,'a API filtrou sem depender da limpeza');
 assert.equal(await limparHistorico(log),0,'outra réplica não executa limpeza simultânea');
 api.kill('SIGTERM');await new Promise(r=>api.once('exit',r));api=null;
 await trava.query('select pg_advisory_unlock(727012)');trava.release();trava=null;
 assert.equal(await limparHistorico(log),3);
 const atuais=(await db.query('select * from mensagens')).rows;
 assert.equal(atuais.length,3);assert.ok(atuais.some(m=>m.id===quase));
 assert.ok(atuais.every(m=>!m.texto.includes('antigo')));
 const aviso=atuais.find(m=>m.direcao==='sistema');assert.match(aviso.texto,/72 horas/);
 assert.equal((await db.umaLinha('select * from mensagens where id=$1',[resposta])).menu_origem,null);
 const a=await db.umaLinha('select * from atendimentos where id=$1',[atendimento]);assert.equal(a.menu_mensagem_id,null);assert.equal(a.primeira_mensagem_id,primeira);
 assert.equal((await db.umaLinha("select count(*)::int as n from jobs where tipo='enviar_mensagem'")).n,0);
 assert.equal((await db.umaLinha("select count(*)::int as n from jobs where tipo='finalizar_no_datacrazy'")).n,1,'pendência operacional sem conteúdo preservada');
 assert.equal((await db.umaLinha('select count(*)::int as n from acessos')).n,0);
 assert.equal(await limparHistorico(log),0);assert.equal((await db.umaLinha('select count(*)::int as n from mensagens')).n,3);
 await enviar('aluno',{texto:'Continuação do atendimento',clienteId:'apos-retencao'},log);
 assert.equal(recebidas.length,1);assert.equal(recebidas[0].novo_atendimento,'nao','limpeza não reinicia boas-vindas');
 console.log('OK: janela estrita na API/envio, exclusão física, pendência expirada com aviso, menus/FKs, idempotência, concorrência e continuidade nativa');
}finally{
 if(api && api.exitCode===null){api.kill('SIGTERM');await new Promise(r=>api.once('exit',r));}
 if(trava){await trava.query('select pg_advisory_unlock(727012)');trava.release();}
 if(db)await db.pool.end();await new Promise(r=>crm.close(r));await admin.query(`drop database ${banco} with (force)`);await admin.end();
}
