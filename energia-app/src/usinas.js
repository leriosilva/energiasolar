// src/usinas.js
// Módulo "Usinas": robô diário do S-Miles Cloud (Hoymiles), painel de performance,
// relatório dos últimos 7 dias, regularidade de funcionamento e envio por e-mail.
//
// A performance é medida SOMENTE com dados do S-Miles. As faturas da Enel/Energisa
// não entram em nenhum cálculo deste módulo (são usadas só na página, na visão Usina × fatura).
//
// Variáveis de ambiente (Railway):
//   HOYMILES_CONTAS      contas do S-Miles, uma por linha ou separadas por ";"  ->  usuario:senha
//   ROBO_HORARIO         horário diário em Brasília (padrão 07:00)
//   RELATORIO_PARA       destinatário(s) do e-mail (padrão otaviolerio@outlook.com)
//   EMAIL_WEBHOOK_URL    endereço do script do Google que envia pelo Gmail (recomendado no Railway)
//   EMAIL_WEBHOOK_TOKEN  senha combinada com o script do Google
//   GMAIL_USER / GMAIL_APP_PASSWORD   alternativa por SMTP (bloqueado em alguns planos do Railway)
//   PUBLIC_URL           endereço da plataforma usado no link do e-mail
//   ROBO_DESATIVADO=sim  desliga o agendamento automático

import crypto from "crypto";
import path from "path";
import { query } from "./db.js";

const TZ = "America/Sao_Paulo";
export const HORARIO_PADRAO = "07:00";
const BASES = { 1: "https://euapi.hoymiles.com" };
const BASE_PADRAO = process.env.HOYMILES_BASE || "https://neapi.hoymiles.com";
const P_ENERGIA = "/pvm-data/api/0/station/data3/ceqc_a";
const LOCK_ID = 7710017;

// Ajustes iniciais conhecidos (podem ser alterados depois pela API / página).
const PADRAO = {
  11501740: { apelido: "Paróquia Santa Bernadete", regiao: "SP", uc: "69572950",
              endereco: "R. Itambaraca, 4246 - Vila Ivg, São Paulo/SP" },
  460970:   { apelido: "Amajouvas", regiao: "SP", uc: "69589968" },
  1219510:  { apelido: "Itapeva (MG)", regiao: "MG", uc: "3071452" },
};

/* ------------------------------------------------------------------ datas (Brasília) */
export const hojeBR = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const horaBR = (d = new Date()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
export const somaDias = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const somaMeses = (ym, n) => {
  const [a, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const dataBR = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const mediana = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (v, d = 0) => Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

/* ------------------------------------------------------------------ banco */
let tabelasOk = null;
export function garantirTabelas() {
  if (!tabelasOk) {
    tabelasOk = query(`
      CREATE TABLE IF NOT EXISTS usinas (
        sid           BIGINT PRIMARY KEY,
        conta         TEXT,
        nome          TEXT,
        apelido       TEXT,
        kwp           NUMERIC,
        instalacao    DATE,
        endereco      TEXT,
        instalador    TEXT,
        regiao        TEXT,
        uc_codigo     TEXT,
        micros        JSONB,
        tempo_real    JSONB,
        real_em       TIMESTAMPTZ,
        ativa         BOOLEAN NOT NULL DEFAULT true,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS usina_dia (
        sid BIGINT NOT NULL, dia DATE NOT NULL, wh NUMERIC NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (sid, dia)
      );
      CREATE TABLE IF NOT EXISTS usina_mes (
        sid BIGINT NOT NULL, mes TEXT NOT NULL, wh NUMERIC NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (sid, mes)
      );
      CREATE TABLE IF NOT EXISTS usina_execucoes (
        id        SERIAL PRIMARY KEY,
        tipo      TEXT NOT NULL,
        data_ref  DATE NOT NULL,
        inicio    TIMESTAMPTZ NOT NULL DEFAULT now(),
        fim       TIMESTAMPTZ,
        status    TEXT,
        log       TEXT,
        email     TEXT,
        relatorio JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_usina_exec_data ON usina_execucoes(data_ref, tipo);
    `).catch((e) => { tabelasOk = null; throw e; });
  }
  return tabelasOk;
}

/* ------------------------------------------------------------------ S-Miles (Hoymiles) */
export function lerContas(txt = process.env.HOYMILES_CONTAS || "") {
  const t = txt.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try { return JSON.parse(t).map((c) => ({ u: String(c.u || c.usuario).trim(), p: String(c.p || c.senha) })); }
    catch { /* cai para o formato simples */ }
  }
  return t.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(":"); return { u: l.slice(0, i).trim(), p: l.slice(i + 1) };
  }).filter((c) => c.u && c.p);
}

export class SMiles {
  constructor(fetchFn = fetch) { this.fetch = fetchFn; this.base = BASE_PADRAO; this.token = null; }

  async req(caminho, corpo, { base } = {}) {
    const r = await this.fetch((base || this.base) + caminho, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: this.token } : {}) },
      body: JSON.stringify(corpo || {}),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`S-Miles respondeu HTTP ${r.status} em ${caminho}`);
    if (String(j.status) !== "0") throw new Error(`S-Miles: ${j.message || "erro " + j.status} (${caminho})`);
    return j.data;
  }

  // Mesmo procedimento do site: pré-consulta (sal + nonce) e senha cifrada (argon2id na versão 3).
  async entrar(usuario, senha) {
    this.token = null; this.base = BASE_PADRAO;
    const pre = await this.req("/iam/pub/3/auth/pre-insp", { u: usuario });
    const { a: sal, n: nonce, v, dc } = pre || {};
    if (v === -1) throw new Error(`usuário "${usuario}" não reconhecido pelo S-Miles`);
    let ch;
    if (Number(v) === 3) {
      if (!sal) throw new Error("S-Miles não enviou o sal da senha");
      const { argon2id } = await import("hash-wasm");
      ch = await argon2id({ password: senha, salt: Buffer.from(sal, "hex"), parallelism: 1, iterations: 3,
        memorySize: 32768, hashLength: 32, outputType: "hex" });
    } else {
      ch = crypto.createHash("md5").update(senha).digest("hex") + "." +
           crypto.createHash("sha256").update(senha).digest("base64");
    }
    const d = await this.req("/iam/pub/3/auth/login", { u: usuario, ch, n: nonce });
    if (!d?.token) throw new Error("S-Miles não devolveu o token de acesso (o login pode exigir verificação humana)");
    this.token = d.token;
    if (BASES[dc]) this.base = BASES[dc];
    return this.token;
  }

  usinas() { return this.req("/pvm/api/0/station/select_by_page", { page: 1, page_size: 100 }).then((d) => d?.list || []); }
  tempoReal(sid) { return this.req("/pvm-data/api/0/station/data/count_station_real_data", { sid }); }
  detalhe(sid) { return this.req("/pvm/api/0/station/find", { id: sid }).catch(() => ({})); }
  micros(sid) {
    return this.req("/pvm/api/0/dev/micro/select_by_station", { sid, page: 1, page_size: 200 }).then((d) => d?.list || []);
  }
  energiaDia(sid, dia) { return this.req(P_ENERGIA, { sid, date: dia, mode: 1 }).then((d) => Number(d?.pv_eq || 0)); }
  energiaMes(sid, ym) { return this.req(P_ENERGIA, { sid, date: ym + "-01", mode: 3 }).then((d) => Number(d?.pv_eq || 0)); }
}

