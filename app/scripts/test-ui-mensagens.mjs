// Regressão: o eco chega antes do ack (e pode provocar recarga do histórico).
// npm run test:ui — tudo simulado, sem banco, CRM ou credenciais.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

let widget;
if (process.env.WEBCHAT_WIDGET_URL) {
  const resposta = await fetch(process.env.WEBCHAT_WIDGET_URL);
  assert.equal(resposta.status, 200);
  widget = Buffer.from(await resposta.arrayBuffer());
} else {
  widget = await readFile(new URL('../public/widget.js', import.meta.url));
}
const servidor = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/widget.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(req.url === '/widget.js' ? widget : '<!doctype html><meta charset="utf-8"><script src="/widget.js" data-modo="pagina" defer></script>');
});
await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));
let navegador;
try {
  navegador = await chromium.launch({ headless: true });
  // eco primeiro / ack primeiro, mensagem em atendimento existente / primeiro envio,
  // anexo e duas mensagens iguais em sequência (não devem ser fundidas pelo texto).
  for (const cenario of ['eco-primeiro', 'ack-primeiro', 'novo-atendimento', 'anexo', 'textos-iguais']) {
    const pagina = await navegador.newPage();
    const erros = [];
    pagina.on('pageerror', erro => erros.push(erro.message));
    await pagina.addInitScript(() => localStorage.setItem('rhino_webchat_tokens', JSON.stringify({ pagina: 'teste' })));
    let atendimento = cenario === 'novo-atendimento' ? null : { id: 'at1', numero: 1, status: 'aberto' };
    const mensagens = [];
    const aguardando = [];
    let numero = 0;
    await pagina.route('**/api/**', async rota => {
      const caminho = new URL(rota.request().url()).pathname;
      let dados;
      if (caminho === '/api/sessao') dados = { token: 'teste', aluno: { nome: 'Aluno' }, faculdade: { nome: 'Faculdade teste' } };
      else if (caminho === '/api/historico') dados = { atendimento, mensagens };
      else if (caminho === '/api/arquivos') dados = { token: 'arquivo' };
      else throw new Error('Rota inesperada: ' + caminho);
      await rota.fulfill({ json: dados });
    });
    await pagina.routeWebSocket('**/ws?*', socket => {
      socket.onMessage(bruto => {
        const envio = JSON.parse(bruto);
        const nova = !atendimento;
        atendimento = atendimento || { id: 'at1', numero: 1, status: 'aberto' };
        const mensagem = {
          id: 'm' + ++numero, clienteId: envio.clienteId, atendimentoId: atendimento.id,
          direcao: 'aluno', texto: envio.texto || '', status: 'enviada', criadaEm: new Date().toISOString(),
          anexo: envio.arquivo ? { url: 'https://example.com/teste.pdf', tipo: 'application/pdf', nome: 'teste.pdf' } : null,
        };
        mensagens.push(mensagem);
        const ack = () => socket.send(JSON.stringify({ tipo: 'ack', clienteId: envio.clienteId, mensagem }));
        const eco = () => socket.send(JSON.stringify({ tipo: 'mensagem', mensagem: process.env.SIMULAR_ECO_SEM_ID ? { ...mensagem, clienteId: null } : mensagem }));
        if (cenario === 'ack-primeiro') { ack(); aguardando.push(eco); }
        else { eco(); aguardando.push(ack); }
        // No primeiro envio o eco força o caminho de recarga do histórico.
        if (nova) socket.send(JSON.stringify({ tipo: 'atendimento', atendimento }));
      });
    });
    await pagina.goto(`http://127.0.0.1:${servidor.address().port}`);
    await pagina.getByRole('textbox', { name: 'Mensagem', exact: true }).waitFor();
    for (let i = 0; i < (cenario === 'textos-iguais' ? 2 : 1); i++) {
      if (cenario === 'anexo') {
        await pagina.locator('input[type=file]').setInputFiles({ name: 'teste.pdf', mimeType: 'application/pdf', buffer: Buffer.from('teste') });
      } else {
        await pagina.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Mesma mensagem');
        await pagina.getByRole('button', { name: 'Enviar', exact: true }).click();
      }
      // Confere durante a espera do ack, não só depois que o duplicado sumiria.
      await pagina.waitForFunction(n => [...document.querySelector('#rhino-webchat').shadowRoot.querySelectorAll('.msg.aluno .meta')].filter(m => m.textContent !== 'enviando…').length === n, i + 1);
      assert.equal(await pagina.locator('.msg.aluno').count(), i + 1, `${cenario}: duplicou antes da confirmação`);
      assert.equal(aguardando.length, i + 1);
    }
    aguardando.forEach(retorno => retorno());
    await pagina.waitForTimeout(80);
    assert.equal(await pagina.locator('.msg.aluno').count(), mensagens.length, `${cenario}: duplicou após confirmação`);
    if (cenario === 'anexo') assert.equal(await pagina.getByRole('link', { name: 'teste.pdf' }).count(), 1);
    assert.deepEqual(erros, []);
    console.log('OK:', cenario);
    await pagina.close();
  }
} finally {
  await navegador?.close();
  await new Promise(resolve => servidor.close(resolve));
}
