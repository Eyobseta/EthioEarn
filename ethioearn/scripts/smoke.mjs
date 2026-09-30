// End-to-end smoke test against a running server + real Postgres.
// Usage: BASE=http://localhost:3000 TELEGRAM_BOT_TOKEN=... node scripts/smoke.mjs   (then: npm run make-admin -- 1001 SUPER when prompted)
import { createHmac, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
const BASE = process.env.BASE ?? "http://localhost:3000", TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const initData = (id) => {
  const f = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: "U" + id }) };
  const dcs = Object.entries(f).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = createHmac("sha256", createHmac("sha256", "WebAppData").update(TOKEN).digest()).update(dcs).digest("hex");
  return new URLSearchParams({ ...f, hash }).toString();
};
const call = async (path, tok, method = "GET", body, headers = {}) => {
  const r = await fetch(BASE + "/api/v1" + path, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
const login = async (id) => (await call("/auth/telegram", null, "POST", { initData: initData(id) })).body.token;

ok((await call("/auth/telegram", null, "POST", { initData: "hash=" + "0".repeat(64) })).status === 401, "forged initData rejected");
const adminTok0 = await login(1001); const userTok = await login(2002);
execSync("npx tsx src/makeAdmin.ts 1001 SUPER", { stdio: "inherit" });
ok((await call("/admin/campaigns", userTok)).status === 403, "normal user blocked from admin API");
const c = (await call("/admin/campaigns", adminTok0, "POST", { title: "Promo", advertiser: "Acme", destinationUrl: "https://acme.et", reward: 150, totalBudget: 100000, minSeconds: 3, dailyUserCap: 1 })).body;
for (const s of ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "ACTIVE"]) await call(`/admin/campaigns/${c.id}/status`, adminTok0, "POST", { status: s });
ok((await call("/ads", userTok)).body.ads.length === 1, "active campaign is listed");
const s = (await call(`/ads/${c.id}/start`, userTok, "POST")).body;
ok((await call("/ads/complete", userTok, "POST", { sessionId: s.sessionId })).status === 409, "early completion refused");
await new Promise((r) => setTimeout(r, 3200));
const race = await Promise.all(Array.from({ length: 10 }, () => call("/ads/complete", userTok, "POST", { sessionId: s.sessionId })));
ok(race.filter((r) => r.body.credited === true).length === 1, "10 concurrent completions credit exactly once");
ok((await call("/wallet", userTok)).body.available === 150, "balance is 1.50 ETB");
ok((await call(`/ads/${c.id}/start`, userTok, "POST")).status === 429, "second play same day refused");
const w = await call("/withdrawals", userTok, "POST", { amount: 10000, method: "telebirr", account: { number: "0911" } }, { "Idempotency-Key": randomUUID() });
ok(w.status === 422, "withdrawal below balance refused");
console.log("ALL SMOKE CHECKS PASSED");
