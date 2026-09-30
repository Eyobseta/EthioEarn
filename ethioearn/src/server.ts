import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { withTx } from "./db.js";
import { AppError } from "./errors.js";
import { balance } from "./ledger.js";
import { completeSession, startSession } from "./rewards.js";
import { validateInitData } from "./telegram.js";
import { requestWithdrawal } from "./withdrawals.js";
import { createCampaign, fastTrackCampaign, reviewWithdrawal, setCampaignStatus, setUserSuspended } from "./admin.js";

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
// Hosted Postgres (e.g. Neon) drops idle connections. Without this handler an idle-client error crashes the process.
pool.on("error", (e) => console.error(JSON.stringify({ level: "warn", msg: "idle db client error", detail: e.message })));
const app = express();
app.set("trust proxy", 1);
app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "https://telegram.org"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
    imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"],
    frameAncestors: ["'self'", "https://web.telegram.org", "https://webk.telegram.org", "https://webz.telegram.org"],
  } },
}));
app.use(express.json({ limit: "20kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true }));

type AuthedReq = Request & { userId: string };
const auth = (req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization?.replace(/^Bearer /, "");
  try { (req as AuthedReq).userId = (jwt.verify(h ?? "", cfg.JWT_SECRET) as { sub: string }).sub; next(); }
  catch { next(new AppError("UNAUTHENTICATED", 401)); }
};
const wrap = (fn: (req: AuthedReq, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req as AuthedReq, res).catch(next);
// Role is re-read from the database on every admin call, so revoking an admin takes effect immediately.
const role = (...allowed: string[]) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const r = (await pool.query(`SELECT role FROM admin_users WHERE user_id=$1`, [(req as AuthedReq).userId])).rows[0];
    if (!r || !allowed.includes(r.role)) throw new AppError("FORBIDDEN", 403);
    next();
  } catch (e) { next(e); }
};
const uuid = z.string().uuid();

const v1 = express.Router();
v1.post("/auth/telegram", rateLimit({ windowMs: 60_000, limit: 20 }), async (req, res, next) => {
  try {
    const { initData } = z.object({ initData: z.string().min(10).max(4096) }).parse(req.body);
    const { user } = validateInitData(initData, cfg.TELEGRAM_BOT_TOKEN);
    const row = (await pool.query(
      `INSERT INTO users(telegram_user_id,username,first_name,last_name,language_code,referral_code,last_seen_at)
       VALUES($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (telegram_user_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, last_seen_at=now()
       RETURNING id,status`, [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null, user.language_code ?? null, randomBytes(5).toString("hex")])).rows[0];
    if (row.status !== "ACTIVE") throw new AppError("USER_BLOCKED", 403);
    res.json({ token: jwt.sign({ sub: row.id }, cfg.JWT_SECRET, { expiresIn: "12h" }) });
  } catch (e) { next(e); }
});
v1.get("/wallet", auth, wrap(async (req, res) => { res.json({ available: await balance(pool, req.userId), currency: "ETB", unit: "santim", minWithdrawal: cfg.MIN_WITHDRAWAL_MINOR }); }));
v1.get("/ledger", auth, wrap(async (req, res) => {
  res.json({ items: (await pool.query(`SELECT type,direction,amount,created_at FROM ledger_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.userId])).rows });
}));
v1.get("/ads", auth, wrap(async (_req, res) => {
  res.json({ ads: (await pool.query(`SELECT id,title,advertiser,reward,min_seconds,destination_url FROM campaigns WHERE status='ACTIVE' AND spent + reward <= total_budget ORDER BY created_at DESC LIMIT 50`)).rows });
}));
v1.post("/ads/complete", auth, wrap(async (req, res) => {
  const { sessionId } = z.object({ sessionId: uuid }).parse(req.body);
  res.json(await withTx(pool, (tx) => completeSession(tx, req.userId, sessionId)));
}));
v1.post("/ads/:id/start", auth, wrap(async (req, res) => {
  res.json(await withTx(pool, (tx) => startSession(tx, req.userId, uuid.parse(req.params.id), { maxDailyCompletions: cfg.MAX_DAILY_COMPLETIONS })));
}));
v1.get("/withdrawals", auth, wrap(async (req, res) => {
  res.json({ items: (await pool.query(`SELECT id,amount,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.userId])).rows });
}));
v1.post("/withdrawals", auth, wrap(async (req, res) => {
  const key = z.string().min(8).max(100).parse(req.header("Idempotency-Key"));
  const b = z.object({ amount: z.number().int().positive(), method: z.enum(["telebirr", "cbe_birr", "bank_transfer"]), account: z.record(z.string().max(100)) }).parse(req.body);
  res.status(201).json(await withTx(pool, (tx) => requestWithdrawal(tx, req.userId, b.amount, key, b.method, b.account, cfg.MIN_WITHDRAWAL_MINOR)));
}));

const adm = express.Router();
adm.use(auth);
adm.get("/campaigns", role("SUPER", "FINANCE", "SUPPORT"), wrap(async (_r, res) => { res.json({ items: (await pool.query(`SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 100`)).rows }); }));
adm.post("/campaigns", role("SUPER"), wrap(async (req, res) => {
  const b = z.object({ title: z.string().min(2).max(120), advertiser: z.string().min(2).max(120), destinationUrl: z.string().url().max(500),
    reward: z.number().int().positive(), totalBudget: z.number().int().positive(), minSeconds: z.number().int().min(3).max(120).default(5), dailyUserCap: z.number().int().min(1).max(20).default(1) }).parse(req.body);
  res.status(201).json(await withTx(pool, (tx) => createCampaign(tx, req.userId, b)));
}));
adm.post("/campaigns/:id/status", role("SUPER"), wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"]) }).parse(req.body);
  await withTx(pool, (tx) => setCampaignStatus(tx, req.userId, uuid.parse(req.params.id), status)); res.json({ ok: true });
}));
adm.get("/withdrawals", role("FINANCE", "SUPER"), wrap(async (req, res) => {
  const st = z.string().default("REQUESTED").parse(req.query.status);
  res.json({ items: (await pool.query(`SELECT w.*, u.telegram_user_id, u.username FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status=$1 ORDER BY w.created_at LIMIT 100`, [st])).rows });
}));
adm.post("/withdrawals/:id/reject", role("FINANCE", "SUPER"), wrap(async (req, res) => { await withTx(pool, (tx) => reviewWithdrawal(tx, req.userId, uuid.parse(req.params.id), "reject")); res.json({ ok: true }); }));
adm.post("/withdrawals/:id/paid", role("FINANCE", "SUPER"), wrap(async (req, res) => {
  const { reference } = z.object({ reference: z.string().min(3).max(100) }).parse(req.body);
  await withTx(pool, (tx) => reviewWithdrawal(tx, req.userId, uuid.parse(req.params.id), "paid", reference)); res.json({ ok: true });
}));
adm.post("/users/:id/suspension", role("SUPPORT", "SUPER"), wrap(async (req, res) => {
  const { suspended } = z.object({ suspended: z.boolean() }).parse(req.body);
  await withTx(pool, (tx) => setUserSuspended(tx, req.userId, uuid.parse(req.params.id), suspended)); res.json({ ok: true });
}));

