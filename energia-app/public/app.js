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
let modoViz = "consolidado"; // "consolidado" | "instalacao"

/* ---------------- Multiselect ---------------- */
class MultiSelect {
  constructor(containerId, { placeholder = "Todos", onChange } = {}) {
    this.el = $(containerId);
    this.placeholder = placeholder;
    this.onChange = onChange || (() => {});
    this.options = []; // {value, label}
    this.selected = new Set();
    this.open = false;
    this.render();
    document.addEventListener("click", (e) => {
      if (!this.el.contains(e.target)) this.setOpen(false);
    });
  }
  setOptions(opts) {
    const valid = new Set(opts.map((o) => String(o.value)));
    [...this.selected].forEach((v) => { if (!valid.has(v)) this.selected.delete(v); });
    this.options = opts;
    this.render();
  }
  getSelected() { return [...this.selected]; }
  setOpen(v) { this.open = v; this.render(); }
  toggle(value) {
    const v = String(value);
    if (this.selected.has(v)) this.selected.delete(v); else this.selected.add(v);
    this.render();
    this.onChange(this.getSelected());
  }
  selectAll() { this.options.forEach((o) => this.selected.add(String(o.value))); this.render(); this.onChange(this.getSelected()); }
  clear() { this.selected.clear(); this.render(); this.onChange(this.getSelected()); }
  label() {
    const n = this.selected.size;
    if (n === 0) return this.placeholder;
    if (n === 1) { const o = this.options.find((o) => String(o.value) === [...this.selected][0]); return o ? o.label : "1 selecionado"; }
    return `${n} selecionados`;
  }
  render() {
    const opts = this.options
      .map((o) => {
        const v = String(o.value);
        const ck = this.selected.has(v) ? "checked" : "";
        return `<label class="ms-opt"><input type="checkbox" ${ck} data-v="${esc(v)}"><span>${esc(o.label)}</span></label>`;
      })
      .join("");
    this.el.innerHTML = `
      <button type="button" class="ms-toggle">${esc(this.label())}<span class="chev">▾</span></button>
      <div class="ms-panel ${this.open ? "open" : ""}">
        <div class="ms-bar"><button type="button" data-all>Todos</button><button type="button" data-none>Limpar</button></div>
        ${opts || '<div class="small" style="padding:8px">Sem opções</div>'}
      </div>`;
    this.el.querySelector(".ms-toggle").addEventListener("click", (e) => { e.stopPropagation(); this.setOpen(!this.open); });
    this.el.querySelector("[data-all]")?.addEventListener("click", (e) => { e.stopPropagation(); this.selectAll(); });
    this.el.querySelector("[data-none]")?.addEventListener("click", (e) => { e.stopPropagation(); this.clear(); });
    this.el.querySelectorAll(".ms-opt input").forEach((cb) =>
      cb.addEventListener("change", (e) => { e.stopPropagation(); this.toggle(cb.dataset.v); })
    );
  }
}
let msTitular, msInstalacao;

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
  if (msTitular) msTitular.setOptions(titulares.map((t) => ({ value: t.id, label: t.nome })));
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
        <button class="small ghost" onclick="limparFaturasTitular(${t.id})">Limpar faturas</button>
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

window.limparFaturasTitular = async (id) => {
  const t = titulares.find((x) => x.id === id);
  const nome = t ? t.nome : "este titular";
  if (!confirm(`Limpar TODAS as faturas de "${nome}"?\nAs instalações são mantidas; apenas as faturas serão apagadas.\nÚtil antes de reimportar dados corrigidos.`)) return;
  try {
    const r = await api(`/api/titulares/${id}/faturas`, { method: "DELETE" });
    alert(`${r.removidas} fatura(s) removida(s) de "${nome}".`);
    await carregarTitulares();
  } catch (e) { alert(e.message); }
};

/* ---------------- Unificar titulares ---------------- */
$("unificarBtn").addEventListener("click", () => {
  if (titulares.length < 2) return alert("É preciso ter ao menos dois titulares para unificar.");
  $("mergeDestino").innerHTML = titulares.map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join("");
  renderMergeOrigens();
  abrirModal("modalMerge");
});
$("mergeDestino").addEventListener("change", renderMergeOrigens);

function renderMergeOrigens() {
  const destino = Number($("mergeDestino").value);
  const origens = titulares.filter((t) => t.id !== destino);
  const cont = $("mergeOrigens");
  if (!origens.length) { cont.innerHTML = '<div class="muted-empty">Nenhum outro titular disponível.</div>'; return; }
  cont.innerHTML = origens
    .map((t) => `<label><input type="checkbox" value="${t.id}"><span>${esc(t.nome)} <span class="small">(${t.qtd_instalacoes} inst. · ${t.qtd_faturas} fat.)</span></span></label>`)
    .join("");
}

