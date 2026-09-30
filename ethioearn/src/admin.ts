import type { Tx } from "./db.js";
import { AppError } from "./errors.js";
import { markPaid, rejectWithdrawal } from "./withdrawals.js";

export async function audit(tx: Tx, actor: string, action: string, entityType: string, entityId: string, metadata: object = {}) {
  await tx.query(`INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)`, [actor, action, entityType, entityId, JSON.stringify(metadata)]);
}
const NEXT: Record<string, string[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"], SUBMITTED: ["UNDER_REVIEW", "REJECTED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"], APPROVED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAUSED", "EXPIRED", "CANCELLED"], PAUSED: ["ACTIVE", "CANCELLED"],
};
export interface NewCampaign { title: string; advertiser: string; destinationUrl: string; reward: number; totalBudget: number; minSeconds: number; dailyUserCap: number; }

export async function createCampaign(tx: Tx, actor: string, i: NewCampaign) {
  if (!/^https:\/\//i.test(i.destinationUrl)) throw new AppError("URL_MUST_BE_HTTPS", 422);
  if (i.reward > i.totalBudget) throw new AppError("REWARD_EXCEEDS_BUDGET", 422);
  const r = await tx.query(`INSERT INTO campaigns(title,advertiser,destination_url,reward,total_budget,min_seconds,daily_user_cap) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [i.title, i.advertiser, i.destinationUrl, i.reward, i.totalBudget, i.minSeconds, i.dailyUserCap]);
  const id = r.rows[0].id as string;
  await audit(tx, actor, "CAMPAIGN_CREATED", "campaign", id, i);
  return { id };
}
export async function setCampaignStatus(tx: Tx, actor: string, id: string, to: string) {
  const c = (await tx.query(`SELECT status FROM campaigns WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!c) throw new AppError("NOT_FOUND", 404);
  if (!(NEXT[c.status] ?? []).includes(to)) throw new AppError("INVALID_TRANSITION", 409);
  await tx.query(`UPDATE campaigns SET status=$2 WHERE id=$1`, [id, to]);
  await audit(tx, actor, "CAMPAIGN_STATUS", "campaign", id, { from: c.status, to });
}
export async function setUserSuspended(tx: Tx, actor: string, userId: string, suspended: boolean) {
  const r = await tx.query(`UPDATE users SET status=$2 WHERE id=$1 RETURNING id`, [userId, suspended ? "SUSPENDED" : "ACTIVE"]);
  if (!r.rows.length) throw new AppError("NOT_FOUND", 404);
  await audit(tx, actor, suspended ? "USER_SUSPENDED" : "USER_REINSTATED", "user", userId);
}
export async function reviewWithdrawal(tx: Tx, actor: string, id: string, action: "reject" | "paid", reference?: string) {
  if (action === "reject") await rejectWithdrawal(tx, id); else await markPaid(tx, id, reference ?? "");
  await audit(tx, actor, action === "reject" ? "WITHDRAWAL_REJECTED" : "WITHDRAWAL_PAID", "withdrawal", id, { reference });
}
