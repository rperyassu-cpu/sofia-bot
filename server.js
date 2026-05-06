const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────
const ENV = {
  ZAPI_INSTANCE_ID:    process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN:          process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN:   process.env.ZAPI_CLIENT_TOKEN,
  ANTHROPIC_API_KEY:   process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL:     process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  CHATWOOT_URL:        process.env.CHATWOOT_URL,
  CHATWOOT_TOKEN:      process.env.CHATWOOT_TOKEN,
  CHATWOOT_ACCOUNT:    process.env.CHATWOOT_ACCOUNT,
  CHATWOOT_INBOX:      process.env.CHATWOOT_INBOX,
  SECRETARIA_PHONE:    process.env.SECRETARIA_PHONE || '5521996423139',
  HANDOFF_TIMEOUT_MIN: parseInt(process.env.HANDOFF_TIMEOUT_MIN || '5'),
  PORT: process.env.PORT || 3000,
};

// ─── HORÁRIO COMERCIAL DA SECRETARIA ─────────────────────────────
function isHorarioComercial() {
  const now = new Date();
  // Converte para horário de Brasília (UTC-3)
  const brasilia = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = brasilia.getHours();
  const dia  = brasilia.getDay(); // 0=Dom, 1=Seg ... 5=Sex, 6=Sab
  const diaUtil = dia >= 1 && dia <= 5;
  return diaUtil && hora >= 9 && hora < 18;
}

// ─── PALAVRAS QUE PEDEM ATENDENTE HUMANO ─────────────────────────
const PALAVRAS_HANDOFF = [
  'atendente', 'humano', 'pessoa', 'secretaria', 'secretária',
  'falar com alguém', 'quero falar', 'me liga', 'ligar',
  'urgente', 'emergência', 'emergencia', 'socorro',
  'não quero robô', 'nao quero robo', 'não é robô', 'nao e robo'
];

function detectaHandoff(message) {
  const lower = message.toLowerCase();
  return PALAVRAS_HANDOFF.some(palavra => lower.includes(palavra));
}

// ─── FILA DE HANDOFF (aguarda secretaria responder) ───────────────
const handoffQueue = new Map(); // phone -> { timer, conversationId, patientName, message }

function iniciarHandoff(phone, conversationId, patientName, message) {
  // Cancela timer anterior se existir
  if (handoffQueue.has(phone)) clearTimeout(handoffQueue.get(phone).timer);

  const timer = setTimeout(async () => {
    handoffQueue.delete(phone);
    console.log(`[HANDOFF TIMEOUT] ${phone}: secretaria não respondeu, Sofia retoma.`);
    // Sofia envia mensagem avisando que vai continuar ajudando
    const msg = 'Nossa secretária ainda não está disponível no momento. Mas pode continuar comigo, a Sofia! Vou te ajudar com o que precisar 😊';
    await sendWhatsApp(phone, msg);
    await registerMessage(conversationId, msg, 'outgoing');
  }, ENV.HANDOFF_TIMEOUT_MIN * 60 * 1000);

  handoffQueue.set(phone, { timer, conversationId, patientName, message });
}

function cancelarHandoff(phone) {
  if (handoffQueue.has(phone)) {
    clearTimeout(handoffQueue.get(phone).timer);
    handoffQueue.delete(phone);
  }
}

function estaEmHandoff(phone) {
  return handoffQueue.has(phone);
}

