// Extrai do título do produto: unidades por embalagem e dose diária (quando informada).
// Mesmo código usado no seed do banco e na importação de novos produtos.

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Subcategorias consideradas "consumíveis com dose"
const SUBS_OK = /suple|suuple|vitamin|oleos naturais|saude infantil|saude da mulher/i;

const ADJ = '(?:(?:veg(?:an|gie|etarian)?|liq(?:uid)?|mini|embo|fish|delayed[\\s-]?release|dr|chewable|vegetarian)[\\s-]+)*';
const UNIT_LIST = [
  'vcaps?', 'vegcaps?', 'drcaps?', 'vgels?', 'vegels?',
  'soft[\\s-]?gels?', 'softgls?', 'sofgels?', 'sft[\\s-]?gels?', 'sfgs?', 'sgls?', 'sgels?', 'sg', 'fsg',
  'mini[\\s-]?tabs?', 'minis', 'fishies', 'tabs?', 'tablets?', 'tabls?', 'tbls?', 'tb', 'caplets?', 'comprimidos?', 'comps?',
  'caps?', 'capsules?', 'capsulas?', 'capsu', 'cps', 'cp', 'c',
  'lozenges?', 'loz', 'pastilhas?', 'chewables?', 'chwbls', 'chews?', 'gumm(?:y|ies)', 'gomas?',
  'servings?', 'pkts?', 'tabletes?', 'comprs?', 'vg', 'doses?', 'porcoes?', 'packets?', 'sachets?', 'sticks?', 'stick[\\s-]?packs?', 'bags',
  'ct', 'count', 'unid(?:ades)?', 'un'
];
const UNIT = '(?<u>' + UNIT_LIST.join('|') + ')';
// unidade ANTES do número ("Tab-100"): sem 'c'/'cp' para não confundir com "Vitamin C-1000"
const UNIT_PRE = '(?<u>' + UNIT_LIST.filter(u => u !== 'c' && u !== 'cp').join('|') + ')';

const PATS = [
  new RegExp('(?<![\\d.,])(?<n>\\d{1,4})\\s*[-x]?\\s*' + ADJ + UNIT + '\\b', 'gi'),          // "100 caps", "60 Veg Caps"
  new RegExp('box\\s+of\\s+(?<n>\\d{1,4})(?<u>)', 'gi'),                                     // "Box of 30"
  new RegExp('\\b' + UNIT_PRE + '\\s*[-x:]?\\s*(?<n>\\d{1,4})(?![\\d.,]*\\s*(?:mg|mcg|g|ml|iu|ui|%|bi))\\b', 'gi'), // "Tab-100"
];
const BULK = /(?<![\w.])\d+(?:[.,]\d+)?\s*(?:lbs?|oz|fl\.?\s*oz|ml|l|kg|g|gr|gramas)\b/i;
const MULT = /^\s*(\d+)\s*(?:x|unid\.?|un\.?|unidades|frascos?)\b/i;
const DOSE = /(\d)\s*(?:compr\w*\.?|caps?\w*\.?|tabs?\w*\.?)?\s*(?:ao|por)\s*dia|(\d)\s*(?:\w+\s)?(?:per|a)\s*day/i;

function extrairUnidades(nome) {
  const n = norm(nome);
  let best = null;
  for (const p of PATS) {
    p.lastIndex = 0;
    let m;
    while ((m = p.exec(n))) {
      const q = parseInt(m.groups.n, 10), u = (m.groups.u || '').toLowerCase();
      if (u === 'un' || u === 'unid' || u === 'unidades') continue;
      if (q < 5 || q > 2000) continue;
      best = { q, u }; break;
    }
    if (best) break;
  }
  if (!best) return { unidades: null, forma: null };
  let q = best.q;
  const mm = n.match(MULT);
  if (mm && [2, 3, 4, 5, 6].includes(+mm[1]) && n.indexOf('=') < 0) q *= +mm[1];
  return { unidades: q, forma: best.u || null };
}

function extrairDose(nome) {
  const m = norm(nome).match(DOSE);
  return m ? parseInt(m[1] || m[2], 10) : null;
}

function ehConsumivel(subcategoria) { return SUBS_OK.test(norm(subcategoria)); }

function analisar(nome) {
  const { unidades, forma } = extrairUnidades(nome);
  const status = unidades ? 'ok' : (BULK.test(norm(nome)) ? 'granel' : 'nao_encontrado');
  return { unidades, forma, dose_dia: extrairDose(nome), status };
}

module.exports = { analisar, ehConsumivel, norm };
