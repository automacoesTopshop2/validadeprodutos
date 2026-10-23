const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const { analisar, ehConsumivel } = require('./extrator');

const STOCKFY_API = (process.env.STOCKFY_API_URL || 'https://api.stockfylog.com').replace(/\/$/, '');
const SESSAO_HORAS = 12;

const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(express.json({ limit: '5mb' }));

// ── Sessões: o login do site é o login do Stockfy ──────────────────
// A senha nunca é guardada nem registrada em log; só o token devolvido pelo Stockfy, em memória.
const sessoes = new Map(); // sid -> { token, usuario, depositantes, depositanteId, expira }

function lerSessao(req) {
  const sid = req.get('X-Session');
  const s = sid && sessoes.get(sid);
  if (!s) return null;
  if (s.expira < Date.now()) { sessoes.delete(sid); return null; }
  return s;
}
function exigirSessao(req, res, next) {
  const s = lerSessao(req);
  if (!s) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.', relogar: true });
  req.sessao = s;
  next();
}
setInterval(() => { const t = Date.now(); for (const [k, v] of sessoes) if (v.expira < t) sessoes.delete(k); }, 30 * 60 * 1000).unref();

async function stockfy(sessao, caminho, params) {
  const url = new URL(STOCKFY_API + caminho);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + sessao.token, Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) { const e = new Error('Token do Stockfy expirado'); e.status = 401; e.relogar = true; throw e; }
  if (r.status === 404) return [];
  if (!r.ok) { const e = new Error('Stockfy respondeu HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200)); e.status = 502; throw e; }
  const j = await r.json();
  return Array.isArray(j) ? j : (j.data || j.items || j.itens || []);
}

const texto = v => (v && typeof v === 'object') ? (v.descricao || v.titulo || v.nome || v.description || '') : (v == null ? '' : String(v));

async function migrar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos_consumo (
      codigo         TEXT PRIMARY KEY,
      nome           TEXT,
      subcategoria   TEXT,
      unidades       INTEGER,          -- unidades por embalagem (caps/tabs/porções)
      forma          TEXT,             -- caps, tabs, softgels...
      dose_dia       NUMERIC,          -- unidades consumidas por dia (null = padrão 1)
      status         TEXT NOT NULL,    -- ok | granel | nao_encontrado | ignorado
      origem         TEXT NOT NULL DEFAULT 'titulo', -- titulo | manual
      atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_por TEXT
    )`);
  await pool.query(`ALTER TABLE produtos_consumo ADD COLUMN IF NOT EXISTS dias_consumo INTEGER`); // duração informada direto (sobrepõe unidades ÷ dose)
  const { rows } = await pool.query('SELECT count(*)::int n FROM produtos_consumo');
  if (rows[0].n === 0) {
    const seed = require('./data/produtos_seed.json');
    await importar(seed);
    console.log(`Seed inicial: ${seed.length} produtos`);
  } else {
    await reanalisarTitulos();
  }
}

// A cada deploy, reaplica o extrator atual nos produtos que vieram do título (corrige melhorias na regra).
async function reanalisarTitulos() {
  const { rows } = await pool.query(`SELECT codigo, nome, unidades, forma, dose_dia::float AS dose_dia, status FROM produtos_consumo WHERE origem = 'titulo'`);
  let n = 0;
  for (const r of rows) {
    const a = analisar(r.nome);
    if (a.unidades !== r.unidades || a.status !== r.status || (a.dose_dia ?? null) !== (r.dose_dia ?? null)) {
      await pool.query(`UPDATE produtos_consumo SET unidades=$2, forma=$3, dose_dia=$4, status=$5, atualizado_em=now() WHERE codigo=$1 AND origem='titulo'`,
        [r.codigo, a.unidades, a.forma, a.dose_dia, a.status]);
      n++;
    }
  }
  if (n) console.log(`Reanálise de títulos: ${n} produtos atualizados`);
}

// Insere/atualiza a partir do título. Nunca sobrescreve o que foi editado manualmente.
async function importar(itens) {
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    for (const i of itens) {
      const r = await client.query(`
        INSERT INTO produtos_consumo (codigo, nome, subcategoria, unidades, forma, dose_dia, status, origem)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'titulo')
        ON CONFLICT (codigo) DO UPDATE SET
          nome = EXCLUDED.nome, subcategoria = EXCLUDED.subcategoria,
          unidades = EXCLUDED.unidades, forma = EXCLUDED.forma,
          dose_dia = EXCLUDED.dose_dia, status = EXCLUDED.status, atualizado_em = now()
        WHERE produtos_consumo.origem <> 'manual'`,
        [i.codigo, i.nome, i.subcategoria, i.unidades, i.forma, i.dose_dia, i.status]);
      n += r.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return n;
}

// Login: repassa usuário/senha ao Stockfy e abre uma sessão no site
app.post('/api/login', async (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ erro: 'Informe usuário e senha' });
  let r;
  try {
    r = await fetch(STOCKFY_API + '/api/Auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: String(usuario), password: String(senha) }),
    });
  } catch (e) { return res.status(502).json({ erro: 'Não foi possível conectar ao Stockfy' }); }
  if (r.status === 401 || r.status === 400) return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
  if (!r.ok) return res.status(502).json({ erro: 'Stockfy respondeu HTTP ' + r.status });
  const j = await r.json();
  if (!j.token) return res.status(502).json({ erro: 'Stockfy não devolveu token' });
  const depositantes = (j.empresaDepositantes || []).map(d => ({ id: d.empresaDepositanteId, nome: [...new Set([d.empresa, d.depositante].filter(Boolean))].join(' · ') }));
  const sid = crypto.randomBytes(24).toString('hex');
  sessoes.set(sid, {
    token: j.token, usuario: String(usuario).slice(0, 60), depositantes,
    depositanteId: depositantes.length === 1 ? depositantes[0].id : null,
    expira: Date.now() + SESSAO_HORAS * 3600 * 1000,
  });
  console.log(`Login: ${String(usuario).slice(0, 60)}`);
  res.json({ sessao: sid, usuario: String(usuario).slice(0, 60), depositantes });
});

app.post('/api/logout', (req, res) => { const sid = req.get('X-Session'); if (sid) sessoes.delete(sid); res.json({ ok: true }); });

app.get('/api/sessao', exigirSessao, (req, res) => {
  res.json({ usuario: req.sessao.usuario, depositantes: req.sessao.depositantes, depositanteId: req.sessao.depositanteId });
});

// Estoque completo do Stockfy, já no formato da planilha exportada
app.get('/api/stockfy/estoque', exigirSessao, async (req, res, next) => {
  try {
    const dep = req.query.depositante || req.sessao.depositanteId;
    const LIM = 1000, linhas = [];
    for (let page = 1; page <= 300; page++) {
      const lote = await stockfy(req.sessao, '/api/Estoque/GetEstoques', { EmpresaDepositanteId: dep, Page: page, Limit: LIM });
      for (const e of lote) {
        if (!(Number(e.quantidade) > 0)) continue;
        linhas.push({
          'Endereço': e.endereco || '', 'Código': e.codigoExterno || '', 'Produto': e.produto || '',
          'Lote': e.variacao || '', 'Quantidade': Number(e.quantidade) || 0,
          'Validade': e.vencimento ? String(e.vencimento).slice(0, 10) : '',
          'Tipo endereço': e.tipoEndereco || '', 'LPN': e.lpn || '',
        });
      }
      if (lote.length < LIM) break;
    }
    res.json({ atualizadoEm: new Date().toISOString(), linhas });
  } catch (e) { if (e.relogar) return res.status(401).json({ erro: e.message, relogar: true }); next(e); }
});

// Inclui no cadastro de consumo os suplementos novos do Stockfy (não altera os que já existem)
app.post('/api/stockfy/sincronizar-produtos', exigirSessao, async (req, res, next) => {
  try {
    const dep = req.body && req.body.depositante || req.sessao.depositanteId;
    const prods = await stockfy(req.sessao, '/api/Produto/GetProdutos', { EmpresaDepositanteId: dep });
    const { rows } = await pool.query('SELECT codigo FROM produtos_consumo');
    const existentes = new Set(rows.map(r => r.codigo));
    const novos = [];
    for (const p of prods) {
      const codigo = String(p.codigoExterno || '').trim();
      const sub = texto(p.subCategoria);
      if (!codigo || existentes.has(codigo) || !ehConsumivel(sub)) continue;
      existentes.add(codigo);
      const nome = String(p.nome || '').trim();
      novos.push({ codigo, nome, subcategoria: sub, ...analisar(nome) });
    }
    const n = novos.length ? await importar(novos) : 0;
    if (n) console.log(`Sincronização Stockfy: ${n} suplementos novos`);
    res.json({ produtosStockfy: prods.length, novos: n });
  } catch (e) { if (e.relogar) return res.status(401).json({ erro: e.message, relogar: true }); next(e); }
});

app.get('/api/produtos', exigirSessao, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT codigo, nome, unidades, forma, dose_dia::float AS dose_dia, dias_consumo, status, origem, atualizado_em, atualizado_por
       FROM produtos_consumo`);
  res.json(rows);
});

