// public/auth-guard.js — barra do usuário (nome, "Usuários" para o administrador, "Sair"),
// volta para o login quando a sessão expira e avisa quando o acesso é só de consulta.
(function () {
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const r = await fetchOriginal(...args);
    if (r.status === 401) window.location.href = "/login";
    if (r.status === 403) {
      const msg = await r.clone().json().then((j) => j.erro).catch(() => "");
      if (msg) alert(msg);
    }
    return r;
  };
  async function barra() {
    if (document.getElementById("ls-barra")) return;
    let me = null;
    try { me = await fetchOriginal("/api/me").then((r) => (r.ok ? r.json() : null)); } catch {}
    const box = document.createElement("div");
    box.id = "ls-barra";
    box.style.cssText = "position:fixed;top:12px;right:16px;z-index:9999;display:flex;gap:8px;align-items:center;" +
      "font:600 13px system-ui,sans-serif;color:#1b2b44";
    const btn = (txt, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = txt;
      b.style.cssText = "padding:6px 14px;border-radius:8px;border:1px solid #c9d2de;background:#fff;color:#1b2b44;" +
        "font:inherit;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.08)";
      b.addEventListener("click", fn);
      return b;
    };
    if (me) {
      const nome = document.createElement("span");
      nome.textContent = (me.nome || me.usuario) + (me.admin ? " (admin)" : "");
      nome.style.cssText = "background:#fff;padding:6px 10px;border-radius:8px;border:1px solid #e3e8ef";
      box.appendChild(nome);
      if (me.admin) box.appendChild(btn("Usu\u00e1rios", () => (window.location.href = "/admin")));
    }
    box.appendChild(btn("Sair", async () => {
      await fetchOriginal("/api/logout", { method: "POST" });
      window.location.href = "/login";
    }));
    document.body.appendChild(box);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", barra);
  else barra();
})();
