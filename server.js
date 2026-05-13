const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const db       = require('./db');

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
  DR_PHONE:            (process.env.DR_PHONE || '5521996423139,5521997336800').split(','),
  HANDOFF_TIMEOUT_MIN: parseInt(process.env.HANDOFF_TIMEOUT_MIN || '5'),
  CALENDAR_ID:         process.env.CALENDAR_ID,
  OPENAI_API_KEY:      process.env.OPENAI_API_KEY,
  PORT: process.env.PORT || 3000,
};

// ─── HORÁRIO COMERCIAL ────────────────────────────────────────────
function isHorarioComercial() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = brasilia.getHours();
  const dia  = brasilia.getDay();
  return dia >= 1 && dia <= 5 && hora >= 9 && hora < 18;
}

// ─── HANDOFF ──────────────────────────────────────────────────────
const PALAVRAS_HANDOFF = ['atendente','humano','pessoa','secretaria','secretária',
  'falar com alguém','quero falar','me liga','ligar','urgente','emergência','emergencia',
  'não quero robô','nao quero robo'];

function detectaHandoff(message) {
  const lower = message.toLowerCase();
  return PALAVRAS_HANDOFF.some(p => lower.includes(p));
}

const handoffQueue = new Map();

function iniciarHandoff(phone, conversationId, patientName) {
  if (handoffQueue.has(phone)) clearTimeout(handoffQueue.get(phone).timer);
  const timer = setTimeout(async () => {
    handoffQueue.delete(phone);
    console.log(`[HANDOFF TIMEOUT] ${phone}: Sofia retoma.`);
    const msg = `Nossa secretária ainda não está disponível. Mas pode continuar comigo, a Sofia! 😊`;
    await sendWhatsApp(phone, msg);
    await registerMessage(conversationId, msg, 'outgoing');
  }, ENV.HANDOFF_TIMEOUT_MIN * 60 * 1000);
  handoffQueue.set(phone, { timer, conversationId, patientName });
}

function cancelarHandoff(phone) {
  if (handoffQueue.has(phone)) { clearTimeout(handoffQueue.get(phone).timer); handoffQueue.delete(phone); }
}

function estaEmHandoff(phone) { return handoffQueue.has(phone); }

// ─── GOOGLE CALENDAR ──────────────────────────────────────────────
let calendarModule = null;
try {
  calendarModule = require('./calendar');
  console.log('📅 Google Calendar integrado!');
} catch (e) {
  console.log('⚠️  Google Calendar não configurado:', e.message);
}

// Detecta pedido de cancelamento
function detectaCancelamento(message) {
  const lower = message.toLowerCase();
  return ['desmarcar','cancelar','cancelamento','remarcar','desmarco','cancelo',
    'não vou poder','nao vou poder','não consigo ir','nao consigo ir',
    'quero cancelar','quero desmarcar'].some(p => lower.includes(p));
}

function detectaAgendamento(message) {
  return ['agendar','marcar','consulta','horário','horario','disponível','disponivel',
    'quando','vaga','encaixar','reservar'].some(p => message.toLowerCase().includes(p));
}

const agendamentoEmAndamento = {
  get: (phone) => db.getAgendamentoEstado(phone),
  set: (phone, estado) => db.setAgendamentoEstado(phone, estado),
  delete: (phone) => db.clearAgendamentoEstado(phone),
};

