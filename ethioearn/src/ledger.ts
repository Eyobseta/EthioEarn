import type { Tx } from "./db.js";
export type Direction = "CREDIT" | "DEBIT";
export interface Entry {
  userId?: string; campaignId?: string; withdrawalId?: string; type: string; direction: Direction;
  amount: number; idempotencyKey: string; referenceType?: string; referenceId?: string; metadata?: object;
}
/** Append one ledger row. Amounts are integer minor units (santim). Replays of the same key are no-ops. */
export async function post(tx: Tx, e: Entry): Promise<{ id: string; created: boolean }> {
  if (!Number.isSafeInteger(e.amount) || e.amount <= 0) throw new Error("amount must be a positive integer of minor units");
  const r = await tx.query(
    `INSERT INTO ledger_transactions(user_id,campaign_id,withdrawal_id,type,direction,amount,idempotency_key,reference_type,reference_id,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [e.userId ?? null, e.campaignId ?? null, e.withdrawalId ?? null, e.type, e.direction, e.amount, e.idempotencyKey, e.referenceType ?? null, e.referenceId ?? null, JSON.stringify(e.metadata ?? {})]);
  if (r.rows.length) return { id: r.rows[0].id, created: true };
  const ex = await tx.query(`SELECT id FROM ledger_transactions WHERE idempotency_key=$1`, [e.idempotencyKey]);
  return { id: ex.rows[0].id, created: false };
}
export async function balance(tx: Tx, userId: string): Promise<number> {
  const r = await tx.query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) AS b FROM ledger_transactions WHERE user_id=$1 AND status='POSTED'`, [userId]);
  return Number(r.rows[0].b);
}
