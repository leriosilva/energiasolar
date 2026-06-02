// public/app.js
const $ = (id) => document.getElementById(id);
const api = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.erro) || `Erro ${res.status}`);
  return data;
};

const fmtMoeda = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtNum = (n, d = 0) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let titulares = [];
let charts = {};

/* ---------------- Tabs ---------------- */
document.querySelectorAll(".tab-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "instalacoes") carregarInstalacoes();
    if (btn.dataset.tab === "analise") carregarAnalise();
    if (btn.dataset.tab === "upload") preencherSelectTitulares($("uploadTitular"), true);
  })
);

/* ---------------- Modais ---------------- */
function abrirModal(id) { $(id).classList.add("open"); }
function fecharModal(id) { $(id).classList.remove("open"); }
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", (e) => e.target.closest(".modal-bg").classList.remove("open"))
);
document.querySelectorAll(".modal-bg").forEach((bg) =>
  bg.addEventListener("click", (e) => { if (e.target === bg) bg.classList.remove("open"); })
);

/* ============================ TITULARES ============================ */
async function carregarTitulares() {
  titulares = await api("/api/titulares");
  renderTitulares();
  preencherSelectTitulares($("filtroTitularInst"), false, "Todos os titulares");
  preencherSelectTitulares($("iTitular"), false);
  preencherSelectTitulares($("uploadTitular"), true);
  preencherSelectTitulares($("fTitular"), false, "Todos");
}

function renderTitulares() {
  const q = ($("buscaTitular").value || "").toLowerCase();
  const lista = titulares.filter(
    (t) => !q || (t.nome || "").toLowerCase().includes(q) || (t.documento || "").toLowerCase().includes(q)
  );
  const grid = $("titularesGrid");
  $("titularesVazio").style.display = lista.length ? "none" : "block";
  grid.innerHTML = lista
    .map(
      (t) => `
    <div class="holder-card">
      <div class="name">${esc(t.nome)}</div>
      <div class="doc">${esc(t.documento || "Sem documento")}${t.email ? " · " + esc(t.email) : ""}</div>
      <div class="pills">
        <span class="pill">${t.qtd_instalacoes} instalação(ões)</span>
        <span class="pill gold">${t.qtd_faturas} fatura(s)</span>
      </div>
      <div class="row-actions" style="margin-top:8px">
        <button class="small secondary" onclick="editarTitular(${t.id})">Editar</button>
        <button class="small ghost" onclick="verInstalacoesDe(${t.id})">Ver instalações</button>
        <button class="small danger" onclick="excluirTitular(${t.id})">Excluir</button>
      </div>
    </div>`
    )
    .join("");
}
$("buscaTitular").addEventListener("input", renderTitulares);

$("novoTitularBtn").addEventListener("click", () => {
  $("modalTitularTitle").textContent = "Novo titular";
  ["titularId", "tNome", "tDoc", "tTel", "tEmail", "tObs"].forEach((id) => ($(id).value = ""));
  abrirModal("modalTitular");
});

window.editarTitular = (id) => {
  const t = titulares.find((x) => x.id === id);
  if (!t) return;
  $("modalTitularTitle").textContent = "Editar titular";
  $("titularId").value = t.id;
  $("tNome").value = t.nome || "";
  $("tDoc").value = t.documento || "";
  $("tTel").value = t.telefone || "";
  $("tEmail").value = t.email || "";
  $("tObs").value = t.observacoes || "";
  abrirModal("modalTitular");
};

