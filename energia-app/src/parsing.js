// src/parsing.js
// Normalizacao de linhas vindas do Excel/CSV.
// Tolera variacoes comuns de cabecalho (unidades entre parenteses, acentos, etc).

const MES_ABBR = {
  JAN: "01", FEV: "02", MAR: "03", ABR: "04", MAI: "05", JUN: "06",
  JUL: "07", AGO: "08", SET: "09", OUT: "10", NOV: "11", DEZ: "12",
};

// Converte "1.234,56" / "R$ 1.234,56" / 1234.56 em Number.
export function parseNumeroBR(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[R$\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", "."); // formato BR
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Deriva chave de ordenacao (AAAA-MM), label (MM/AAAA) e ano a partir do mes.
export function parseMes(mes) {
  if (!mes && mes !== 0) return { chave: "", label: "", ano: "" };
  const s = String(mes).trim().toUpperCase();
  if (/^\d{2}\/\d{4}$/.test(s)) {
    const [mm, yyyy] = s.split("/");
    return { chave: `${yyyy}-${mm}`, label: `${mm}/${yyyy}`, ano: yyyy };
  }
  const m = s.match(/^([A-Z]{3})\/(\d{2})$/);
  if (m) {
    const mm = MES_ABBR[m[1]] || "01";
    const yyyy = "20" + m[2];
    return { chave: `${yyyy}-${mm}`, label: `${mm}/${yyyy}`, ano: yyyy };
  }
  return { chave: s, label: s, ano: "" };
}

// Normaliza nome de coluna: minusculo, sem acento, sem (unidades), sem pontuacao.
// "Total a Pagar (R$)" -> "total a pagar" ; "# Dias" -> "dias"
function norm(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Le um valor da linha tentando varios nomes de coluna (tolerante).
function pick(row, ...keys) {
  const map = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = norm(k);
    if (map[nk] === undefined || map[nk] === "") map[nk] = v; // nao sobrescreve preenchido por vazio
  }
  for (const key of keys) {
    const nk = norm(key);
    if (map[nk] !== undefined && map[nk] !== "") return map[nk];
  }
  return "";
}

export function normalizarLinha(row) {
  const mesRaw = pick(row, "Mês", "Mes", "mes");
  const mesInfo = parseMes(mesRaw);
  const consumo = parseNumeroBR(
    pick(row, "Consumo Faturado (kWh)", "Consumo Faturado", "Consumo (kWh)", "Consumo", "consumo")
  );
  const total = parseNumeroBR(
    pick(row, "Total a Pagar (R$)", "Total a pagar", "Total a Pagar", "Total (R$)", "Total", "total")
  );

  return {
    distribuidora: String(pick(row, "Distribuidora", "distribuidora")).trim(),
    titular: String(pick(row, "Titular", "titular", "Cliente", "Nome")).trim(),
    instalacao: String(pick(row, "Instalação", "Instalacao", "UC", "instalacao")).trim(),
    apelido: String(pick(row, "Apelido", "Nome da Instalação", "Nome da Instalacao")).trim(),
    mes: String(mesRaw).trim(),
    mesLabel: mesInfo.label || String(mesRaw).trim(),
    mesKey: mesInfo.chave || String(mesRaw).trim(),
    ano: mesInfo.ano || "",
    leitura: String(pick(row, "Leitura Atual", "Leitura", "leitura")).trim(),
    vencimento: String(pick(row, "Vencimento", "vencimento")).trim(),
    consumo,
    dias: parseNumeroBR(pick(row, "# Dias", "Dias", "dias")),
    total,
    bandeira: String(pick(row, "Bandeira", "bandeira")).trim(),
    saldo: parseNumeroBR(
      pick(row, "Saldo de Energia (kWh)", "Saldo de Energia", "Saldo atualizado de energia em kWh", "Saldo", "saldo")
    ),
    inj: parseNumeroBR(
      pick(row, "Energia Injetada (kWh)", "Energia Injetada", "Energia injetada no mês em kWh", "Energia injetada", "inj")
    ),
    arquivo: String(pick(row, "Arquivo", "arquivo")).trim(),
    status: String(pick(row, "Status", "status")).trim() || "OK",
  };
}
