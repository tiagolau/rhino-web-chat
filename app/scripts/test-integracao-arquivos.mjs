// Postgres descartável e CRM/CDN simulados, sem credenciais reais.
import pg from 'pg';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const adminUrl = process.env.POSTGRES_TEST_ADMIN_URL || 'postgresql://localhost/postgres';
const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
const banco = `webchat_arquivos_${Date.now()}`; await admin.query(`create database ${banco}`);
const dbUrl = new URL(adminUrl); dbUrl.pathname = '/' + banco;
const pasta = await mkdtemp(join(tmpdir(), 'rhino-arquivos-'));
let uploads = 0, posts = 0, corromper = false, perderResposta = false, falharUpload = false;
let bloquearUpload, avisarUpload;
const objetos = new Map(), registros = [];
const crm = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const pedacos = []; for await (const p of req) pedacos.push(p);
  const corpo = Buffer.concat(pedacos); res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && url.pathname.includes('/files/upload/file/')) {
    assert.equal(req.headers.authorization, 'Bearer token-ficticio');
    assert.ok(req.headers['user-agent'].includes('Mozilla'));
    if (falharUpload) { res.statusCode = 503; return res.end('{}'); }
    uploads++; if (avisarUpload) { avisarUpload(); await bloquearUpload; }
    const boundary = req.headers['content-type'].split('boundary=')[1];
    const inicio = corpo.indexOf('\r\n\r\n') + 4;
    const fim = corpo.lastIndexOf(Buffer.from('\r\n--' + boundary));
    const caminho = '/tenant/lead-attachments/' + randomUUID(); objetos.set(caminho, corpo.subarray(inicio, fim));
    res.statusCode = 201; return res.end(JSON.stringify({ url: base + caminho }));
  }
  if (req.method === 'GET' && objetos.has(url.pathname)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.end(corromper ? Buffer.from('corrompido') : objetos.get(url.pathname));
  }
  if (url.pathname.endsWith('/attachments')) {
    assert.equal(req.headers.authorization, 'Bearer token-ficticio');
    if (req.method === 'GET') return res.end(JSON.stringify({ data: registros }));
    posts++; const dados = JSON.parse(corpo.toString()); assert.equal(typeof dados.fileSize, 'number');
    const registro = { id: randomUUID(), ...dados }; registros.push(registro);
    if (perderResposta) { perderResposta = false; res.statusCode = 503; return res.end('{}'); }
    res.statusCode = 201; return res.end(JSON.stringify(registro));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise(r => crm.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${crm.address().port}`;
Object.assign(process.env, { DATABASE_URL: dbUrl.href, SESSION_SECRET: 'teste', CPF_PEPPER: 'teste', CPF_ENC_KEY: 'ab'.repeat(32),
  DATACRAZY_API_TOKEN: 'token-ficticio', DC_REST_PER_MINUTE: '10000', DATACRAZY_API_BASE: base,
  DATACRAZY_UPLOAD_BASE: base, DATACRAZY_CDN_BASE: base, ANEXOS_NO_CRM: 'true', FILES_DIR: pasta });
const log = { info() {}, warn() {}, error() {} }; let db, api;
try {
  db = await import('../src/db.js'); await db.migrar(log);
  const { jobTransferirArquivo: transferir, agendarTransferencias } = await import('../src/arquivos-crm.js');
  const { validarUrlDoCdn } = await import('../src/datacrazy.js');
  assert.throws(() => validarUrlDoCdn('https://externo.example/tenant/lead-attachments/x'));
  await db.query(`insert into faculdades(slug,nome,rodape,instance_id,webhook_url,webhook_secret,api_key)
    values('teste','Teste','Teste','instancia',$1,'segredo','chave')`, [base]);
  await db.query(`insert into alunos(contact_id,faculdade,cpf_hash,cpf_cifrado,nome)
    values('aluno','teste','hash','cifra','Aluno fictício')`);
  async function arquivo(conteudo = Buffer.from('conteudo sintético')) {
    const token = randomBytes(32).toString('base64url'); await writeFile(join(pasta, token), conteudo);
    await db.query(`insert into arquivos(token,contact_id,nome,mime,tamanho) values($1,'aluno','teste.txt','text/plain',$2)`, [token, conteudo.length]);
    return { token, conteudo };
  }
  const primeiro = await arquivo(); await assert.rejects(transferir(primeiro, log), /vínculo/);
  assert.deepEqual(await readFile(join(pasta, primeiro.token)), primeiro.conteudo);
  await db.query("update alunos set lead_id='lead-teste'"); await transferir(primeiro, log);
  let row = await db.umaLinha('select * from arquivos where token=$1', [primeiro.token]);
  assert.ok(row.crm_verificado_em && row.crm_anexo_id && row.local_removido_em);
  await assert.rejects(access(join(pasta, primeiro.token)), { code: 'ENOENT' });
  const totalUploads = uploads; await transferir(primeiro, log); assert.equal(uploads, totalUploads);
  console.log('OK: vínculo obrigatório, upload, integridade, registro e remoção idempotente');
  const segundo = await arquivo(); corromper = true;
  await assert.rejects(transferir(segundo, log), /diverge|excede/);
  row = await db.umaLinha('select * from arquivos where token=$1', [segundo.token]); assert.ok(row.crm_url); assert.equal(row.crm_verificado_em, null);
  assert.deepEqual(await readFile(join(pasta, segundo.token)), segundo.conteudo);
  const antesRetry = uploads; corromper = false; perderResposta = true;
  await assert.rejects(transferir(segundo, log), /503/); await access(join(pasta, segundo.token));
  const antesPosts = posts; await transferir(segundo, log); assert.equal(uploads, antesRetry); assert.equal(posts, antesPosts);
  console.log('OK: corrupção preserva origem; retry reaproveita upload e registro com resposta perdida');
  const terceiro = await arquivo(); falharUpload = true;
  await assert.rejects(transferir(terceiro, log), /503/); await access(join(pasta, terceiro.token)); falharUpload = false;
  let liberar; bloquearUpload = new Promise(r => { liberar = r; }); const aguardando = new Promise(r => { avisarUpload = r; });
  const emCurso = transferir(terceiro, log); await aguardando;
  await assert.rejects(transferir(terceiro, log), /outra réplica/); liberar(); await emCurso; avisarUpload = null;
  console.log('OK: falha preserva arquivo; réplicas não transferem simultaneamente');
  const antigo = await arquivo(Buffer.alloc(1024 * 1024, 7));
  await db.query("update arquivos set created_at=now()-interval '4 days' where token=$1", [antigo.token]); await agendarTransferencias();
  assert.ok(await db.umaLinha("select * from jobs where tipo='transferir_arquivo' and chave=$1", [antigo.token])); await transferir(antigo, log);
  const porta = await new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const apiBase = `http://127.0.0.1:${porta}`;
  api = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(porta), PUBLIC_URL: apiBase, LOG_LEVEL: 'silent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let erros = ''; api.stderr.on('data', p => { erros += p; });
  let saudavel = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(apiBase + '/health')).ok) { saudavel = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(saudavel, erros);
  const caminho = apiBase + '/f/' + antigo.token + '/teste.txt';
  assert.equal((await fetch(caminho, { redirect: 'manual' })).status, 302);
  assert.deepEqual(Buffer.from(await (await fetch(caminho)).arrayBuffer()), antigo.conteudo);
  const dispositivo = randomUUID(); await db.query("insert into dispositivos(id,contact_id) values($1,'aluno')", [dispositivo]);
  const { emitirToken } = await import('../src/identidade.js');
  const form = new FormData(); form.append('file', new Blob(['upload HTTP'], { type: 'text/plain' }), 'http.txt');
  const up = await fetch(apiBase + '/api/arquivos', { method: 'POST', headers: { Authorization: 'Bearer ' + emitirToken({ contactId: 'aluno', dispositivo }) }, body: form });
  assert.equal(up.status, 200); const novo = await up.json();
  assert.ok(await db.umaLinha("select * from jobs where tipo='transferir_arquivo' and chave=$1", [novo.token]));
  for (let i = 0; i < 100; i++) { if ((await db.umaLinha('select local_removido_em from arquivos where token=$1', [novo.token]))?.local_removido_em) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok((await db.umaLinha('select local_removido_em from arquivos where token=$1', [novo.token])).local_removido_em);
  assert.equal(await (await fetch(apiBase + '/f/' + novo.token + '/http.txt')).text(), 'upload HTTP');
  console.log('OK: antigo migrado, /f/ preservado e upload HTTP transferido pelo consumidor');
} finally {
  if (api && api.exitCode === null) { api.kill('SIGTERM'); await new Promise(r => api.once('exit', r)); }
  if (db) await db.pool.end(); await new Promise(r => crm.close(r));
  await rm(pasta, { recursive: true, force: true }); await admin.query(`drop database ${banco} with (force)`); await admin.end();
}