$("salvarTitularBtn").addEventListener("click", async () => {
  const body = {
    nome: $("tNome").value.trim(),
    documento: $("tDoc").value.trim(),
    telefone: $("tTel").value.trim(),
    email: $("tEmail").value.trim(),
    observacoes: $("tObs").value.trim(),
  };
  if (!body.nome) return alert("Informe o nome do titular.");
  const id = $("titularId").value;
  try {
    if (id) await api(`/api/titulares/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    else await api("/api/titulares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    fecharModal("modalTitular");
    await carregarTitulares();
  } catch (e) { alert(e.message); }
});

window.excluirTitular = async (id) => {
  if (!confirm("Excluir este titular? Todas as instalações e faturas vinculadas serão removidas.")) return;
  await api(`/api/titulares/${id}`, { method: "DELETE" });
  await carregarTitulares();
};

window.verInstalacoesDe = (id) => {
  document.querySelector('[data-tab="instalacoes"]').click();
  $("filtroTitularInst").value = id;
  carregarInstalacoes();
};

function preencherSelectTitulares(sel, comAuto, allLabel) {
  if (!sel) return;
  const atual = sel.value;
  let html = "";
  if (comAuto) html += `<option value="">— Usar a coluna “Titular” da planilha —</option>`;
  else if (allLabel) html += `<option value="">${allLabel}</option>`;
  html += titulares.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join("");
  sel.innerHTML = html;
  if (atual) sel.value = atual;
}

/* ============================ INSTALAÇÕES ============================ */
async function carregarInstalacoes() {
  const tid = $("filtroTitularInst").value;
  const lista = await api("/api/instalacoes" + (tid ? `?titular_id=${tid}` : ""));
  const tbody = $("instalacoesBody");
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma instalação cadastrada.</td></tr>';
    return;
  }
  tbody.innerHTML = lista
    .map(
      (i) => `<tr>
      <td>${esc(i.titular_nome)}</td>
      <td><strong>${esc(i.codigo)}</strong></td>
      <td>${esc(i.apelido || "—")}</td>
      <td>${esc(i.distribuidora || "—")}</td>
      <td>${esc(i.endereco || "—")}</td>
      <td>${i.qtd_faturas}</td>
      <td class="row-actions">
        <button class="small secondary" onclick='editarInstalacao(${JSON.stringify(i)})'>Editar</button>
        <button class="small danger" onclick="excluirInstalacao(${i.id})">Excluir</button>
      </td>
    </tr>`
    )
    .join("");
}
$("filtroTitularInst").addEventListener("change", carregarInstalacoes);

$("novaInstalacaoBtn").addEventListener("click", () => {
  if (!titulares.length) return alert("Cadastre um titular antes de criar instalações.");
  $("modalInstTitle").textContent = "Nova instalação";
  ["instId", "iCodigo", "iApelido", "iDist", "iEnd"].forEach((id) => ($(id).value = ""));
  $("iTitular").value = $("filtroTitularInst").value || (titulares[0] && titulares[0].id) || "";
  abrirModal("modalInstalacao");
});

window.editarInstalacao = (i) => {
  $("modalInstTitle").textContent = "Editar instalação";
  $("instId").value = i.id;
  $("iTitular").value = i.titular_id;
  $("iCodigo").value = i.codigo || "";
  $("iApelido").value = i.apelido || "";
  $("iDist").value = i.distribuidora || "";
  $("iEnd").value = i.endereco || "";
  abrirModal("modalInstalacao");
};

$("salvarInstBtn").addEventListener("click", async () => {
  const id = $("instId").value;
  const body = {
    titular_id: Number($("iTitular").value),
    codigo: $("iCodigo").value.trim(),
    apelido: $("iApelido").value.trim(),
    distribuidora: $("iDist").value.trim(),
    endereco: $("iEnd").value.trim(),
  };
  if (!body.titular_id || !body.codigo) return alert("Titular e código são obrigatórios.");
  try {
    if (id) await api(`/api/instalacoes/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    else await api("/api/instalacoes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    fecharModal("modalInstalacao");
    await carregarInstalacoes();
    await carregarTitulares();
  } catch (e) { alert(e.message); }
});

window.excluirInstalacao = async (id) => {
  if (!confirm("Excluir esta instalação e todas as suas faturas?")) return;
  await api(`/api/instalacoes/${id}`, { method: "DELETE" });
  await carregarInstalacoes();
  await carregarTitulares();
};

/* ============================ UPLOAD EXCEL ============================ */
let arquivoExcel = null;
const drop = $("excelDrop"), input = $("excelInput");
drop.addEventListener("click", () => input.click());
input.addEventListener("change", (e) => setArquivo(e.target.files[0]));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); }));
drop.addEventListener("drop", (e) => setArquivo(e.dataTransfer.files[0]));

