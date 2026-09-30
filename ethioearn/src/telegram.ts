import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
export interface TgUser { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string; photo_url?: string; }
/** Server-side Telegram Mini App initData validation (HMAC-SHA256 scheme from Telegram's docs). */
export function validateInitData(initData: string, botToken: string, maxAgeSec = 3600, now = Date.now()): { user: TgUser; authDate: number } {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new AppError("INVALID_INIT_DATA", 401);
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = createHmac("sha256", secret).update(dcs).digest();
  if (!timingSafeEqual(Buffer.from(hash, "hex"), calc)) throw new AppError("INVALID_INIT_DATA", 401);
  const authDate = Number(p.get("auth_date"));
  if (!authDate || now / 1000 - authDate > maxAgeSec || authDate - now / 1000 > 60) throw new AppError("INIT_DATA_EXPIRED", 401);
  let user: TgUser;
  try { user = JSON.parse(p.get("user") ?? ""); } catch { throw new AppError("INVALID_INIT_DATA", 401); }
  if (!user?.id) throw new AppError("INVALID_INIT_DATA", 401);
  return { user, authDate };
}