// ─── BANCO DE DADOS (MEMÓRIA PERSISTENTE) ─────────────────────────
const db = new Database(path.join(__dirname, 'sofia-memory.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS pacientes (
    phone TEXT PRIMARY KEY,
    nome TEXT,
    primeira_vez INTEGER DEFAULT 1,
    consultorio_preferido TEXT,
    ultima_queixa TEXT,
    procedimentos_interesse TEXT,
    total_conversas INTEGER DEFAULT 0,
    ultima_conversa TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS historico_conversas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    role TEXT,
    content TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );
`);

function getPaciente(phone) {
  return db.prepare('SELECT * FROM pacientes WHERE phone = ?').get(phone);
}

function upsertPaciente(phone, dados) {
  const existing = getPaciente(phone);
  if (!existing) {
    db.prepare(`INSERT INTO pacientes (phone, nome, primeira_vez, consultorio_preferido, ultima_queixa, procedimentos_interesse, total_conversas, ultima_conversa)
      VALUES (?, ?, 1, ?, ?, ?, 1, datetime('now'))`)
      .run(phone, dados.nome || null, dados.consultorio_preferido || null, dados.ultima_queixa || null, dados.procedimentos_interesse || null);
  } else {
    db.prepare(`UPDATE pacientes SET
        nome = COALESCE(?, nome),
        primeira_vez = 0,
        consultorio_preferido = COALESCE(?, consultorio_preferido),
        ultima_queixa = COALESCE(?, ultima_queixa),
        procedimentos_interesse = COALESCE(?, procedimentos_interesse),
        total_conversas = total_conversas + 1,
        ultima_conversa = datetime('now')
      WHERE phone = ?`)
      .run(dados.nome || null, dados.consultorio_preferido || null, dados.ultima_queixa || null, dados.procedimentos_interesse || null, phone);
  }
}

function getHistorico(phone, limit = 20) {
  return db.prepare(`SELECT role, content FROM historico_conversas WHERE phone = ? ORDER BY criado_em DESC LIMIT ?`)
    .all(phone, limit).reverse();
}

function saveHistorico(phone, role, content) {
  db.prepare('INSERT INTO historico_conversas (phone, role, content) VALUES (?, ?, ?)').run(phone, role, content);
  db.prepare(`DELETE FROM historico_conversas WHERE phone = ? AND id NOT IN (
    SELECT id FROM historico_conversas WHERE phone = ? ORDER BY criado_em DESC LIMIT 100
  )`).run(phone, phone);
}

// ─── CONFIG ───────────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'sofia-config.json'), 'utf-8'));
}

function buildSystemPrompt(cfg, paciente) {
  const c = cfg.clinica;
  const s = cfg.sofia;

  const consultorios = cfg['consultórios'].map(co => {
    const horarios = Object.entries(co.horarios).map(([dia, hr]) => `    ${dia}: ${hr}`).join('\n');
    return `  • ${co.nome}: ${co.endereço}\n    Tel: ${co.telefone}\n    Horários:\n${horarios}`;
  }).join('\n\n');

  const servicos = Object.entries(cfg.servicos).map(([area, lista]) =>
    `  ${area.charAt(0).toUpperCase() + area.slice(1)}: ${lista.join(', ')}`).join('\n');

  const faqs = cfg.perguntas_frequentes.map((faq, i) =>
    `  ${i + 1}. P: "${faq.pergunta}"\n     R: "${faq.resposta}"`).join('\n');

  const urgencias  = cfg.sinais_urgencia.map(u => `  - ${u}`).join('\n');
  const instrucoes = s.instrucoes_gerais.map(i => `  • ${i}`).join('\n');
  const proibidas  = s.frases_proibidas.map(f => `  • "${f}"`).join('\n');

  let memoriaBloco = '';
  if (paciente) {
    memoriaBloco = `
━━━ MEMÓRIA DO PACIENTE ━━━
• Nome: ${paciente.nome || 'Não informado ainda'}
• Primeira vez: ${paciente.primeira_vez ? 'Sim' : `Não (${paciente.total_conversas} conversa(s))`}
• Consultório preferido: ${paciente.consultorio_preferido || 'Não informado'}
• Última queixa: ${paciente.ultima_queixa || 'Não informada'}
• Procedimentos de interesse: ${paciente.procedimentos_interesse || 'Nenhum registrado'}
• Última conversa: ${paciente.ultima_conversa || 'Agora'}
USE estas informações para personalizar. Se souber o nome, use-o. Se já conhecer a queixa, pergunte se ainda persiste.`;
  }

  const horarioInfo = isHorarioComercial()
    ? 'A secretária humana está disponível agora (Seg-Sex 9h-18h). Se o paciente pedir atendente, informe que vamos transferir.'
    : 'Fora do horário comercial (Seg-Sex 9h-18h). Informe que a equipe retornará no próximo dia útil e que você pode ajudar agora.';

  return `Você é ${s.nome}, a secretária virtual ${s.tom} do consultório do ${c.nome_doutor}, ${c.especialidade}.
${memoriaBloco}

━━━ HORÁRIO ATUAL ━━━
${horarioInfo}

━━━ CONSULTÓRIOS ━━━
${consultorios}

━━━ SERVIÇOS ━━━
${servicos}

━━━ PERGUNTAS FREQUENTES ━━━
${faqs}

━━━ SINAIS DE URGÊNCIA ━━━
${urgencias}
Mensagem de urgência: "${cfg.mensagem_urgencia}"

━━━ SUAS INSTRUÇÕES ━━━
${instrucoes}
  • Tente descobrir naturalmente: nome, consultório preferido e queixa principal.

━━━ FRASES PROIBIDAS ━━━
${proibidas}

━━━ AGENDAMENTO ━━━
WhatsApp: ${c.whatsapp_agendamento} | Instagram: ${c.instagram} | Site: ${c.site}`;
}

// ─── CLAUDE AI ────────────────────────────────────────────────────
async function askClaude(phone, userMessage, senderName) {
  const cfg = loadConfig();
  const paciente = getPaciente(phone);
  const systemPrompt = buildSystemPrompt(cfg, paciente);

  saveHistorico(phone, 'user', userMessage);
  const history = getHistorico(phone);

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: ENV.ANTHROPIC_MODEL, max_tokens: 1000, system: systemPrompt, messages: history },
    { headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  const reply = response.data.content.map(b => b.text || '').join('');
  saveHistorico(phone, 'assistant', reply);

  // Extrai dados do paciente em background
  extrairDadosPaciente(phone, getHistorico(phone, 10)).then(dados => {
    if (dados && Object.keys(dados).length) upsertPaciente(phone, { ...dados, nome: dados.nome || senderName });
  }).catch(() => {});

  upsertPaciente(phone, { nome: senderName });
  return reply;
}

async function extrairDadosPaciente(phone, messages) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: ENV.ANTHROPIC_MODEL, max_tokens: 200,
        system: `Extraia dados do paciente da conversa. Responda APENAS em JSON válido:
{"nome":"primeiro nome ou null","consultorio_preferido":"Copacabana ou Barra da Tijuca ou null","ultima_queixa":"em até 10 palavras ou null","procedimentos_interesse":"separados por vírgula ou null"}`,
        messages: [{ role: 'user', content: messages.map(m => `${m.role}: ${m.content}`).join('\n') }]
      },
      { headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    return JSON.parse(response.data.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim());
  } catch { return {}; }
}

// ─── WHATSAPP & CHATWOOT ──────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_TOKEN}/send-text`,
    { phone, message },
    { headers: { 'Client-Token': ENV.ZAPI_CLIENT_TOKEN } }
  );
}

