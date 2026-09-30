"use strict";
// Admin screens. Only shown when /admin/me returns a role; the API enforces roles on every call regardless.
Object.assign(MSG, { FORBIDDEN: "You don't have permission for that.", INVALID_TRANSITION: "That change isn't allowed from the current status.", URL_MUST_BE_HTTPS: "The link must start with https://",
  REWARD_EXCEEDS_BUDGET: "Reward is bigger than the budget.", REFERENCE_REQUIRED: "Enter the payment reference.", INVALID_STATE: "That request was already handled.", VALIDATION_ERROR: "Check the form: title, https link and amounts." });
let asec = "withdrawals", uq = "";
const ask = (m) => new Promise((r) => (tg && tg.showConfirm ? tg.showConfirm(m, r) : r(confirm(m))));
const post = (p, b) => api(p, { method: "POST", body: JSON.stringify(b || {}) });
const etb = (v) => Math.round(parseFloat(v) * 100);
const none = (t) => `<p class="empty">${t}</p>`;
const cbtn = (id, to, label, cls) => `<button class="btn ${cls || ""}" data-a="cst" data-id="${esc(id)}" data-to="${to}">${label}</button>`;

const sections = {
  async withdrawals() {
    const { items } = await api("/admin/withdrawals?status=REQUESTED");
    return items.map((w) => `<div class="card"><div class="item"><b>${fmt(Number(w.amount))}</b><span class="st">${esc(w.method)}</span></div>
      <div class="meta">${esc(w.username ? "@" + w.username : "ID " + w.telegram_user_id)} · ${esc((w.account && w.account.number) || "")}</div>
      <div class="rowin"><input id="ref-${esc(w.id)}" placeholder="Payment reference" maxlength="100"><button class="btn" data-a="paid" data-id="${esc(w.id)}">Paid</button><button class="btn ghost" data-a="rej" data-id="${esc(w.id)}">Reject</button></div></div>`).join("") || none("No pending withdrawals.");
  },
  async campaigns() {
    const { items } = await api("/admin/campaigns");
    const f = (id, l, extra) => `<label for="cf-${id}">${l}</label><input id="cf-${id}" ${extra || ""}>`;
    const form = `<div class="card"><h3>New campaign</h3>${f("t", "Title", 'maxlength="120"')}${f("a", "Advertiser", 'maxlength="120"')}${f("u", "Link (https)", 'type="url" placeholder="https://"')}
      <div class="rowin"><div>${f("r", "Reward (ETB)", 'type="number" step="0.01" value="1.50"')}</div><div>${f("b", "Budget (ETB)", 'type="number" step="0.01" value="500"')}</div></div>
      <div class="rowin"><div>${f("s", "Seconds", 'type="number" value="5"')}</div><div>${f("c", "Per user / day", 'type="number" value="1"')}</div></div>
      <button class="btn full" data-a="mk">Create draft</button></div>`;
    const list = items.map((c) => {
      const s = c.status, x = cbtn(c.id, "CANCELLED", "Cancel", "ghost");
      const acts = s === "DRAFT" ? `<button class="btn" data-a="act" data-id="${esc(c.id)}">Activate</button>${x}` : s === "ACTIVE" ? cbtn(c.id, "PAUSED", "Pause") + x : s === "PAUSED" ? cbtn(c.id, "ACTIVE", "Resume") + x : "";
      return `<div class="card"><div class="item"><b>${esc(c.title)}</b><span class="st">${esc(s.toLowerCase())}</span></div><div class="meta">${esc(c.advertiser)} · pays ${fmt(Number(c.reward))} · ${fmt(Number(c.spent))} of ${fmt(Number(c.total_budget))} spent</div>${acts ? `<div class="rowin">${acts}</div>` : ""}</div>`;
    }).join("");
    return form + (list || none("No campaigns yet."));
  },
  async users() {
    const { items } = await api("/admin/users?q=" + encodeURIComponent(uq));
    const rows = items.map((u) => `<div class="card"><div class="item"><b>${esc(u.username ? "@" + u.username : u.first_name || "User")}</b><span class="st">${esc(u.status.toLowerCase())}</span></div>
      <div class="meta">ID ${esc(u.telegram_user_id)} · balance ${fmt(Number(u.balance))}</div>
      <div class="rowin"><button class="btn ghost" data-a="susp" data-id="${esc(u.id)}" data-v="${u.status === "ACTIVE" ? 1 : 0}">${u.status === "ACTIVE" ? "Suspend" : "Reinstate"}</button></div></div>`).join("");
    return `<div class="rowin"><input id="uq" placeholder="Username or Telegram ID" value="${esc(uq)}"><button class="btn" data-a="find">Search</button></div>` + (rows || none("No users found."));
  },
};
views.admin = async () => {
  const st = await api("/admin/stats");
  const nav = ["withdrawals", "campaigns", "users"].map((s) => `<button class="btn ghost" data-a="sec" data-s="${s}" aria-current="${s === asec}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("");
  return `<h2>Admin <span class="st">${esc(role)}</span></h2><div class="card"><div class="item"><span>Users</span><b>${st.users}</b></div><div class="item"><span>Owed to users</span><b>${fmt(st.owed)}</b></div><div class="item"><span>Pending payouts</span><b>${st.pending_n} · ${fmt(st.pending_amt)}</b></div></div><div class="seg">${nav}</div>` + (await sections[asec]());
};
const A = {
  sec: (b) => { asec = b.dataset.s; },
  find: () => { uq = $("uq").value.trim(); },
  async paid(b) { const ref = $("ref-" + b.dataset.id).value.trim(); if (ref.length < 3) { toast("REFERENCE_REQUIRED"); return false; } await post(`/admin/withdrawals/${b.dataset.id}/paid`, { reference: ref }); toast("Marked as paid"); },
  async rej(b) { if (!(await ask("Reject this request and refund the user?"))) return false; await post(`/admin/withdrawals/${b.dataset.id}/reject`); toast("Rejected and refunded"); },
  async act(b) { await post(`/admin/campaigns/${b.dataset.id}/activate`); toast("Campaign is live"); },
  async cst(b) { if (b.dataset.to === "CANCELLED" && !(await ask("Cancel this campaign?"))) return false; await post(`/admin/campaigns/${b.dataset.id}/status`, { status: b.dataset.to }); },
  async susp(b) { const v = b.dataset.v === "1"; if (!(await ask(v ? "Suspend this user?" : "Reinstate this user?"))) return false; await post(`/admin/users/${b.dataset.id}/suspension`, { suspended: v }); },
  async mk() {
    const v = (i) => $("cf-" + i).value.trim();
    await post("/admin/campaigns", { title: v("t"), advertiser: v("a"), destinationUrl: v("u"), reward: etb(v("r")), totalBudget: etb(v("b")), minSeconds: parseInt(v("s"), 10), dailyUserCap: parseInt(v("c"), 10) });
    toast("Draft created. Tap Activate to publish it.");
  },
};
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-a]"); if (!b || busy) return;
  busy = true;
  try { const r = await A[b.dataset.a](b); busy = false; if (r !== false) await show("admin"); }
  catch (err) { busy = false; toast(err.message); }
});