async function processarAgendamento(phone, message, name, conversationId) {
  if (!calendarModule) return null;
  const estado = agendamentoEmAndamento.get(phone);

  if (detectaAgendamento(message) && !estado) {
    try {
      const paciente = db.getPaciente(phone);
      const procedimento = paciente?.procedimentos_interesse?.split(',')[0]?.trim() || 'consulta';
      const disponibilidade = await calendarModule.buscarHorariosDisponiveis(procedimento, paciente?.consultorio_preferido);
      const texto = calendarModule.formatarDisponibilidade(disponibilidade);
      agendamentoEmAndamento.set(phone, { disponibilidade, procedimento, nome: paciente?.nome || name });
      return texto;
    } catch (e) {
      console.error('[CALENDAR]', e.message);
      return null;
    }
  }

  if (estado) {
    // Extrai hora da mensagem
    const horaMatch = message.match(/(\d{1,2})[h:](\d{2})?|(\d{1,2})\s*(h|hora|horas|da manhã|da tarde)/i);
    if (!horaMatch) return null;

    const horaStr = message.match(/(\d{1,2})[h:]?(\d{2})?/);
    const hora = parseInt(horaStr[1]);
    const min  = parseInt(horaStr[2] || '0');
    const horaFormatada = `${String(hora).padStart(2,'0')}:${String(min).padStart(2,'0')}`;

    // Detecta o dia mencionado
    const diaMatch    = message.match(/segunda|terça|terca|quarta|quinta|sexta/i);
    const diaNumMatch = message.match(/dia\s+(\d{1,2})/i);
    const amanhaMatch = message.match(/amanhã|amanha/i);
    const hojeMatch   = message.match(/\bhoje\b/i);

    // Busca o slot correspondente nos resultados salvos
    const todos_slots = estado.disponibilidade?.resultados || [];
    let slotEncontrado = null;

    for (const resultado of todos_slots) {
      for (const slot of resultado.slots) {
        if (slot.hora === horaFormatada) {
          // Verifica se o dia bate
          const slotData = new Date(slot.dataHoraISO);
          const slotDiaBR = slotData.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', timeZone:'America/Sao_Paulo' });

          let diaOk = false;
          if (amanhaMatch) {
            // "amanhã" — verifica se é o próximo dia
            const amanha = new Date(new Date().toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' }) + 'T00:00:00-03:00');
            amanha.setDate(amanha.getDate() + 1);
            const slotDiaNum = slotData.toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' });
            const amanhaDiaNum = amanha.toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' });
            diaOk = slotDiaNum === amanhaDiaNum;
          } else if (hojeMatch) {
            const hoje = new Date().toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' });
            diaOk = slotData.toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' }) === hoje;
          } else if (diaNumMatch) {
            const diaNum = parseInt(diaNumMatch[1]);
            diaOk = slotData.toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' }).endsWith('-' + String(diaNum).padStart(2,'0'));
          } else if (diaMatch) {
            const dias = { segunda:'segunda',terca:'terça',terça:'terça',quinta:'quinta',sexta:'sexta' };
            const diaBuscado = dias[diaMatch[0].toLowerCase()] || diaMatch[0].toLowerCase();
            diaOk = slotDiaBR.toLowerCase().includes(diaBuscado);
          } else {
            // Sem dia especificado — usa o primeiro disponível com esse horário
            diaOk = true;
          }

          if (diaOk) { slotEncontrado = { slot, resultado }; break; }
        }
      }
      if (slotEncontrado) break;
    }

    if (!slotEncontrado) {
      // Horário não encontrado nos slots disponíveis
      const horariosDisponiveis = todos_slots.slice(0,2).map(r =>
        `*${r.data}* (${r.consultorio}): ${r.slots.slice(0,3).map(s => s.hora).join(', ')}`
      ).join('\n');
      return `😊 Não encontrei disponibilidade às ${horaFormatada}. Os horários disponíveis são:\n\n${horariosDisponiveis}\n\nQual prefere?`;
    }

    try {
      const { slot, resultado } = slotEncontrado;
      await calendarModule.agendarConsulta({
        nome: estado.nome || name,
        phone,
        procedimento: estado.procedimento,
        dataHoraISO: slot.dataHoraISO,
        consultorio: resultado.consultorio,
        endereco: resultado.endereco,
      });
      agendamentoEmAndamento.delete(phone);

      const dataFinal = new Date(slot.dataHoraISO);
      const dataStr = dataFinal.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', timeZone:'America/Sao_Paulo' });
      const horaFinal = dataFinal.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' });

      return `✅ *Consulta agendada com sucesso!*\n\n📅 ${dataStr}\n🕐 ${horaFinal}\n📍 ${resultado.consultorio}\n📍 ${resultado.endereco}\n👨‍⚕️ Dr. Raphael Peryassú\n\nVocê receberá um lembrete 24h antes. Até lá! 😊`;
    } catch (e) {
      console.error('[CALENDAR AGENDAR]', e.message);
      return null;
    }
  }
  return null;
}

// ─── CONFIG ───────────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'sofia-config.json'), 'utf-8'));
}

