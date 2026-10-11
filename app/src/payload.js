// Contrato da Conexão Universal. O texto interno do widget continua sendo string.
export function lerTexto(valor) {
  if (valor == null) return "";
  if (typeof valor === "string") return valor;
  if (typeof valor === "object" && !Array.isArray(valor) && typeof valor.body === "string") return valor.body;
  throw new TypeError("text deve ser uma string ou um objeto com body string");
}

export function montarPayloadWebhook(aluno, mensagem, textoEstruturado = true) {
  const texto = mensagem.texto || mensagem.anexo_nome || "";
  const payload = {
    message_id: mensagem.id,
    contact: { id: aluno.contact_id, name: aluno.nome },
    text: textoEstruturado ? { body: texto } : texto,
    timestamp: Math.floor(new Date(mensagem.created_at).getTime() / 1000),
    fromMe: false,
    novo_atendimento: mensagem.primeira ? "sim" : "nao",
    com_atendente: mensagem.atendente ? "sim" : "nao",
    atendimento_id: mensagem.atendimento_id,
    opcao_id: mensagem.opcao_id || "",
  };
  if (mensagem.anexo_url) payload.media = { url: mensagem.anexo_url, type: mensagem.anexo_tipo };
  return payload;
}