/* ------------------------------------------------------------------ coleta */
export async function coletar({ cliente = new SMiles(), contas = lerContas(), log = console.log, hoje = hojeBR() } = {}) {
  await garantirTabelas();
  if (!contas.length) throw new Error("Nenhuma conta do S-Miles configurada (variável HOYMILES_CONTAS).");
  const res = { contas: 0, usinas: 0, falhas: [] };
  for (const c of contas) {
    try {
      await cliente.entrar(c.u, c.p);
      const lista = await cliente.usinas();
      log(`conta ${c.u}: login ok, ${lista.length} usina(s)`);
      res.contas++;
      for (const s of lista) {
        await coletarUsina(cliente, c.u, s, hoje, log);
        res.usinas++;
      }
    } catch (e) {
      log(`conta ${c.u}: FALHA - ${e.message}`);
      res.falhas.push({ conta: c.u, erro: e.message });
    }
  }
  return res;
}

async function coletarUsina(cli, conta, s, hoje, log) {
  const sid = Number(s.id);
  const [real, det, micros] = await Promise.all([cli.tempoReal(sid), cli.detalhe(sid), cli.micros(sid)]);
  const pad = PADRAO[sid] || {};
  const endereco = det?.address || s.address || pad.endereco || "";
  const regiao = pad.regiao || (/\bMG\b|Minas/i.test(endereco) ? "MG" : "SP");
  const instalacao = String(s.create_at || "").slice(0, 10) || null;
  await query(`
    INSERT INTO usinas (sid, conta, nome, apelido, kwp, instalacao, endereco, instalador, regiao, uc_codigo,
                        micros, tempo_real, real_em, atualizado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
    ON CONFLICT (sid) DO UPDATE SET
      conta = EXCLUDED.conta, nome = EXCLUDED.nome, kwp = EXCLUDED.kwp, instalacao = EXCLUDED.instalacao,
      endereco = COALESCE(NULLIF(EXCLUDED.endereco, ''), usinas.endereco), instalador = EXCLUDED.instalador,
      micros = EXCLUDED.micros, tempo_real = EXCLUDED.tempo_real, real_em = EXCLUDED.real_em, atualizado_em = now()`,
    [sid, conta, s.name, pad.apelido || s.name, Number(s.capacitor) || 0, instalacao, endereco, s.org_name || null,
     regiao, pad.uc || null,
     JSON.stringify(micros.map((m) => ({ sn: m.sn, modelo: m.model_no || m.init_hard_no, alarme: !!m.warn_data?.warn,
       conectado: m.warn_data?.connect !== false }))),
     JSON.stringify({ ...real, alertas: s.warn_data || null }),
     (real?.last_data_time || real?.data_time) ? new Date(String(real.last_data_time || real.data_time).slice(0, 19).replace(" ", "T") + "-03:00") : null]);

  // dias: completa os últimos 90 dias que faltam + atualiza sempre os últimos 10
  const ini90 = somaDias(hoje, -89);
  const { rows } = await query("SELECT to_char(dia,'YYYY-MM-DD') d FROM usina_dia WHERE sid=$1 AND dia >= $2", [sid, ini90]);
  const tem = new Set(rows.map((r) => r.d));
  const dias = [];
  for (let d = ini90; d <= hoje; d = somaDias(d, 1)) {
    if (instalacao && d < instalacao) continue;
    if (!tem.has(d) || d >= somaDias(hoje, -9)) dias.push(d);
  }
  for (const d of dias) {
    const wh = await cli.energiaDia(sid, d);
    await query(`INSERT INTO usina_dia (sid, dia, wh) VALUES ($1,$2,$3)
                 ON CONFLICT (sid, dia) DO UPDATE SET wh = EXCLUDED.wh, atualizado_em = now()`, [sid, d, wh]);
    await pausa(60);
  }
  // meses: todos desde a instalação que faltam + mês atual e anterior
  const mHoje = hoje.slice(0, 7);
  const { rows: rm } = await query("SELECT mes FROM usina_mes WHERE sid=$1", [sid]);
  const temM = new Set(rm.map((r) => r.mes));
  const meses = [];
  for (let m = (instalacao || hoje).slice(0, 7); m <= mHoje; m = somaMeses(m, 1)) {
    if (!temM.has(m) || m >= somaMeses(mHoje, -1)) meses.push(m);
  }
  for (const m of meses) {
    const wh = await cli.energiaMes(sid, m);
    await query(`INSERT INTO usina_mes (sid, mes, wh) VALUES ($1,$2,$3)
                 ON CONFLICT (sid, mes) DO UPDATE SET wh = EXCLUDED.wh, atualizado_em = now()`, [sid, m, wh]);
    await pausa(60);
  }
  log(`  ${pad.apelido || s.name}: ${dias.length} dia(s) e ${meses.length} mês(es) atualizados`);
}