function buildSystemPrompt(cfg, paciente) {
  const c = cfg.clinica, s = cfg.sofia;
  const consultorios = cfg['consultórios'].map(co => {
    const h = Object.entries(co.horarios).map(([d,hr]) => `    ${d}: ${hr}`).join('\n');
    return `  • ${co.nome}: ${co.endereço}\n    Tel: ${co.telefone}\n    Horários:\n${h}`;
  }).join('\n\n');
  const servicos   = Object.entries(cfg.servicos).map(([a,l]) => `  ${a.charAt(0).toUpperCase()+a.slice(1)}: ${l.join(', ')}`).join('\n');
  const faqs       = cfg.perguntas_frequentes.map((f,i) => `  ${i+1}. P: "${f.pergunta}"\n     R: "${f.resposta}"`).join('\n');
  const urgencias  = cfg.sinais_urgencia.map(u => `  - ${u}`).join('\n');
  const instrucoes = s.instrucoes_gerais.map(i => `  • ${i}`).join('\n');
  const proibidas  = s.frases_proibidas.map(f => `  • "${f}"`).join('\n');

  let memoriaBloco = '';
  if (paciente) {
    memoriaBloco = `\n━━━ MEMÓRIA DO PACIENTE ━━━
• Nome: ${paciente.nome || 'Não informado'}
• Primeira vez: ${paciente.primeira_vez ? 'Sim' : `Não (${paciente.total_conversas} conversa(s))`}
• Consultório preferido: ${paciente.consultorio_preferido || 'Não informado'}
• Última queixa: ${paciente.ultima_queixa || 'Não informada'}
• Procedimentos de interesse: ${paciente.procedimentos_interesse || 'Nenhum'}
• Última conversa: ${paciente.ultima_conversa || 'Agora'}
USE estas informações para personalizar o atendimento.`;
  }

  const horarioInfo = isHorarioComercial()
    ? 'Secretária humana disponível (Seg-Sex 9h-18h). Se pedir atendente, informe que vai transferir.'
    : 'Fora do horário comercial. Informe que a equipe retorna no próximo dia útil.';

  // Data atual em Brasília
  const _agora = new Date();
  const dataHojeBR = _agora.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric', timeZone:'America/Sao_Paulo' });
  const horaHojeBR = _agora.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' });
  const _amanha = new Date(_agora.toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' }) + 'T00:00:00-03:00');
  _amanha.setDate(_amanha.getDate() + 1);
  const dataAmanhaBR = _amanha.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', timeZone:'America/Sao_Paulo' });

  return `Você é ${s.nome}, a secretária virtual ${s.tom} do consultório do ${c.nome_doutor}, ${c.especialidade}.
${memoriaBloco}

━━━ DATA E HORA ATUAL (Brasília) ━━━
Hoje: ${dataHojeBR}, ${horaHojeBR}
Amanhã: ${dataAmanhaBR}
IMPORTANTE: Use sempre essas datas. NUNCA peça ao paciente para informar a data — você já sabe qual é.

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

━━━ INSTRUÇÕES ━━━
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
  const paciente = db.getPaciente(phone);
  const systemPrompt = buildSystemPrompt(cfg, paciente);
  db.saveHistorico(phone, 'user', userMessage);
  const history = db.getHistorico(phone);

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: ENV.ANTHROPIC_MODEL, max_tokens: 1000, system: systemPrompt, messages: history },
    { headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  const reply = response.data.content.map(b => b.text || '').join('');
  db.saveHistorico(phone, 'assistant', reply);

  extrairDadosPaciente(phone, db.getHistorico(phone, 10)).then(dados => {
    if (dados && Object.keys(dados).length) db.upsertPaciente(phone, { ...dados, nome: dados.nome || senderName });
  }).catch(() => {});

  db.upsertPaciente(phone, { nome: senderName });
  return reply;
}

async function extrairDadosPaciente(phone, messages) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: ENV.ANTHROPIC_MODEL, max_tokens: 200,
        system: `Extraia dados do paciente. Responda APENAS em JSON válido:
{"nome":"primeiro nome ou null","consultorio_preferido":"Copacabana ou Barra da Tijuca ou null","ultima_queixa":"em até 10 palavras ou null","procedimentos_interesse":"separados por vírgula ou null"}`,
        messages: [{ role: 'user', content: messages.map(m => `${m.role}: ${m.content}`).join('\n') }]
      },
      { headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    return JSON.parse(response.data.content.map(b => b.text||'').join('').replace(/```json|```/g,'').trim());
  } catch { return {}; }
}

// ─── WHATSAPP & CHATWOOT ──────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_TOKEN}/send-text`,
    { phone, message }, { headers: { 'Client-Token': ENV.ZAPI_CLIENT_TOKEN } }
  );
}

