// src/db.js
// Camada de acesso ao PostgreSQL (banco gerenciado do Railway).
// O Railway injeta automaticamente a variavel DATABASE_URL quando voce
// adiciona um servico PostgreSQL ao projeto.

import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "\n[ERRO] Variavel DATABASE_URL nao definida.\n" +
      "No Railway: adicione um plugin PostgreSQL ao projeto (a variavel e injetada sozinha).\n" +
      "Localmente: crie um arquivo .env baseado em .env.example.\n"
  );
}

// SSL e exigido pela maioria dos provedores gerenciados (inclusive Railway em alguns casos).
const needsSsl =
  process.env.PGSSL === "true" ||
  (connectionString && /\brailway\b|\bsupabase\b|\bneon\b|\brender\b/i.test(connectionString));

export const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

// Cria as tabelas se ainda nao existirem (migracao idempotente, roda no boot).
export async function migrate() {
  const sql = `
  CREATE TABLE IF NOT EXISTS titulares (
    id           SERIAL PRIMARY KEY,
    nome         TEXT NOT NULL,
    documento    TEXT,
    email        TEXT,
    telefone     TEXT,
    observacoes  TEXT,
    criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS instalacoes (
    id            SERIAL PRIMARY KEY,
    titular_id    INTEGER NOT NULL REFERENCES titulares(id) ON DELETE CASCADE,
    codigo        TEXT NOT NULL,
    apelido       TEXT,
    endereco      TEXT,
    distribuidora TEXT,
    criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (titular_id, codigo)
  );

  CREATE TABLE IF NOT EXISTS faturas (
    id             SERIAL PRIMARY KEY,
    instalacao_id  INTEGER NOT NULL REFERENCES instalacoes(id) ON DELETE CASCADE,
    mes            TEXT,
    mes_key        TEXT,
    ano            TEXT,
    leitura        TEXT,
    vencimento     TEXT,
    consumo        NUMERIC DEFAULT 0,
    dias           NUMERIC DEFAULT 0,
    total          NUMERIC DEFAULT 0,
    bandeira       TEXT,
    saldo          NUMERIC DEFAULT 0,
    inj            NUMERIC DEFAULT 0,
    status         TEXT,
    arquivo        TEXT,
    criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (instalacao_id, mes_key)
  );

  CREATE INDEX IF NOT EXISTS idx_instalacoes_titular ON instalacoes(titular_id);
  CREATE INDEX IF NOT EXISTS idx_faturas_instalacao ON faturas(instalacao_id);
  `;
  await pool.query(sql);
  console.log("[db] migracao concluida (tabelas verificadas/criadas).");
}

export async function query(text, params) {
  return pool.query(text, params);
}