function setArquivo(f) {
  arquivoExcel = f || null;
  $("enviarExcelBtn").disabled = !arquivoExcel;
  setStatus("uploadStatus", arquivoExcel ? "Arquivo selecionado: " + arquivoExcel.name : "Aguardando arquivo…");
}

$("enviarExcelBtn").addEventListener("click", async () => {
  if (!arquivoExcel) return;
  const fd = new FormData();
  fd.append("arquivo", arquivoExcel);
  if ($("uploadTitular").value) fd.append("titular_id", $("uploadTitular").value);
  setStatus("uploadStatus", "Importando…");
  $("enviarExcelBtn").disabled = true;
  try {
    const r = await api("/api/upload/excel", { method: "POST", body: fd });
    let msg = `Importação concluída.\n${r.gravadas} linha(s) processada(s) de ${r.total_linhas}.`;
    msg += `\n${r.faturas_unicas} fatura(s) única(s) gravada(s) (uma por instalação/mês).`;
    if (r.duplicadas) msg += `\n⚠ ${r.duplicadas} linha(s) com instalação+mês repetidos no arquivo foram consolidadas (prevaleceu a última).`;
    if (r.ignoradas) msg += `\n${r.ignoradas} linha(s) ignorada(s) (sem titular, instalação ou mês).`;
    setStatus("uploadStatus", msg, "ok");
    await carregarTitulares();
  } catch (e) {
    setStatus("uploadStatus", "Erro: " + e.message, "err");
  } finally {
    $("enviarExcelBtn").disabled = false;
  }
});

$("baixarTemplateBtn").addEventListener("click", () => { window.location.href = "/api/template"; });

function setStatus(id, txt, kind) {
  const el = $(id);
  el.textContent = txt;
  el.className = "status" + (kind ? " " + kind : "");
}

/* ============================ ANÁLISE ============================ */
let faturas = [];

function parseMesKey(mk) { return String(mk || ""); }

async function carregarAnalise() {
  setStatus("analiseStatus", "Carregando dados…");
  const tid = $("fTitular").value, iid = $("fInstalacao").value;
  const qs = [];
  if (tid) qs.push("titular_id=" + tid);
  if (iid) qs.push("instalacao_id=" + iid);
  try {
    faturas = await api("/api/faturas" + (qs.length ? "?" + qs.join("&") : ""));
    popularFiltrosAnalise();
    aplicarFiltrosAnalise();
    setStatus("analiseStatus", `${faturas.length} fatura(s) carregada(s).`, "ok");
  } catch (e) {
    setStatus("analiseStatus", "Erro ao carregar: " + e.message, "err");
  }
}

function popularFiltrosAnalise() {
  // instalacoes do titular selecionado
  const tid = $("fTitular").value;
  const insts = [...new Map(faturas.map((f) => [f.instalacao_codigo, f])).values()];
  const selInst = $("fInstalacao");
  const atualInst = selInst.value;
  selInst.innerHTML = '<option value="">Todas</option>' +
    insts.map((f) => `<option value="${f.instalacao_id}">${esc(f.instalacao_codigo)}${f.instalacao_apelido ? " — " + esc(f.instalacao_apelido) : ""}</option>`).join("");
  if (atualInst) selInst.value = atualInst;

  const anos = [...new Set(faturas.map((f) => f.ano).filter(Boolean))].sort();
  const selAno = $("fAno"); const atualAno = selAno.value;
  selAno.innerHTML = '<option value="">Todos</option>' + anos.map((a) => `<option value="${a}">${a}</option>`).join("");
  if (atualAno) selAno.value = atualAno;

  const bands = [...new Set(faturas.map((f) => f.bandeira).filter(Boolean))].sort();
  const selB = $("fBandeira"); const atualB = selB.value;
  selB.innerHTML = '<option value="">Todas</option>' + bands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  if (atualB) selB.value = atualB;
}

