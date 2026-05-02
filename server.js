const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────
const ENV = {
  ZAPI_INSTANCE_ID:  process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN:        process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3000,
};

// ─── CARREGA sofia-config.json (recarrega a cada mensagem) ────────
function loadConfig() {
  const configPath = path.join(__dirname, 'sofia-config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

// ─── MONTA SYSTEM PROMPT A PARTIR DO CONFIG ───────────────────────
function buildSystemPrompt(cfg) {
  const c = cfg.clinica;
  const s = cfg.sofia;

  const consultorios = cfg['consultórios'].map(co => {
    const horarios = Object.entries(co.horarios)
      .map(([dia, hr]) => `    ${dia}: ${hr}`)
      .join('\n');
    return `  • ${co.nome}: ${co.endereço} (CEP ${co.cep})\n    Tel: ${co.telefone}\n    Horários:\n${horarios}`;
  }).join('\n\n');

  const servicos = Object.entries(cfg.servicos).map(([area, lista]) =>
    `  ${area.charAt(0).toUpperCase() + area.slice(1)}: ${lista.join(', ')}`
  ).join('\n');

  const faqs = cfg.perguntas_frequentes.map((faq, i) =>
    `  ${i + 1}. P: "${faq.pergunta}"\n     R: "${faq.resposta}"`
  ).join('\n');

  const urgencias = cfg.sinais_urgencia.map(u => `  - ${u}`).join('\n');
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

Mensagem de urgência a usar:
"${cfg.mensagem_urgencia}"

━━━ SUAS INSTRUÇÕES ━━━
${instrucoes}

━━━ FRASES QUE VOCÊ JAMAIS DEVE USAR ━━━
${proibidas}

━━━ AGENDAMENTO ━━━
Sempre direcione para: WhatsApp ${c.whatsapp_agendamento}
Instagram: ${c.instagram}
Site: ${c.site}`;
}

// ─── MEMÓRIA DE CONVERSAS (TTL 2h) ───────────────────────────────
const conversationHistory = new Map();
const HISTORY_TTL = 2 * 60 * 60 * 1000;

function getHistory(phone) {
  const entry = conversationHistory.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.timestamp > HISTORY_TTL) {
    conversationHistory.delete(phone);
    return [];
  }
  return entry.messages;
}

function saveHistory(phone, messages) {
  conversationHistory.set(phone, { messages, timestamp: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of conversationHistory.entries()) {
    if (now - entry.timestamp > HISTORY_TTL) conversationHistory.delete(phone);
  }
}, 30 * 60 * 1000);

// ─── CLAUDE AI ────────────────────────────────────────────────────
async function askClaude(phone, userMessage) {
  const cfg = loadConfig(); // recarrega a cada mensagem → edite o JSON e já vale!
  const systemPrompt = buildSystemPrompt(cfg);

  const history = getHistory(phone);
  history.push({ role: 'user', content: userMessage });

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: history,
    },
    {
      headers: {
        'x-api-key': ENV.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const reply = response.data.content.map(b => b.text || '').join('');
  history.push({ role: 'assistant', content: reply });
  const trimmed = history.length > 40 ? history.slice(-40) : history;
  saveHistory(phone, trimmed);

  return reply;
}

// ─── ENVIAR MENSAGEM VIA Z-API ────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const url = `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_TOKEN}/send-text`;
  await axios.post(
    url,
    { phone, message },
    { headers: { 'Client-Token': ENV.ZAPI_CLIENT_TOKEN } }
  );
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.fromMe) return;
    if (body.type !== 'ReceivedCallback') return;
    if (!body.text?.message) return;

    const phone   = body.phone;
    const message = body.text.message.trim();
    console.log(`[IN]  ${phone}: ${message}`);

    const reply = await askClaude(phone, message);
    console.log(`[OUT] ${phone}: ${reply}`);

    await sendWhatsApp(phone, reply);
  } catch (err) {
    console.error('[ERRO]', err.response?.data || err.message);
  }
});

// ─── ROTA: validar config manualmente ────────────────────────────
app.post('/reload-config', (req, res) => {
  try {
    loadConfig();
    res.json({ ok: true, message: 'Config válida e recarregada ✅' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  try {
    const cfg = loadConfig();
    res.json({
      status: 'Sofia online ✅',
      clinica: cfg.clinica.nome_doutor,
      consultorios: cfg['consultórios'].map(c => c.nome),
      faqs: cfg.perguntas_frequentes.length,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ status: 'Erro ao carregar config ❌', error: e.message });
  }
});

app.listen(ENV.PORT, () => {
  console.log(`🤖 Sofia rodando na porta ${ENV.PORT}`);
  console.log(`📋 Config: sofia-config.json`);
});
