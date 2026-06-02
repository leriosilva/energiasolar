// server.js
// Servidor Express: API REST + servico de arquivos estaticos do frontend.

import express from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { fileURLToPath } from "url";
import path from "path";

import { pool, migrate, query } from "./src/db.js";
import { normalizarLinha } from "./src/parsing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// Pequeno wrapper para tratar erros de rotas async.
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ erro: e.message || "Erro interno" });
});

/* ============================ TITULARES ============================ */

app.get("/api/titulares", wrap(async (req, res) => {
  const { rows } = await query(`
    SELECT t.*,
           (SELECT COUNT(*) FROM instalacoes i WHERE i.titular_id = t.id) AS qtd_instalacoes,
           (SELECT COUNT(*) FROM faturas f
              JOIN instalacoes i ON i.id = f.instalacao_id
            WHERE i.titular_id = t.id) AS qtd_faturas
    FROM titulares t
    ORDER BY t.nome ASC
  `);
  res.json(rows);
}));

app.post("/api/titulares", wrap(async (req, res) => {
  const { nome, documento, email, telefone, observacoes } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: "Nome e obrigatorio." });
  const { rows } = await query(
    `INSERT INTO titulares (nome, documento, email, telefone, observacoes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [nome.trim(), documento || null, email || null, telefone || null, observacoes || null]
  );
  res.status(201).json(rows[0]);
}));

app.put("/api/titulares/:id", wrap(async (req, res) => {
  const { nome, documento, email, telefone, observacoes } = req.body;
  const { rows } = await query(
    `UPDATE titulares SET nome=$1, documento=$2, email=$3, telefone=$4, observacoes=$5
     WHERE id=$6 RETURNING *`,
    [nome, documento || null, email || null, telefone || null, observacoes || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ erro: "Titular nao encontrado." });
  res.json(rows[0]);
}));

app.delete("/api/titulares/:id", wrap(async (req, res) => {
  await query(`DELETE FROM titulares WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

/* ============================ INSTALACOES ============================ */

app.get("/api/instalacoes", wrap(async (req, res) => {
  const { titular_id } = req.query;
  const params = [];
  let where = "";
  if (titular_id) { params.push(titular_id); where = "WHERE i.titular_id = $1"; }
  const { rows } = await query(`
    SELECT i.*, t.nome AS titular_nome,
           (SELECT COUNT(*) FROM faturas f WHERE f.instalacao_id = i.id) AS qtd_faturas
    FROM instalacoes i
    JOIN titulares t ON t.id = i.titular_id
    ${where}
    ORDER BY t.nome, i.codigo
  `, params);
  res.json(rows);
}));

app.post("/api/instalacoes", wrap(async (req, res) => {
  const { titular_id, codigo, apelido, endereco, distribuidora } = req.body;
  if (!titular_id || !codigo) return res.status(400).json({ erro: "titular_id e codigo sao obrigatorios." });
  const { rows } = await query(
    `INSERT INTO instalacoes (titular_id, codigo, apelido, endereco, distribuidora)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (titular_id, codigo) DO UPDATE SET
        apelido = COALESCE(EXCLUDED.apelido, instalacoes.apelido),
        endereco = COALESCE(EXCLUDED.endereco, instalacoes.endereco),
        distribuidora = COALESCE(EXCLUDED.distribuidora, instalacoes.distribuidora)
     RETURNING *`,
    [titular_id, String(codigo).trim(), apelido || null, endereco || null, distribuidora || null]
  );
  res.status(201).json(rows[0]);
}));

app.put("/api/instalacoes/:id", wrap(async (req, res) => {
  const { codigo, apelido, endereco, distribuidora } = req.body;
  const { rows } = await query(
    `UPDATE instalacoes SET codigo=$1, apelido=$2, endereco=$3, distribuidora=$4
     WHERE id=$5 RETURNING *`,
    [codigo, apelido || null, endereco || null, distribuidora || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ erro: "Instalacao nao encontrada." });
  res.json(rows[0]);
}));

app.delete("/api/instalacoes/:id", wrap(async (req, res) => {
  await query(`DELETE FROM instalacoes WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

/* ============================ FATURAS ============================ */

// Lista faturas (com info de titular/instalacao) para a tela de analise.
app.get("/api/faturas", wrap(async (req, res) => {
  const { titular_id, instalacao_id } = req.query;
  const params = [];
  const cond = [];
  if (titular_id) { params.push(titular_id); cond.push(`i.titular_id = $${params.length}`); }
  if (instalacao_id) { params.push(instalacao_id); cond.push(`f.instalacao_id = $${params.length}`); }
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  const { rows } = await query(`
    SELECT f.*, i.codigo AS instalacao_codigo, i.apelido AS instalacao_apelido,
           t.id AS titular_id, t.nome AS titular_nome
    FROM faturas f
    JOIN instalacoes i ON i.id = f.instalacao_id
    JOIN titulares t ON t.id = i.titular_id
    ${where}
    ORDER BY i.codigo, f.mes_key
  `, params);
  res.json(rows);
}));

app.delete("/api/faturas/:id", wrap(async (req, res) => {
  await query(`DELETE FROM faturas WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// Insere/atualiza uma fatura (upsert por instalacao + mes_key).
async function upsertFatura(instalacaoId, f) {
  await query(
    `INSERT INTO faturas
      (instalacao_id, mes, mes_key, ano, leitura, vencimento, consumo, dias, total, bandeira, saldo, inj, status, arquivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (instalacao_id, mes_key) DO UPDATE SET
       mes=EXCLUDED.mes, ano=EXCLUDED.ano, leitura=EXCLUDED.leitura, vencimento=EXCLUDED.vencimento,
       consumo=EXCLUDED.consumo, dias=EXCLUDED.dias, total=EXCLUDED.total, bandeira=EXCLUDED.bandeira,
       saldo=EXCLUDED.saldo, inj=EXCLUDED.inj, status=EXCLUDED.status, arquivo=EXCLUDED.arquivo`,
    [
      instalacaoId, f.mes, f.mesKey, f.ano, f.leitura, f.vencimento,
      f.consumo, f.dias, f.total, f.bandeira, f.saldo, f.inj, f.status, f.arquivo || null,
    ]
  );
}

// Garante instalacao por (titular, codigo), criando se necessario.
async function getOrCreateInstalacao(titularId, codigo, apelido) {
  const { rows } = await query(
    `INSERT INTO instalacoes (titular_id, codigo, apelido)
     VALUES ($1,$2,$3)
     ON CONFLICT (titular_id, codigo) DO UPDATE SET
       apelido = COALESCE(instalacoes.apelido, EXCLUDED.apelido)
     RETURNING id`,
    [titularId, String(codigo).trim(), apelido || null]
  );
  return rows[0].id;
}

/* ============================ UPLOAD EXCEL ============================ */

// Recebe um .xlsx/.csv e grava as faturas.
// O titular pode vir por (a) titular_id no form (todas as linhas vao para ele)
// ou (b) coluna "Titular" no proprio arquivo (cria/encontra por nome).
app.post("/api/upload/excel", upload.single("arquivo"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo enviado." });

  const titularIdForm = req.body.titular_id ? Number(req.body.titular_id) : null;

  const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const linhas = json
    .map(normalizarLinha)
    .filter((r) => r.instalacao || r.mes || r.total || r.consumo);

  if (!linhas.length) return res.status(400).json({ erro: "Planilha vazia ou sem colunas reconhecidas." });

  // cache de nome de titular -> id (para a opcao por coluna)
  const cacheTitular = new Map();
  async function resolverTitularPorNome(nome) {
    const key = nome.toLowerCase();
    if (cacheTitular.has(key)) return cacheTitular.get(key);
    const sel = await query(`SELECT id FROM titulares WHERE LOWER(nome)=LOWER($1) LIMIT 1`, [nome]);
    let id;
    if (sel.rows.length) id = sel.rows[0].id;
    else {
      const ins = await query(`INSERT INTO titulares (nome) VALUES ($1) RETURNING id`, [nome]);
      id = ins.rows[0].id;
    }
    cacheTitular.set(key, id);
    return id;
  }

  let gravadas = 0;
  const ignoradas = [];
  const instalacaoCache = new Map(); // `${titularId}:${codigo}` -> instalacaoId

  for (const f of linhas) {
    // resolve titular da linha
    let titularId = titularIdForm;
    if (!titularId && f.titular) titularId = await resolverTitularPorNome(f.titular);
    if (!titularId) { ignoradas.push({ motivo: "sem titular", linha: f }); continue; }
    if (!f.instalacao) { ignoradas.push({ motivo: "sem codigo de instalacao", linha: f }); continue; }
    if (!f.mesKey) { ignoradas.push({ motivo: "sem mes", linha: f }); continue; }

    const ck = `${titularId}:${f.instalacao}`;
    let instalacaoId = instalacaoCache.get(ck);
    if (!instalacaoId) {
      instalacaoId = await getOrCreateInstalacao(titularId, f.instalacao, f.apelido);
      instalacaoCache.set(ck, instalacaoId);
    }
    await upsertFatura(instalacaoId, f);
    gravadas++;
  }

  res.json({
    ok: true,
    total_linhas: linhas.length,
    gravadas,
    ignoradas: ignoradas.length,
    detalhe_ignoradas: ignoradas.slice(0, 20),
  });
}));

// Salva faturas extraidas via PDF no frontend (envio em lote JSON).
app.post("/api/faturas/lote", wrap(async (req, res) => {
  const { titular_id, faturas } = req.body;
  if (!titular_id) return res.status(400).json({ erro: "titular_id e obrigatorio." });
  if (!Array.isArray(faturas) || !faturas.length) return res.status(400).json({ erro: "Lista de faturas vazia." });

  let gravadas = 0;
  const cache = new Map();
  for (const f of faturas) {
    if (!f.instalacao || !f.mesKey) continue;
    let instId = cache.get(f.instalacao);
    if (!instId) { instId = await getOrCreateInstalacao(titular_id, f.instalacao, f.apelido); cache.set(f.instalacao, instId); }
    await upsertFatura(instId, f);
    gravadas++;
  }
  res.json({ ok: true, gravadas });
}));

/* ============================ TEMPLATE EXCEL ============================ */

// Gera e baixa um modelo de planilha com as colunas esperadas.
app.get("/api/template", (req, res) => {
  const headers = [
    "Titular", "Instalação", "Apelido", "Mês", "Leitura Atual", "Vencimento",
    "Consumo Faturado (kWh)", "# Dias", "Total a pagar", "Bandeira",
    "Saldo atualizado de energia em kWh", "Energia injetada no mês em kWh", "Status",
  ];
  const exemplo = {
    "Titular": "Empresa Exemplo LTDA",
    "Instalação": "1234567890",
    "Apelido": "Matriz",
    "Mês": "01/2025",
    "Leitura Atual": "15/01/2025",
    "Vencimento": "28/01/2025",
    "Consumo Faturado (kWh)": "1234,000",
    "# Dias": 30,
    "Total a pagar": "R$ 1.234,56",
    "Bandeira": "VERDE",
    "Saldo atualizado de energia em kWh": "120,5",
    "Energia injetada no mês em kWh": "80,0",
    "Status": "OK",
  };
  const ws = XLSX.utils.json_to_sheet([exemplo], { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Faturas");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="modelo_faturas_energia.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

/* ============================ HEALTHCHECK ============================ */
app.get("/api/health", wrap(async (req, res) => {
  await query("SELECT 1");
  res.json({ ok: true, ts: new Date().toISOString() });
}));

// SPA fallback (qualquer rota nao-API devolve o index)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================ BOOT ============================ */
async function start() {
  try {
    await migrate();
  } catch (e) {
    console.error("[boot] Falha ao migrar o banco:", e.message);
  }
  app.listen(PORT, () => console.log(`[boot] Servidor ouvindo na porta ${PORT}`));
}
start();
