// src/parsing.js
// Normalizacao de linhas vindas do Excel/CSV.
// Porta a logica de parsing do arquivo HTML original para o lado do servidor.

const MES_ABBR = {
  JAN: "01", FEV: "02", MAR: "03", ABR: "04", MAI: "05", JUN: "06",
  JUL: "07", AGO: "08", SET: "09", OUT: "10", NOV: "11", DEZ: "12",
};

// Converte "1.234,56" / "R$ 1.234,56" / 1234.56 em Number.
export function parseNumeroBR(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Deriva chave de ordenacao (AAAA-MM), label (MM/AAAA) e ano a partir do mes.
export function parseMes(mes) {
  if (!mes) return { chave: "", label: "", ano: "" };
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

// Le um valor de uma linha tentando varios nomes de coluna (case/acentuacao tolerante).
function pick(row, ...keys) {
  // mapa normalizado (sem acento, minusculo, sem espacos extras)
  const norm = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = String(k)
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    // nunca sobrescreve um valor ja preenchido por um vazio (colunas duplicadas)
    if (norm[nk] === undefined || norm[nk] === "") norm[nk] = v;
  }
  for (const key of keys) {
    const nk = String(key)
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (norm[nk] !== undefined && norm[nk] !== "") return norm[nk];
  }
  return "";
}

// Recebe um objeto de linha (do XLSX.utils.sheet_to_json) e devolve uma fatura normalizada.
export function normalizarLinha(row) {
  const mesRaw = pick(row, "Mês", "Mes", "mes");
  const mesInfo = parseMes(mesRaw);
  const consumo = parseNumeroBR(
    pick(row, "Consumo Faturado (kWh)", "Consumo (kWh)", "Consumo", "consumo")
  );
  const total = parseNumeroBR(pick(row, "Total a pagar", "Total", "total"));

  return {
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
      pick(row, "Saldo atualizado de energia em kWh", "Saldo", "saldo")
    ),
    inj: parseNumeroBR(
      pick(row, "Energia injetada no mês em kWh", "Energia injetada", "inj")
    ),
    status: String(pick(row, "Status", "status")).trim() || "OK",
  };
}