const chatwootHeaders = () => ({ 'api_access_token': ENV.CHATWOOT_TOKEN, 'Content-Type': 'application/json' });

async function getOrCreateContact(phone, name) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  try {
    const search = await axios.get(`${base}/contacts/search?q=${phone}`, { headers: chatwootHeaders() });
    const found = search.data.payload?.find(c => c.phone_number?.replace(/\D/g,'').endsWith(phone.slice(-8)));
    if (found) return found.id;
  } catch {}
  const created = await axios.post(`${base}/contacts`, { name: name || phone, phone_number: `+${phone}`, inbox_id: Number(ENV.CHATWOOT_INBOX) }, { headers: chatwootHeaders() });
  return created.data.id;
}

async function getOrCreateConversation(contactId) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  try {
    const convs = await axios.get(`${base}/contacts/${contactId}/conversations`, { headers: chatwootHeaders() });
    const open = convs.data.payload?.find(c => c.status === 'open' && c.inbox_id === Number(ENV.CHATWOOT_INBOX));
    if (open) return { id: open.id, assignedHuman: !!open.meta?.assignee };
  } catch {}
  const created = await axios.post(`${base}/conversations`, { contact_id: contactId, inbox_id: Number(ENV.CHATWOOT_INBOX) }, { headers: chatwootHeaders() });
  return { id: created.data.id, assignedHuman: false };
}

async function registerMessage(conversationId, message, type) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  await axios.post(`${base}/conversations/${conversationId}/messages`, { content: message, message_type: type, private: false }, { headers: chatwootHeaders() });
}

async function hasHumanAgent(conversationId) {
  try {
    const res = await axios.get(`${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}/conversations/${conversationId}`, { headers: chatwootHeaders() });
    return !!res.data.meta?.assignee;
  } catch { return false; }
}