["fTitular", "fInstalacao", "fAno", "fBandeira"].forEach((id) =>
  $(id).addEventListener("change", () => {
    if (id === "fTitular" || id === "fInstalacao") carregarAnalise();
    else aplicarFiltrosAnalise();
  })
);
$("recarregarBtn").addEventListener("click", carregarAnalise);

let filtradas = [];
function aplicarFiltrosAnalise() {
  const ano = $("fAno").value, band = $("fBandeira").value;
  filtradas = faturas
    .filter((f) => !ano || f.ano === ano)
    .filter((f) => !band || f.bandeira === band)
    .map((f) => ({
      ...f,
      consumo: Number(f.consumo) || 0,
      total: Number(f.total) || 0,
      dias: Number(f.dias) || 0,
      saldo: Number(f.saldo) || 0,
      inj: Number(f.inj) || 0,
      custo: Number(f.consumo) > 0 ? Number(f.total) / Number(f.consumo) : 0,
    }))
    .sort((a, b) => (a.instalacao_codigo || "").localeCompare(b.instalacao_codigo || "") || parseMesKey(a.mes_key).localeCompare(parseMesKey(b.mes_key)));

  atualizarKPIs();
  renderConsolidado();
  renderAnalitica();
  renderCharts();
  $("exportResumoBtn").disabled = filtradas.length === 0;
}

function saldoFinalPorInstalacao(rows) {
  const latest = new Map();
  for (const r of rows) {
    const prev = latest.get(r.instalacao_id);
    if (!prev || String(r.mes_key) >= String(prev.mes_key)) latest.set(r.instalacao_id, r);
  }
  return [...latest.values()].reduce((s, r) => s + (Number(r.saldo) || 0), 0);
}

function atualizarKPIs() {
  const consumo = filtradas.reduce((s, r) => s + r.consumo, 0);
  const total = filtradas.reduce((s, r) => s + r.total, 0);
  $("kpiFaturas").textContent = fmtNum(filtradas.length);
  $("kpiConsumo").textContent = fmtNum(consumo) + " kWh";
  $("kpiTotal").textContent = fmtMoeda(total);
  $("kpiCusto").textContent = fmtMoeda(consumo > 0 ? total / consumo : 0);
  $("kpiSaldo").textContent = fmtNum(saldoFinalPorInstalacao(filtradas), 1) + " kWh";
}

