import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import type { Tx } from "../src/db.js";
export async function newDb() {
  const db = new PGlite();
  for (const f of fs.readdirSync("db/migrations").sort()) await db.exec(fs.readFileSync(`db/migrations/${f}`, "utf8"));
  const run = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction((tx) => fn(tx as unknown as Tx)) as Promise<T>;
  const user = async (tg = 1) => (await db.query<any>(`INSERT INTO users(telegram_user_id,referral_code) VALUES($1,$2) RETURNING id`, [tg, "R" + tg])).rows[0].id as string;
  const campaign = async (o: { reward?: number; budget?: number; cap?: number; secs?: number } = {}) =>
    (await db.query<any>(`INSERT INTO campaigns(title,advertiser,destination_url,reward,total_budget,daily_user_cap,min_seconds,status) VALUES('t','a','https://x.et',$1,$2,$3,$4,'ACTIVE') RETURNING id`,
      [o.reward ?? 150, o.budget ?? 10000, o.cap ?? 1, o.secs ?? 5])).rows[0].id as string;
  return { db, run, user, campaign };
}