$("confirmMergeBtn").addEventListener("click", async () => {
  const destino = Number($("mergeDestino").value);
  const origens = [...$("mergeOrigens").querySelectorAll("input:checked")].map((c) => Number(c.value));
  if (!destino) return alert("Selecione o titular de destino.");
  if (!origens.length) return alert("Selecione ao menos um titular de origem para unificar.");
  const nomeDest = (titulares.find((t) => t.id === destino) || {}).nome || "destino";
  if (!confirm(`Unificar ${origens.length} titular(es) em "${nomeDest}"?\nOs titulares de origem serão removidos. Esta ação não pode ser desfeita.`)) return;
  try {
    const r = await api("/api/titulares/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destino_id: destino, origem_ids: origens }),
    });
    let msg = `Unificação concluída.\n${r.titulares_removidos} titular(es) removido(s).`;
    msg += `\n${r.instalacoes_movidas} instalação(ões) movida(s), ${r.instalacoes_mescladas} mesclada(s).`;
    if (r.faturas_descartadas) msg += `\n${r.faturas_descartadas} fatura(s) duplicada(s) descartada(s) na mesclagem.`;
    alert(msg);
    fecharModal("modalMerge");
    await carregarTitulares();
    await carregarInstalacoes();
  } catch (e) { alert(e.message); }
});

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
        <button class="small ghost" onclick="limparFaturasInstalacao(${i.id})">Limpar faturas</button>
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

window.limparFaturasInstalacao = async (id) => {
  if (!confirm("Limpar todas as faturas desta instalação? A instalação é mantida.")) return;
  try {
    const r = await api(`/api/instalacoes/${id}/faturas`, { method: "DELETE" });
    alert(`${r.removidas} fatura(s) removida(s).`);
    await carregarInstalacoes();
    await carregarTitulares();
  } catch (e) { alert(e.message); }
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
  if ($("substituirChk").checked) fd.append("substituir", "true");
  setStatus("uploadStatus", "Importando…");
  $("enviarExcelBtn").disabled = true;
  try {
    const r = await api("/api/upload/excel", { method: "POST", body: fd });
    let msg = `Importação concluída (${r.modo === "substituir" ? "modo substituir" : "modo padrão"}). ${r.total_linhas} linha(s) lida(s).`;
    msg += `\n✓ ${r.gravadas} fatura(s) nova(s) gravada(s).`;
    if (r.atualizadas) msg += `\n↻ ${r.atualizadas} fatura(s) existente(s) sobrescrita(s).`;
    if (r.duplicadas_arquivo) msg += `\n• ${r.duplicadas_arquivo} duplicata(s) dentro do arquivo.`;
    if (r.duplicadas_banco) msg += `\n• ${r.duplicadas_banco} já existiam no banco (não reimportadas).`;
    msg += `\nNenhuma linha foi descartada por campos faltantes.`;
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
  const tids = msTitular ? msTitular.getSelected() : [];
  const qs = [];
  if (tids.length) qs.push("titular_id=" + tids.join(","));
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
  // instalacoes presentes nas faturas carregadas -> alimenta o multiselect
  const insts = [...new Map(faturas.map((f) => [f.instalacao_id, f])).values()];
  if (msInstalacao) {
    msInstalacao.setOptions(
      insts.map((f) => ({
        value: f.instalacao_id,
        label: f.instalacao_codigo + (f.instalacao_apelido ? " — " + f.instalacao_apelido : ""),
      }))
    );
  }

  const anos = [...new Set(faturas.map((f) => f.ano).filter(Boolean))].sort();
  const selAno = $("fAno"); const atualAno = selAno.value;
  selAno.innerHTML = '<option value="">Todos</option>' + anos.map((a) => `<option value="${a}">${a}</option>`).join("");
  if (atualAno) selAno.value = atualAno;

  const bands = [...new Set(faturas.map((f) => f.bandeira).filter(Boolean))].sort();
  const selB = $("fBandeira"); const atualB = selB.value;
  selB.innerHTML = '<option value="">Todas</option>' + bands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  if (atualB) selB.value = atualB;
}

["fAno", "fBandeira"].forEach((id) => $(id).addEventListener("change", aplicarFiltrosAnalise));
$("recarregarBtn").addEventListener("click", carregarAnalise);

// Alterna o modo de visualizacao (consolidado x por instalacao) e redesenha.
document.querySelectorAll("#segViz .seg-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("#segViz .seg-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    modoViz = btn.dataset.mode;
    renderCharts();
  })
);

