import type { Tx } from "./db.js";
import { AppError } from "./errors.js";
import { post } from "./ledger.js";
export interface RewardConfig { maxDailyCompletions: number; }
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

/** Step 1: server creates the session and fixes the reward. The client never sends an amount. */
export async function startSession(tx: Tx, userId: string, campaignId: string, cfg: RewardConfig, now = new Date()) {
  const u = (await tx.query(`SELECT status FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
  if (!u || u.status !== "ACTIVE") throw new AppError("USER_BLOCKED", 403);
  const c = (await tx.query(`SELECT * FROM campaigns WHERE id=$1`, [campaignId])).rows[0];
  if (!c || c.status !== "ACTIVE") throw new AppError("CAMPAIGN_UNAVAILABLE", 404);
  if (Number(c.spent) + Number(c.reward) > Number(c.total_budget)) throw new AppError("CAMPAIGN_EXHAUSTED", 409);
  const ds = dayStart(now);
  const all = await tx.query(`SELECT count(*)::int AS n FROM earning_sessions WHERE user_id=$1 AND status='COMPLETED' AND completed_at >= $2::timestamptz`, [userId, ds]);
  if (all.rows[0].n >= cfg.maxDailyCompletions) throw new AppError("DAILY_LIMIT_REACHED", 429);
  const per = await tx.query(`SELECT count(*)::int AS n FROM earning_sessions WHERE user_id=$1 AND campaign_id=$2 AND status='COMPLETED' AND completed_at >= $3::timestamptz`, [userId, campaignId, ds]);
  if (per.rows[0].n >= c.daily_user_cap) throw new AppError("CAMPAIGN_DAILY_LIMIT", 429);
  const s = await tx.query(`INSERT INTO earning_sessions(user_id,campaign_id,reward,min_seconds,started_at) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [userId, campaignId, c.reward, c.min_seconds, now.toISOString()]);
  return { sessionId: s.rows[0].id as string, minSeconds: c.min_seconds as number };
}

/** Step 2: validate elapsed time, budget and single use, then debit campaign + credit user atomically. */
export async function completeSession(tx: Tx, userId: string, sessionId: string, now = new Date()) {
  const s = (await tx.query(`SELECT * FROM earning_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [sessionId, userId])).rows[0];
  if (!s) throw new AppError("SESSION_NOT_FOUND", 404);
  if (s.status === "COMPLETED") return { credited: false, amount: Number(s.reward) };
  const elapsed = (now.getTime() - new Date(s.started_at).getTime()) / 1000;
  if (elapsed < s.min_seconds) throw new AppError("COMPLETED_TOO_EARLY", 409);
  const u = (await tx.query(`SELECT status FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
  if (u.status !== "ACTIVE") throw new AppError("USER_BLOCKED", 403);
  const c = (await tx.query(`SELECT * FROM campaigns WHERE id=$1 FOR UPDATE`, [s.campaign_id])).rows[0];
  const reward = Number(s.reward);
  if (c.status !== "ACTIVE" || Number(c.spent) + reward > Number(c.total_budget)) throw new AppError("CAMPAIGN_EXHAUSTED", 409);
  await tx.query(`UPDATE campaigns SET spent = spent + $2 WHERE id=$1`, [c.id, reward]);
  await post(tx, { userId, campaignId: c.id, type: "AD_REWARD", direction: "CREDIT", amount: reward,
    idempotencyKey: `ad-reward:${sessionId}`, referenceType: "earning_session", referenceId: sessionId });
  await tx.query(`UPDATE earning_sessions SET status='COMPLETED', completed_at=$2 WHERE id=$1`, [sessionId, now.toISOString()]);
  return { credited: true, amount: reward };
}