const chatwootHeaders = () => ({ 'api_access_token': ENV.CHATWOOT_TOKEN, 'Content-Type': 'application/json' });

async function getOrCreateContact(phone, name) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  try {
    const s = await axios.get(`${base}/contacts/search?q=${phone}`, { headers: chatwootHeaders() });
    const found = s.data.payload?.find(c => c.phone_number?.replace(/\D/g,'').endsWith(phone.slice(-8)));
    if (found) return found.id;
  } catch {}
  const r = await axios.post(`${base}/contacts`, { name: name||phone, phone_number:`+${phone}`, inbox_id:Number(ENV.CHATWOOT_INBOX) }, { headers: chatwootHeaders() });
  return r.data.id;
}

async function getOrCreateConversation(contactId) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  try {
    const r = await axios.get(`${base}/contacts/${contactId}/conversations`, { headers: chatwootHeaders() });
    const open = r.data.payload?.find(c => c.status==='open' && c.inbox_id===Number(ENV.CHATWOOT_INBOX));
    if (open) return { id: open.id, assignedHuman: !!open.meta?.assignee };
  } catch {}
  const r = await axios.post(`${base}/conversations`, { contact_id:contactId, inbox_id:Number(ENV.CHATWOOT_INBOX) }, { headers: chatwootHeaders() });
  return { id: r.data.id, assignedHuman: false };
}

async function registerMessage(conversationId, message, type) {
  const base = `${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}`;
  await axios.post(`${base}/conversations/${conversationId}/messages`, { content:message, message_type:type, private:false }, { headers: chatwootHeaders() });
}

async function hasHumanAgent(conversationId) {
  try {
    const r = await axios.get(`${ENV.CHATWOOT_URL}/api/v1/accounts/${ENV.CHATWOOT_ACCOUNT}/conversations/${conversationId}`, { headers: chatwootHeaders() });
    return !!r.data.meta?.assignee;
  } catch { return false; }
}

async function notificarSecretaria(phone, name, message) {
  const texto = `🔔 *Transferência de atendimento*\n\nPaciente *${name}* (${phone}) pediu atendimento humano.\n\n💬 "${message}"\n\n📱 Acesse o Chatwoot para continuar.`;
  await sendWhatsApp(ENV.SECRETARIA_PHONE, texto);
}