/* ------------------------------------------------------------------ leitura do banco */
export async function carregarUsinas({ titulares = null, diasHist = 400 } = {}) {
  await garantirTabelas();
  const { rows } = await query(`
    SELECT u.*, to_char(u.instalacao,'YYYY-MM-DD') AS instalacao_txt,
           i.id AS instalacao_id, i.titular_id, t.nome AS titular_nome, i.distribuidora
      FROM usinas u
      LEFT JOIN LATERAL (SELECT * FROM instalacoes x WHERE x.codigo = u.uc_codigo ORDER BY x.id LIMIT 1) i ON true
      LEFT JOIN titulares t ON t.id = i.titular_id
     WHERE u.ativa
     ORDER BY u.kwp DESC, u.sid`).catch(async (e) => {
    // tabelas de faturas ainda não existem (instalação nova): carrega só as usinas
    if (!/instalacoes|titulares/.test(e.message)) throw e;
    return query(`SELECT u.*, to_char(u.instalacao,'YYYY-MM-DD') AS instalacao_txt FROM usinas u WHERE u.ativa ORDER BY u.kwp DESC`);
  });
  let lista = rows;
  if (titulares) lista = lista.filter((u) => u.titular_id && titulares.has(Number(u.titular_id)));
  if (!lista.length) return [];
  const sids = lista.map((u) => u.sid);
  const desde = somaDias(hojeBR(), -diasHist);
  const [d, m] = await Promise.all([
    query("SELECT sid, to_char(dia,'YYYY-MM-DD') dia, wh FROM usina_dia WHERE sid = ANY($1) AND dia >= $2 ORDER BY dia", [sids, desde]),
    query("SELECT sid, mes, wh FROM usina_mes WHERE sid = ANY($1) ORDER BY mes", [sids]),
  ]);
  return lista.map((u) => ({
    sid: Number(u.sid), conta: u.conta, nome: u.nome, apelido: u.apelido || u.nome, kwp: Number(u.kwp),
    instalacao: u.instalacao_txt, endereco: u.endereco, instalador: u.instalador, regiao: u.regiao || "SP",
    uc_codigo: u.uc_codigo, instalacao_id: u.instalacao_id || null, titular_id: u.titular_id || null,
    titular_nome: u.titular_nome || null, distribuidora: u.distribuidora || null,
    micros: u.micros || [], tempo_real: u.tempo_real || {}, real_em: u.real_em, atualizado_em: u.atualizado_em,
    diario: d.rows.filter((r) => String(r.sid) === String(u.sid)).map((r) => [r.dia, Number(r.wh)]),
    mensal: m.rows.filter((r) => String(r.sid) === String(u.sid)).map((r) => [r.mes, Number(r.wh)]),
  }));
}

/* ------------------------------------------------------------------ análise (só S-Miles) */
// Referência de cada dia = média da produtividade (kWh/kWp) das outras usinas da mesma região;
// sem vizinha, usa as demais usinas e um limite mais rigoroso.
export function analisar(usinas, hoje = hojeBR(), janela = 90) {
  const dias = []; for (let d = somaDias(hoje, -janela); d < hoje; d = somaDias(d, 1)) dias.push(d);
  const U = usinas.map((u) => {
    const mapa = new Map(u.diario);
    return { ...u, prod: dias.map((d) => (mapa.has(d) ? mapa.get(d) / 1000 / u.kwp : NaN)) };
  });
  U.forEach((u) => {
    const viz = U.filter((o) => o !== u && o.regiao === u.regiao);
    u.vizinhas = viz.length > 0;
    const base = viz.length ? viz : U.filter((o) => o !== u);
    u.ref = dias.map((_, k) => {
      const v = base.map((o) => o.prod[k]).filter((x) => Number.isFinite(x) && x > 0); // vizinha parada não vira referência
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    });
    u.limiar = u.vizinhas ? 0.6 : 0.25;
    const razoes = [];
    dias.forEach((_, k) => { if (u.ref[k] >= 2 && u.prod[k] > 0) razoes.push(u.prod[k] / u.ref[k]); });
    u.razaoNormal = mediana(razoes);
    if (!Number.isFinite(u.razaoNormal)) {
      // sem referência (uma usina só): o esperado passa a ser a mediana dos últimos 30 dias dela
      const proprios = mediana(u.prod.slice(-30));
      u.ref = dias.map(() => proprios); u.razaoNormal = 1; u.limiar = 0.25;
    }
    u.esperado = dias.map((_, k) => (Number.isFinite(u.ref[k]) ? u.ref[k] * u.razaoNormal : NaN));
    u.status = dias.map((_, k) => {
      const p = u.prod[k], e = u.esperado[k];
      if (!Number.isFinite(p)) return "sem dado";
      if (!Number.isFinite(e) || u.ref[k] < 1) return "ok";
      if (p === 0) return "parada";
      return p / e < u.limiar ? "baixa" : "ok";
    });
    u.eventos = []; let atual = null;
    dias.forEach((d, k) => {
      const st = u.status[k];
      if (st === "parada" || st === "baixa") {
        const perda = (u.esperado[k] - u.prod[k]) * u.kwp;
        if (atual && atual.fimIdx === k - 1) {
          Object.assign(atual, { fimIdx: k, fim: d, perda: atual.perda + perda, n: atual.n + 1,
            min: Math.min(atual.min, u.prod[k] / u.esperado[k]), zeros: atual.zeros + (st === "parada" ? 1 : 0) });
        } else {
          atual = { ini: d, fim: d, fimIdx: k, perda, n: 1, min: u.prod[k] / u.esperado[k], zeros: st === "parada" ? 1 : 0 };
          u.eventos.push(atual);
        }
      } else atual = null;
    });
  });
  return { dias, usinas: U };
}

