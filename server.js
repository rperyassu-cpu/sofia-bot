const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────
const ENV = {
  ZAPI_INSTANCE_ID:   process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN:         process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN:  process.env.ZAPI_CLIENT_TOKEN,
  ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY,
  CHATWOOT_URL:       process.env.CHATWOOT_URL,       // ex: http://187.77.243.87:3000
  CHATWOOT_TOKEN:     process.env.CHATWOOT_TOKEN,     // Access Token
  CHATWOOT_ACCOUNT:   process.env.CHATWOOT_ACCOUNT,   // Account ID (1)
  CHATWOOT_INBOX:     process.env.CHATWOOT_INBOX,     // Inbox ID (1)
  PORT: process.env.PORT || 3000,
};

// ─── CARREGA sofia-config.json ────────────────────────────────────
function loadConfig() {
  const configPath = path.join(__dirname, 'sofia-config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ─── MONTA SYSTEM PROMPT ──────────────────────────────────────────
function buildSystemPrompt(cfg) {
  const c = cfg.clinica;
  const s = cfg.sofia;

  const consultorios = cfg['consultórios'].map(co => {
    const horarios = Object.entries(co.horarios)
      .map(([dia, hr]) => `    ${dia}: ${hr}`).join('\n');
    return `  • ${co.nome}: ${co.endereço} (CEP ${co.cep})\n    Tel: ${co.telefone}\n    Horários:\n${horarios}`;
  }).join('\n\n');

  const servicos = Object.entries(cfg.servicos).map(([area, lista]) =>
    `  ${area.charAt(0).toUpperCase() + area.slice(1)}: ${lista.join(', ')}`
  ).join('\n');

  const faqs = cfg.perguntas_frequentes.map((faq, i) =>
    `  ${i + 1}. P: "${faq.pergunta}"\n     R: "${faq.resposta}"`
  ).join('\n');

  const urgencias  = cfg.sinais_urgencia.map(u => `  - ${u}`).join('\n');
  const instrucoes = s.instrucoes_gerais.map(i => `  • ${i}`).join('\n');
  const proibidas  = s.frases_proibidas.map(f => `  • "${f}"`).join('\n');

  return `Você é ${s.nome}, a secretária virtual ${s.tom} do consultório do ${c.nome_doutor}, ${c.especialidade} com mais de ${c.anos_experiencia} anos de experiência no Rio de Janeiro.

━━━ CONSULTÓRIOS ━━━
${consultorios}

━━━ SERVIÇOS OFERECIDOS ━━━
${servicos}

━━━ PERGUNTAS FREQUENTES (use estas respostas exatas) ━━━
${faqs}

━━━ SINAIS DE URGÊNCIA ━━━
Se o paciente mencionar qualquer um dos itens abaixo, responda com a mensagem de urgência:
${urgencias}
Mensagem de urgência: "${cfg.mensagem_urgencia}"

━━━ SUAS INSTRUÇÕES ━━━
${instrucoes}

━━━ FRASES QUE VOCÊ JAMAIS DEVE USAR ━━━
${proibidas}

━━━ AGENDAMENTO ━━━
Sempre direcione para: WhatsApp ${c.whatsapp_agendamento}
Instagram: ${c.instagram} | Site: ${c.site}`;
}

// ─── MEMÓRIA DE CONVERSAS (TTL 2h) ───────────────────────────────
const conversationHistory = new Map();
const HISTORY_TTL = 2 * 60 * 60 * 1000;

function getHistory(phone) {
  const entry = conversationHistory.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.timestamp > HISTORY_TTL) { conversationHistory.delete(phone); return []; }
  return entry.messages;
}

function saveHistory(phone, messages) {
  conversationHistory.set(phone, { messages, timestamp: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of conversationHistory.entries())
    if (now - entry.timestamp > HISTORY_TTL) conversationHistory.delete(phone);
}, 30 * 60 * 1000);

// ─── CHATWOOT API ─────────────────────────────────────────────────
const chatwootHeaders = () => ({
  'api_access_token': ENV.CHATWOOT_TOKEN,
  'Content-Type': 'application/json',
});

// Busca ou cria contato no Chatwoot
async function getOrCreateContact(phone, name) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  try {
    const search = await axios.get(`${base}/contacts/search?q=${phone}`, { headers: chatwootHeaders() });
    const found = search.data.payload?.find(c => c.phone_number?.replace(/\D/g,'').endsWith(phone.replace(/\D/g,'').slice(-8)));
    if (found) return found.id;
  } catch {}

  const created = await axios.post(`${base}/contacts`, {
    name: name || phone,
    phone_number: `+${phone}`,
    inbox_id: Number(ENV.CHATWOOT_INBOX),
  }, { headers: chatwootHeaders() });
  return created.data.id;
}

