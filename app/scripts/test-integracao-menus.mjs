// Postgres real, CRM simulado. Cria e remove um banco exclusivo, nunca usa .env.
// POSTGRES_TEST_ADMIN_URL pode apontar para um Postgres local com CREATE DATABASE.
import pg from 'pg';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const adminUrl = process.env.POSTGRES_TEST_ADMIN_URL || 'postgresql://localhost/postgres';
const nomeBanco = `webchat_teste_${Date.now()}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`create database ${nomeBanco}`);
const urlBanco = new URL(adminUrl);
urlBanco.pathname = '/' + nomeBanco;
const env = {
  DATABASE_URL: urlBanco.href, SESSION_SECRET: 'sessao-teste', CPF_PEPPER: 'pepper-teste',
  CPF_ENC_KEY: 'ab'.repeat(32), DATACRAZY_API_TOKEN: 'token-ficticio', DC_REST_PER_MINUTE: '1000',
};
Object.assign(process.env, env);
const recebidas = [];
let historicoCRM = { messages: [], histories: [] };
let consultasCRM = 0;
let liberarEncerramento;
let avisarControle;
const controleRecebido = new Promise(resolve => { avisarControle = resolve; });
const esperaEncerramento = new Promise(resolve => { liberarEncerramento = resolve; });
let liberarLead;
const esperaLead = new Promise(resolve => { liberarLead = resolve; });
const crm = createServer(async (req, res) => {
  let bruto = '';
  for await (const pedaco of req) bruto += pedaco;
  const caminho = new URL(req.url, 'http://local').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (caminho === '/webhook') {
    assert.equal(req.headers['x-signature'], createHmac('sha256', 'segredo-teste').update(bruto).digest('hex'));
    const mensagem = JSON.parse(bruto);
    recebidas.push(mensagem);
    if (mensagem.text.body === 'Atendimento encerrado') {
      avisarControle();
      await esperaEncerramento;
      await db.query('update atendimentos set dc_sessao_limpa_em=now() where id=$1', [mensagem.atendimento_id]);
    }
    return res.end('{}');
  }
  if (req.method === 'GET' && caminho === '/api/v1/leads') {
    await esperaLead;
    return res.end(JSON.stringify({ data: [{ id: 'lead-teste', taxId: '52998224725', email: 'teste@example.com' }] }));
  }
  if (req.method === 'PATCH' && caminho === '/api/v1/leads/lead-teste') return res.end('{}');
  if (req.method === 'GET' && caminho === '/api/v1/conversations/conversa-teste/messages') {
    consultasCRM++;
    return res.end(JSON.stringify(historicoCRM));
  }
  if (req.method === 'POST' && caminho.startsWith('/api/v1/conversations/conversa-teste/')) return res.end('{}');
  res.statusCode = 404;
  res.end('{}');
});
await new Promise(resolve => crm.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${crm.address().port}`;
process.env.DATACRAZY_API_BASE = base;
let db;
let apiServidor;
const log = { info() {}, warn() {}, error() {} };
try {
  db = await import('../src/db.js');
  await db.migrar(log);
  const { cifrar } = await import('../src/identidade.js');
  const { vincularLead } = await import('../src/leads.js');
  const { registrarMensagemDoAluno: enviar, registrarMensagemDoAtendente: responder, jobEnviarMensagem } = await import('../src/mensagens.js');
  const { encerrarAtendimento, jobFinalizarNoDataCrazy, jobSincronizarMenu } = await import('../src/atendimentos.js');
  const { invalidarCacheFaculdades } = await import('../src/faculdades.js');
  const { serializarMensagem, serializarAtendimento } = await import('../src/tempo-real.js');
  await db.query(`insert into faculdades (slug,nome,rodape,instance_id,webhook_url,webhook_secret,api_key,fluxo_nativo,texto_estruturado)
    values ('teste','Teste','Teste','instancia-teste',$1,'segredo-teste','chave-teste',true,true)`, [base + '/webhook']);
  const contactId = 'eduno:teste:ficticio';
  await db.query(`insert into alunos (contact_id,faculdade,cpf_hash,cpf_cifrado,nome)
    values ($1,'teste','hash-ficticio',$2,'Aluno Teste')`, [contactId, cifrar('52998224725')]);
  const vinculo = vincularLead(contactId, log);
  const primeira = await enviar(contactId, { texto: 'Olá', clienteId: 'primeira' }, log);
  const segunda = await enviar(contactId, { texto: 'Outra mensagem', clienteId: 'segunda' }, log);
  assert.equal(primeira.status, 'pendente');
  assert.equal(recebidas.length, 0, 'não pode iniciar antes de vincular o lead');
  liberarLead();
  await vinculo;
  await assert.rejects(jobEnviarMensagem({ mensagemId: segunda.id }), /mensagem anterior/);
  await jobEnviarMensagem({ mensagemId: primeira.id });
  await jobEnviarMensagem({ mensagemId: segunda.id });
  assert.deepEqual(recebidas.map(m => m.text.body), ['Olá', 'Outra mensagem']);
  assert.deepEqual(recebidas.map(m => m.novo_atendimento), ['sim', 'nao']);
  console.log('OK: vínculo antes da entrada; fila preserva a ordem e inicia uma vez');

  const menu = await responder(contactId, { texto: 'Escolha\n\n▸ Encerrar atendimento\n▸ Outra opção', dcMessageId: 'menu-a' });
  const escolha = { menuId: menu.id, opcaoId: 'op1' };
  const concorrentes = await Promise.allSettled([
    enviar(contactId, { texto: 'texto adulterado', opcao: escolha, clienteId: 'clique-a' }, log),
    enviar(contactId, { texto: 'texto adulterado', opcao: escolha, clienteId: 'clique-b' }, log),
  ]);
  assert.equal(concorrentes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(concorrentes.filter(r => r.status === 'rejected').length, 1);
  assert.equal(recebidas.at(-1).text.body, 'Outra opção');
  const sucesso = concorrentes.find(r => r.status === 'fulfilled').value;
  const repetida = await enviar(contactId, { opcao: escolha, clienteId: sucesso.cliente_id }, log);
  assert.equal(repetida.id, sucesso.id);
  assert.equal(recebidas.length, 3, 'repetição do mesmo clique não reenvia');
  console.log('OK: clique concorrente único, texto validado, repetição idempotente');

  const menuB = await responder(contactId, { texto: 'Outro contexto\n\n▸ Encerrar atendimento', dcMessageId: 'menu-b' });
  await assert.rejects(enviar(contactId, { opcao: { menuId: menu.id, opcaoId: 'op0' } }, log), /não está mais disponível/);
  assert.equal(serializarMensagem(menuB).menu.id, menuB.id);
  assert.equal(serializarAtendimento(await db.umaLinha('select * from atendimentos where id=$1', [menuB.atendimento_id])).menuId, menuB.id);
  // Callback repetido não restaura um menu antigo.
  await responder(contactId, { texto: menu.texto, dcMessageId: 'menu-a' });
  assert.equal((await db.umaLinha('select * from atendimentos where id=$1', [menuB.atendimento_id])).menu_mensagem_id, menuB.id);
  await db.query('update atendimentos set atendente=$2, menu_mensagem_id=null where id=$1', [menuB.atendimento_id, 'Atendente Teste']);
  await assert.rejects(enviar(contactId, { opcao: { menuId: menuB.id, opcaoId: 'op0' } }, log), /não está mais disponível/);
  await responder(contactId, { texto: 'Menu tardio\n▸ Opção', dcMessageId: 'menu-c' });
  assert.equal((await db.umaLinha('select * from atendimentos where id=$1', [menuB.atendimento_id])).menu_mensagem_id, null);
  await encerrarAtendimento(contactId, 'datacrazy');
  await assert.rejects(enviar(contactId, { opcao: { menuId: menuB.id, opcaoId: 'op0' } }, log), /não está mais disponível/);
  await enviar(contactId, { texto: 'repetição', clienteId: 'primeira' }, log);
  assert.equal((await db.umaLinha("select count(*)::int as n from atendimentos where status='aberto'")).n, 0);
  await db.query('update alunos set dc_conversation_id=$2 where contact_id=$1', [contactId, 'conversa-teste']);
  const limpeza = jobFinalizarNoDataCrazy({ contactId, atendimentoId: menuB.atendimento_id, por: 'datacrazy' }, log);
  await controleRecebido;
  const proxima = await enviar(contactId, { texto: 'Novo atendimento', clienteId: randomUUID() }, log);
  assert.equal(proxima.status, 'pendente', 'não iniciar antes de cancelar a espera antiga');
  assert.equal(recebidas.at(-1).text.body, 'Atendimento encerrado');
  liberarEncerramento();
  await limpeza;
  assert.ok((await db.umaLinha('select * from atendimentos where id=$1', [menuB.atendimento_id])).dc_encerramento_concluido_em);
  await jobEnviarMensagem({ mensagemId: proxima.id });
  assert.equal(recebidas.at(-1).novo_atendimento, 'sim');
  console.log('OK: histórico, menus antigos, humano, encerramento confirmado antes do reinício');

  await db.query("update faculdades set menus_crm=true where slug='teste'");
  invalidarCacheFaculdades();
  const velhaCRM = await responder(contactId, { texto: 'Menu anterior sem marcações', dcMessageId: 'crm-antigo' });
  const atualCRM = await responder(contactId, { texto: 'Escolha seu setor', dcMessageId: 'crm-atual' });
  historicoCRM = { messages: [{ id: 'crm-atual', received: false, isInternal: false,
    buttons: [{ name: 'Secretaria', url: null }, { name: 'Atendimento encerrado', url: null }] }], histories: [] };
  await jobSincronizarMenu({ mensagemId: velhaCRM.id });
  assert.equal(consultasCRM, 0, 'job superado termina sem consulta');
  await jobSincronizarMenu({ mensagemId: atualCRM.id });
  assert.equal(consultasCRM, 1);
  const lidaCRM = await db.umaLinha('select * from mensagens where id=$1', [atualCRM.id]);
  assert.equal(lidaCRM.texto, 'Escolha seu setor');
  assert.deepEqual(lidaCRM.menu.opcoes, [{ id: 'op0', texto: 'Secretaria' }]);
  assert.equal((await db.umaLinha('select * from atendimentos where id=$1', [atualCRM.atendimento_id])).menu_mensagem_id, atualCRM.id);
  await enviar(contactId, { texto: 'adulterado', opcao: { menuId: atualCRM.id, opcaoId: 'op0' } }, log);
  assert.equal(recebidas.at(-1).text.body, 'Secretaria');
  await jobSincronizarMenu({ mensagemId: atualCRM.id });
  assert.equal(consultasCRM, 1, 'enriquecimento idempotente dispensa outra consulta');
  assert.equal((await db.umaLinha('select * from atendimentos where id=$1', [atualCRM.atendimento_id])).menu_mensagem_id, null);

  const tardia = await responder(contactId, { texto: 'Menu ainda não consultado', dcMessageId: 'crm-tardio' });
  await enviar(contactId, { texto: 'Resposta digitada antes da consulta' }, log);
  historicoCRM.messages = [{ id: 'crm-tardio', buttons: [{ name: 'Outra opção' }] }];
  await jobSincronizarMenu({ mensagemId: tardia.id });
  assert.ok((await db.umaLinha('select * from mensagens where id=$1', [tardia.id])).menu);
  assert.equal((await db.umaLinha('select * from atendimentos where id=$1', [tardia.atendimento_id])).menu_mensagem_id, null,
    'consulta atrasada preserva histórico sem reativar opções já respondidas');

  const humana = await responder(contactId, { texto: 'Mensagem após transferência', dcMessageId: 'crm-humano' });
  historicoCRM = { messages: [{ id: 'crm-humano', buttons: [{ name: 'Opção' }] }],
    histories: [{ historyCode: 'attendant-added', params: { attendantName: 'Ana' }, createdAt: new Date().toISOString() }] };
  await jobSincronizarMenu({ mensagemId: humana.id });
  assert.equal((await db.umaLinha('select * from mensagens where id=$1', [humana.id])).menu, null);
  assert.equal((await db.umaLinha('select * from atendimentos where id=$1', [humana.atendimento_id])).atendente, 'Ana');
  // Simula encerramento local; a sessão nativa é exercitada acima.
  await db.query("update atendimentos set status='encerrado', menu_mensagem_id=null, dc_encerramento_concluido_em=now() where id=$1", [humana.atendimento_id]);
  const consultasAntes = consultasCRM;
  await jobSincronizarMenu({ mensagemId: humana.id });
  assert.equal(consultasCRM, consultasAntes, 'atendimento encerrado não consulta menus');
  await db.query("update faculdades set menus_crm=false where slug='teste'");
  invalidarCacheFaculdades();
  console.log('OK: botões sem marcação, consulta compartilhada com identificação humana, menus superados/respondidos/encerrados protegidos');
  // Exercita a rota HTTP real: normalização, persistência, menu e rejeição.
  const reserva = createServer();
  await new Promise(resolve => reserva.listen(0, '127.0.0.1', resolve));
  const porta = reserva.address().port;
  await new Promise(resolve => reserva.close(resolve));
  const apiBase = `http://127.0.0.1:${porta}`;
  apiServidor = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: String(porta), PUBLIC_URL: apiBase, LOG_LEVEL: 'silent' },
    stdio: 'ignore',
  });
  let pronta = false;
  for (let i = 0; i < 100; i++) {
    if (apiServidor.exitCode != null) throw new Error('API de teste terminou antes da saúde');
    try { pronta = (await fetch(apiBase + '/health')).ok; } catch {}
    if (pronta) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(pronta, 'API local precisa iniciar');
  for (const [dcMessageId, text] of [['http-legado', 'Resposta antiga'], ['http-estruturado', { body: 'Escolha\n▸ Secretaria' }], ['http-anexo', { body: '' }]]) {
    const resposta = await fetch(apiBase + '/dc/teste/send', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'chave-teste' },
      body: JSON.stringify({ contactId, dcMessageId, text,
        ...(dcMessageId === 'http-anexo' ? { attachmentUrl: 'https://teste.invalid/f.pdf', mimeType: 'application/pdf', filename: 'f.pdf' } : {}) }) });
    assert.equal(resposta.status, 200);
    const gravada = await db.umaLinha('select * from mensagens where dc_message_id=$1', [dcMessageId]);
    assert.equal(gravada.texto, typeof text === 'string' ? text : text.body);
    if (dcMessageId === 'http-estruturado') assert.equal(gravada.menu.opcoes[0].texto, 'Secretaria');
    if (dcMessageId === 'http-anexo') assert.equal(gravada.anexo_nome, 'f.pdf');
  }
  const invalida = await fetch(apiBase + '/dc/teste/send', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'chave-teste' },
    body: JSON.stringify({ contactId, dcMessageId: 'http-invalido', text: { body: {} } }) });
  assert.equal(invalida.status, 400);
  assert.equal(await db.umaLinha('select id from mensagens where dc_message_id=$1', ['http-invalido']), null);
  console.log('OK: callback HTTP legado/estruturado, menu e anexo persistidos; payload inválido recusado');
} finally {
  liberarLead();
  liberarEncerramento();
  if (apiServidor && apiServidor.exitCode == null) {
    const terminou = once(apiServidor, 'exit');
    apiServidor.kill('SIGTERM');
    await terminou;
  }
  await db?.pool.end();
  await new Promise(resolve => crm.close(resolve));
  await admin.query(`drop database ${nomeBanco}`);
  await admin.end();
}
