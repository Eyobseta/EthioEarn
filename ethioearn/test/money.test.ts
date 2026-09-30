import { beforeEach, describe, expect, it } from "vitest";
import { balance, post } from "../src/ledger.js";
import { completeSession, startSession } from "../src/rewards.js";
import { markPaid, rejectWithdrawal, requestWithdrawal } from "../src/withdrawals.js";
import { newDb } from "./helpers.js";
const cfg = { maxDailyCompletions: 3 };
const t0 = new Date("2026-09-29T10:00:00Z");
const later = (s: number) => new Date(t0.getTime() + s * 1000);
let h: Awaited<ReturnType<typeof newDb>>;
beforeEach(async () => { h = await newDb(); });

describe("ledger", () => {
  it("replaying an idempotency key credits once", async () => {
    const u = await h.user();
    const e = { userId: u, type: "BONUS", direction: "CREDIT" as const, amount: 500, idempotencyKey: "k1" };
    await h.run(async (tx) => { await post(tx, e); await post(tx, e); });
    expect(await h.run((tx) => balance(tx, u))).toBe(500);
  });
  it("rejects non-integer and non-positive amounts", async () => {
    const u = await h.user();
    await expect(h.run((tx) => post(tx, { userId: u, type: "BONUS", direction: "CREDIT", amount: 1.5, idempotencyKey: "a" }))).rejects.toThrow();
    await expect(h.run((tx) => post(tx, { userId: u, type: "BONUS", direction: "CREDIT", amount: 0, idempotencyKey: "b" }))).rejects.toThrow();
  });
  it("is append-only", async () => {
    const u = await h.user();
    await h.run((tx) => post(tx, { userId: u, type: "BONUS", direction: "CREDIT", amount: 5, idempotencyKey: "z" }));
    await expect(h.db.query(`UPDATE ledger_transactions SET amount=999`)).rejects.toThrow(/append-only/);
    await expect(h.db.query(`DELETE FROM ledger_transactions`)).rejects.toThrow(/append-only/);
  });
});

describe("rewards", () => {
  it("credits the server-fixed reward once, even if completed twice", async () => {
    const u = await h.user(), c = await h.campaign({ reward: 150 });
    const { sessionId } = await h.run((tx) => startSession(tx, u, c, cfg, t0));
    expect((await h.run((tx) => completeSession(tx, u, sessionId, later(6)))).credited).toBe(true);
    expect((await h.run((tx) => completeSession(tx, u, sessionId, later(7)))).credited).toBe(false);
    expect(await h.run((tx) => balance(tx, u))).toBe(150);
  });
  it("rejects completion before the minimum time and credits nothing", async () => {
    const u = await h.user(), c = await h.campaign({ secs: 8 });
    const { sessionId } = await h.run((tx) => startSession(tx, u, c, cfg, t0));
    await expect(h.run((tx) => completeSession(tx, u, sessionId, later(2)))).rejects.toThrow("COMPLETED_TOO_EARLY");
    expect(await h.run((tx) => balance(tx, u))).toBe(0);
  });
  it("cannot complete another user's session", async () => {
    const a = await h.user(1), b = await h.user(2), c = await h.campaign();
    const { sessionId } = await h.run((tx) => startSession(tx, a, c, cfg, t0));
    await expect(h.run((tx) => completeSession(tx, b, sessionId, later(9)))).rejects.toThrow("SESSION_NOT_FOUND");
  });
  it("never overspends the campaign budget", async () => {
    const c = await h.campaign({ reward: 100, budget: 250, cap: 1 });
    let paid = 0;
    for (let i = 1; i <= 4; i++) {
      const u = await h.user(i);
      try { const s = await h.run((tx) => startSession(tx, u, c, cfg, t0)); paid += (await h.run((tx) => completeSession(tx, u, s.sessionId, later(9)))).amount; } catch { /* exhausted */ }
    }
    expect(paid).toBe(200);
    expect(Number((await h.db.query<any>(`SELECT spent FROM campaigns`)).rows[0].spent)).toBe(200);
  });
  it("enforces per-campaign and global daily caps", async () => {
    const u = await h.user(), c = await h.campaign({ cap: 1 });
    const s = await h.run((tx) => startSession(tx, u, c, cfg, t0));
    await h.run((tx) => completeSession(tx, u, s.sessionId, later(9)));
    await expect(h.run((tx) => startSession(tx, u, c, cfg, later(20)))).rejects.toThrow("CAMPAIGN_DAILY_LIMIT");
    const next = new Date("2026-09-30T10:00:00Z");
    await expect(h.run((tx) => startSession(tx, u, c, cfg, next))).resolves.toBeTruthy();
  });
  it("blocks suspended users", async () => {
    const u = await h.user(), c = await h.campaign();
    await h.db.query(`UPDATE users SET status='SUSPENDED'`);
    await expect(h.run((tx) => startSession(tx, u, c, cfg, t0))).rejects.toThrow("USER_BLOCKED");
  });
});

describe("withdrawals", () => {
  const fund = (u: string, amt: number) => h.run((tx) => post(tx, { userId: u, type: "BONUS", direction: "CREDIT", amount: amt, idempotencyKey: "fund" + u + amt }));
  it("enforces minimum and sufficient balance", async () => {
    const u = await h.user(); await fund(u, 15000);
    await expect(h.run((tx) => requestWithdrawal(tx, u, 5000, "key-00001", "telebirr", {}, 10000))).rejects.toThrow("BELOW_MINIMUM");
    await expect(h.run((tx) => requestWithdrawal(tx, u, 20000, "key-00002", "telebirr", {}, 10000))).rejects.toThrow("INSUFFICIENT_BALANCE");
  });
  it("holds balance and is idempotent per key", async () => {
    const u = await h.user(); await fund(u, 15000);
    const a = await h.run((tx) => requestWithdrawal(tx, u, 10000, "key-00003", "telebirr", { phone: "09" }, 10000));
    const b = await h.run((tx) => requestWithdrawal(tx, u, 10000, "key-00003", "telebirr", { phone: "09" }, 10000));
    expect(b.withdrawalId).toBe(a.withdrawalId); expect(b.created).toBe(false);
    expect(await h.run((tx) => balance(tx, u))).toBe(5000);
  });
  it("cannot double-spend the same funds with different keys", async () => {
    const u = await h.user(); await fund(u, 15000);
    await h.run((tx) => requestWithdrawal(tx, u, 10000, "key-00004", "telebirr", {}, 10000));
    await expect(h.run((tx) => requestWithdrawal(tx, u, 10000, "key-00005", "telebirr", {}, 10000))).rejects.toThrow("INSUFFICIENT_BALANCE");
  });
  it("rejection restores the balance exactly once; paid cannot be rejected", async () => {
    const u = await h.user(); await fund(u, 15000);
    const w = await h.run((tx) => requestWithdrawal(tx, u, 10000, "key-00006", "telebirr", {}, 10000));
    await h.run((tx) => rejectWithdrawal(tx, w.withdrawalId));
    await expect(h.run((tx) => rejectWithdrawal(tx, w.withdrawalId))).rejects.toThrow("INVALID_STATE");
    expect(await h.run((tx) => balance(tx, u))).toBe(15000);
    const w2 = await h.run((tx) => requestWithdrawal(tx, u, 10000, "key-00007", "telebirr", {}, 10000));
    await h.run((tx) => markPaid(tx, w2.withdrawalId, "TXN-123"));
    await expect(h.run((tx) => rejectWithdrawal(tx, w2.withdrawalId))).rejects.toThrow("INVALID_STATE");
    expect(await h.run((tx) => balance(tx, u))).toBe(5000);
  });
});