// Relatório dos últimos 7 dias fechados (até ontem) + regularidade de funcionamento.
export function montarRelatorio(usinas, { hoje = hojeBR(), agora = new Date() } = {}) {
  const { dias, usinas: U } = analisar(usinas, hoje);
  const n = dias.length, i7 = n - 7, i14 = n - 14;
  const sum = (a) => a.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
  const itens = U.map((u) => {
    const real7 = u.prod.slice(i7).map((p) => p * u.kwp), esp7 = u.esperado.slice(i7).map((p) => p * u.kwp);
    const total7 = sum(real7), esperado7 = sum(esp7), prev7 = sum(u.prod.slice(i14, i7).map((p) => p * u.kwp));
    const indice7 = esperado7 > 0 ? total7 / esperado7 : NaN;
    const diasRep = dias.slice(i7).map((d, j) => ({
      dia: d, kwh: real7[j], esperado: esp7[j], pct: esp7[j] > 0 ? real7[j] / esp7[j] : NaN,
      kwh_kwp: u.prod[i7 + j], status: u.status[i7 + j] }));
    const validos = diasRep.filter((x) => Number.isFinite(x.kwh));
    const melhor = validos.reduce((a, b) => (!a || b.kwh > a.kwh ? b : a), null);
    const pior = validos.reduce((a, b) => (!a || b.kwh < a.kwh ? b : a), null);
    const parados = diasRep.filter((x) => x.status === "parada").length;
    const baixos = diasRep.filter((x) => x.status === "baixa").length;
    const semDado = diasRep.filter((x) => x.status === "sem dado").length;
    const perda = sum(diasRep.filter((x) => x.status === "parada" || x.status === "baixa").map((x) => x.esperado - x.kwh));
    const micros = u.micros || [];
    const micOff = micros.filter((m) => m.conectado === false).length, micAlarme = micros.filter((m) => m.alarme).length;
    const ultima = u.real_em ? new Date(u.real_em) : null;
    const horasSem = ultima ? (agora - ultima) / 3600e3 : Infinity;
    const hBR = Number(horaBR(agora).slice(0, 2));
    const diurno = hBR >= 8 && hBR < 18; // à noite os microinversores desligam (sem sol) e o S-Miles os mostra desconectados
    // de dia: mais de 3 h sem dado; de manhã cedo/à noite: nenhum dado desde a tarde do dia anterior
    const semComunicacao = diurno ? horasSem > 3 : horasSem > 16;
    const micOffDia = diurno ? micOff : 0;
    const motivos = [];
    if (parados) motivos.push(`${parados} dia(s) sem geração enquanto a referência gerou normalmente`);
    if (baixos) motivos.push(`${baixos} dia(s) com geração muito abaixo do esperado`);
    if (semComunicacao) motivos.push(`sem comunicação com o S-Miles há ${Number.isFinite(horasSem) ? fmt(horasSem) + " h" : "tempo indeterminado"}`);
    if (micOffDia) motivos.push(`${micOff} de ${micros.length} microinversor(es) desconectado(s)`);
    if (micAlarme) motivos.push(`${micAlarme} microinversor(es) com alarme`);
    // sem vizinha monitorada a comparação sofre com o clima de outra região: margem maior
    const [limAt, limIrr] = u.vizinhas ? [0.9, 0.75] : [0.7, 0.5];
    const indBaixo = Number.isFinite(indice7) && indice7 < limAt, indMuitoBaixo = Number.isFinite(indice7) && indice7 < limIrr;
    if (indBaixo) motivos.push(`índice de desempenho da semana em ${fmt(indice7 * 100)}%`);
    if (semDado) motivos.push(`${semDado} dia(s) sem dado no S-Miles`);
    let nivel = "Regular";
    if (parados || semComunicacao || baixos >= 2 || indMuitoBaixo) nivel = "Irregular";
    else if (baixos || micOffDia || micAlarme || semDado || indBaixo) nivel = "Atenção";
    if (!motivos.length) motivos.push(micOff && !diurno
      ? "geração dentro do esperado todos os dias; microinversores desligados agora porque é noite"
      : "geração dentro do esperado todos os dias, microinversores online e sem alarme");
    const tr = u.tempo_real || {};
    // ---- status de funcionamento (para ação dos gestores): foco no último dia fechado e no agora
    const ontem = diasRep[diasRep.length - 1] || {};
    const snOff = micros.filter((m) => m.conectado === false).map((m) => m.sn).filter(Boolean);
    const snAlarme = micros.filter((m) => m.alarme).map((m) => m.sn).filter(Boolean);
    const acoes = [];
    if (ontem.status === "parada")
      acoes.push({ grav: "alta", alerta: `Não gerou ontem (${dataBR(ontem.dia)})`,
        acao: "Verificar no local disjuntores/DPS do quadro solar e se há energia da rede; conferir o app S-Miles e acionar o instalador." });
    else if (ontem.status === "baixa")
      acoes.push({ grav: "media", alerta: `Geração de ontem em ${Number.isFinite(ontem.pct) ? fmt(ontem.pct * 100) + "%" : "—"} do esperado`,
        acao: "Conferir no S-Miles se algum microinversor/painel ficou zerado; verificar sombreamento ou sujeira." });
    if (semComunicacao)
      acoes.push({ grav: "alta", alerta: `Sem comunicação com o S-Miles há ${Number.isFinite(horasSem) ? fmt(horasSem) + " h" : "tempo indeterminado"}`,
        acao: "Verificar internet/Wi-Fi do local e o DTU (desligar e ligar da tomada); se continuar, acionar o instalador." });
    if (micOffDia)
      acoes.push({ grav: micOff === micros.length ? "alta" : "media", alerta: `${micOff} de ${micros.length} microinversor(es) desconectado(s)`,
        acao: `Acionar o instalador para checar ${snOff.length ? "os microinversores " + snOff.join(", ") : "os microinversores desconectados"} (conectores, disjuntor do circuito).` });
    if (micAlarme)
      acoes.push({ grav: "media", alerta: `${micAlarme} microinversor(es) com alarme`,
        acao: `Abrir os alarmes no S-Miles${snAlarme.length ? " (" + snAlarme.join(", ") + ")" : ""} e repassar ao instalador.` });
    if (parados > (ontem.status === "parada" ? 1 : 0) || baixos >= 2)
      acoes.push({ grav: "media", alerta: `Semana com ${parados ? parados + " dia(s) parada" : ""}${parados && baixos ? " e " : ""}${baixos ? baixos + " dia(s) com geração baixa" : ""}`,
        acao: "Comparar dia a dia no painel; se recorrente, agendar inspeção técnica." });
    if (indBaixo && !acoes.length)
      acoes.push({ grav: indMuitoBaixo ? "alta" : "media", alerta: `Desempenho da semana em ${fmt(indice7 * 100)}% do esperado`,
        acao: "Agendar limpeza dos painéis e inspeção de sombreamento/strings." });
    if (semDado)
      acoes.push({ grav: "baixa", alerta: `${semDado} dia(s) sem dado no S-Miles`, acao: "Conferir se o DTU está enviando os dados ao S-Miles." });
    const operacao = acoes.some((a) => a.grav === "alta") ? "Anomalia" : acoes.length ? "Atenção" : "Operando normalmente";
    return {
      sid: u.sid, apelido: u.apelido, kwp: u.kwp, regiao: u.regiao, vizinhas: u.vizinhas,
      total7, esperado7, indice7, prev7, var_semana: prev7 > 0 ? total7 / prev7 - 1 : NaN,
      media_kwp_dia: total7 / u.kwp / 7, perda7: perda, melhor, pior, dias: diasRep,
      hoje_kwh: Number(tr.today_eq || 0) / 1000, potencia_kw: Number(tr.real_power || 0) / 1000,
      mes_kwh: Number(tr.month_eq || 0) / 1000, total_mwh: Number(tr.total_eq || 0) / 1e6,
      micros: { total: micros.length, online: micros.length - micOff, alarme: micAlarme },
      ultima_comunicacao: ultima ? ultima.toISOString() : null,
      regularidade: { nivel, motivos },
      status: { operacao, acoes, ontem_kwh: ontem.kwh, ontem_pct: ontem.pct, ontem_status: ontem.status, ontem_dia: ontem.dia,
                diurno, horas_sem_dado: Number.isFinite(horasSem) ? horasSem : null, micros_off: snOff, micros_alarme: snAlarme },
      eventos90: u.eventos.map(({ fimIdx, ...e }) => e),
    };
  });
  const tot = (k) => itens.reduce((s, x) => s + (Number.isFinite(x[k]) ? x[k] : 0), 0);
  return {
    gerado_em: agora.toISOString(), hoje, periodo: { ini: dias[i7], fim: dias[n - 1] },
    totais: { kwh7: tot("total7"), prev7: tot("prev7"), esperado7: tot("esperado7"), perda7: tot("perda7"),
              hoje_kwh: tot("hoje_kwh"), kwp: tot("kwp") },
    contagem: { Regular: itens.filter((x) => x.regularidade.nivel === "Regular").length,
                "Atenção": itens.filter((x) => x.regularidade.nivel === "Atenção").length,
                Irregular: itens.filter((x) => x.regularidade.nivel === "Irregular").length },
    usinas: itens,
  };
}


