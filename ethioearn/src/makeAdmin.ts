import pg from "pg";
const [tg, role = "SUPER"] = process.argv.slice(2);
if (!tg || !["SUPPORT", "FINANCE", "SUPER"].includes(role)) { console.error("usage: make-admin <telegram_user_id> [SUPPORT|FINANCE|SUPER]"); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const u = (await pool.query(`SELECT id FROM users WHERE telegram_user_id=$1`, [tg])).rows[0];
if (!u) { console.error("User not found: they must open the Mini App once first."); process.exit(1); }
await pool.query(`INSERT INTO admin_users(user_id,role) VALUES($1,$2) ON CONFLICT (user_id) DO UPDATE SET role=EXCLUDED.role`, [u.id, role]);
console.log("admin set", tg, role);
await pool.end();