function renderConsolidado() {
  const tbody = $("consolidadoBody");
  if (!filtradas.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">Sem dados.</td></tr>'; return; }
  const mapa = new Map();
  for (const r of filtradas) {
    const k = r.instalacao_id;
    if (!mapa.has(k)) mapa.set(k, { titular: r.titular_nome, cod: r.instalacao_codigo, ap: r.instalacao_apelido, qtd: 0, consumo: 0, total: 0, inj: 0, saldo: 0, ult: "" });
    const a = mapa.get(k);
    a.qtd++; a.consumo += r.consumo; a.total += r.total; a.inj += r.inj;
    if (!a.ult || String(r.mes_key) >= a.ult) { a.ult = String(r.mes_key); a.saldo = r.saldo; }
  }
  tbody.innerHTML = [...mapa.values()].map((r) => {
    const custo = r.consumo > 0 ? r.total / r.consumo : 0;
    return `<tr>
      <td>${esc(r.titular)}</td>
      <td>${esc(r.cod)}${r.ap ? " — " + esc(r.ap) : ""}</td>
      <td>${fmtNum(r.qtd)}</td><td>${fmtNum(r.consumo, 1)}</td><td>${fmtMoeda(r.total)}</td>
      <td>${fmtMoeda(custo)}</td><td>${fmtNum(r.saldo, 1)}</td><td>${fmtNum(r.inj, 1)}</td>
    </tr>`;
  }).join("");
}

function renderAnalitica() {
  const tbody = $("analiticaBody");
  if (!filtradas.length) { tbody.innerHTML = '<tr><td colspan="12" class="empty">Sem dados.</td></tr>'; return; }
  tbody.innerHTML = filtradas.map((r) => {
    let cls = "ok";
    if ((r.status || "").toLowerCase().includes("parcial")) cls = "warn";
    if ((r.status || "").toLowerCase().includes("erro")) cls = "err";
    return `<tr>
      <td>${esc(r.titular_nome)}</td><td>${esc(r.instalacao_codigo)}</td><td>${esc(r.mes || r.mes_key)}</td><td>${esc(r.vencimento || "—")}</td>
      <td>${fmtNum(r.consumo, 1)}</td><td>${fmtNum(r.dias)}</td><td>${fmtMoeda(r.total)}</td><td>${fmtMoeda(r.custo)}</td>
      <td>${esc(r.bandeira || "—")}</td><td>${fmtNum(r.saldo, 1)}</td><td>${fmtNum(r.inj, 1)}</td>
      <td><span class="badge ${cls}">${esc(r.status || "OK")}</span></td>
    </tr>`;
  }).join("");
}

function agruparPorMes() {
  const mapa = new Map();
  for (const r of filtradas) {
    const k = r.mes_key || r.mes;
    if (!mapa.has(k)) mapa.set(k, { key: k, label: r.mes || k, consumo: 0, total: 0, saldo: 0, inj: 0, custo: 0 });
    const a = mapa.get(k);
    a.consumo += r.consumo; a.total += r.total; a.saldo += r.saldo; a.inj += r.inj;
  }
  const rows = [...mapa.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  rows.forEach((r) => (r.custo = r.consumo > 0 ? r.total / r.consumo : 0));
  return rows;
}

function renderCharts() {
  Object.values(charts).forEach((c) => c && c.destroy());
  charts = {};
  if (typeof Chart === "undefined") return;
  const rows = agruparPorMes();
  const labels = rows.map((r) => r.label);
  const base = { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: "#44506b" } }, y: { ticks: { color: "#44506b" } } } };
  const C = (id, cfg) => { const el = $(id); if (el) charts[id] = new Chart(el, cfg); };
  C("cConsumo", { type: "line", data: { labels, datasets: [{ label: "Consumo", data: rows.map((r) => r.consumo), borderColor: "#3146a3", backgroundColor: "rgba(49,70,163,.12)", fill: true, tension: .3 }] }, options: { ...base, plugins: { legend: { display: false } } } });
  C("cValor", { type: "bar", data: { labels, datasets: [{ label: "Total", data: rows.map((r) => r.total), backgroundColor: "#1a2456" }] }, options: { ...base, plugins: { legend: { display: false } } } });
  C("cCusto", { type: "line", data: { labels, datasets: [{ label: "Custo/kWh", data: rows.map((r) => r.custo), borderColor: "#c79a3a", backgroundColor: "rgba(199,154,58,.14)", fill: true, tension: .3 }] }, options: { ...base, plugins: { legend: { display: false } } } });
  C("cSaldo", { type: "bar", data: { labels, datasets: [{ label: "Saldo", data: rows.map((r) => r.saldo), backgroundColor: "#5468c7" }, { label: "Injetada", data: rows.map((r) => r.inj), backgroundColor: "#12805c" }] }, options: { ...base, plugins: { legend: { display: true } } } });
}

/* ---------------- Exportar resumo (client-side via Chart? usar SheetJS CDN) ---------------- */
$("exportResumoBtn").addEventListener("click", () => {
  // monta CSV simples (sem dependencia extra) e baixa
  const headers = ["Titular", "Instalação", "Mês", "Vencimento", "Consumo (kWh)", "# Dias", "Total", "Custo/kWh", "Bandeira", "Saldo", "Injetada", "Status"];
  const linhas = filtradas.map((r) => [
    r.titular_nome, r.instalacao_codigo, r.mes || r.mes_key, r.vencimento || "",
    fmtNum(r.consumo, 3), fmtNum(r.dias), fmtNum(r.total, 2), fmtNum(r.custo, 4),
    r.bandeira || "", fmtNum(r.saldo, 1), fmtNum(r.inj, 1), r.status || "OK",
  ]);
  const csv = [headers, ...linhas].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "resumo_faturas_energia.csv";
  a.click();
});

/* ============================ INIT ============================ */
carregarTitulares().catch((e) => console.error(e));
