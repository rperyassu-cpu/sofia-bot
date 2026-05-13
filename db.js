/**
 * db.js — Camada de banco de dados usando sql.js (sem compilação nativa)
 * Salva em arquivo JSON para persistência simples e confiável
 */
const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'sofia-data.json');

// Estrutura do banco em memória
let data = {
  pacientes: {},
  historico: {}
};

// Carrega do disco se existir
function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('Erro ao carregar DB:', e.message);
  }
}

// Salva no disco
function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Erro ao salvar DB:', e.message);
  }
}

// Carrega na inicialização
load();

// ─── PACIENTES ────────────────────────────────────────────────────
function getPaciente(phone) {
  return data.pacientes[phone] || null;
}

function upsertPaciente(phone, dados) {
  const existing = data.pacientes[phone];
  if (!existing) {
    data.pacientes[phone] = {
      phone,
      nome: dados.nome || null,
      primeira_vez: true,
      consultorio_preferido: dados.consultorio_preferido || null,
      ultima_queixa: dados.ultima_queixa || null,
      procedimentos_interesse: dados.procedimentos_interesse || null,
      total_conversas: 1,
      ultima_conversa: new Date().toISOString(),
      criado_em: new Date().toISOString(),
    };
  } else {
    data.pacientes[phone] = {
      ...existing,
      nome: dados.nome || existing.nome,
      primeira_vez: false,
      consultorio_preferido: dados.consultorio_preferido || existing.consultorio_preferido,
      ultima_queixa: dados.ultima_queixa || existing.ultima_queixa,
      procedimentos_interesse: dados.procedimentos_interesse || existing.procedimentos_interesse,
      total_conversas: (existing.total_conversas || 0) + 1,
      ultima_conversa: new Date().toISOString(),
    };
  }
  save();
}

// ─── HISTÓRICO ────────────────────────────────────────────────────
function getHistorico(phone, limit = 20) {
  const hist = data.historico[phone] || [];
  return hist.slice(-limit).map(m => ({ role: m.role, content: m.content }));
}

function saveHistorico(phone, role, content) {
  if (!data.historico[phone]) data.historico[phone] = [];
  data.historico[phone].push({ role, content, criado_em: new Date().toISOString() });
  // Mantém últimas 100 mensagens
  if (data.historico[phone].length > 100) {
    data.historico[phone] = data.historico[phone].slice(-100);
  }
  save();
}

// ─── STATS ────────────────────────────────────────────────────────
function getStats() {
  const agora = new Date();
  const h24   = new Date(agora - 24 * 60 * 60 * 1000);

  const totalPacientes = Object.keys(data.pacientes).length;
  const novosHoje = Object.values(data.pacientes).filter(p => new Date(p.criado_em) >= h24).length;
  const conversasHoje = Object.values(data.pacientes).filter(p => new Date(p.ultima_conversa) >= h24).length;
  const retornos = Object.values(data.pacientes).filter(p => !p.primeira_vez && new Date(p.ultima_conversa) >= h24).length;

  let mensagensHoje = 0;
  for (const hist of Object.values(data.historico)) {
    mensagensHoje += hist.filter(m => new Date(m.criado_em) >= h24).length;
  }

  return { totalPacientes, novosHoje, conversasHoje, mensagensHoje, retornos };
}

function getConversasRecentes() {
  const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = [];

  for (const [phone, hist] of Object.entries(data.historico)) {
    const recentes = hist.filter(m => new Date(m.criado_em) >= h24);
    if (recentes.length === 0) continue;
    const paciente = data.pacientes[phone] || {};
    result.push({
      phone,
      nome: paciente.nome,
      ultima_queixa: paciente.ultima_queixa,
      consultorio_preferido: paciente.consultorio_preferido,
      conversa: recentes.map(m => `${m.role}: ${m.content}`).join('\n'),
      total_mensagens: recentes.length,
    });
  }

  return result;
}

// ─── ESTADO DE AGENDAMENTO ───────────────────────────────────────
function getAgendamentoEstado(phone) {
  return data.agendamentos?.[phone] || null;
}

function setAgendamentoEstado(phone, estado) {
  if (!data.agendamentos) data.agendamentos = {};
  data.agendamentos[phone] = { ...estado, ts: Date.now() };
  save();
}

function clearAgendamentoEstado(phone) {
  if (data.agendamentos) delete data.agendamentos[phone];
  save();
}

module.exports = { getPaciente, upsertPaciente, getHistorico, saveHistorico, getStats, getConversasRecentes, getAgendamentoEstado, setAgendamentoEstado, clearAgendamentoEstado };
