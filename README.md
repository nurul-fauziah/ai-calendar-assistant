# Personal Calendar (AI Telegram Assistant)

AI calendar-assistant bot. User kirim tugas dalam bahasa natural via Telegram → AI (atau regex fallback) parse → jadwal ditempatkan di slot kosong → konfirmasi → sync ke Google Calendar.

**Stack**: NestJS 11 · Prisma 7 + SQLite (better-sqlite3) · Express · Telegram Bot API.

## Struktur

```
src/
  ai/          Parser tugas: LLM (OpenAI-compatible) atau regex fallback
  auth/        OAuth2 Google (connect calendar) — encode state dari telegramId
  calendar/    Interaksi Google Calendar API: list/create event + refresh token
  scheduler/   Cari slot kosong, buat rekomendasi, confirm/modify/cancel
  telegram/    Webhook Telegram (message + callback query)
  tasks/       CRUD task (internal)
  users/       Registrasi user telegram
  preferences/ UserPreference scaffold (preferred hours dll)
  common/      PrismaService, crypto.util (token enkripsi), html-escape
```

## Setup

```bash
npm install
npx prisma migrate dev          # jalankan migrasi ke dev.db
npm run start:dev
```

Dibutuhkan `.env` (lihat `PRD.docx` untuk konteks fitur):

```
# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_URL=            # https://<host>/webhook/telegram
TELEGRAM_WEBHOOK_SECRET=         # wajib: dikirim ke setWebhook, diverifikasi di controller
BASE_URL=                        # origin app, dipakai di link connect Google

# Google OAuth2
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

# DB (default: file:./dev.db di working dir)
DATABASE_URL=file:./dev.db

# LLM parsing — kosongkan utk pakai regex fallback
LLM_API_KEY=
LLM_API_URL=https://api.openai.com/v1/chat/completions
```

Jika `TELEGRAM_WEBHOOK_SECRET` diset, webhook di-secure dengan header
`X-Telegram-Bot-Api-Secret-Token`. Token Google disimpan terenkripsi
(AES-256-GCM, `TOKEN_ENCRYPTION_KEY` — wajib diset di prod; lihat `src/common/crypto.util.ts`).

## Commands bot

- `/start` — pengenalan
- `/today` — ringkasan jadwal hari ini
- `/week` — ringkasan minggu ini
- `/connect google` — tautkan Google Calendar
- Teks bebas (mis. *"besok belajar Python 2 jam"*) — parse & rekomendasi slot

## Development

```bash
npm test        # unit tests
npm run lint
npm run build
```

Catatan: test di-set dengan stub `PrismaClient` (mapping `generated/prisma/client`
→ `test/prisma-client.stub.ts`) karena client ESM break ts-jest CJS.

## Deploy

`npm run build` lalu `node dist/main`, dengan env di atas ter-set.
`setWebhook` otomatis di `onModuleInit` saat `TELEGRAM_BOT_TOKEN`+`TELEGRAM_WEBHOOK_URL` ada.