import { beforeEach, describe, expect, it } from "vitest";
import { createCampaign, fastTrackCampaign, reviewWithdrawal, setCampaignStatus, setUserSuspended } from "../src/admin.js";
import { balance, post } from "../src/ledger.js";
import { requestWithdrawal } from "../src/withdrawals.js";
import { newDb } from "./helpers.js";
let h: Awaited<ReturnType<typeof newDb>>;
beforeEach(async () => { h = await newDb(); });
const input = { title: "Promo", advertiser: "Acme", destinationUrl: "https://acme.et", reward: 100, totalBudget: 1000, minSeconds: 5, dailyUserCap: 1 };
const logs = async () => (await h.db.query<any>(`SELECT action FROM audit_logs ORDER BY created_at`)).rows.map((r) => r.action);

describe("admin", () => {
  it("creates campaigns as DRAFT, validates input, and audits", async () => {
    const a = await h.user();
    await expect(h.run((tx) => createCampaign(tx, a, { ...input, destinationUrl: "http://x.et" }))).rejects.toThrow("URL_MUST_BE_HTTPS");
    await expect(h.run((tx) => createCampaign(tx, a, { ...input, reward: 5000 }))).rejects.toThrow("REWARD_EXCEEDS_BUDGET");
    const { id } = await h.run((tx) => createCampaign(tx, a, input));
    expect((await h.db.query<any>(`SELECT status FROM campaigns WHERE id=$1`, [id])).rows[0].status).toBe("DRAFT");
    expect(await logs()).toEqual(["CAMPAIGN_CREATED"]);
  });
  it("only allows valid status transitions", async () => {
    const a = await h.user(); const { id } = await h.run((tx) => createCampaign(tx, a, input));
    await expect(h.run((tx) => setCampaignStatus(tx, a, id, "ACTIVE"))).rejects.toThrow("INVALID_TRANSITION");
    for (const s of ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "ACTIVE", "PAUSED"]) await h.run((tx) => setCampaignStatus(tx, a, id, s));
    expect((await logs()).length).toBe(6);
  });
  it("suspension is audited and reversible", async () => {
    const a = await h.user(1), u = await h.user(2);
    await h.run((tx) => setUserSuspended(tx, a, u, true));
    expect((await h.db.query<any>(`SELECT status FROM users WHERE id=$1`, [u])).rows[0].status).toBe("SUSPENDED");
    await h.run((tx) => setUserSuspended(tx, a, u, false));
    await expect(h.run((tx) => setUserSuspended(tx, a, "00000000-0000-0000-0000-000000000000", true))).rejects.toThrow("NOT_FOUND");
  });
  it("withdrawal review writes an audit row and needs a payout reference", async () => {
    const a = await h.user(1), u = await h.user(2);
    await h.run((tx) => post(tx, { userId: u, type: "BONUS", direction: "CREDIT", amount: 20000, idempotencyKey: "f" }));
    const w = await h.run((tx) => requestWithdrawal(tx, u, 10000, "key-aaaa1", "telebirr", {}, 10000));
    await expect(h.run((tx) => reviewWithdrawal(tx, a, w.withdrawalId, "paid", " "))).rejects.toThrow("REFERENCE_REQUIRED");
    await h.run((tx) => reviewWithdrawal(tx, a, w.withdrawalId, "paid", "TXN-9"));
    expect(await logs()).toContain("WITHDRAWAL_PAID");
    expect(await h.run((tx) => balance(tx, u))).toBe(10000);
  });
  it("audit log is append-only", async () => {
    const a = await h.user(); await h.run((tx) => createCampaign(tx, a, input));
    await expect(h.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });
});

describe("fast track", () => {
  it("takes a draft to ACTIVE with every step audited, and only from DRAFT", async () => {
    const h2 = await newDb(); const a = await h2.user();
    const { id } = await h2.run((tx) => createCampaign(tx, a, input));
    await h2.run((tx) => fastTrackCampaign(tx, a, id));
    expect((await h2.db.query<any>(`SELECT status FROM campaigns WHERE id=$1`, [id])).rows[0].status).toBe("ACTIVE");
    expect(Number((await h2.db.query<any>(`SELECT count(*) AS n FROM audit_logs`)).rows[0].n)).toBe(5);
    await expect(h2.run((tx) => fastTrackCampaign(tx, a, id))).rejects.toThrow("INVALID_TRANSITION");
  });
});