/* ------------------------------------------------------------------ visibilidade por usuário */
// A análise usa sempre TODAS as usinas (a vizinha é a referência); o usuário só vê as dos titulares liberados.
export const visivel = (u, titulares) => !titulares || (u.titular_id && titulares.has(Number(u.titular_id)));
export function filtrarRelatorio(rel, sids) {
  const usinas = rel.usinas.filter((u) => sids.has(Number(u.sid)));
  const tot = (k) => usinas.reduce((s, x) => s + (Number.isFinite(x[k]) ? x[k] : 0), 0);
  const cont = (n) => usinas.filter((x) => x.regularidade.nivel === n).length;
  return { ...rel, usinas,
    totais: { kwh7: tot("total7"), prev7: tot("prev7"), esperado7: tot("esperado7"), perda7: tot("perda7"), hoje_kwh: tot("hoje_kwh"), kwp: tot("kwp") },
    contagem: { Regular: cont("Regular"), "Atenção": cont("Atenção"), Irregular: cont("Irregular") } };
}
async function relatorioDoUsuario(titulares) {
  const todas = await carregarUsinas();
  const rel = montarRelatorio(todas);
  if (!titulares) return rel;
  return filtrarRelatorio(rel, new Set(todas.filter((u) => visivel(u, titulares)).map((u) => Number(u.sid))));
}

/* ------------------------------------------------------------------ e-mail */
const COR = { Regular: ["#12805c", "#e3f4ec"], "Atenção": ["#b76a00", "#fdf1de"], Irregular: ["#b42318", "#fde8e6"] };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const COR_OP = { "Anomalia": ["#b42318", "#fde8e6", "●"], "Atenção": ["#b76a00", "#fdf1de", "●"], "Operando normalmente": ["#12805c", "#e3f4ec", "●"] };

export function assuntoRelatorio(rel) {
  const c = rel.contagem, partes = [];
  const anom = rel.usinas.filter((u) => u.status?.operacao === "Anomalia").map((u) => u.apelido);
  const aten = rel.usinas.filter((u) => u.status?.operacao === "Atenção").map((u) => u.apelido);
  const prefixo = anom.length ? `[AÇÃO NECESSÁRIA: ${anom.join(", ")}] ` : aten.length ? `[ATENÇÃO: ${aten.join(", ")}] ` : "[OK] ";
  if (c.Irregular) partes.push(`${c.Irregular} irregular${c.Irregular > 1 ? "es" : ""}`);
  if (c["Atenção"]) partes.push(`${c["Atenção"]} em atenção`);
  if (c.Regular) partes.push(`${c.Regular} regular${c.Regular > 1 ? "es" : ""}`);
  return `${prefixo}Usinas solares · ${dataBR(rel.hoje)} · ${partes.join(", ") || "sem dados"}`;
}