let filtradas = [];
function aplicarFiltrosAnalise() {
  const ano = $("fAno").value, band = $("fBandeira").value;
  const instSel = new Set(msInstalacao ? msInstalacao.getSelected() : []);
  filtradas = faturas
    .filter((f) => instSel.size === 0 || instSel.has(String(f.instalacao_id)))
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

// Agrupa por mes, separando uma serie por instalacao (para o modo comparativo).
function agruparPorMesPorInstalacao() {
  const keys = [...new Set(filtradas.map((r) => r.mes_key || r.mes))].sort();
  const labelByKey = {};
  filtradas.forEach((r) => { labelByKey[r.mes_key || r.mes] = r.mes || r.mes_key; });
  const labels = keys.map((k) => labelByKey[k] || k);

  const insts = new Map(); // instId -> { codigo, consumo:{}, total:{}, custo:{}, saldo:{} }
  for (const r of filtradas) {
    const k = r.mes_key || r.mes;
    if (!insts.has(r.instalacao_id)) {
      insts.set(r.instalacao_id, { codigo: r.instalacao_codigo + (r.instalacao_apelido ? " — " + r.instalacao_apelido : ""), consumo: {}, total: {}, saldo: {} });
    }
    const a = insts.get(r.instalacao_id);
    a.consumo[k] = (a.consumo[k] || 0) + r.consumo;
    a.total[k] = (a.total[k] || 0) + r.total;
    a.saldo[k] = r.saldo; // saldo e um estado (ultimo do mes), nao soma
  }
  return { keys, labels, insts };
}

// Paleta de cores estavel por indice.
const PALETA = ["#3146a3", "#c79a3a", "#12805c", "#b42318", "#5468c7", "#0e7490", "#9333ea", "#b76a00", "#2563eb", "#16a34a", "#db2777", "#475569"];
const corDe = (i) => PALETA[i % PALETA.length];

function renderCharts() {
  Object.values(charts).forEach((c) => c && c.destroy());
  charts = {};
  if (typeof Chart === "undefined") return;
  const base = { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: "#44506b" } }, y: { ticks: { color: "#44506b" } } } };
  const C = (id, cfg) => { const el = $(id); if (el) charts[id] = new Chart(el, cfg); };
  const setTitulo = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

  // Titulo do 4o grafico depende do modo (no comparativo mostra apenas saldo por UC).
  setTitulo("tConsumo", "Consumo faturado (kWh)");
  setTitulo("tValor", "Total a pagar (R$)");
  setTitulo("tCusto", "Custo por kWh (R$)");
  setTitulo("tSaldo", modoViz === "instalacao" ? "Saldo por instalação (kWh)" : "Saldo × Energia injetada (kWh)");

  if (modoViz === "instalacao") {
    // Uma serie (linha) por instalacao em cada grafico -> comparativo.
    const { keys, labels, insts } = agruparPorMesPorInstalacao();
    const entradas = [...insts.entries()];
    const mkDatasets = (campo) =>
      entradas.map(([id, d], i) => ({
        label: d.codigo,
        data: keys.map((k) => d[campo][k] ?? null),
        borderColor: corDe(i),
        backgroundColor: corDe(i),
        tension: .3,
        spanGaps: true,
      }));
    const custoDatasets = entradas.map(([id, d], i) => ({
      label: d.codigo,
      data: keys.map((k) => (d.consumo[k] > 0 ? d.total[k] / d.consumo[k] : null)),
      borderColor: corDe(i), backgroundColor: corDe(i), tension: .3, spanGaps: true,
    }));
    const legenda = { legend: { display: true, position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } };
    C("cConsumo", { type: "line", data: { labels, datasets: mkDatasets("consumo") }, options: { ...base, plugins: legenda } });
    C("cValor", { type: "line", data: { labels, datasets: mkDatasets("total") }, options: { ...base, plugins: legenda } });
    C("cCusto", { type: "line", data: { labels, datasets: custoDatasets }, options: { ...base, plugins: legenda } });
    C("cSaldo", { type: "line", data: { labels, datasets: mkDatasets("saldo") }, options: { ...base, plugins: legenda } });
    return;
  }

  // Modo consolidado: todas as instalacoes somadas em uma serie.
  const rows = agruparPorMes();
  const labels = rows.map((r) => r.label);
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
msTitular = new MultiSelect("msTitular", { placeholder: "Todos os titulares", onChange: () => carregarAnalise() });
msInstalacao = new MultiSelect("msInstalacao", { placeholder: "Todas as instalações", onChange: () => aplicarFiltrosAnalise() });
carregarTitulares().catch((e) => console.error(e));
