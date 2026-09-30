import { z } from "zod";
const schema = z.object({
  APP_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  JWT_SECRET: z.string().min(32),
  MIN_WITHDRAWAL_MINOR: z.coerce.number().int().positive().default(10000),
  MAX_DAILY_COMPLETIONS: z.coerce.number().int().positive().default(10),
});
export const loadConfig = () => schema.parse(process.env);
