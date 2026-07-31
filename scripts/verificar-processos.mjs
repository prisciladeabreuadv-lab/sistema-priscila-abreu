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
  const itens = data?.items || data?.content || [];
  return itens.map((it) => ({
    id: it.id || `${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    data: (it.data_disponibilizacao || it.dataDisponibilizacao || "").slice(0, 10),
    orgao: it.orgao?.nome || it.nomeOrgao || "—",
    numeroProcesso: it.numero_processo ||