async function notificarSecretaria(phone, patientName, message) {
  const texto = `🔔 *Transferência de atendimento*\n\nO paciente *${patientName}* (${phone}) está pedindo atendimento humano.\n\n💬 Última mensagem: "${message}"\n\n📱 Acesse o Chatwoot para continuar o atendimento.`;
  await sendWhatsApp(ENV.SECRETARIA_PHONE, texto);
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
    const name    = body.senderName || phone;

    console.log(`[IN] ${phone} (${name}): ${message}`);

    const contactId = await getOrCreateContact(phone, name);
    const { id: conversationId } = await getOrCreateConversation(contactId);
    await registerMessage(conversationId, message, 'incoming');

    // 1. Verifica se agente humano já está atendendo no Chatwoot
    if (await hasHumanAgent(conversationId)) {
      cancelarHandoff(phone);
      console.log(`[SKIP] ${phone}: agente humano atendendo.`);
      return;
    }

    // 2. Verifica se está em fila de handoff (aguardando secretaria)
    if (estaEmHandoff(phone)) {
      console.log(`[HANDOFF WAIT] ${phone}: aguardando secretaria.`);
      const msg = 'Já acionei nossa secretária! Em breve ela entrará em contato. Aguarde um momento 😊';
      await sendWhatsApp(phone, msg);
      await registerMessage(conversationId, msg, 'outgoing');
      return;
    }

    // 3. Detecta pedido de atendente humano
    if (detectaHandoff(message)) {
      console.log(`[HANDOFF] ${phone}: pediu atendente humano.`);
      const horario = isHorarioComercial();

      let msgPaciente, msgLog;
      if (horario) {
        msgPaciente = `Claro! Vou chamar nossa secretária agora 😊\nEla entrará em contato em breve. Caso demore mais de ${ENV.HANDOFF_TIMEOUT_MIN} minutos, posso continuar te ajudando!`;
        msgLog = 'Horário comercial — notificando secretária.';
      } else {
        msgPaciente = `Entendido! Nosso horário de atendimento humano é segunda a sexta das 9h às 18h.\nDeixarei um recado para nossa secretária te contatar amanhã cedo. Posso te ajudar com mais alguma coisa? 😊`;
        msgLog = 'Fora do horário — secretária será notificada.';
      }

      console.log(`[HANDOFF] ${msgLog}`);
      await sendWhatsApp(phone, msgPaciente);
      await registerMessage(conversationId, msgPaciente, 'outgoing');

      // Notifica secretária e inicia timer
      await notificarSecretaria(phone, name, message);
      iniciarHandoff(phone, conversationId, name, message);
      return;
    }

    // 4. Fora do horário comercial — Sofia responde normalmente
    // 5. Dentro do horário comercial — Sofia responde (secretaria pode assumir no Chatwoot)
    const reply = await askClaude(phone, message, name);
    console.log(`[OUT] ${phone}: ${reply}`);

    await sendWhatsApp(phone, reply);
    await registerMessage(conversationId, reply, 'outgoing');

  } catch (err) {
    console.error('[ERRO]', err.response?.data || err.message);
  }
});

// ─── ROTAS UTILITÁRIAS ────────────────────────────────────────────
app.get('/memoria/:phone', (req, res) => {
  const paciente  = getPaciente(req.params.phone);
  const historico = getHistorico(req.params.phone, 20);
  res.json({ paciente, historico });
});

app.get('/handoff-queue', (req, res) => {
  const queue = [...handoffQueue.entries()].map(([phone, data]) => ({ phone, patientName: data.patientName }));
  res.json({ em_espera: queue.length, pacientes: queue });
});

app.get('/', (req, res) => {
  const total   = db.prepare('SELECT COUNT(*) as count FROM pacientes').get();
  const horario = isHorarioComercial();
  res.json({
    status: 'Sofia online ✅',
    horario_comercial: horario ? 'Sim — secretária disponível' : 'Não — atendimento 24h pela Sofia',
    pacientes_na_memoria: total.count,
    em_handoff: handoffQueue.size,
    time: new Date().toISOString()
  });
});

app.listen(ENV.PORT, () => {
  console.log(`🤖 Sofia rodando na porta ${ENV.PORT}`);
  console.log(`🧠 Memória persistente ativa`);
  console.log(`📞 Secretária: ${ENV.SECRETARIA_PHONE}`);
  console.log(`⏱️  Timeout handoff: ${ENV.HANDOFF_TIMEOUT_MIN} min`);
});

// ─── ANÁLISE NOTURNA AGENDADA (6h horário de Brasília) ───────────
const cron = require('node-cron');