export function htmlRelatorio(rel, { url = process.env.PUBLIC_URL || "https://energiasolar-production.up.railway.app", falhas = [] } = {}) {
  const pct = (x) => (Number.isFinite(x) ? fmt(x * 100) + "%" : "—");
  const manha = Number(horaBR(new Date(rel.gerado_em)).slice(0, 2)) < 10;
  const td = "padding:7px 8px;border-bottom:1px solid #e3e8f4;font-size:13px;";
  const th = "padding:7px 8px;border-bottom:2px solid #dde4f5;font-size:11px;color:#5d6a84;text-transform:uppercase;letter-spacing:.04em;text-align:right;";
  const cartoes = rel.usinas.map((u) => {
    const [cor, fundo] = COR[u.regularidade.nivel];
    const varS = Number.isFinite(u.var_semana) ? `${u.var_semana >= 0 ? "+" : ""}${fmt(u.var_semana * 100)}% vs. semana anterior` : "";
    return `<tr><td style="padding:0 0 14px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dde4f5;border-left:5px solid ${cor};border-radius:10px;background:#fff">
        <tr><td style="padding:14px 16px">
          <table role="presentation" width="100%"><tr>
            <td style="font-size:16px;font-weight:700;color:#172033">${esc(u.apelido)} <span style="font-weight:400;color:#5d6a84;font-size:13px">· ${fmt(u.kwp)} kWp</span></td>
            <td align="right"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${fundo};color:${cor};font-size:12px;font-weight:700">${u.regularidade.nivel}</span></td>
          </tr></table>
          <table role="presentation" width="100%" style="margin-top:10px"><tr>
            <td style="font-size:12px;color:#5d6a84">7 dias<br><b style="font-size:18px;color:#1a2456">${fmt(u.total7)} kWh</b><br>${varS}</td>
            <td style="font-size:12px;color:#5d6a84">Desempenho<br><b style="font-size:18px;color:${u.indice7 >= (u.vizinhas ? 0.9 : 0.7) ? "#12805c" : u.indice7 >= (u.vizinhas ? 0.75 : 0.5) ? "#b76a00" : "#b42318"}">${pct(u.indice7)}</b><br>do esperado</td>
            <td style="font-size:12px;color:#5d6a84">Produtividade<br><b style="font-size:18px;color:#1a2456">${fmt(u.media_kwp_dia, 2)}</b><br>kWh/kWp/dia</td>
            ${manha
              ? `<td style="font-size:12px;color:#5d6a84">Ontem<br><b style="font-size:18px;color:#1a2456">${Number.isFinite(u.status?.ontem_kwh) ? fmt(u.status.ontem_kwh, 1) : "—"} kWh</b><br>${pct(u.status?.ontem_pct)} do esperado</td>`
              : `<td style="font-size:12px;color:#5d6a84">Hoje até agora<br><b style="font-size:18px;color:#1a2456">${fmt(u.hoje_kwh, 1)} kWh</b><br>${u.micros.online}/${u.micros.total} micros online</td>`}
          </tr></table>
          <p style="margin:10px 0 0;font-size:13px;color:#172033"><b>Funcionamento:</b> ${u.regularidade.motivos.map(esc).join("; ")}.</p>
          ${u.perda7 > 0.5 ? `<p style="margin:6px 0 0;font-size:13px;color:#b42318">Perda estimada na semana: ${fmt(u.perda7, 1)} kWh.</p>` : ""}
        </td></tr></table></td></tr>`;
  }).join("");
  const cab = rel.usinas.map((u) => `<th style="${th}">${esc(u.apelido)}</th>`).join("");
  const linhas = (rel.usinas[0]?.dias || []).map((_, j) => {
    const d = rel.usinas[0].dias[j].dia;
    const cel = rel.usinas.map((u) => {
      const x = u.dias[j]; const cor = x.status === "parada" || x.status === "baixa" ? "#b42318" : "#172033";
      const marca = x.status === "parada" ? " · parada" : x.status === "baixa" ? " · baixa" : x.status === "sem dado" ? " · sem dado" : "";
      return `<td style="${td}text-align:right;color:${cor}">${Number.isFinite(x.kwh) ? fmt(x.kwh, 1) : "—"} kWh<br><span style="font-size:11px;color:#5d6a84">${pct(x.pct)} do esperado${marca}</span></td>`;
    }).join("");
    return `<tr><td style="${td}white-space:nowrap">${dataBR(d)}</td>${cel}</tr>`;
  }).join("");
  const t = rel.totais;
  const nAnom = rel.usinas.filter((u) => u.status?.operacao === "Anomalia").length;
  const nAten = rel.usinas.filter((u) => u.status?.operacao === "Atenção").length;
  const [bCor, bFundo] = nAnom ? COR_OP["Anomalia"] : nAten ? COR_OP["Atenção"] : COR_OP["Operando normalmente"];
  const bTexto = nAnom ? `AÇÃO NECESSÁRIA · ${nAnom} usina(s) com anomalia de funcionamento`
    : nAten ? `ATENÇÃO · ${nAten} usina(s) para acompanhar` : `TODAS AS USINAS OPERANDO NORMALMENTE`;
  const bSub = nAnom || nAten ? "Veja abaixo o que foi detectado e a ação recomendada para cada usina."
    : "Geração de ontem dentro do esperado, comunicação com o S-Miles ativa e microinversores sem alarme.";
  const ultCom = (u) => {
    if (!u.ultima_comunicacao) return "sem registro";
    const d = new Date(u.ultima_comunicacao);
    return `${hojeBR(d) === rel.hoje ? "hoje" : dataBR(hojeBR(d))} ${horaBR(d)}`;
  };
  const linhasStatus = rel.usinas.map((u) => {
    const st = u.status || { operacao: "Atenção", acoes: [] };
    const [cor, fundo] = COR_OP[st.operacao] || COR_OP["Atenção"];
    const ontemTxt = Number.isFinite(st.ontem_kwh) ? `${fmt(st.ontem_kwh, 1)} kWh · ${Number.isFinite(st.ontem_pct) ? fmt(st.ontem_pct * 100) + "%" : "—"} do esperado` : "sem dado";
    const acoes = st.acoes.length ? `<tr><td colspan="4" style="padding:0 12px 12px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${st.acoes.map((a) => `
          <tr><td style="padding:8px 10px;border-radius:6px;background:${a.grav === "alta" ? "#fde8e6" : a.grav === "media" ? "#fdf1de" : "#eef1f9"};font-size:13px;color:#172033">
            <b style="color:${a.grav === "alta" ? "#b42318" : a.grav === "media" ? "#b76a00" : "#5d6a84"}">${esc(a.alerta)}</b><br>
            <span style="color:#172033">→ Ação: ${esc(a.acao)}</span></td></tr><tr><td style="height:6px"></td></tr>`).join("")}
        </table></td></tr>` : "";
    return `<tr><td style="padding:0 0 10px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dde4f5;border-left:6px solid ${cor};border-radius:10px;background:#fff">
      <tr>
        <td style="padding:12px 12px 10px;font-size:15px;font-weight:700;color:#172033">${esc(u.apelido)}<br>
          <span style="display:inline-block;margin-top:5px;padding:3px 10px;border-radius:999px;background:${fundo};color:${cor};font-size:12px;font-weight:700">${st.operacao.toUpperCase()}</span></td>
        <td style="padding:12px 6px 10px;font-size:12px;color:#5d6a84">Ontem<br><b style="font-size:14px;color:${st.ontem_status === "parada" || st.ontem_status === "baixa" ? "#b42318" : "#1a2456"}">${ontemTxt}</b></td>
        <td style="padding:12px 6px 10px;font-size:12px;color:#5d6a84">Última comunicação<br><b style="font-size:14px;color:${u.regularidade.motivos.some((m) => m.startsWith("sem comunicação")) ? "#b42318" : "#1a2456"}">${ultCom(u)}</b></td>
        <td style="padding:12px 12px 10px 6px;font-size:12px;color:#5d6a84">Microinversores<br><b style="font-size:14px;color:${st.diurno && u.micros.online < u.micros.total ? "#b42318" : "#1a2456"}">${st.diurno ? `${u.micros.online}/${u.micros.total} online` : `${u.micros.total} · fora do horário de sol`}</b>${u.micros.alarme ? `<br><span style="color:#b42318">${u.micros.alarme} com alarme</span>` : ""}</td>
      </tr>${acoes}</table></td></tr>`;
  }).join("");
  const painelStatus = `
    <tr><td style="padding:0 0 14px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${bFundo};border:2px solid ${bCor};border-radius:12px">
        <tr><td style="padding:14px 16px">
          <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5d6a84;font-weight:700">Status de funcionamento</div>
          <div style="font-size:19px;font-weight:800;color:${bCor};margin-top:3px">${bTexto}</div>
          <div style="font-size:13px;color:#172033;margin-top:3px">${bSub}</div>
        </td></tr></table></td></tr>
    ${linhasStatus}
    <tr><td style="padding:0 0 4px;font-size:11px;color:#5d6a84">Anomalia = exige ação hoje (usina parada, sem comunicação ou todos os microinversores desconectados). Atenção = acompanhar. ${manha ? "De manhã cedo os microinversores ainda podem estar ligando com o sol; a conexão deles só é cobrada entre 8h e 18h." : ""}</td></tr>
    <tr><td style="height:14px"></td></tr>
    <tr><td style="padding:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5d6a84;font-weight:700">Performance dos últimos 7 dias</td></tr>`;
  const avisoFalha = falhas.length ? `<p style="margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#fde8e6;color:#b42318;font-size:13px">
     O robô não conseguiu ler ${falhas.length} conta(s) do S-Miles hoje: ${falhas.map((f) => esc(f.conta) + " (" + esc(f.erro) + ")").join("; ")}. Os números dessas usinas são da última leitura bem-sucedida.</p>` : "";
  return `<!doctype html><html><body style="margin:0;background:#eef1f9;font-family:Segoe UI,Arial,sans-serif;color:#172033">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef1f9"><tr><td align="center" style="padding:20px 12px">
  <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%">
    <tr><td style="background:#1a2456;border-radius:14px;padding:18px 20px;color:#fff">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#f3dcae">Lério &amp; Silva · Usinas solares</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">Relatório de performance · ${dataBR(rel.hoje)}</div>
      <div style="font-size:13px;color:#d6dcf2;margin-top:4px">Últimos 7 dias (${dataBR(rel.periodo.ini)} a ${dataBR(rel.periodo.fim)}) · fonte: S-Miles Cloud (Hoymiles)</div>
    </td></tr>
    <tr><td style="height:14px"></td></tr>
    ${avisoFalha ? `<tr><td>${avisoFalha}</td></tr>` : ""}
    ${painelStatus}
    <tr><td style="background:#fff;padding:16px 20px;border-radius:14px;border:1px solid #dde4f5">
      <table role="presentation" width="100%"><tr>
        <td style="font-size:12px;color:#5d6a84">Geração 7 dias<br><b style="font-size:20px;color:#1a2456">${fmt(t.kwh7)} kWh</b></td>
        <td style="font-size:12px;color:#5d6a84">Esperado<br><b style="font-size:20px;color:#1a2456">${fmt(t.esperado7)} kWh</b></td>
        <td style="font-size:12px;color:#5d6a84">Semana anterior<br><b style="font-size:20px;color:#1a2456">${fmt(t.prev7)} kWh</b></td>
        <td style="font-size:12px;color:#5d6a84">Perda estimada<br><b style="font-size:20px;color:${t.perda7 > 0.5 ? "#b42318" : "#12805c"}">${fmt(t.perda7, 1)} kWh</b></td>
      </tr></table>
    </td></tr>
    <tr><td style="height:14px"></td></tr>
    ${cartoes}
    <tr><td style="background:#fff;border:1px solid #dde4f5;border-radius:10px;padding:14px 16px">
      <div style="font-size:15px;font-weight:700;margin-bottom:6px">Geração diária</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><th style="${th}text-align:left">Dia</th>${cab}</tr>${linhas}</table>
      <p style="font-size:11px;color:#5d6a84;margin:10px 0 0">Esperado = geração da usina vizinha no mesmo dia, ajustada pelo desempenho normal de cada usina.${rel.usinas.filter((u) => !u.vizinhas).length ? ` ${rel.usinas.filter((u) => !u.vizinhas).map((u) => esc(u.apelido)).join(", ")} não tem vizinha monitorada e só é marcada em quedas fortes.` : ""}</p>
    </td></tr>
    <tr><td style="padding:16px 4px;font-size:12px;color:#5d6a84;text-align:center">
      <a href="${esc(url)}/usinas" style="color:#3146a3;font-weight:700">Abrir o painel das usinas</a><br>
      Enviado automaticamente pelo robô da plataforma às ${horaBR(new Date(rel.gerado_em))} (horário de Brasília).
    </td></tr>
  </table></td></tr></table></body></html>`;
}

