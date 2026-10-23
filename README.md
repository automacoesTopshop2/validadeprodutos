# validadeprodutos

Análise de validade do estoque (exportação do Stockfy) com **regra por prazo de consumo** para suplementos.

## Regra

- **Suplementos** (cadastro de consumo no banco):
  `limite de venda = validade − (unidades ÷ dose diária − 1) − dias de entrega`
  Aparece em *Validade curta* quando faltam até N dias (antecedência) para o limite. Dose não cadastrada = 1/dia (marcada com `*`).
- **Demais produtos**: validade em até 90 dias.
- **Pendentes de cadastro**: suplemento cujo título não traz a quantidade (pó, líquido etc.) só aparece para preencher quando a validade estiver a até **180 dias**.

Unidades e dose são extraídas do título (`Tab-100`, `60 Veg Caps`, `2 compr. ao dia`...). Edições feitas no site ficam marcadas como `manual` e **não são sobrescritas** quando a lista de produtos é reimportada.

## Deploy no Railway

1. Suba este repositório no GitHub e crie um projeto no Railway a partir dele.
2. No projeto, **+ New → Database → PostgreSQL**.
3. No serviço do site, em *Variables*, adicione `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
4. (Opcional) `APP_PASSWORD` = senha para proteger o site (login com qualquer usuário + essa senha).
5. Deploy. Na primeira subida a tabela é criada e populada com `data/produtos_seed.json` (2.516 suplementos).
6. Em *Settings → Networking*, gere o domínio público.

## Atualizar a lista de produtos

No site, botão **"Atualizar lista de produtos"** → envie a planilha no formato `Produtos_analise.xlsx` (colunas SKU, Subcategoria, Item).

## API

- `GET  /api/produtos` — cadastro de consumo
- `PUT  /api/produtos/:codigo` — `{unidades, dose_dia, ignorar, usuario}`
- `POST /api/importar` — `[{codigo, subcategoria, nome}]`

## Local

```
DATABASE_URL=postgres://... npm start
```
