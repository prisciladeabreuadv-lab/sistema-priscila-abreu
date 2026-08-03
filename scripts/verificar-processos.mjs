#!/usr/bin/env node
/**
 * Verificação diária de publicações (DJEN, por OAB) e movimentações (DataJud, por número do processo).
 * Roda via GitHub Actions (agendado), sem depender do navegador aberto.
 *
 * Usa a SERVICE ROLE KEY do Supabase, que ignora as políticas de RLS — por isso ela nunca deve
 * aparecer no index.html nem em qualquer lugar público, só nos "Secrets" do repositório no GitHub.
 *
 * Lê e grava direto na tabela `dados_sistema` (mesma tabela usada pelo sistema no navegador),
 * então tudo o que essa automação encontrar aparece automaticamente pro usuário na próxima vez
 * que ele abrir o sistema.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Chave pública (anon) do Supabase — a mesma já embutida no index.html, usada só para
// chamar a Edge Function de IA (gemini-proxy). Não é segredo, mas fica aqui por conveniência.
const SUPABASE_ANON_KEY = "sb_publishable_hIKdT8oUKKHdcxIGkN904Q_gK7vvhkx";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nos Secrets do repositório (Settings > Secrets and variables > Actions).");
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

// ---------- Mesma lógica de detecção de tribunal e endpoints do DataJud usada no sistema ----------
const DATAJUD_ENDPOINTS = {
  TJRJ: "https://api-publica.datajud.cnj.jus.br/api_publica_tjrj/_search",
  TJSP: "https://api-publica.datajud.cnj.jus.br/api_publica_tjsp/_search",
  TRF2: "https://api-publica.datajud.cnj.jus.br/api_publica_trf2/_search",
  TST: "https://api-publica.datajud.cnj.jus.br/api_publica_tst/_search",
};

function detectarTribunalPorNumero(numero) {
  // Formato CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO — dígito J = segmento de justiça, TR = tribunal
  const limpo = (numero || "").replace(/\D/g, "");
  if (limpo.length < 20) return "TJRJ";
  const j = limpo[13];
  const tr = limpo.slice(14, 16);
  if (j === "8" && tr === "19") return "TJRJ";
  if (j === "8" && tr === "26") return "TJSP";
  if (j === "4" && tr === "02") return "TRF2";
  if (j === "5") return "TST";
  return "TJRJ";
}

function fmtDataHoje() {
  return new Date().toISOString().slice(0, 10);
}

function uid() {
  return `${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

// Soma N dias (úteis ou corridos) a partir de uma data-base ISO, para sugerir uma data de prazo.
function adicionarDias(dataBaseISO, quantidade, diasUteis) {
  if (!dataBaseISO || !quantidade) return "";
  let d = new Date(dataBaseISO + "T00:00:00");
  let restantes = quantidade;
  while (restantes > 0) {
    d.setDate(d.getDate() + 1);
    if (diasUteis) {
      const diaSemana = d.getDay();
      if (diaSemana === 0 || diaSemana === 6) continue;
    }
    restantes--;
  }
  return d.toISOString().slice(0, 10);
}

// Usa a mesma Edge Function de IA (gemini-proxy) do sistema para analisar se uma publicação
// exige a prática de algum ato com prazo. NUNCA cria o prazo sozinha — só sugere; a
// confirmação e o registro do prazo de fato continuam sendo feitos manualmente pela usuária
// dentro do sistema (aba Intimações).
async function analisarPublicacaoIA(texto) {
  const vazio = { temPrazo: false, diasPrazo: null, diasUteis: true, descricaoAto: "", confianca: "baixa" };
  if (!texto || !texto.trim()) return vazio;
  try {
    const systemPrompt = `Você é um assistente jurídico brasileiro especializado em Direito Civil e Direito Imobiliário. Você recebe o texto de uma publicação do Diário de Justiça Eletrônico Nacional (DJEN) e deve analisar SOMENTE se ela exige a prática de algum ato processual pela parte/advogado (ex: contestação, réplica, recurso, manifestação, cumprimento de decisão, emenda à inicial) com prazo em dias. Se for apenas informativa (mero andamento, decisão sem exigência de ato da parte, designação de audiência sem necessidade de manifestação prévia, etc.), considere que não há prazo. Responda APENAS com um JSON no formato exato, sem nenhum texto antes ou depois: {"temPrazo": true ou false, "diasPrazo": número ou null, "diasUteis": true ou false, "descricaoAto": "descrição curta do ato", "confianca": "alta" ou "media" ou "baixa"}. Use diasUteis:true salvo se o texto indicar prazo em dias corridos.`;
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/gemini-proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ systemPrompt, userContent: texto.slice(0, 3000), comBusca: false }),
    });
    const data = await resp.json();
    const resposta = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n") || "";
    const jsonMatch = resposta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return vazio;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      temPrazo: !!parsed.temPrazo,
      diasPrazo: typeof parsed.diasPrazo === "number" ? parsed.diasPrazo : null,
      diasUteis: parsed.diasUteis !== false,
      descricaoAto: parsed.descricaoAto || "",
      confianca: parsed.confianca || "baixa",
    };
  } catch (e) {
    console.error("Erro na análise de IA da publicação:", e.message);
    return vazio;
  }
}

// ---------- DataJud: andamentos por número de processo ----------
async function buscarAndamentosDataJud(numeroProcesso, apiKey) {
  const numeroLimpo = (numeroProcesso || "").replace(/\D/g, "");
  if (numeroLimpo.length < 20) return [];
  const tribunal = detectarTribunalPorNumero(numeroProcesso);
  const endpoint = DATAJUD_ENDPOINTS[tribunal] || DATAJUD_ENDPOINTS.TJRJ;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `APIKey ${apiKey}` },
    body: JSON.stringify({ query: { match: { numeroProcesso: numeroLimpo } } }),
  });
  if (!resp.ok) {
    console.error(`DataJud (${tribunal}) retornou ${resp.status} para o processo ${numeroProcesso}`);
    return [];
  }
  const data = await resp.json();
  const hits = data?.hits?.hits || [];
  if (hits.length === 0) return [];
  const fonte = hits[0]._source || {};
  const movimentos = fonte.movimentos || [];
  return movimentos
    .map((m) => ({ data: (m.dataHora || "").slice(0, 10), desc: m.nome || "Movimentação", fonte: "datajud" }))
    .filter((m) => m.data)
    .sort((a, b) => a.data.localeCompare(b.data));
}

// ---------- DJEN: publicações por número/UF da OAB ----------
async function buscarIntimacoesDJEN({ oabNumero, oabUf, dias = 7 }) {
  if (!oabNumero || !oabUf) return [];
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - dias * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroOab=${encodeURIComponent(oabNumero)}&ufOab=${encodeURIComponent(oabUf)}&dataDisponibilizacaoInicio=${fmt(inicio)}&dataDisponibilizacaoFim=${fmt(hoje)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`DJEN retornou ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  const itensBrutos = data?.items || data?.content || [];

  // Proteção extra: números de OAB se repetem entre estados, então descartamos qualquer
  // publicação cujo texto não mencione explicitamente o número+UF informados, mesmo que a
  // API tenha retornado (caso o filtro de UF do lado do governo não seja confiável).
  const numeroLimpo = String(oabNumero).replace(/\D/g, "");
  const ufLimpa = String(oabUf).trim().toUpperCase();
  const padraoOab = new RegExp(`${ufLimpa}[\\s-]*0*${numeroLimpo}\\b`, "i");
  const itens = itensBrutos.filter((it) => padraoOab.test(it.texto || it.conteudo || ""));

  return itens.map((it) => ({
    id: it.id || `${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    data: (it.data_disponibilizacao || it.dataDisponibilizacao || "").slice(0, 10),
    orgao: it.orgao?.nome || it.nomeOrgao || "—",
    numeroProcesso: it.numero_processo || it.numeroProcesso || "",
    texto: it.texto || it.conteudo || "",
    vinculada: false,
  }));
}

// ---------- Acesso à tabela dados_sistema via REST (PostgREST) ----------
async function pegarLinha(chave) {
  const url = `${REST}/dados_sistema?chave=eq.${encodeURIComponent(chave)}&select=user_id,valor&limit=1`;
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`Falha ao ler '${chave}': ${resp.status} ${await resp.text()}`);
  const rows = await resp.json();
  return rows[0] || null;
}

async function salvarLinha(userId, chave, valor) {
  const url = `${REST}/dados_sistema?on_conflict=user_id,chave`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ user_id: userId, chave, valor, atualizado_em: new Date().toISOString() }]),
  });
  if (!resp.ok) throw new Error(`Falha ao salvar '${chave}': ${resp.status} ${await resp.text()}`);
}

// ---------- Rotina principal ----------
async function main() {
  const configRow = await pegarLinha("config");
  if (!configRow) {
    console.log("Nenhuma configuração encontrada no banco ainda — o sistema precisa ser usado/configurado ao menos uma vez. Encerrando sem erro.");
    return;
  }

  const userId = configRow.user_id;
  const config = configRow.valor || {};
  const temDataJud = !!config.datajudApiKey;
  const temDJEN = !!(config.oabNumero && config.oabUf);

  if (!temDataJud && !temDJEN) {
    console.log("DataJud e DJEN não estão configurados em Configurações. Nada a verificar hoje.");
    return;
  }

  const processosRow = await pegarLinha("processos");
  let processos = processosRow?.valor || [];

  const intimacoesRow = await pegarLinha("intimacoes");
  let intimacoes = intimacoesRow?.valor || [];

  let totalAndamentosDataJud = 0;
  let totalMovimentacoesDJEN = 0;
  const processosAtualizadosDJEN = new Set();
  let processosCriadosDJEN = 0;
  let intimacoesPendentesNovas = 0;

  // 1) DataJud: processo a processo, pelo número
  if (temDataJud) {
    for (const p of processos) {
      if (p.arquivado || !p.numero) continue;
      try {
        const encontrados = await buscarAndamentosDataJud(p.numero, config.datajudApiKey);
        const jaExistem = new Set((p.andamentos || []).map((a) => `${a.data}|${a.desc}`));
        const novos = encontrados.filter((a) => !jaExistem.has(`${a.data}|${a.desc}`));
        if (novos.length > 0) {
          p.andamentos = [...(p.andamentos || []), ...novos];
          totalAndamentosDataJud += novos.length;
        }
      } catch (e) {
        console.error(`Erro DataJud no processo ${p.numero}:`, e.message);
      }
    }
  }

  // 2) DJEN: publicações recentes pela OAB — casa com processos cadastrados pelo número e,
  // quando a publicação traz um número de processo ainda não cadastrado, cria o processo
  // automaticamente (sem cliente vinculado, para revisão e complementação depois).
  if (temDJEN) {
    try {
      const encontradas = await buscarIntimacoesDJEN({ oabNumero: config.oabNumero, oabUf: config.oabUf, dias: 7 });
      const jaTemIds = new Set(intimacoes.map((i) => i.id));
      const novasBrutas = encontradas.filter((i) => !jaTemIds.has(i.id));
      const paraIntimacoes = [];
      for (const it of novasBrutas) {
        const numLimpo = (it.numeroProcesso || "").replace(/\D/g, "");
        let proc = numLimpo ? processos.find((p) => (p.numero || "").replace(/\D/g, "") === numLimpo) : null;

        if (!proc && numLimpo) {
          proc = {
            id: uid(),
            numero: it.numeroProcesso || "",
            clienteId: "",
            sistema: "PJe",
            classificacao: "",
            vara: it.orgao || "",
            autor: "",
            reu: "",
            assunto: "",
            valorCausa: "",
            prazo: "",
            prazoAto: "",
            obs: "Processo cadastrado automaticamente a partir de uma publicação do DJEN. Confira e complete os dados (cliente, partes, assunto).",
            arquivado: false,
            andamentos: [],
          };
          processos.push(proc);
          processosCriadosDJEN++;
        }

        const analiseIA = await analisarPublicacaoIA(it.texto);

        if (proc) {
          const desc = `Publicação DJEN: ${(it.texto || "").slice(0, 200) || "—"}`;
          const jaExiste = (proc.andamentos || []).some((a) => a.desc === desc && a.data === it.data);
          if (!jaExiste) {
            proc.andamentos = [...(proc.andamentos || []), { data: it.data || fmtDataHoje(), desc, fonte: "djen" }];
            totalMovimentacoesDJEN++;
            processosAtualizadosDJEN.add(proc.id);
          }
          paraIntimacoes.push({ ...it, vinculada: true, processoId: proc.id, analisadaIA: true, ...analiseIA, revisada: false });
        } else {
          intimacoesPendentesNovas++;
          paraIntimacoes.push({ ...it, analisadaIA: true, ...analiseIA, revisada: false });
        }
      }
      if (paraIntimacoes.length > 0) intimacoes = [...paraIntimacoes, ...intimacoes];
    } catch (e) {
      console.error("Erro DJEN:", e.message);
    }
  }

  if (totalAndamentosDataJud > 0 || totalMovimentacoesDJEN > 0 || processosCriadosDJEN > 0) {
    await salvarLinha(userId, "processos", processos);
  }
  if (intimacoesPendentesNovas > 0 || totalMovimentacoesDJEN > 0) {
    await salvarLinha(userId, "intimacoes", intimacoes);
  }

  console.log(
    `Verificação concluída: ${totalAndamentosDataJud} andamento(s) novo(s) via DataJud; ` +
    `${totalMovimentacoesDJEN} movimentação(ões) via DJEN em ${processosAtualizadosDJEN.size} processo(s); ` +
    `${processosCriadosDJEN} processo(s) novo(s) cadastrado(s) automaticamente; ` +
    `${intimacoesPendentesNovas} publicação(ões) sem número de processo identificável.`
  );
}

main().catch((e) => {
  console.error("Falha na verificação diária:", e);
  process.exit(1);
});
