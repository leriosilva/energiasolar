// server.js
// Servidor Express: API REST + servico de arquivos estaticos do frontend.

import express from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { fileURLToPath } from "url";
import path from "path";

import { pool, migrate, query } from "./src/db.js";
import { normalizarLinha, normalizarCodigo } from "./src/parsing.js";
import crypto from "crypto";

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
  const cod = normalizarCodigo(codigo);
  const { rows } = await query(
    `INSERT INTO instalacoes (titular_id, codigo, apelido, endereco, distribuidora)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (titular_id, codigo) DO UPDATE SET
        apelido = COALESCE(EXCLUDED.apelido, instalacoes.apelido),
        endereco = COALESCE(EXCLUDED.endereco, instalacoes.endereco),
        distribuidora = COALESCE(EXCLUDED.distribuidora, instalacoes.distribuidora)
     RETURNING *`,
    [titular_id, cod, apelido || null, endereco || null, distribuidora || null]
  );
  res.status(201).json(rows[0]);
}));

app.put("/api/instalacoes/:id", wrap(async (req, res) => {
  const { codigo, apelido, endereco, distribuidora } = req.body;
  const { rows } = await query(
    `UPDATE instalacoes SET codigo=$1, apelido=$2, endereco=$3, distribuidora=$4
     WHERE id=$5 RETURNING *`,
    [normalizarCodigo(codigo), apelido || null, endereco || null, distribuidora || null, req.params.id]
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
// Aceita multiplos ids separados por virgula: ?titular_id=1,2&instalacao_id=5,6
app.get("/api/faturas", wrap(async (req, res) => {
  const parseIds = (v) =>
    String(v || "")
      .split(",")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n));
  const titIds = parseIds(req.query.titular_id);
  const instIds = parseIds(req.query.instalacao_id);
  const params = [];
  const cond = [];
  if (titIds.length) { params.push(titIds); cond.push(`i.titular_id = ANY($${params.length})`); }
  if (instIds.length) { params.push(instIds); cond.push(`f.instalacao_id = ANY($${params.length})`); }
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

// Limpa TODAS as faturas de um titular (todas as instalacoes dele).
app.delete("/api/titulares/:id/faturas", wrap(async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM faturas
     WHERE instalacao_id IN (SELECT id FROM instalacoes WHERE titular_id = $1)`,
    [req.params.id]
  );
  res.json({ ok: true, removidas: rowCount });
}));

// Limpa todas as faturas de uma instalacao.
app.delete("/api/instalacoes/:id/faturas", wrap(async (req, res) => {
  const { rowCount } = await query(`DELETE FROM faturas WHERE instalacao_id = $1`, [req.params.id]);
  res.json({ ok: true, removidas: rowCount });
}));

// Insere a fatura SOMENTE se ainda nao existir (instalacao + mes_key).
// Retorna true se inseriu; false se ja existia (duplicata no banco).
async function inserirFaturaSeNova(instalacaoId, f) {
  const { rows } = await query(
    `INSERT INTO faturas
      (instalacao_id, mes, mes_key, ano, leitura, vencimento, consumo, dias, total, bandeira, saldo, inj, status, arquivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (instalacao_id, mes_key) DO NOTHING
     RETURNING id`,
    [
      instalacaoId, f.mes, f.mesKey, f.ano, f.leitura, f.vencimento,
      f.consumo, f.dias, f.total, f.bandeira, f.saldo, f.inj, f.status, f.arquivo || null,
    ]
  );
  return rows.length > 0;
}

// Insere OU sobrescreve a fatura existente (instalacao + mes_key).
// Retorna true se foi uma insercao nova; false se atualizou uma existente.
async function upsertFaturaSubstituindo(instalacaoId, f) {
  const { rows } = await query(
    `INSERT INTO faturas
      (instalacao_id, mes, mes_key, ano, leitura, vencimento, consumo, dias, total, bandeira, saldo, inj, status, arquivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (instalacao_id, mes_key) DO UPDATE SET
       mes=EXCLUDED.mes, ano=EXCLUDED.ano, leitura=EXCLUDED.leitura, vencimento=EXCLUDED.vencimento,
       consumo=EXCLUDED.consumo, dias=EXCLUDED.dias, total=EXCLUDED.total, bandeira=EXCLUDED.bandeira,
       saldo=EXCLUDED.saldo, inj=EXCLUDED.inj, status=EXCLUDED.status, arquivo=EXCLUDED.arquivo
     RETURNING (xmax = 0) AS inserted`,
    [
      instalacaoId, f.mes, f.mesKey, f.ano, f.leitura, f.vencimento,
      f.consumo, f.dias, f.total, f.bandeira, f.saldo, f.inj, f.status, f.arquivo || null,
    ]
  );
  return rows[0] && rows[0].inserted === true;
}

// Chave estavel para faturas sem mes: evita colisao mas detecta reimportacao identica.
function chaveSemMes(f) {
  const base = [f.instalacao, f.total, f.consumo, f.saldo, f.inj, f.vencimento, f.arquivo].join("|");
  return "SM-" + crypto.createHash("md5").update(base).digest("hex").slice(0, 12);
}

// Garante instalacao por (titular, codigo normalizado), criando se necessario.
async function getOrCreateInstalacao(titularId, codigo, apelido, distribuidora) {
  const cod = normalizarCodigo(codigo) || "SEM-INSTALACAO";
  const { rows } = await query(
    `INSERT INTO instalacoes (titular_id, codigo, apelido, distribuidora)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (titular_id, codigo) DO UPDATE SET
       apelido = COALESCE(instalacoes.apelido, EXCLUDED.apelido),
       distribuidora = COALESCE(instalacoes.distribuidora, EXCLUDED.distribuidora)
     RETURNING id`,
    [titularId, cod, apelido || null, distribuidora || null]
  );
  return rows[0].id;
}

// Garante um titular "guarda-chuva" para linhas sem titular (nao perder dados).
async function getOrCreateTitularPadrao() {
  const sel = await query(`SELECT id FROM titulares WHERE nome = $1 LIMIT 1`, ["(Sem titular)"]);
  if (sel.rows.length) return sel.rows[0].id;
  const ins = await query(`INSERT INTO titulares (nome) VALUES ($1) RETURNING id`, ["(Sem titular)"]);
  return ins.rows[0].id;
}

/* ============================ UPLOAD EXCEL ============================ */

// Recebe um .xlsx/.csv e grava as faturas.
// O titular pode vir por (a) titular_id no form (todas as linhas vao para ele)
// ou (b) coluna "Titular" no proprio arquivo (cria/encontra por nome).
app.post("/api/upload/excel", upload.single("arquivo"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo enviado." });

  const titularIdForm = req.body.titular_id ? Number(req.body.titular_id) : null;
  const substituir = String(req.body.substituir || "") === "true";

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

  let titularPadraoId = null; // criado sob demanda
  let gravadas = 0;        // faturas novas inseridas
  let atualizadas = 0;     // faturas existentes sobrescritas (modo substituir)
  const dupArquivo = [];   // duplicadas dentro do proprio arquivo
  let dupBanco = 0;        // ja existiam no banco (modo padrao, nao reimporta)
  const vistas = new Set();
  const instalacaoCache = new Map(); // `${titularId}:${codigo}` -> instalacaoId

  for (const f of linhas) {
    // 1) Resolve titular: form > coluna > titular padrao (nunca ignora)
    let titularId = titularIdForm;
    if (!titularId && f.titular) titularId = await resolverTitularPorNome(f.titular);
    if (!titularId) {
      if (!titularPadraoId) titularPadraoId = await getOrCreateTitularPadrao();
      titularId = titularPadraoId;
    }

    // 2) Codigo de instalacao: normaliza; se vazio usa placeholder (nunca ignora)
    const codigo = f.instalacao || "SEM-INSTALACAO";

    // 3) Chave do mes: se vazio, gera chave estavel por conteudo (nunca ignora)
    if (!f.mesKey) f.mesKey = chaveSemMes({ ...f, instalacao: codigo });

    // 4) Dedup dentro do arquivo (em ambos os modos: a ultima ocorrencia vale)
    const chaveUnica = `${titularId}:${codigo}:${f.mesKey}`;
    if (vistas.has(chaveUnica)) {
      dupArquivo.push({ instalacao: codigo, mes: f.mesLabel, arquivo: f.arquivo });
      if (!substituir) continue; // modo padrao: ignora repetida do arquivo
    }
    vistas.add(chaveUnica);

    // 5) Instalacao (cache por requisicao)
    const ck = `${titularId}:${codigo}`;
    let instalacaoId = instalacaoCache.get(ck);
    if (!instalacaoId) {
      instalacaoId = await getOrCreateInstalacao(titularId, codigo, f.apelido, f.distribuidora);
      instalacaoCache.set(ck, instalacaoId);
    }

    // 6) Grava conforme o modo
    if (substituir) {
      const inseriu = await upsertFaturaSubstituindo(instalacaoId, f);
      if (inseriu) gravadas++; else atualizadas++;
    } else {
      const inseriu = await inserirFaturaSeNova(instalacaoId, f);
      if (inseriu) gravadas++; else dupBanco++;
    }
  }

  res.json({
    ok: true,
    modo: substituir ? "substituir" : "padrao",
    total_linhas: linhas.length,
    gravadas,
    atualizadas,
    duplicadas_arquivo: dupArquivo.length,
    duplicadas_banco: dupBanco,
    detalhe_duplicadas: dupArquivo.slice(0, 20),
  });
}));

// Salva faturas extraidas via PDF no frontend (envio em lote JSON).
app.post("/api/faturas/lote", wrap(async (req, res) => {
  const { titular_id, faturas } = req.body;
  if (!titular_id) return res.status(400).json({ erro: "titular_id e obrigatorio." });
  if (!Array.isArray(faturas) || !faturas.length) return res.status(400).json({ erro: "Lista de faturas vazia." });

  let gravadas = 0, duplicadas = 0;
  const cache = new Map();
  for (const f of faturas) {
    const codigo = normalizarCodigo(f.instalacao) || "SEM-INSTALACAO";
    if (!f.mesKey) f.mesKey = chaveSemMes({ ...f, instalacao: codigo });
    let instId = cache.get(codigo);
    if (!instId) { instId = await getOrCreateInstalacao(titular_id, codigo, f.apelido, f.distribuidora); cache.set(codigo, instId); }
    const inseriu = await inserirFaturaSeNova(instId, f);
    if (inseriu) gravadas++; else duplicadas++;
  }
  res.json({ ok: true, gravadas, duplicadas });
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