// Busca conversa aberta ou cria nova
async function getOrCreateConversation(contactId, phone) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  try {
    const convs = await axios.get(`${base}/contacts/${contactId}/conversations`, { headers: chatwootHeaders() });
    const open = convs.data.payload?.find(c => c.status === 'open' && c.inbox_id === Number(ENV.CHATWOOT_INBOX));
    if (open) return { id: open.id, assignedHuman: !!open.meta?.assignee };
  } catch {}

  const created = await axios.post(`${base}/conversations`, {
    contact_id: contactId,
    inbox_id: Number(ENV.CHATWOOT_INBOX),
    additional_attributes: { phone },
  }, { headers: chatwootHeaders() });
  return { id: created.data.id, assignedHuman: false };
}

// Registra mensagem do paciente no Chatwoot
async function registerIncomingMessage(conversationId, message) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  await axios.post(`${base}/conversations/${conversationId}/messages`, {
    content: message,
    message_type: 'incoming',
    private: false,
  }, { headers: chatwootHeaders() });
}

// Envia resposta da Sofia como mensagem de saída no Chatwoot
async function registerOutgoingMessage(conversationId, message) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  await axios.post(`${base}/conversations/${conversationId}/messages`, {
    content: message,
    message_type: 'outgoing',
    private: false,
  }, { headers: chatwootHeaders() });
}

// Verifica se há agente humano atribuído à conversa
async function hasHumanAgent(conversationId) {
  try {
    const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
    const res = await axios.get(`${base}/conversations/${conversationId}`, { headers: chatwootHeaders() });
    return !!res.data.meta?.assignee;
  } catch { return false; }
}

// ─── CLAUDE AI ────────────────────────────────────────────────────
async function askClaude(phone, userMessage) {
  const cfg = loadConfig();
  const systemPrompt = buildSystemPrompt(cfg);
  const history = getHistory(phone);
  history.push({ role: 'user', content: userMessage });

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: systemPrompt, messages: history },
    { headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  const reply = response.data.content.map(b => b.text || '').join('');
  history.push({ role: 'assistant', content: reply });
  saveHistory(phone, history.length > 40 ? history.slice(-40) : history);
  return reply;
}

// ─── ENVIAR MENSAGEM VIA Z-API ────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const url = `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_TOKEN}/send-text`;
  await axios.post(url, { phone, message }, { headers: { 'Client-Token': ENV.ZAPI_CLIENT_TOKEN } });
}

// ─── WEBHOOK PRINCIPAL (Z-API → Sofia → Chatwoot) ────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.fromMe) return;
    if (body.type !== 'ReceivedCallback') return;
    if (!body.text?.message) return;

    const phone   = body.phone;
    const message = body.text.message.trim();
    const name    = body.senderName || phone;

    console.log(`[IN] ${phone}: ${message}`);

    // 1. Registra contato e conversa no Chatwoot
    const contactId = await getOrCreateContact(phone, name);
    const { id: conversationId, assignedHuman } = await getOrCreateConversation(contactId, phone);

    // 2. Registra mensagem do paciente no Chatwoot
    await registerIncomingMessage(conversationId, message);

    // 3. Verifica se agente humano está atendendo
    const humanAttending = assignedHuman || await hasHumanAgent(conversationId);
    if (humanAttending) {
      console.log(`[SKIP] ${phone}: agente humano atendendo, Sofia não responde.`);
      return;
    }

    // 4. Sofia responde
    const reply = await askClaude(phone, message);
    console.log(`[OUT] ${phone}: ${reply}`);

    // 5. Envia pelo WhatsApp
    await sendWhatsApp(phone, reply);

    // 6. Registra resposta da Sofia no Chatwoot
    await registerOutgoingMessage(conversationId, reply);

  } catch (err) {
    console.error('[ERRO]', err.response?.data || err.message);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const cfg = loadConfig();
    res.json({ status: 'Sofia online ✅', clinica: cfg.clinica.nome_doutor, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'Erro ❌', error: e.message });
  }
});

app.listen(ENV.PORT, () => {
  console.log(`🤖 Sofia rodando na porta ${ENV.PORT}`);
  console.log(`💬 Chatwoot: ${ENV.CHATWOOT_URL}`);
});