cron.schedule('0 9 * * *', async () => {
  // 9h UTC = 6h Brasília (UTC-3)
  console.log('🔍 Iniciando análise noturna automática...');
  try {
    const { execSync } = require('child_process');
    execSync('node analise-noturna.js', { cwd: __dirname, stdio: 'inherit' });
  } catch (err) {
    console.error('❌ Erro na análise noturna:', err.message);
  }
}, { timezone: 'UTC' });

console.log('⏰ Análise noturna agendada para 6h (horário de Brasília)');

// ─── INTEGRAÇÃO GOOGLE CALENDAR ───────────────────────────────────
let calendarModule = null;
try {
  calendarModule = require('./calendar');
  console.log('📅 Google Calendar integrado!');
} catch (e) {
  console.log('⚠️  Google Calendar não configurado:', e.message);
}

// Detecta intenção de agendamento na mensagem
function detectaAgendamento(message) {
  const lower = message.toLowerCase();
  return ['agendar', 'marcar', 'consulta', 'horário', 'horario', 'disponível', 'disponivel',
          'quando', 'vaga', 'encaixar', 'reservar', 'appointment'].some(p => lower.includes(p));
}

// Detecta confirmação de horário (ex: "quero o de terça às 9h")
function detectaConfirmacao(message) {
  return /\b(\d{1,2})[h:]\s*(\d{0,2})\b/.test(message) ||
    ['confirmo', 'quero esse', 'pode ser', 'esse horário', 'esse dia', 'perfeito', 'ótimo'].some(p => message.toLowerCase().includes(p));
}

// Estado de agendamento em andamento por paciente
const agendamentoEmAndamento = new Map();

async function processarAgendamento(phone, message, name, conversationId) {
  if (!calendarModule) return null;

  const estado = agendamentoEmAndamento.get(phone);

  // Paciente quer ver horários
  if (detectaAgendamento(message) && !estado) {
    try {
      const paciente   = getPaciente(phone);
      const procedimento = paciente?.procedimentos_interesse?.split(',')[0]?.trim() || 'padrao';
      const disponibilidade = await calendarModule.buscarHorariosDisponiveis(null, procedimento);
      const texto = calendarModule.formatarDisponibilidade(disponibilidade);

      // Salva estado com os slots disponíveis
      agendamentoEmAndamento.set(phone, { disponibilidade, procedimento, nome: paciente?.nome || name });

      return texto;
    } catch (e) {
      console.error('[CALENDAR] Erro ao buscar horários:', e.message);
      return null;
    }
  }

  // Paciente confirmou um horário
  if (estado && detectaConfirmacao(message)) {
    try {
      // Tenta extrair data/hora da mensagem
      const horaMatch = message.match(/(\d{1,2})[h:](\d{0,2})/);
      const diaMatch  = message.match(/segunda|terça|terca|quarta|quinta|sexta/i);

      if (horaMatch && diaMatch) {
        const hora    = parseInt(horaMatch[1]);
        const minutos = parseInt(horaMatch[2] || '0');
        const diaNome = diaMatch[0].toLowerCase().replace('terça','terca');

        // Encontra a próxima data correspondente ao dia da semana
        const diasIdx = { segunda:1, terca:2, quarta:3, quinta:4, sexta:5 };
        const targetDay = diasIdx[diaNome];
        const data = new Date();
        while (data.getDay() !== targetDay) data.setDate(data.getDate() + 1);
        data.setHours(hora, minutos, 0, 0);

        // Detecta consultório pelo dia
        const consultorio = [1,3,5].includes(targetDay) ? 'Copacabana' : 'Barra da Tijuca';

        await calendarModule.agendarConsulta({
          nome: estado.nome,
          phone,
          procedimento: estado.procedimento,
          dataHoraISO: data.toISOString(),
          consultorio,
        });

        agendamentoEmAndamento.delete(phone);

        const dataStr = data.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long' });
        const horaStr = data.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });

        return `✅ *Consulta agendada com sucesso!*\n\n📅 ${dataStr}\n🕐 ${horaStr}\n📍 ${consultorio}\n👨‍⚕️ Dr. Raphael Peryassú\n\nVocê receberá um lembrete 24h antes. Até lá! 😊`;
      }
    } catch (e) {
      console.error('[CALENDAR] Erro ao agendar:', e.message);
    }
  }

  return null;
}