export async function enviarEmail({ assunto, html }) {
  const para = process.env.RELATORIO_PARA || "otaviolerio@outlook.com";
  if (process.env.EMAIL_WEBHOOK_URL) {
    const url = process.env.EMAIL_WEBHOOK_URL.trim();
    // O Apps Script executa o doPost e responde 302 para a página com o resultado: segue o redirecionamento
    // manualmente com GET (alguns clientes refazem o POST sem o corpo e caem na página de erro).
    let r = await fetch(url, {
      method: "POST", redirect: "manual", headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: (process.env.EMAIL_WEBHOOK_TOKEN || "").trim(), para, assunto, html }),
    });
    for (let i = 0; i < 3 && r.status >= 300 && r.status < 400 && r.headers.get("location"); i++) {
      r = await fetch(new URL(r.headers.get("location"), url), { method: "GET", redirect: "manual" });
    }
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
    if (!j?.ok) {
      const msg = j?.erro || ((txt.match(/<title>([^<]*)/i) || [])[1] || "") + " " +
        txt.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(`o script do Google não enviou (HTTP ${r.status}): ${msg}`);
    }
    return `enviado pelo Gmail (script do Google) para ${para}`;
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    const nm = (await import("nodemailer")).default;
    const tr = nm.createTransport({ host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }, connectionTimeout: 20000 });
    await tr.sendMail({ from: `"Robô Usinas · Lério & Silva" <${process.env.GMAIL_USER}>`, to: para, subject: assunto, html });
    return `enviado pelo Gmail (SMTP) para ${para}`;
  }
  throw new Error("envio de e-mail não configurado (EMAIL_WEBHOOK_URL ou GMAIL_USER + GMAIL_APP_PASSWORD)");
}

/* ------------------------------------------------------------------ execução diária */
let rodando = null;
export function emExecucao() { return !!rodando; }