const ALL = ["SUPER", "FINANCE", "SUPPORT"];
const SIGNED = `CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END`;
adm.get("/me", wrap(async (req, res) => {
  const r = (await pool.query(`SELECT role FROM admin_users WHERE user_id=$1`, [req.userId])).rows[0];
  if (!r) throw new AppError("FORBIDDEN", 403);
  res.json({ role: r.role });
}));
adm.get("/stats", role(...ALL), wrap(async (_r, res) => {
  const r = (await pool.query(`SELECT
    (SELECT count(*) FROM users) AS users,
    (SELECT COALESCE(SUM(${SIGNED}),0) FROM ledger_transactions l WHERE l.user_id IS NOT NULL) AS owed,
    (SELECT count(*) FROM withdrawals WHERE status='REQUESTED') AS pending_n,
    (SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='REQUESTED') AS pending_amt`)).rows[0];
  res.json({ users: Number(r.users), owed: Number(r.owed), pending_n: Number(r.pending_n), pending_amt: Number(r.pending_amt) });
}));
adm.get("/users", role(...ALL), wrap(async (req, res) => {
  const q = z.string().max(64).default("").parse(req.query.q);
  res.json({ items: (await pool.query(`SELECT u.id,u.telegram_user_id,u.username,u.first_name,u.status,u.created_at,
    COALESCE((SELECT SUM(${SIGNED}) FROM ledger_transactions l WHERE l.user_id=u.id),0) AS balance
    FROM users u WHERE $1='' OR u.username ILIKE $2 OR u.telegram_user_id::text=$1 ORDER BY u.created_at DESC LIMIT 30`, [q, `%${q}%`])).rows });
}));
adm.post("/campaigns/:id/activate", role("SUPER"), wrap(async (req, res) => {
  await withTx(pool, (tx) => fastTrackCampaign(tx, req.userId, uuid.parse(req.params.id))); res.json({ ok: true });
}));

app.use("/api/v1/admin", adm);
app.use("/api/v1", v1);
app.get("/healthz", (_q, r) => r.json({ ok: true }));
app.get("/readyz", async (_q, r) => { try { await pool.query("SELECT 1"); r.json({ ok: true }); } catch { r.status(503).json({ ok: false }); } });
app.use(express.static(path.resolve("public"), { maxAge: "5m" }));
app.use((err: unknown, _req: Request, res: Response, _n: NextFunction) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.code });
  if (err instanceof z.ZodError) return res.status(400).json({ error: "VALIDATION_ERROR", details: err.issues });
  console.error(JSON.stringify({ level: "error", msg: String((err as Error)?.message) }));
  res.status(500).json({ error: "INTERNAL" });
});
const server = app.listen(cfg.PORT, () => console.log(JSON.stringify({ level: "info", msg: "listening", port: cfg.PORT })));
const stop = () => server.close(async () => { await pool.end(); process.exit(0); });
process.on("SIGTERM", stop); process.on("SIGINT", stop);
