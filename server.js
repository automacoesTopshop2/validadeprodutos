const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { analisar, ehConsumivel } = require('./extrator');

const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(express.json({ limit: '5mb' }));

// Senha opcional para o site inteiro (defina APP_PASSWORD no Railway)
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const [, b64] = h.split(' ');
    const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (pass === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Validade"').status(401).send('Acesso restrito');
  });
}

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

app.get('/api/produtos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT codigo, nome, unidades, forma, dose_dia::float AS dose_dia, dias_consumo, status, origem, atualizado_em, atualizado_por
       FROM produtos_consumo`);
  res.json(rows);
});

// Salva edição manual (unidades, dose, ignorar)
app.put('/api/produtos/:codigo', async (req, res) => {
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
    [codigo, b.nome || null, unidades, dose, dias, status, (b.usuario || '').slice(0, 60) || null]);
  res.json(rows[0]);
});

// Importa uma nova planilha de produtos (mesmo formato do Produtos_analise.xlsx), já processada no navegador
app.post('/api/importar', async (req, res) => {
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

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erro: err.message }); });

migrar()
  .then(() => app.listen(PORT, () => console.log('Rodando na porta ' + PORT)))
  .catch(e => { console.error('Falha ao iniciar', e); process.exit(1); });