// ─── TRANSCRIÇÃO DE ÁUDIO (Whisper) ──────────────────────────────
async function transcreverAudio(audioUrl) {
  if (!ENV.OPENAI_API_KEY) return null;
  try {
    // Baixa o áudio
    const audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(audioResp.data);

    // Monta o FormData manualmente
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const filename = 'audio.ogg';
    const mimeType = 'audio/ogg';

    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const mid = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n` +
      `--${boundary}--\r\n`
    );
    const body = Buffer.concat([pre, audioBuffer, mid]);

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      body,
      {
        headers: {
          'Authorization': `Bearer ${ENV.OPENAI_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        maxBodyLength: Infinity,
      }
    );

    return response.data.text?.trim() || null;
  } catch (e) {
    console.error('[WHISPER ERRO]', e.response?.data || e.message);
    return null;
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.fromMe) return;
    if (body.type !== 'ReceivedCallback') return;

    const phone = body.phone;
    const name  = body.senderName || phone;
    let message = '';
    let isAudio = false;

    // Texto normal
    if (body.text?.message) {
      message = body.text.message.trim();
    }
    // Áudio (PTT = Push To Talk = mensagem de voz)
    else if (body.audio || body.ptt) {
      const audioUrl = body.audio?.audioUrl || body.ptt?.audioUrl || body.audio?.url || body.ptt?.url;
      if (!audioUrl) return;
      console.log(`[ÁUDIO] ${phone}: transcrevendo...`);
      const transcricao = await transcreverAudio(audioUrl);
      if (!transcricao) {
        await sendWhatsApp(phone, 'Desculpe, não consegui entender o áudio. Pode digitar sua mensagem? 😊');
        return;
      }
      message = transcricao;
      isAudio = true;
      console.log(`[ÁUDIO TRANSCRITO] ${phone}: "${message}"`);
    } else {
      return;
    }

    console.log(`[IN] ${phone} (${name}): ${message}`);

    const contactId = await getOrCreateContact(phone, name);
    const { id: conversationId } = await getOrCreateConversation(contactId);
    await registerMessage(conversationId, message, 'incoming');

    if (await hasHumanAgent(conversationId)) {
      cancelarHandoff(phone);
      console.log(`[SKIP] ${phone}: agente humano atendendo.`);
      return;
    }

    if (estaEmHandoff(phone)) {
      const msg = 'Já acionei nossa secretária! Em breve ela entrará em contato 😊';
      await sendWhatsApp(phone, msg);
      await registerMessage(conversationId, msg, 'outgoing');
      return;
    }

    if (detectaHandoff(message)) {
      const horario = isHorarioComercial();
      const msgPaciente = horario
        ? `Claro! Vou chamar nossa secretária agora 😊\nEla entrará em contato em breve!`
        : `Nosso horário é segunda a sexta das 9h às 18h.\nDeixarei um recado para ela te contatar amanhã! 😊`;
      await sendWhatsApp(phone, msgPaciente);
      await registerMessage(conversationId, msgPaciente, 'outgoing');
      await notificarSecretaria(phone, name, message);
      iniciarHandoff(phone, conversationId, name);
      return;
    }

    // Detecta pedido de cancelamento
    if (detectaCancelamento(message) && calendarModule) {
      try {
        const consulta = await calendarModule.buscarConsultaPaciente(phone);
        if (consulta) {
          const inicio = new Date(consulta.start.dateTime);
          const dataStr = inicio.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', timeZone:'America/Sao_Paulo' });
          const horaStr = inicio.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' });

          // Verifica se é cancelamento com menos de 48h de antecedência
          const horasRestantes = (inicio - new Date()) / (1000 * 60 * 60);
          let msgCancelamento;

          if (horasRestantes < 48) {
            msgCancelamento = `${name ? name.split(' ')[0] : 'Olá'}, aconteceu algo grave? Normalmente não temos remarcações em cima da hora. 😔

Sua consulta está marcada para *${dataStr} às ${horaStr}*. A agenda do Dr. Raphael é bem apertada — só conseguiria agendar um horário daqui alguns dias.

Tem certeza que precisa cancelar?`;
          } else {
            msgCancelamento = `${name ? name.split(' ')[0] : 'Olá'}, entendido. Sua consulta de *${dataStr} às ${horaStr}* será cancelada.

Se tiver algum imprevisto, recomendamos avisar com pelo menos 48h de antecedência para que possamos oferecer o horário a outro paciente.

Deseja confirmar o cancelamento? (responda *sim* para confirmar)`;
          }

          // Salva estado de cancelamento pendente
          db.setAgendamentoEstado(phone, { cancelamento: true, eventId: consulta.id, dataStr, horaStr, horasRestantes });

          await sendWhatsApp(phone, msgCancelamento);
          await registerMessage(conversationId, msgCancelamento, 'outgoing');
          db.saveHistorico(phone, 'assistant', msgCancelamento);
          return;
        } else {
          const msg = `Não encontrei nenhuma consulta agendada para você. Gostaria de agendar uma nova? 😊`;
          await sendWhatsApp(phone, msg);
          await registerMessage(conversationId, msg, 'outgoing');
          return;
        }
      } catch (e) {
        console.error('[CANCELAMENTO]', e.message);
      }
    }

    // Confirma cancelamento pendente
    const estadoAtual = agendamentoEmAndamento.get(phone);
    if (estadoAtual?.cancelamento && message.toLowerCase().includes('sim')) {
      try {
        await calendarModule.cancelarConsulta(estadoAtual.eventId);
        agendamentoEmAndamento.delete(phone);
        const msg = `✅ Consulta de *${estadoAtual.dataStr} às ${estadoAtual.horaStr}* cancelada.

Quando quiser reagendar, é só me avisar! 😊`;
        await sendWhatsApp(phone, msg);
        await registerMessage(conversationId, msg, 'outgoing');
        db.saveHistorico(phone, 'assistant', msg);
        return;
      } catch (e) {
        console.error('[CANCELAMENTO CONFIRMA]', e.message);
      }
    }

    // Tenta processar agendamento pelo Calendar
    const calendarReply = await processarAgendamento(phone, message, name, conversationId);
    if (calendarReply) {
      await sendWhatsApp(phone, calendarReply);
      await registerMessage(conversationId, calendarReply, 'outgoing');
      db.saveHistorico(phone, 'assistant', calendarReply);
      return;
    }

    // Sofia responde normalmente
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
  res.json({ paciente: db.getPaciente(req.params.phone), historico: db.getHistorico(req.params.phone, 20) });
});

app.get('/', (req, res) => {
  const stats = db.getStats();
  res.json({
    status: 'Sofia online ✅',
    horario_comercial: isHorarioComercial() ? 'Sim' : 'Não',
    pacientes_na_memoria: stats.totalPacientes,
    em_handoff: handoffQueue.size,
    calendar: calendarModule ? 'Conectado ✅' : 'Não configurado',
    time: new Date().toISOString()
  });
});

// ─── ANÁLISE NOTURNA (6h Brasília = 9h UTC) ──────────────────────
const cron = require('node-cron');
cron.schedule('0 9 * * *', async () => {
  console.log('🔍 Iniciando análise noturna...');
  try { require('child_process').execSync('node analise-noturna.js', { cwd: __dirname, stdio: 'inherit' }); }
  catch (e) { console.error('❌ Erro na análise:', e.message); }
}, { timezone: 'UTC' });

app.listen(ENV.PORT, () => {
  console.log(`🤖 Sofia rodando na porta ${ENV.PORT}`);
  console.log(`🧠 Memória: sofia-data.json`);
  console.log(`📞 Secretária: ${ENV.SECRETARIA_PHONE}`);
  console.log(`⏰ Análise noturna: 6h (Brasília)`);
});
// already complete
