"use strict";
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n / 100).toFixed(2) + " ETB";
const MSG = { USER_BLOCKED: "This account is restricted.", DAILY_LIMIT_REACHED: "You reached today's limit. Come back tomorrow.", CAMPAIGN_DAILY_LIMIT: "You already did this one today.",
  CAMPAIGN_EXHAUSTED: "This offer just ran out.", CAMPAIGN_UNAVAILABLE: "This offer is not available.", COMPLETED_TOO_EARLY: "Please stay for the full time.",
  BELOW_MINIMUM: "Amount is below the minimum.", INSUFFICIENT_BALANCE: "Not enough balance.", UNAUTHENTICATED: "Session expired. Reopen the app." };
const TABS = [["home", "Home"], ["ads", "Ads"], ["withdraw", "Withdraw"]];
let token = null, cur = "home", wallet = null, busy = false, role = null;

async function api(path, opts = {}) {
  const r = await fetch("/api/v1" + path, { ...opts, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "REQUEST_FAILED");
  return j;
}
function toast(m) { const t = $("toast"); t.textContent = MSG[m] || m; t.classList.remove("hide"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hide"), 3500); }
function tabs() { $("tabs").innerHTML = (role ? TABS.concat([["admin", "Admin"]]) : TABS).map(([k, n]) => `<button class="tab" data-act="tab" data-k="${k}" aria-current="${k === cur}">${n}</button>`).join(""); }

async function show(v) {
  cur = v; tabs(); $("view").innerHTML = '<p class="empty">Loading…</p>';
  try { wallet = await api("/wallet"); $("view").innerHTML = await views[v](); } catch (e) { $("view").innerHTML = `<p class="empty">${esc(MSG[e.message] || "Something went wrong. Try again.")}</p>`; }
}
const views = {
  async home() {
    const { items } = await api("/ledger");
    const rows = items.map((x) => `<div class="item" style="margin-top:10px"><div>${esc(x.type.replace(/_/g, " ").toLowerCase())}<div class="meta">${new Date(x.created_at).toLocaleString()}</div></div><span class="rw" style="color:${x.direction === "DEBIT" ? "var(--red)" : ""}">${x.direction === "DEBIT" ? "−" : "+"}${fmt(x.amount)}</span></div>`).join("");
    return `<div class="bal"><small>Available balance</small><div class="big">${fmt(wallet.available)}</div></div><div class="card"><h3>Recent activity</h3>${rows || '<p class="empty">Nothing yet. Try an ad to earn your first reward.</p>'}</div>`;
  },
  async ads() {
    const { ads } = await api("/ads");
    if (!ads.length) return '<h2>Sponsored visits</h2><p class="empty">No offers right now. Check back soon.</p>';
    return "<h2>Sponsored visits</h2><p class=\"meta\">Open the offer and stay for the full time to earn.</p>" + ads.map((a) => `<div class="card item"><div><h3>${esc(a.title)}</h3><div class="meta">${esc(a.advertiser)} · ${a.min_seconds} seconds</div><div class="rw">+${fmt(Number(a.reward))}</div></div><button class="btn" data-act="ad" data-id="${esc(a.id)}" data-url="${esc(a.destination_url)}">Start</button></div>`).join("");
  },
  async withdraw() {
    const { items } = await api("/withdrawals");
    const min = wallet.minWithdrawal, ok = wallet.available >= min;
    const hist = items.map((w) => `<div class="item" style="margin-top:8px"><span>${fmt(Number(w.amount))} <span class="meta">${esc(w.method)}</span></span><span class="st">${esc(w.status.toLowerCase())}</span></div>`).join("");
    return `<h2>Withdraw</h2><div class="card"><div class="item"><span>Available</span><b>${fmt(wallet.available)}</b></div><div class="bar"><i style="width:${Math.min(100, wallet.available / min * 100)}%"></i></div><div class="meta">Minimum ${fmt(min)}. Requests are reviewed before payment.</div>
    <label for="m">Payment method</label><select id="m"><option value="telebirr">Telebirr</option><option value="cbe_birr">CBE Birr</option><option value="bank_transfer">Bank transfer</option></select>
    <label for="ph">Account or phone number</label><input id="ph" autocomplete="off" maxlength="60">
    <label for="amt">Amount (ETB)</label><input id="amt" type="number" min="${min / 100}" step="0.01" value="${min / 100}">
    <button class="btn" style="width:100%;margin-top:14px" data-act="wd" ${ok ? "" : "disabled"}>Request withdrawal</button></div>
    <div class="card"><h3>Your requests</h3>${hist || '<p class="empty">No requests yet.</p>'}</div>`;
  },
};
async function runAd(btn) {
  if (busy) return; busy = true; btn.disabled = true;
  try {
    const s = await api(`/ads/${btn.dataset.id}/start`, { method: "POST" });
    if (tg && tg.openLink) tg.openLink(btn.dataset.url); else window.open(btn.dataset.url, "_blank", "noopener");
    for (let left = s.minSeconds; left > 0; left--) { btn.textContent = left + "s"; await new Promise((r) => setTimeout(r, 1000)); }
    const r = await api("/ads/complete", { method: "POST", body: JSON.stringify({ sessionId: s.sessionId }) });
    toast(r.credited ? "Earned " + fmt(r.amount) : "Already counted");
  } catch (e) { toast(e.message); }
  busy = false; show(cur);
}
async function withdraw() {
  const amount = Math.round(parseFloat($("amt").value) * 100), phone = $("ph").value.trim();
  if (!phone) return toast("Enter your account or phone number.");
  if (busy) return; busy = true;
  try {
    await api("/withdrawals", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ amount, method: $("m").value, account: { number: phone } }) });
    toast("Request sent. We will review it soon.");
  } catch (e) { toast(e.message); }
  busy = false; show("withdraw");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  if (b.dataset.act === "tab") show(b.dataset.k); else if (b.dataset.act === "ad") runAd(b); else if (b.dataset.act === "wd") withdraw();
});
(async function boot() {
  tabs();
  if (!tg || !tg.initData) { $("acct").textContent = "Not in Telegram"; $("view").innerHTML = '<p class="empty">Please open EthioEarn from Telegram.</p>'; return; }
  try { token = (await api("/auth/telegram", { method: "POST", body: JSON.stringify({ initData: tg.initData }) })).token; $("acct").textContent = "Account active"; try { role = (await api("/admin/me")).role; } catch (e) { role = null; } show("home"); }
  catch (e) { $("acct").textContent = "Offline"; $("view").innerHTML = `<p class="empty">${esc(MSG[e.message] || "Could not sign in. Reopen the app.")}</p>`; }
})();
