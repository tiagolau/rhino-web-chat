// A navegação pertence à sessão nativa do DataCrazy (ADR 007). Os IDs
// identificam as opções de UMA mensagem; o servidor envia o rótulo validado.
export function extrairMenu(texto, mensagemId) {
  const linhas = String(texto || "").trimEnd().split("\n");
  const opcoes = [];
  while (linhas.length && /^\s*▸\s*/.test(linhas.at(-1))) {
    const valor = linhas.pop().replace(/^\s*▸\s*/, "").trim();
    if (!valor || valor.length > 300 || opcoes.length >= 30) return null;
    opcoes.unshift(valor);
  }
  return opcoes.length ? { id: mensagemId, opcoes: opcoes.map((texto, i) => ({ id: `op${i}`, texto })) } : null;
}

// A REST guarda os nomes dos botões; URLs são links, não respostas da sessão.
export function menuDaMensagemCRM(mensagem, mensagemId, ocultarControle = false) {
  if (mensagem.received || mensagem.isInternal || mensagem.attendant?.name || mensagem.signature) return null;
  if (!Array.isArray(mensagem.buttons) || mensagem.buttons.length > 30) return null;
  const rotulos = [];
  for (const botao of mensagem.buttons) {
    if (!botao || typeof botao.name !== "string") return null;
    if (botao.url) continue;
    const texto = botao.name.trim();
    if (ocultarControle && texto === "Atendimento encerrado") continue;
    if (!texto || texto.length > 300 || rotulos.includes(texto)) return null;
    rotulos.push(texto);
  }
  return rotulos.length ? { id: mensagemId, opcoes: rotulos.map((texto, i) => ({ id: `op${i}`, texto })) } : null;
}

export function escolherOpcao(menu, escolha, texto) {
  if (!menu) {
    if (escolha) throw new Error("Este menu não está mais disponível. Atualize o atendimento.");
    return null;
  }
  if (escolha) {
    if (escolha.menuId !== menu.id || typeof escolha.opcaoId !== "string") {
      throw new Error("Este menu não está mais disponível. Atualize o atendimento.");
    }
    const opcao = menu.opcoes.find(o => o.id === escolha.opcaoId);
    if (!opcao) throw new Error("Opção inválida para este menu.");
    return opcao;
  }
  // Clientes antigos e respostas digitadas, sempre no menu atual.
  return menu.opcoes.find(o => o.texto === String(texto || "").trim()) || null;
}
