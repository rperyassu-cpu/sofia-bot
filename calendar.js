const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────
const CALENDAR_ID      = process.env.CALENDAR_ID || 'b25c87395fd9c7b85ec996f832515bb86ccc48893d1327f31c6ed609fd4a63ab@group.calendar.google.com';
const TOKEN_PATH       = path.join(__dirname, 'token-calendar.json');
const CREDENTIALS_PATH = path.join(__dirname, 'client_secret.json');

// ─── AGENDA DO DR. RAPHAEL ────────────────────────────────────────
// Turnos: manhã 10h-12h | tarde 14h-17h30
const AGENDA = {
  segunda: {
    consultorio: 'Barra da Tijuca',
    endereco: 'Av. das Américas, 2.480, bloco 2, sala S120',
    turnos: [
      { inicio: { h: 10, m: 0 }, fim: { h: 12, m: 0 } },
      { inicio: { h: 14, m: 0 }, fim: { h: 17, m: 30 } },
    ]
  },
  terca: {
    consultorio: 'Copacabana',
    endereco: 'Rua Siqueira Campos, 59, sala 308',
    turnos: [
      { inicio: { h: 10, m: 0 }, fim: { h: 12, m: 0 } },
      { inicio: { h: 14, m: 0 }, fim: { h: 17, m: 30 } },
    ]
  },
  quinta: {
    consultorio: 'Barra da Tijuca',
    endereco: 'Av. das Américas, 2.480, bloco 2, sala S120',
    turnos: [
      { inicio: { h: 10, m: 0 }, fim: { h: 12, m: 0 } },
      { inicio: { h: 14, m: 0 }, fim: { h: 17, m: 30 } },
    ]
  },
  sexta: {
    consultorio: 'Copacabana',
    endereco: 'Rua Siqueira Campos, 59, sala 308',
    turnos: [
      { inicio: { h: 10, m: 0 }, fim: { h: 12, m: 0 } },
      { inicio: { h: 14, m: 0 }, fim: { h: 17, m: 30 } },
    ]
  },
};

const DIAS_NOMES = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'];
const DIAS_IDX   = { segunda:1, terca:2, quarta:3, quinta:4, sexta:5 };

// ─── DURAÇÃO POR PROCEDIMENTO (minutos) ──────────────────────────
// Reflete os padrões reais do Doctoralia:
// Consulta (1ª vez ou retorno) = 30 min
// Revisão = 10 ou 20 min
// Procedimento = 30 a 60 min
const DURACOES = {
  'consulta':           30,
  'consulta clinica':   30,
  'consulta estetica':  30,
  'primeira consulta':  30,
  'retorno':            20,
  'revisao':            20,
  'revisão':            20,
  'botox':              30,
  'preenchimento':      30,
  'bioestimulador':     30,
  'radiesse':           30,
  'laser':              60,
  'peeling':            30,
  'limpeza de pele':    60,
  'cirurgia':           60,
  'procedimento':       30,
  'padrao':             30,
};

function getDuracao(procedimento) {
  if (!procedimento) return DURACOES['padrao'];
  const lower = procedimento.toLowerCase();
  for (const [key, val] of Object.entries(DURACOES)) {
    if (lower.includes(key)) return val;
  }
  return DURACOES['padrao'];
}

// ─── INFO DO DIA: onde o Dr. atende ──────────────────────────────
function infoDia(data) {
  const nome = DIAS_NOMES[data.getDay()];
  return AGENDA[nome] || null;
}

// ─── ONDE O DR. ESTARÁ EM DETERMINADO DIA ────────────────────────
function ondeAtende(diaNome) {
  const info = AGENDA[diaNome.toLowerCase().replace('terça','terca')];
  if (!info) return null;
  return info;
}