// Salva edição manual (unidades, dose, ignorar)
app.put('/api/produtos/:codigo', exigirSessao, async (req, res) => {
  const codigo = String(req.params.codigo).trim();
  const b = req.body || {};
  const int = v => (v === '' || v == null ? null : Math.round(Number(v)));
  const num = v => (v === '' || v == null ? null : Number(v));
  const unidades = int(b.unidades), dose = num(b.dose_dia), dias = int(b.dias_consumo);
  if (unidades !== null && !(unidades > 0 && unidades <= 10000)) return res.status(400).json({ erro: 'Unidades inválidas' });
  if (dose !== null && !(dose > 0 && dose <= 50)) return res.status(400).json({ erro: 'Dose inválida' });
  if (dias !== null && !(dias > 0 && dias <= 5000)) return res.status(400).json({ erro: 'Dias de consumo inválidos' });
  const status = b.ignorar ? 'ignorado' : ((unidades || dias) ? 'ok' : 'nao_encontrado');
  const { rows } = await pool.query(`
    INSERT INTO produtos_consumo (codigo, nome, unidades, dose_dia, dias_consumo, status, origem, atualizado_por)
    VALUES ($1,$2,$3,$4,$5,$6,'manual',$7)
    ON CONFLICT (codigo) DO UPDATE SET
      unidades = EXCLUDED.unidades, dose_dia = EXCLUDED.dose_dia, dias_consumo = EXCLUDED.dias_consumo,
      status = EXCLUDED.status, nome = COALESCE(produtos_consumo.nome, EXCLUDED.nome),
      origem = 'manual', atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por
    RETURNING codigo, nome, unidades, forma, dose_dia::float AS dose_dia, dias_consumo, status, origem, atualizado_em, atualizado_por`,
    [codigo, b.nome || null, unidades, dose, dias, status, req.sessao.usuario]);
  res.json(rows[0]);
});

// Importa uma nova planilha de produtos (mesmo formato do Produtos_analise.xlsx), já processada no navegador
app.post('/api/importar', exigirSessao, async (req, res) => {
  const linhas = Array.isArray(req.body) ? req.body : [];
  const itens = [];
  const vistos = new Set();
  for (const r of linhas) {
    const codigo = String(r.codigo || '').trim();
    if (!codigo || vistos.has(codigo) || !ehConsumivel(r.subcategoria)) continue;
    vistos.add(codigo);
    const nome = String(r.nome || '').trim();
    itens.push({ codigo, nome, subcategoria: String(r.subcategoria).trim(), ...analisar(nome) });
  }
  const n = await importar(itens);
  res.json({ consumiveis: itens.length, atualizados: n });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500).json({ erro: err.message }); });

migrar()
  .then(() => app.listen(PORT, () => console.log('Rodando na porta ' + PORT)))
  .catch(e => { console.error('Falha ao iniciar', e); process.exit(1); });
