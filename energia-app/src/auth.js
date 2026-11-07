// src/auth.js
// Login, perfis e permissões da Plataforma de Faturas (Lério & Silva).
//
//  - ADMINISTRADOR: vê e altera tudo; cria usuários e define quais titulares (contas) cada um acessa.
//  - USUÁRIO: só VÊ os titulares liberados para ele (e as instalações/faturas desses titulares).
//
// Variáveis de ambiente (Railway > serviço > Variables):
//   APP_USER, APP_PASSWORD  administrador principal (sempre funciona, mesmo sem usuários no banco)
//   SESSION_SECRET          texto longo e aleatório para assinar o cookie de sessão (obrigatório na prática)
//   API_TOKEN               (opcional) chave do robô de faturas; tem poder de administrador
//   SESSION_HOURS           (opcional) duração da sessão em horas (padrão 12)

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { query } from "./db.js";

const COOKIE = "ls_sessao";
const ABERTAS = new Set(["/login", "/login.html", "/api/login", "/api/logout", "/api/health",
  "/auth-guard.js", "/favicon.ico", "/styles.css",
  "/logo.svg", "/logo-simbolo.svg"]);
// GETs que trazem dados: para usuários comuns a resposta é filtrada pelos titulares liberados
const FILTRADAS = {
  "/api/titulares": (row, ok) => ok.has(Number(row.id)),
  "/api/instalacoes": (row, ok) => ok.has(Number(row.titular_id)),
  "/api/faturas": (row, ok) => ok.has(Number(row.titular_id)),
};
const tentativas = new Map(); // ip -> { falhas, ate }

/* ---------------------------------------------------------------- utilidades */
const sha = (s) => crypto.createHash("sha256").update(String(s ?? ""), "utf8").digest();
const iguais = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(senha), sal, 32);
  return `scrypt$${sal.toString("hex")}$${h.toString("hex")}`;
}
function conferirSenha(senha, guardado) {
  const [alg, salHex, hHex] = String(guardado || "").split("$");
  if (alg !== "scrypt" || !salHex || !hHex) return false;
  const h = crypto.scryptSync(String(senha ?? ""), Buffer.from(salHex, "hex"), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hHex, "hex"));
}

function segredo() {
  return process.env.SESSION_SECRET || sha(`${process.env.APP_USER}|${process.env.APP_PASSWORD}|ls`).toString("hex");
}
function assinar(dados) {
  const corpo = Buffer.from(JSON.stringify(dados), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  return `${corpo}.${sig}`;
}
function lerCookie(req) {
  const bruto = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE + "="));
  if (!bruto) return null;
  const [corpo, sig] = decodeURIComponent(bruto.slice(COOKIE.length + 1)).split(".");
  if (!corpo || !sig) return null;
  const esperado = crypto.createHmac("sha256", segredo()).update(corpo).digest("base64url");
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const d = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
function cookie(req, valor, maxAgeSeg) {
  return `${COOKIE}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeg}` +
    (req.secure ? "; Secure" : "");
}
const envAdminConfigurado = () => Boolean(process.env.APP_USER && process.env.APP_PASSWORD);

