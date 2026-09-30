# EthioEarn (API + Telegram Mini App)

Node + TypeScript + Express + PostgreSQL. All money is integer santim (1 ETB = 100), stored in an append-only ledger.

    cp .env.example .env     # fill in real values
    npm install
    npm run migrate          # needs DATABASE_URL
    npm test                 # 18 tests, runs on in-memory Postgres (PGlite)
    npm run dev

Docker: `cp .env.example .env` (set TELEGRAM_BOT_TOKEN, JWT_SECRET), then `docker compose up --build`.
First admin: open the Mini App once, then `npm run make-admin -- <your_telegram_id> SUPER`.
End-to-end check against a running server: `node scripts/smoke.mjs`.
Set the bot's Mini App URL (BotFather) to your HTTPS domain; Telegram requires HTTPS.

Endpoints (/api/v1): POST /auth/telegram, GET /wallet, GET /ads, POST /ads/:id/start,
POST /ads/complete, POST /withdrawals (Idempotency-Key header required).

Admin API (roles SUPPORT/FINANCE/SUPER, audited): /admin/campaigns, /admin/withdrawals, /admin/users/:id/suspension.
Not built yet: admin web UI, tasks, referrals, advertiser API, ad-network adapter,
payout adapter, notifications bot, KYC, fraud scoring beyond caps. Do not run real money until
the compliance items in the spec (section 21) are done.