// ─── RESUMO DA AGENDA SEMANAL (para a Sofia explicar) ────────────
function resumoAgenda() {
  return `📅 *Agenda do Dr. Raphael Peryassú:*

🏥 *Barra da Tijuca* (Av. das Américas, 2.480, bl. 2, sala S120)
  • Segundas: 10h–12h e 14h–17h30
  • Quintas: 10h–12h e 14h–17h30

🏥 *Copacabana* (Rua Siqueira Campos, 59, sala 308)
  • Terças: 10h–12h e 14h–17h30
  • Sextas: 10h–12h e 14h–17h30`;
}

// ─── AUTENTICAÇÃO ─────────────────────────────────────────────────
function getAuth() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token  = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oAuth2.setCredentials(token);
  oAuth2.on('tokens', (tokens) => {
    if (tokens.refresh_token) token.refresh_token = tokens.refresh_token;
    token.access_token = tokens.access_token;
    token.expiry_date  = tokens.expiry_date;
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  });
  return oAuth2;
}

function getCalendar() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}

// ─── GERA SLOTS DISPONÍVEIS EM UM DIA ────────────────────────────
async function slotsDisponivelNoDia(data, duracao) {
  const calendar = getCalendar();
  const diaInfo  = infoDia(data);
  if (!diaInfo) return [];

  // Busca todos os eventos do dia no fuso de Brasília (UTC-3)
  const dataStr = data.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const inicioDia = new Date(dataStr + 'T00:00:00-03:00');
  const fimDia    = new Date(dataStr + 'T23:59:59-03:00');

  const resp = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: inicioDia.toISOString(),
    timeMax: fimDia.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: 'America/Sao_Paulo',
  });
  const eventos = resp.data.items || [];

  const slots = [];
  const agora  = agoraEmBrasilia();

  // Usa o fuso de Brasília para os slots
  const dataStrBR = data.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

  for (const turno of diaInfo.turnos) {
    let slot = new Date(dataStrBR + `T${String(turno.inicio.h).padStart(2,'0')}:${String(turno.inicio.m).padStart(2,'0')}:00-03:00`);
    const fimTurno = new Date(dataStrBR + `T${String(turno.fim.h).padStart(2,'0')}:${String(turno.fim.m).padStart(2,'0')}:00-03:00`);

    while (slot < fimTurno) {
      const slotFim = new Date(slot.getTime() + duracao * 60000);
      if (slotFim > fimTurno) break;
      if (slot <= agora) { slot = new Date(slot.getTime() + 30 * 60000); continue; }

      // Slot está ocupado se o início do slot cair dentro de algum evento
      // OU se algum evento começar durante este slot
      const ocupado = eventos.some(ev => {
        const evIni = new Date(ev.start.dateTime || ev.start.date);
        const evFim = new Date(ev.end.dateTime   || ev.end.date);
        // Slot conflita com evento se há qualquer sobreposição
        return slot < evFim && slotFim > evIni;
      });

      if (!ocupado) {
        slots.push({
          hora: slot.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' }),
          dataHoraISO: slot.toISOString(),
        });
      }

      slot = new Date(slot.getTime() + 20 * 60000);
    }
  }

  return slots;
}

// ─── HELPER: data atual no fuso de Brasília ───────────────────────
function hojeEmBrasilia() {
  const str = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  return new Date(str + "T00:00:00-03:00");
}
function agoraEmBrasilia() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
}

// ─── BUSCAR PRÓXIMOS HORÁRIOS DISPONÍVEIS ────────────────────────
async function buscarHorariosDisponiveis(procedimento, consultorioPref) {
  const duracao = getDuracao(procedimento);
  const hoje    = hojeEmBrasilia();


  const resultados = [];
  let d = new Date(hoje);
  let tentativas = 0;

  while (resultados.length < 3 && tentativas < 30) {
    tentativas++;
    const diaInfo = infoDia(d);

    if (diaInfo) {
      // Filtra por consultório preferido se informado
      if (!consultorioPref || diaInfo.consultorio.toLowerCase().includes(consultorioPref.toLowerCase())) {
        const slots = await slotsDisponivelNoDia(d, duracao);
        if (slots.length > 0) {
          const dataStr = d.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', timeZone:'America/Sao_Paulo' });
          resultados.push({
            data: dataStr,
            dataObj: new Date(d),
            consultorio: diaInfo.consultorio,
            endereco: diaInfo.endereco,
            slots: slots.slice(0, 6),
          });
        }
      }
    }

    d.setDate(d.getDate() + 1);
  }

  return { duracao, resultados };
}