export async function executar({ tipo = "manual", enviar = true, cliente, contas } = {}) {
  if (rodando) throw new Error("já existe uma atualização em andamento");
  rodando = (async () => {
    await garantirTabelas();
    const hoje = hojeBR();
    const { rows } = await query("INSERT INTO usina_execucoes (tipo, data_ref, status) VALUES ($1,$2,'rodando') RETURNING id", [tipo, hoje]);
    const id = rows[0].id, linhas = [];
    const log = (m) => { const l = `[${horaBR()}] ${m}`; linhas.push(l); console.log("[usinas] " + m); };
    let status = "ok", email = null, rel = null, res = { falhas: [] };
    try {
      res = await coletar({ cliente, contas, log, hoje });
      if (res.falhas.length) status = res.contas ? "parcial" : "erro";
      rel = montarRelatorio(await carregarUsinas(), { hoje });
      log(`relatório: ${rel.usinas.map((u) => `${u.apelido} ${u.regularidade.nivel}`).join(" | ")}`);
    } catch (e) { status = "erro"; log("FALHA: " + e.message); }
    if (enviar) {
      try {
        if (rel && rel.usinas.length) {
          email = await enviarEmail({ assunto: assuntoRelatorio(rel), html: htmlRelatorio(rel, { falhas: res.falhas }) });
        } else {
          email = await enviarEmail({ assunto: `Usinas solares · ${dataBR(hoje)} · robô sem dados`,
            html: `<p>O robô das usinas não conseguiu gerar o relatório de hoje.</p><pre>${esc(linhas.join("\n"))}</pre>` });
        }
        log(email);
      } catch (e) { email = "FALHA: " + e.message; log("e-mail: " + e.message); if (status === "ok") status = "parcial"; }
    }
    await query("UPDATE usina_execucoes SET fim=now(), status=$2, log=$3, email=$4, relatorio=$5 WHERE id=$1",
      [id, status, linhas.join("\n"), email, rel ? JSON.stringify(rel) : null]);
    return { id, status, email, log: linhas };
  })();
  try { return await rodando; } finally { rodando = null; }
}

export function iniciarAgendador() {
  if (/^(sim|true|1)$/i.test(process.env.ROBO_DESATIVADO || "")) { console.log("[usinas] agendamento desativado"); return; }
  const horario = (process.env.ROBO_HORARIO || HORARIO_PADRAO).padStart(5, "0");
  console.log(`[usinas] robô diário agendado para ${horario} (Brasília)`);
  const tick = async () => {
    try {
      if (rodando || !lerContas().length || horaBR() < horario) return;
      await garantirTabelas();
      const hoje = hojeBR();
      const { rows } = await query("SELECT 1 FROM usina_execucoes WHERE tipo='diario' AND data_ref=$1 LIMIT 1", [hoje]);
      if (rows.length) return;
      const lock = await query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID]);
      if (!lock.rows[0].ok) return;
      try {
        const again = await query("SELECT 1 FROM usina_execucoes WHERE tipo='diario' AND data_ref=$1 LIMIT 1", [hoje]);
        if (!again.rows.length) await executar({ tipo: "diario", enviar: true });
      } finally { await query("SELECT pg_advisory_unlock($1)", [LOCK_ID]); }
    } catch (e) { console.error("[usinas] agendador:", e.message); }
  };
  setInterval(tick, 60 * 1000).unref?.();
  setTimeout(tick, 15 * 1000);
}

/* ------------------------------------------------------------------ rotas */
export function instalarUsinas(app, { publicDir }) {
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("[usinas]", e); res.status(500).json({ erro: e.message || "Erro interno" });
  });
  const soAdmin = (req, res, next) => (req.usuario?.admin ? next() : res.status(403).json({ erro: "Acesso restrito ao administrador." }));
  const filtro = (req) => (req.usuario?.admin ? null : req.usuario?.titulares || new Set());

  garantirTabelas().catch((e) => console.error("[usinas] falha ao criar tabelas:", e.message));

  app.get(["/usinas", "/usinas.html"], (req, res) => res.sendFile(path.join(publicDir, "usinas.html")));

  app.get("/api/usinas/painel", wrap(async (req, res) => {
    const tit = filtro(req), todas = await carregarUsinas();
    const usinas = todas.filter((u) => visivel(u, tit));
    // séries anônimas das demais usinas, só para a comparação com a vizinha (sem nome, conta ou endereço)
    const referencias = tit ? todas.filter((u) => !visivel(u, tit)).map((u) => ({ regiao: u.regiao,
      diario: u.diario.slice(-120).map(([d, wh]) => [d, u.kwp ? wh / 1000 / u.kwp : null]) })) : [];
    const ult = await query(`SELECT id, tipo, data_ref, inicio, fim, status, email FROM usina_execucoes ORDER BY id DESC LIMIT 1`);
    res.json({
      hoje: hojeBR(), usinas, referencias, ultima_execucao: ult.rows[0] || null, em_execucao: emExecucao(),
      config: req.usuario?.admin ? {
        contas: lerContas().map((c) => c.u), horario: process.env.ROBO_HORARIO || HORARIO_PADRAO,
        para: process.env.RELATORIO_PARA || "otaviolerio@outlook.com",
        email: process.env.EMAIL_WEBHOOK_URL ? "script do Google" : process.env.GMAIL_USER ? "Gmail SMTP" : null,
        agendamento: !/^(sim|true|1)$/i.test(process.env.ROBO_DESATIVADO || ""),
      } : null,
    });
  }));

  app.get("/api/usinas/relatorio", wrap(async (req, res) => {
    res.json(await relatorioDoUsuario(filtro(req)));
  }));

  app.get("/api/usinas/relatorio.html", wrap(async (req, res) => {
    const rel = await relatorioDoUsuario(filtro(req));
    res.type("html").send(htmlRelatorio(rel));
  }));

  app.get("/api/usinas/execucoes", soAdmin, wrap(async (req, res) => {
    const { rows } = await query(`SELECT id, tipo, to_char(data_ref,'YYYY-MM-DD') data_ref, inicio, fim, status, email, log
                                    FROM usina_execucoes ORDER BY id DESC LIMIT 30`);
    res.json(rows);
  }));

  app.post("/api/usinas/executar", soAdmin, wrap(async (req, res) => {
    if (emExecucao()) return res.status(409).json({ erro: "Já existe uma atualização em andamento." });
    if (!lerContas().length) return res.status(400).json({ erro: "Cadastre as contas do S-Miles na variável HOYMILES_CONTAS do Railway." });
    const enviar = req.body?.enviar !== false;
    executar({ tipo: "manual", enviar }).catch((e) => console.error("[usinas] execução manual:", e.message));
    res.status(202).json({ ok: true, mensagem: enviar ? "Atualização iniciada; o e-mail sai ao final." : "Atualização iniciada." });
  }));

  app.put("/api/usinas/:sid", soAdmin, wrap(async (req, res) => {
    const { apelido, uc_codigo, regiao, ativa } = req.body || {};
    const { rowCount } = await query(`UPDATE usinas SET
        apelido = COALESCE($2, apelido), uc_codigo = COALESCE($3, uc_codigo),
        regiao = COALESCE($4, regiao), ativa = COALESCE($5, ativa) WHERE sid = $1`,
      [req.params.sid, apelido ?? null, uc_codigo ?? null, regiao ?? null, typeof ativa === "boolean" ? ativa : null]);
    if (!rowCount) return res.status(404).json({ erro: "Usina não encontrada." });
    res.json({ ok: true });
  }));

  iniciarAgendador();
}
