// Uso: node scripts/gerar-seed.js Produtos_analise.xlsx data/produtos_seed.json
const XLSX = require('xlsx');
const fs = require('fs');
const { analisar, ehConsumivel } = require('../extrator');

function lerPlanilha(arquivo) {
  const wb = XLSX.readFile(arquivo);
  const out = new Map();
  for (const nomeAba of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { defval: '' });
    for (const r of rows) {
      const codigo = String(r['SKU'] ?? '').trim();
      if (!codigo || out.has(codigo)) continue;
      if (!ehConsumivel(r['Subcategoria'])) continue;
      const nome = String(r['Item'] ?? '').trim();
      out.set(codigo, { codigo, nome, subcategoria: String(r['Subcategoria']).trim(), ...analisar(nome) });
    }
  }
  return [...out.values()];
}

module.exports = { lerPlanilha };

if (require.main === module) {
  const [src, dst] = process.argv.slice(2);
  const itens = lerPlanilha(src);
  fs.writeFileSync(dst, JSON.stringify(itens));
  const c = {}; itens.forEach(i => c[i.status] = (c[i.status] || 0) + 1);
  console.log(itens.length, 'produtos', c);
}