/* ---------------------------------------------------------------- banco */
let migrado = null;
function garantirTabelas() {
  migrado ||= query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id          SERIAL PRIMARY KEY,
      usuario     TEXT NOT NULL UNIQUE,
      nome        TEXT,
      senha_hash  TEXT NOT NULL,
      perfil      TEXT NOT NULL DEFAULT 'usuario',
      ativo       BOOLEAN NOT NULL DEFAULT true,
      criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS usuario_titulares (
      usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      titular_id  INTEGER NOT NULL REFERENCES titulares(id) ON DELETE CASCADE,
      PRIMARY KEY (usuario_id, titular_id)
    );
  `).then(() => console.log("[auth] tabelas de usuarios verificadas."))
    .catch((e) => { migrado = null; throw e; });
  return migrado;
}

async function carregarUsuario(id) {
  const { rows } = await query("SELECT id, usuario, nome, perfil, ativo FROM usuarios WHERE id = $1", [id]);
  const u = rows[0];
  if (!u || !u.ativo) return null;
  const t = await query("SELECT titular_id FROM usuario_titulares WHERE usuario_id = $1", [id]);
  return { id: u.id, usuario: u.usuario, nome: u.nome, admin: u.perfil === "admin",
    titulares: new Set(t.rows.map((r) => Number(r.titular_id))) };
}

// Descobre quem está fazendo a requisição (sessão, token do robô ou ninguém)
async function identificar(req) {
  const tk = process.env.API_TOKEN;
  const h = req.headers.authorization || "";
  if (tk && h.startsWith("Bearer ") && iguais(h.slice(7).trim(), tk)) {
    return { id: 0, usuario: "robo", nome: "Robô de faturas", admin: true, titulares: new Set() };
  }
  const s = lerCookie(req);
  if (!s) return null;
  if (s.uid === 0) {
    return envAdminConfigurado() && s.u === process.env.APP_USER
      ? { id: 0, usuario: s.u, nome: "Administrador", admin: true, titulares: new Set() } : null;
  }
  await garantirTabelas();
  return carregarUsuario(s.uid);
}

/* ---------------------------------------------------------------- instalação no Express */
export function instalarAutenticacao(app, { publicDir }) {
  app.set("trust proxy", 1); // o Railway fica atrás de um proxy HTTPS
  if (!envAdminConfigurado()) {
    console.warn("[auth] APP_USER/APP_PASSWORD não configurados: só usuários do banco conseguem entrar.");
  }
  garantirTabelas().catch((e) => console.error("[auth] falha ao criar tabelas:", e.message));
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((e) => {
    console.error(e);
    res.status(500).json({ erro: e.message || "Erro interno" });
  });

  /* ---- login / logout ---- */
  app.post("/api/login", wrap(async (req, res) => {
    const ip = req.ip || "?";
    const t = tentativas.get(ip);
    if (t && t.ate > Date.now()) return res.status(429).json({ erro: "Muitas tentativas. Aguarde 15 minutos." });
    const { usuario, senha } = req.body || {};
    let sessao = null;
    if (envAdminConfigurado() && iguais(usuario, process.env.APP_USER) & iguais(senha, process.env.APP_PASSWORD)) {
      sessao = { uid: 0, u: process.env.APP_USER };
    } else if (usuario && senha) {
      await garantirTabelas();
      const { rows } = await query("SELECT id, usuario, senha_hash, ativo FROM usuarios WHERE lower(usuario) = lower($1)",
        [String(usuario).trim()]);
      const u = rows[0];
      if (u && u.ativo && conferirSenha(senha, u.senha_hash)) sessao = { uid: u.id, u: u.usuario };
    }
    if (!sessao) {
      const falhas = (t?.falhas || 0) + 1;
      tentativas.set(ip, { falhas, ate: falhas >= 8 ? Date.now() + 15 * 60 * 1000 : 0 });
      return res.status(401).json({ erro: "Usuário ou senha inválidos." });
    }
    tentativas.delete(ip);
    const horas = Number(process.env.SESSION_HOURS) || 12;
    res.setHeader("Set-Cookie", cookie(req, assinar({ ...sessao, exp: Date.now() + horas * 3600e3 }), horas * 3600));
    res.json({ ok: true });
  }));

  app.post("/api/logout", (req, res) => {
    res.setHeader("Set-Cookie", cookie(req, "", 0));
    res.json({ ok: true });
  });

  app.get(["/login", "/login.html"], wrap(async (req, res) => {
    if (await identificar(req)) return res.redirect("/");
    res.sendFile(path.join(publicDir, "login.html"));
  }));

  /* ---- todo o resto exige login ---- */
  app.use(wrap(async (req, res, next) => {
    if (ABERTAS.has(req.path)) return next();
    const quem = await identificar(req);
    if (!quem) {
      if (req.path.startsWith("/api/")) return res.status(401).json({ erro: "Não autenticado." });
      return res.redirect("/login");
    }
    req.usuario = quem;
    if (quem.admin) return next();

    // usuário comum: somente leitura e somente os titulares liberados
    if (req.path.startsWith("/admin") || req.path.startsWith("/api/admin")) {
      return res.status(403).json({ erro: "Acesso restrito ao administrador." });
    }
    if (req.method !== "GET" && req.path.startsWith("/api/") && req.path !== "/api/me") {
      return res.status(403).json({ erro: "Seu acesso é somente para consulta." });
    }
    const filtro = FILTRADAS[req.path];
    if (filtro) {
      const json = res.json.bind(res);
      res.json = (dados) => json(Array.isArray(dados) ? dados.filter((r) => filtro(r, quem.titulares)) : dados);
    } else if (/^\/api\/(titulares|instalacoes)\/\d+/.test(req.path)) {
      return res.status(403).json({ erro: "Sem permissão." });
    }
    next();
  }));

  /* ---- quem sou eu ---- */
  app.get("/api/me", (req, res) => {
    const u = req.usuario;
    res.json({ usuario: u.usuario, nome: u.nome, admin: u.admin, titulares: [...u.titulares] });
  });

  /* ---- administração de usuários (somente administrador) ---- */
  const soAdmin = (req, res, next) => (req.usuario?.admin ? next() : res.status(403).json({ erro: "Acesso restrito." }));

  app.get("/admin", soAdmin, (req, res) => res.sendFile(path.join(publicDir, "admin.html")));

  app.get("/api/admin/usuarios", soAdmin, wrap(async (req, res) => {
    await garantirTabelas();
    const { rows } = await query(`
      SELECT u.id, u.usuario, u.nome, u.perfil, u.ativo, u.criado_em,
             COALESCE(array_agg(ut.titular_id) FILTER (WHERE ut.titular_id IS NOT NULL), '{}') AS titulares
      FROM usuarios u LEFT JOIN usuario_titulares ut ON ut.usuario_id = u.id
      GROUP BY u.id ORDER BY u.usuario`);
    res.json(rows);
  }));

  async function gravarTitulares(uid, titulares) {
    await query("DELETE FROM usuario_titulares WHERE usuario_id = $1", [uid]);
    for (const tid of [...new Set((titulares || []).map(Number).filter(Boolean))]) {
      await query("INSERT INTO usuario_titulares (usuario_id, titular_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [uid, tid]);
    }
  }

  app.post("/api/admin/usuarios", soAdmin, wrap(async (req, res) => {
    await garantirTabelas();
    const { usuario, nome, senha, perfil, titulares } = req.body || {};
    const login = String(usuario || "").trim().toLowerCase();
    if (!/^[a-z0-9._@-]{3,60}$/.test(login)) return res.status(400).json({ erro: "Usuário inválido (3 a 60 letras, números, ponto, hífen, @)." });
    if (!senha || String(senha).length < 8) return res.status(400).json({ erro: "A senha precisa ter pelo menos 8 caracteres." });
    if (envAdminConfigurado() && login === String(process.env.APP_USER).toLowerCase()) {
      return res.status(400).json({ erro: "Esse usuário é o administrador principal." });
    }
    const existe = await query("SELECT 1 FROM usuarios WHERE lower(usuario) = $1", [login]);
    if (existe.rows.length) return res.status(409).json({ erro: "Já existe um usuário com esse login." });
    const { rows } = await query(
      "INSERT INTO usuarios (usuario, nome, senha_hash, perfil) VALUES ($1,$2,$3,$4) RETURNING id",
      [login, nome || null, hashSenha(senha), perfil === "admin" ? "admin" : "usuario"]);
    await gravarTitulares(rows[0].id, titulares);
    res.status(201).json({ id: rows[0].id });
  }));

  app.put("/api/admin/usuarios/:id", soAdmin, wrap(async (req, res) => {
    await garantirTabelas();
    const id = Number(req.params.id);
    const { nome, senha, perfil, ativo, titulares } = req.body || {};
    const atual = await query("SELECT id FROM usuarios WHERE id = $1", [id]);
    if (!atual.rows.length) return res.status(404).json({ erro: "Usuário não encontrado." });
    if (nome !== undefined) await query("UPDATE usuarios SET nome = $1 WHERE id = $2", [nome || null, id]);
    if (perfil !== undefined) await query("UPDATE usuarios SET perfil = $1 WHERE id = $2", [perfil === "admin" ? "admin" : "usuario", id]);
    if (ativo !== undefined) await query("UPDATE usuarios SET ativo = $1 WHERE id = $2", [Boolean(ativo), id]);
    if (senha) {
      if (String(senha).length < 8) return res.status(400).json({ erro: "A senha precisa ter pelo menos 8 caracteres." });
      await query("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [hashSenha(senha), id]);
    }
    if (titulares !== undefined) await gravarTitulares(id, titulares);
    res.json({ ok: true });
  }));

  app.delete("/api/admin/usuarios/:id", soAdmin, wrap(async (req, res) => {
    await garantirTabelas();
    await query("DELETE FROM usuarios WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  /* ---- página principal: injeta o script do botão Sair / Usuários ---- */
  app.get(["/", "/index.html"], (req, res, next) => {
    fs.readFile(path.join(publicDir, "index.html"), "utf8", (err, html) => {
      if (err) return next();
      res.type("html").send(html.replace("</body>", '<script src="/auth-guard.js"></script></body>'));
    });
  });
}
