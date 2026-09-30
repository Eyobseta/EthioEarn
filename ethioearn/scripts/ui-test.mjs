// Drives the real Mini App JS in a simulated browser (jsdom) against a running server. Run after smoke.mjs on the same DB.
// npm i --no-save jsdom && BASE=... DATABASE_URL=... TELEGRAM_BOT_TOKEN=... node scripts/ui-test.mjs
import { JSDOM } from "jsdom"; import pg from "pg"; import fs from "node:fs"; import { createHmac, randomUUID } from "node:crypto";
const BASE = process.env.BASE, TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const initData = (id) => { const f = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: "U" + id }) };
  const dcs = Object.entries(f).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  return new URLSearchParams({ ...f, hash: createHmac("sha256", createHmac("sha256", "WebAppData").update(TOKEN).digest()).update(dcs).digest("hex") }).toString(); };
const api = async (path, tok, method = "GET", body, h = {}) => { const r = await fetch(BASE + "/api/v1" + path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, ...h }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
const html = fs.readFileSync("public/index.html", "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", url: BASE + "/", beforeParse(w) {
  w.Telegram = { WebApp: { initData: initData(1001), ready() {}, expand() {}, showConfirm: (m, cb) => cb(true), openLink() {} } };
  w.fetch = (u, o) => fetch(BASE + u, o); } });
const { window } = dom, doc = window.document;
for (const f of ["public/app.js", "public/admin.js"]) { const s = doc.createElement("script"); s.textContent = fs.readFileSync(f, "utf8"); doc.body.appendChild(s); }
const until = async (fn, m) => { for (let i = 0; i < 60; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } console.error("TIMEOUT:", m, "\n", doc.getElementById("view").textContent.slice(0, 300)); process.exit(1); };
const view = () => doc.getElementById("view").textContent;
const chips = () => [...doc.querySelectorAll(".st")].map((e) => e.textContent);
const click = (sel) => doc.querySelector(sel).click();
const setv = (id, v) => { doc.getElementById(id).value = v; };

await until(() => doc.getElementById("tabs").textContent.includes("Admin"), "Admin tab appears for admin");
ok(true, "Admin tab is shown to an admin");
click('[data-k="admin"]'); await until(() => view().includes("Pending payouts"), "admin dashboard"); ok(true, "admin dashboard loads with stats");
click('[data-s="campaigns"]'); await until(() => view().includes("New campaign"), "campaigns");
setv("cf-t", "UI test"); setv("cf-a", "Acme"); setv("cf-u", "https://acme.et"); click('[data-a="mk"]');
await until(() => view().includes("UI test") && chips().includes("draft"), "draft created"); ok(true, "campaign created as draft through the UI");
click('[data-a="act"]'); await until(() => !chips().includes("draft") && chips().includes("active"), "activated"); ok(true, "campaign activated through the UI");
click('[data-s="users"]'); await until(() => view().includes("Search"), "users");
setv("uq", "2002"); click('[data-a="find"]'); await until(() => doc.querySelectorAll('[data-a="susp"]').length === 1 && view().includes("ID 2002"), "user found");
click('[data-a="susp"]'); await until(() => chips().includes("suspended"), "suspended"); ok(true, "user suspended through the UI");
click('[data-a="susp"]'); await until(() => chips().includes("active") && !chips().includes("suspended"), "reinstated"); ok(true, "user reinstated through the UI");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const uid = (await pool.query("SELECT id FROM users WHERE telegram_user_id=2002")).rows[0].id;
await pool.query("INSERT INTO ledger_transactions(user_id,type,direction,amount,idempotency_key) VALUES($1,'BONUS','CREDIT',20000,$2)", [uid, randomUUID()]);
const ut = (await (await fetch(BASE + "/api/v1/auth/telegram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: initData(2002) }) })).json()).token;
const wd = () => api("/withdrawals", ut, "POST", { amount: 10000, method: "telebirr", account: { number: "0911000000" } }, { "Idempotency-Key": randomUUID() });
ok((await wd()).status === 201, "user requested a withdrawal");
click('[data-s="withdrawals"]'); await until(() => view().includes("100.00 ETB") && view().includes("0911000000"), "withdrawal shown");
click('[data-a="paid"]'); await until(() => doc.getElementById("toast").textContent.includes("payment reference"), "reference required");
ok(view().includes("0911000000"), "Paid without a reference is refused");
const ref = doc.querySelector('input[id^="ref-"]'); ref.value = "TXN-1001"; click('[data-a="paid"]');
await until(() => view().includes("No pending withdrawals"), "paid"); ok(true, "withdrawal marked paid through the UI");
ok((await api("/wallet", ut)).body.available === 150 + 20000 - 10000, "paid withdrawal keeps the funds deducted");
ok((await wd()).status === 201, "second withdrawal requested");
click('[data-s="withdrawals"]');
await until(() => view().includes("100.00 ETB") && view().includes("Reject"), "second withdrawal shown");
click('[data-a="rej"]'); await until(() => view().includes("No pending withdrawals"), "rejected"); ok(true, "withdrawal rejected through the UI");
ok((await api("/wallet", ut)).body.available === 150 + 20000 - 10000, "rejection refunded exactly once");
await pool.end(); window.close(); console.log("ALL UI CHECKS PASSED");
