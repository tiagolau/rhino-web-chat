// Configuração lida do ambiente. Variáveis obrigatórias derrubam o processo na
// subida, com mensagem clara, em vez de falhar no meio de uma conversa.

function obrigatoria(nome) {
  const valor = process.env[nome];
  if (!valor) throw new Error(`variável de ambiente ${nome} é obrigatória`);
  return valor;
}

function chaveHex(nome, bytes) {
  const buf = Buffer.from(obrigatoria(nome), "hex");
  if (buf.length !== bytes) throw new Error(`${nome} precisa ter ${bytes} bytes em hex (${bytes * 2} caracteres)`);
  return buf;
}

const lista = (valor) => (valor || "").split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  databaseUrl: obrigatoria("DATABASE_URL"),

  // Assina o token do navegador (sessão + dispositivo).
  sessionSecret: obrigatoria("SESSION_SECRET"),
  sessionDays: Number(process.env.SESSION_DAYS || 90),

  // CPF: hash para busca (HMAC com pepper) e cópia cifrada (AES-256-GCM) para
  // gravar no lead. Trocar qualquer um dos dois invalida os dados existentes.
  cpfPepper: obrigatoria("CPF_PEPPER"),
  cpfEncKey: chaveHex("CPF_ENC_KEY", 32),

  dcApiBase: (process.env.DATACRAZY_API_BASE || "https://api.g1.datacrazy.io").replace(/\/$/, ""),
  dcApiToken: obrigatoria("DATACRAZY_API_TOKEN"),
  dcUploadBase: (process.env.DATACRAZY_UPLOAD_BASE || "https://crm.g1.datacrazy.io").replace(/\/$/, ""),
  dcCdnBase: (process.env.DATACRAZY_CDN_BASE || "https://g1cdn1.datacrazy.io").replace(/\/$/, ""),
  // Orçamento por réplica. A REST tem 30 req/min por tenant, dividido com as
  // outras integrações do RJ Global; 2 réplicas x 10 deixam folga.
  dcRestPorMinuto: Number(process.env.DC_REST_PER_MINUTE || 10),

  // Origens que podem carregar o widget (portais Eduno). A própria PUBLIC_URL
  // (página /chat) é sempre aceita.
  allowedOrigins: lista(process.env.ALLOWED_ORIGINS),

  filesDir: process.env.FILES_DIR || "./data/files",
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 15),
  anexosNoCrm: process.env.ANEXOS_NO_CRM === "true",

  // Anti-abuso: o mesmo dispositivo ou IP alternando entre CPFs.
  // Computadores de laboratório/polo são compartilhados: não apertar demais.
  limiteCpfsPorDispositivo: Number(process.env.DEVICE_CPF_LIMIT || 3),
  limiteCpfsPorIpHora: Number(process.env.IP_CPF_LIMIT_PER_HOUR || 30),

  adminKey: process.env.ADMIN_API_KEY || "",
  logLevel: process.env.LOG_LEVEL || "info",
};
