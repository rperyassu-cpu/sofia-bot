/**
 * confirmacao.js — Fluxo proativo de confirmação de consultas
 * Roda a cada hora e envia mensagem 24h antes de cada consulta
 */
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const { google } = require('googleapis');

const ENV = {
  ZAPI_INSTANCE_ID:  process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN:        process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  CALENDAR_ID:       process.env.CALENDAR_ID,
};

const CONFIRMADOS_PATH = path.join(__dirname, 'confirmacoes-enviadas.json');

// ─── CONTROLE DE CONFIRMAÇÕES JÁ ENVIADAS ────────────────────────
function loadConfirmados() {
  try {
    if (fs.existsSync(CONFIRMADOS_PATH))
      return JSON.parse(fs.readFileSync(CONFIRMADOS_PATH, 'utf-8'));
  } catch {}
  return {};
}

function marcarConfirmacaoEnviada(eventId) {
  const data = loadConfirmados();
  data[eventId] = new Date().toISOString();
  fs.writeFileSync(CONFIRMADOS_PATH, JSON.stringify(data, null, 2));
}

function jaEnviouConfirmacao(eventId) {
  const data = loadConfirmados();
  return !!data[eventId];
}

// Limpa confirmações de eventos passados (roda semanalmente)
function limparConfirmadosAntigos() {
  const data = loadConfirmados();
  const semanaPassada = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const limpo = {};
  for (const [id, ts] of Object.entries(data)) {
    if (new Date(ts) > semanaPassada) limpo[id] = ts;
  }
  fs.writeFileSync(CONFIRMADOS_PATH, JSON.stringify(limpo, null, 2));
}

// ─── AUTENTICAÇÃO GOOGLE ──────────────────────────────────────────
function getAuth() {
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'client_secret.json')));
  const { client_id, client_secret, redirect_uris } = creds.installed;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token  = JSON.parse(fs.readFileSync(path.join(__dirname, 'token-calendar.json')));
  oAuth2.setCredentials(token);
  oAuth2.on('tokens', (tokens) => {
    if (tokens.refresh_token) token.refresh_token = tokens.refresh_token;
    token.access_token = tokens.access_token;
    token.expiry_date  = tokens.expiry_date;
    fs.writeFileSync(path.join(__dirname, 'token-calendar.json'), JSON.stringify(token, null, 2));
  });
  return oAuth2;
}

// ─── EXTRAI TELEFONE DO EVENTO ────────────────────────────────────
function extrairTelefone(evento) {
  const texto = (evento.summary || '') + ' ' + (evento.description || '');

  // Padrões: +5521999999999, 5521999999999, 21999999999, +55 21 99999-9999
  const match = texto.match(/(?:\+?55\s?)?(\d{2})\s?(\d{4,5})[\s-]?(\d{4})/);
  if (match) {
    const numero = '55' + match[1] + match[2] + match[3];
    return numero.replace(/\D/g, '');
  }
  return null;
}

// ─── EXTRAI NOME DO PACIENTE DO EVENTO ───────────────────────────
function extrairNome(evento) {
  // Eventos da Sofia: "consulta — Raphael Peryassú"
  if (evento.summary?.includes('—')) {
    return evento.summary.split('—')[1]?.trim().split(' ')[0] || 'paciente';
  }
  // Eventos do Doctoralia: "Helena Lais | +55 21..."
  if (evento.summary?.includes('|')) {
    return evento.summary.split('|')[0]?.trim().split(' ')[0] || 'paciente';
  }
  return 'paciente';
}

// ─── ENVIA WHATSAPP ───────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_TOKEN}/send-text`,
    { phone, message },
    { headers: { 'Client-Token': ENV.ZAPI_CLIENT_TOKEN } }
  );
}

// ─── BUSCA CONSULTAS NAS PRÓXIMAS 24H ────────────────────────────
async function buscarConsultasProximas24h() {
  const calendar = google.calendar({ version: 'v3', auth: getAuth() });

  const agora      = new Date();
  const daqui24h   = new Date(agora.getTime() + 24 * 60 * 60 * 1000);

  const resp = await calendar.events.list({
    calendarId: ENV.CALENDAR_ID,
    timeMin: agora.toISOString(),
    timeMax: daqui24h.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return resp.data.items || [];
}

// ─── ENVIA CONFIRMAÇÕES PENDENTES ────────────────────────────────
async function enviarConfirmacoesPendentes() {
  console.log('🔔 Verificando consultas para confirmação...');

  let eventos;
  try {
    eventos = await buscarConsultasProximas24h();
  } catch (e) {
    console.error('❌ Erro ao buscar eventos:', e.message);
    return;
  }

  console.log(`📅 ${eventos.length} consulta(s) nas próximas 24h`);

  for (const evento of eventos) {
    if (jaEnviouConfirmacao(evento.id)) {
      console.log(`⏭️  Confirmação já enviada para: ${evento.summary}`);
      continue;
    }

    const phone = extrairTelefone(evento);
    if (!phone) {
      console.log(`⚠️  Sem telefone: ${evento.summary}`);
      continue;
    }

    const nome    = extrairNome(evento);
    const inicio  = new Date(evento.start.dateTime || evento.start.date);
    const dataStr = inicio.toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long',
      timeZone: 'America/Sao_Paulo'
    });
    const horaStr = inicio.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    });

    // Detecta consultório pelo dia da semana
    const diaSemana = inicio.toLocaleDateString('en-US', { weekday:'long', timeZone:'America/Sao_Paulo' }).toLowerCase();
    const consultorio = ['monday','thursday'].includes(diaSemana)
      ? 'Barra da Tijuca — Av. das Américas, 2.480, bloco 2, sala S120'
      : 'Copacabana — Rua Siqueira Campos, 59, sala 308';

    const mensagem = `Olá, ${nome}! 😊

Sua consulta com o *Dr. Raphael Peryassú* está confirmada para:

📅 *${dataStr}*
🕐 *${horaStr}*
📍 *${consultorio}*

Posso confirmar sua presença? (responda *SIM* para confirmar)

Se houver algum imprevisto, pedimos gentileza de avisar com antecedência para que possamos organizar a agenda. 🙏`;

    try {
      await sendWhatsApp(phone, mensagem);
      marcarConfirmacaoEnviada(evento.id);
      console.log(`✅ Confirmação enviada para ${nome} (${phone})`);

      // Pequena pausa entre envios para não sobrecarregar a API
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`❌ Erro ao enviar para ${phone}:`, e.message);
    }
  }

  limparConfirmadosAntigos();
  console.log('✅ Verificação de confirmações concluída');
}

module.exports = { enviarConfirmacoesPendentes, extrairTelefone, extrairNome };
