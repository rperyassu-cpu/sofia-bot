const axios    = require('axios');
const Database = require('better-sqlite3');
const path     = require('path');

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────
const ENV = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL:   process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
  ZAPI_INSTANCE_ID:  process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN:        process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  DR_PHONE: (process.env.DR_PHONE || '5521996423139,5521997336800').split(','),
};

const db = new Database(path.join(__dirname, 'sofia-memory.db'));

// ─── BUSCA CONVERSAS DAS ÚLTIMAS 24H ─────────────────────────────
function getConversasRecentes() {
  return db.prepare(`
    SELECT
      h.phone,
      p.nome,
      p.ultima_queixa,
      p.consultorio_preferido,
      GROUP_CONCAT(h.role || ': ' || h.content, '\n') as conversa,
      COUNT(*) as total_mensagens
    FROM historico_conversas h
    LEFT JOIN pacientes p ON p.phone = h.phone
    WHERE h.criado_em >= datetime('now', '-24 hours')
    GROUP BY h.phone
    ORDER BY MAX(h.criado_em) DESC
  `).all();
}

// ─── ESTATÍSTICAS GERAIS ──────────────────────────────────────────
function getEstatisticas() {
  const totalPacientes = db.prepare(`SELECT COUNT(*) as n FROM pacientes`).get().n;
  const novosHoje      = db.prepare(`SELECT COUNT(*) as n FROM pacientes WHERE criado_em >= datetime('now', '-24 hours')`).get().n;
  const conversasHoje  = db.prepare(`SELECT COUNT(DISTINCT phone) as n FROM historico_conversas WHERE criado_em >= datetime('now', '-24 hours')`).get().n;
  const mensagensHoje  = db.prepare(`SELECT COUNT(*) as n FROM historico_conversas WHERE criado_em >= datetime('now', '-24 hours')`).get().n;
  const retornos       = db.prepare(`SELECT COUNT(*) as n FROM pacientes WHERE primeira_vez = 0 AND ultima_conversa >= datetime('now', '-24 hours')`).get().n;

  return { totalPacientes, novosHoje, conversasHoje, mensagensHoje, retornos };
}

// ─── ANALISA CONVERSAS COM IA ─────────────────────────────────────
async function analisarConversas(conversas) {
  if (conversas.length === 0) return null;

  const conversasTexto = conversas.map((c, i) =>
    `--- Paciente ${i + 1}: ${c.nome || c.phone} ---\n${c.conversa}`
  ).join('\n\n');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: ENV.ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: `Você é um especialista em atendimento médico e conversão de pacientes. 
Analise as conversas da secretária virtual Sofia de um consultório de dermatologia e forneça insights práticos.
Seja direto, objetivo e use linguagem simples. Responda em português do Brasil.`,
      messages: [{
        role: 'user',
        content: `Analise as conversas de hoje da Sofia e responda em formato estruturado:

CONVERSAS DO DIA:
${conversasTexto}

Forneça:
1. PONTOS POSITIVOS (o que a Sofia fez bem)
2. PONTOS DE MELHORIA (onde ela poderia ter sido melhor)
3. PERGUNTAS SEM RESPOSTA ADEQUADA (que devem ser adicionadas ao FAQ)
4. PADRÕES IDENTIFICADOS (dúvidas recorrentes dos pacientes)
5. SUGESTÕES PARA O CONFIG (melhorias concretas para o sofia-config.json)
6. OPORTUNIDADES PERDIDAS (conversas que poderiam ter convertido em agendamento)

Seja específico e prático. Máximo 500 palavras no total.`
      }]
    },
    { headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  return response.data.content.map(b => b.text || '').join('');
}

// ─── ENVIA RELATÓRIO VIA WHATSAPP ─────────────────────────────────
async function enviarWhatsApp(phone, message) {
  await axios.post(
    `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_TOKEN}/send-text`,
    { phone, message },
    { headers: { 'Client-Token': ENV.ZAPI_CLIENT_TOKEN } }
  );
}

// ─── FORMATA E ENVIA RELATÓRIO ────────────────────────────────────
async function enviarRelatorio() {
  console.log('🔍 Iniciando análise noturna...');

  const stats     = getEstatisticas();
  const conversas = getConversasRecentes();

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const hoje  = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // Monta cabeçalho do relatório
  let relatorio = `📊 *Relatório Sofia — ${hoje}*\n\n`;
  relatorio += `📈 *Resumo do dia:*\n`;
  relatorio += `• Conversas: ${stats.conversasHoje}\n`;
  relatorio += `• Mensagens trocadas: ${stats.mensagensHoje}\n`;
  relatorio += `• Pacientes novos: ${stats.novosHoje}\n`;
  relatorio += `• Retornos: ${stats.retornos}\n`;
  relatorio += `• Total na base: ${stats.totalPacientes} pacientes\n\n`;

  if (conversas.length === 0) {
    relatorio += `💤 Nenhuma conversa registrada nas últimas 24h.\n`;
    for (const phone of ENV.DR_PHONE) await enviarWhatsApp(phone, relatorio);
    console.log('✅ Relatório enviado (sem conversas).');
    return;
  }

  // Análise por IA
  console.log(`📝 Analisando ${conversas.length} conversa(s) com IA...`);
  const analise = await analisarConversas(conversas);

  if (analise) {
    relatorio += `🤖 *Análise da Sofia:*\n\n${analise}`;
  }

  // Divide em mensagens menores se necessário (WhatsApp tem limite)
  const LIMITE = 3500;
  if (relatorio.length <= LIMITE) {
    for (const phone of ENV.DR_PHONE) await enviarWhatsApp(phone, relatorio);
  } else {
    const partes = [];
    let atual = '';
    for (const linha of relatorio.split('\n')) {
      if ((atual + linha).length > LIMITE) {
        partes.push(atual);
        atual = linha + '\n';
      } else {
        atual += linha + '\n';
      }
    }
    if (atual) partes.push(atual);

    for (let i = 0; i < partes.length; i++) {
      for (const phone of ENV.DR_PHONE) await enviarWhatsApp(phone, `(${i+1}/${partes.length})\n${partes[i]}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`✅ Relatório enviado para: ${ENV.DR_PHONE.join(", ")}`);
}

// ─── EXECUTA ──────────────────────────────────────────────────────
enviarRelatorio().catch(err => {
  console.error('❌ Erro na análise noturna:', err.response?.data || err.message);
  process.exit(1);
});
