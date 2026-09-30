import type { Tx } from "./db.js";
import { AppError } from "./errors.js";
import { balance, post } from "./ledger.js";

export async function requestWithdrawal(tx: Tx, userId: string, amount: number, key: string, method: string, account: object, minAmount: number) {
  const idem = `withdrawal:${userId}:${key}`;
  const u = (await tx.query(`SELECT status FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
  if (!u || u.status !== "ACTIVE") throw new AppError("USER_BLOCKED", 403);
  const existing = (await tx.query(`SELECT id,status FROM withdrawals WHERE idempotency_key=$1`, [idem])).rows[0];
  if (existing) return { withdrawalId: existing.id as string, status: existing.status as string, created: false };
  if (!Number.isSafeInteger(amount) || amount < minAmount) throw new AppError("BELOW_MINIMUM", 422);
  if ((await balance(tx, userId)) < amount) throw new AppError("INSUFFICIENT_BALANCE", 422);
  const w = (await tx.query(`INSERT INTO withdrawals(user_id,amount,method,account,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [userId, amount, method, JSON.stringify(account), idem])).rows[0];
  await post(tx, { userId, withdrawalId: w.id, type: "WITHDRAWAL_HOLD", direction: "DEBIT", amount, idempotencyKey: `wd-hold:${w.id}` });
  return { withdrawalId: w.id as string, status: "REQUESTED", created: true };
}
async function lockOne(tx: Tx, id: string) {
  const w = (await tx.query(`SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!w) throw new AppError("NOT_FOUND", 404);
  if (["PAID", "REJECTED", "CANCELLED"].includes(w.status)) throw new AppError("INVALID_STATE", 409);
  return w;
}
/** Admin action: refund the hold with a compensating credit. */
export async function rejectWithdrawal(tx: Tx, id: string) {
  const w = await lockOne(tx, id);
  await post(tx, { userId: w.user_id, withdrawalId: id, type: "WITHDRAWAL_REVERSAL", direction: "CREDIT", amount: Number(w.amount), idempotencyKey: `wd-reverse:${id}` });
  await tx.query(`UPDATE withdrawals SET status='REJECTED', updated_at=now() WHERE id=$1`, [id]);
}
/** Admin action after paying externally (manual MVP payout). The hold already left the balance. */
export async function markPaid(tx: Tx, id: string, providerReference: string) {
  if (!providerReference.trim()) throw new AppError("REFERENCE_REQUIRED", 422);
  await lockOne(tx, id);
  await tx.query(`UPDATE withdrawals SET status='PAID', provider_reference=$2, updated_at=now() WHERE id=$1`, [id, providerReference]);
}
