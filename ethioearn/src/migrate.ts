import fs from "node:fs"; import path from "node:path"; import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
const dir = path.resolve("db/migrations");
for (const f of fs.readdirSync(dir).sort()) {
  if ((await pool.query(`SELECT 1 FROM schema_migrations WHERE name=$1`, [f])).rowCount) continue;
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query(fs.readFileSync(path.join(dir, f), "utf8")); await c.query(`INSERT INTO schema_migrations(name) VALUES($1)`, [f]); await c.query("COMMIT"); console.log("applied", f); }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
await pool.end();