// ─── AGENDAR CONSULTA ─────────────────────────────────────────────
async function agendarConsulta({ nome, phone, procedimento, dataHoraISO, consultorio, endereco }) {
  const calendar = getCalendar();
  const duracao  = getDuracao(procedimento);
  const inicio   = new Date(dataHoraISO);
  const fim      = new Date(inicio.getTime() + duracao * 60000);

  const evento = {
    summary:     `${procedimento || 'Consulta'} — ${nome}`,
    description: `Paciente: ${nome}\nWhatsApp: +${phone}\nProcedimento: ${procedimento || 'Consulta'}\n\nAgendado automaticamente pela Sofia (IA Secretária).`,
    location:    `${endereco} — ${consultorio}`,
    start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
    end:   { dateTime: fim.toISOString(),    timeZone: 'America/Sao_Paulo' },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 1440 },
      ]
    }
  };

  const result = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: evento });
  return result.data;
}

// ─── FORMATA DISPONIBILIDADE PARA WHATSAPP ────────────────────────
function formatarDisponibilidade({ duracao, resultados }) {
  if (resultados.length === 0) {
    return '😔 Não encontrei horários disponíveis nos próximos dias. Entre em contato pelo (21) 99642-3139 para verificarmos juntos! 😊';
  }

  let texto = `📅 *Horários disponíveis* (consulta ~${duracao} min):\n\n`;
  for (const { data, consultorio, endereco, slots } of resultados) {
    texto += `*${data}*\n`;
    texto += `📍 ${consultorio} — ${endereco}\n`;
    texto += slots.map(s => `  🕐 ${s.hora}`).join('\n');
    texto += '\n\n';
  }
  texto += 'Qual horário prefere? Me diga o dia e a hora que confirmo o agendamento! 😊';
  return texto;
}


// already complete  

// ─── BUSCAR CONSULTA AGENDADA DO PACIENTE ────────────────────────
async function buscarConsultaPaciente(phone) {
  const calendar = getCalendar();
  const agora = new Date();
  const daqui30dias = new Date(agora.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Busca todos os eventos futuros criados pela Sofia (sem filtro de texto)
  const resp = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: agora.toISOString(),
    timeMax: daqui30dias.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const eventos = resp.data.items || [];

  // Formatos possíveis do telefone para busca
  const phoneFormats = [
    phone,                          // 5521997336800
    phone.slice(-8),                // 97336800
    phone.replace(/^55/, ''),       // 21997336800
    '+' + phone,                    // +5521997336800
    '+55 ' + phone.slice(2),        // +55 21997336800
    phone.slice(2),                 // 21997336800
  ];

  const consultaPaciente = eventos.find(e => {
    const titulo = e.summary || '';
    const desc   = e.description || '';
    const texto  = titulo + ' ' + desc;
    // Busca em título (Doctoralia) e descrição (Sofia)
    return phoneFormats.some(f => texto.replace(/[\s\-().]/g, '').includes(f.replace(/[\s\-().]/g, '')));
  });

  return consultaPaciente || null;
}

// ─── CANCELAR CONSULTA ────────────────────────────────────────────
async function cancelarConsulta(eventId) {
  const calendar = getCalendar();
  await calendar.events.delete({
    calendarId: CALENDAR_ID,
    eventId,
  });
}

module.exports = {
  buscarHorariosDisponiveis,
  agendarConsulta,
  cancelarConsulta,
  buscarConsultaPaciente,
  formatarDisponibilidade,
  resumoAgenda,
  ondeAtende,
  infoDia,
  getDuracao,
  AGENDA,
  DIAS_IDX,
  DIAS_NOMES,
};
