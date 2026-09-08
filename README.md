# Personal Calendar — AI Calendar Assistant for Telegram

A self-hosted AI calendar assistant built with **NestJS + Prisma 7 + Telegram Bot API + Google Calendar**. Send natural language task requests in Indonesian via Telegram, and the bot parses them, recommends time slots around existing conflicts, and syncs to Google Calendar on confirmation.

---

## Key Features

| Feature | Detail |
|---|---|
| **Natural language parsing** | Supports Indonesian: `"besok jam 8 pagi belajar Python 2 jam"`, `"hari ini jam 13.50 harus tidur"`. Handles `jam 14.50`, `jam 14:50`, `jam 8 pagi/malam`, bare `13:50`. |
| **Explicit time preservation** | If user specifies a time, the scheduler uses it exactly. Only falls back to alternatives if the slot conflicts — never silently shifts. |
| **Interactive schedule recommendation** | Bot replies with Confirm ✅ / Modify ✏️ / Cancel ❌ inline buttons on every recommendation. |
| **Single-thread modify flow** | Click Modify → bot edits the same message (no duplicate asks). Type `"pindah jam 15.50"` → new recommendation replaces the old one in one message. |
| **Google Calendar sync** | On confirm, events sync to the user's primary Google Calendar via OAuth2. |
| **Timezone-aware** | All scheduling computed in the user's local timezone (default `Asia/Jakarta`). Wall-clock time is preserved end-to-end. |
| **Regex parser + optional LLM** | Works out of the box with regex fallback; plug in an LLM API key for better natural language coverage. |
| **Session state management** | `/start` resets all conversation state and clears stale recommendations from the database. |
| **DB double-book guard** | Confirm-time check prevents two tasks from locking the same slot in parallel. |

---

## System Flow

```
User Telegram message
        │
        ▼
  ┌─────────────┐
  │  Webhook     │  POST /webhook/telegram (secret token validation)
  │  Controller  │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  Telegram    │  Command routing: /start /today /week /connect
  │  Service     │  → hasPendingModify? → continueModify (step 2)
  └──────┬──────┘  → else → parseTask → findAvailableSlots → sendRecommendation
         │
         ▼
  ┌─────────────┐         ┌─────────────┐
  │  AI Service  │ ──→     │ Scheduler   │  findAvailableSlots (busy = SCHEDULED tasks + Google Cal)
  │  (regex/LLM) │         │ Service     │  sendRecommendation (Confirm/Modify/Cancel buttons)
  └─────────────┘         └──────┬──────┘
                                 │
                          Confirm ▼
                       ┌──────────────┐
                       │ Calendar      │  createEvent (wall-clock + timeZone)
                       │ Service       │  ← Google Calendar API v3
                       └──────────────┘
```

**Modify flow (single message):**
```
User clicks "✏️ Modify"
    → bot edits SAME message → "Mau diubah apa?"
User types "pindah jam 15.50"
    → parser extracts preferredMinutes = 950
    → delete old slot, findAvailableSlots, delete old recommendation
    → bot edits SAME message again → new recommendation (one thread, no duplicate)
```

---

## Example Interaction

```
User: gw harus belajar Python 2 jam minggu depan

Bot: 📅 Schedule Recommendation

     📌 belajar Python
     Duration: 2h
     Deadline: Mon, 14 Sep

     📝 belajar Python
     Senin, 14 Sep
     08:00 – 10:00

     [✅ Confirm] [✏️ Modify] [❌ Cancel]

User: (clicks ✏️ Modify)

Bot: ✏️ Mau diubah apa dari jadwal ini?
     📌 belajar Python
     Senin, 14 Sep 08:00 – 10:00

     Ketik perubahan, misalnya:
     • pindah jam 15.50
     • jadinya besok jam 10
     • durasi 2 jam
     • ganti judul belajar java

     Atau ketik batal buat nggak jadi.

User: pindah jam 15.50

Bot: 📅 Schedule Recommendation
     📌 belajar Python
     📝 belajar Python
     Senin, 14 Sep
     15:50 – 17:50

     [✅ Confirm] [✏️ Modify] [❌ Cancel]

User: (clicks ✅ Confirm)

Bot: ✅ Jadwal dikonfirmasi!
     📌 belajar Python
     Senin, 14 Sep
     15:50 – 17:50
     📆 Berhasil ditambahkan ke Google Calendar!
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [NestJS](https://nestjs.com/) v11 |
| ORM | [Prisma 7](https://www.prisma.io/) + `@prisma/adapter-better-sqlite3` |
| Database | SQLite (`better-sqlite3`) |
| Bot | Telegram Bot API (webhook mode) |
| Calendar | Google Calendar API v3 (OAuth2) |
| Time | `date-fns` v4 + `date-fns-tz` v3 |
| Parser | Regex fallback (no deps); optional LLM via `axios` |
| Crypto | Node.js `crypto` — AES-256-GCM for token encryption |
| Language | TypeScript 5.7+ |
| Testing | Jest 30 + `@nestjs/testing` |
| Linting | ESLint 9 + Prettier |

---

## Project Structure

```
personal-calendar/
├── prisma/
│   ├── schema.prisma          # Prisma 7 schema (User, Task, ScheduledTask, GoogleConnection)
│   ├── migrations/            # SQL migrations
│   └── prisma.config.ts       # Prisma 7 config (SQLite, better-sqlite3 adapter)
├── src/
│   ├── ai/                    # AI task parsing (regex + optional LLM)
│   │   ├── ai.service.ts
│   │   └── ai.interface.ts    # ParsedTask interface
│   ├── auth/                  # Google OAuth2 flow
│   │   ├── auth.service.ts
│   │   └── auth.controller.ts # GET /auth/google, GET /auth/google/callback
│   ├── calendar/              # Google Calendar integration
│   │   └── calendar.service.ts
│   ├── common/                # Shared utilities
│   │   ├── prisma.service.ts  # Prisma 7 client with adapter
│   │   ├── timezone.ts        # localDateToUtc, toLocal, format helpers
│   │   ├── crypto.util.ts     # AES-256-GCM encrypt/decrypt (tokens)
│   │   └── html-escape.ts     # HTML escape for Telegram HTML parse mode
│   ├── health/
│   │   └── health.controller.ts  # GET /health (DB, Telegram, LLM, Google status)
│   ├── scheduler/             # Slot finding, recommendation, modify flow
│   │   ├── scheduler.service.ts
│   │   └── scheduler.interface.ts
│   ├── tasks/                 # Task CRUD
│   │   └── tasks.service.ts
│   ├── telegram/              # Webhook handler, bot commands, message routing
│   │   ├── telegram.controller.ts   # POST /webhook/telegram
│   │   └── telegram.service.ts
│   ├── users/                 # User CRUD, timezone lookup
│   │   └── users.service.ts
│   ├── app.module.ts
│   └── main.ts                # NestJS bootstrap
└── package.json
```

---

## Setup & Configuration

### 1. Clone and install

```bash
git clone <repo-url>
cd personal-calendar
npm install
```

### 2. Configure environment

Copy the `.env.example` to `.env` (or create `.env` directly) with the following variables:

```env
# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_WEBHOOK_URL=https://your-domain/webhook/telegram
TELEGRAM_WEBHOOK_SECRET=your-secret

# Google OAuth2
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://your-domain/auth/google/callback

# Token encryption (AES-256-GCM) — set a strong random value for production
TOKEN_ENCRYPTION_KEY=change-me-in-production

# Server
PORT=3000
BASE_URL=https://your-domain

# Database
DATABASE_URL=file:./dev.db

# Optional: LLM for better natural language parsing (falls back to regex if omitted)
LLM_API_KEY=your-api-key
```

### 3. Initialize database

```bash
npx prisma generate
npx prisma migrate deploy
```

### 4. Start the server

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

### 5. Set Telegram webhook

Once the server is running and reachable, the bot automatically registers the webhook via `TELEGRAM_WEBHOOK_URL` on startup. Ensure your server is accessible from the internet (use ngrok, Cloudflare Tunnel, etc. during development).

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message. Resets all conversation state and clears stale recommendations. |
| `/today` | Shows all scheduled events for today (timezone-aware). |
| `/week` | Weekly summary grouped by day (Monday start). |
| `/connect` | Generates a Google OAuth2 link to connect Google Calendar. |

---

## Testing

```bash
# Run all tests (parser + scheduler + telegram + utils)
npm test

# Run with coverage
npm run test:cov

# Run specific test suites
npx jest src/ai
npx jest src/scheduler
npx jest src/telegram
```

Test files cover:
- **Parser** (`ai.regex.spec.ts`): 17 test cases for Indonesian time/date parsing, duration extraction, title stripping, and edge cases.
- **Scheduler** (`scheduler.service.spec.ts`): 13 test cases for slot finding, time preservation, conflict detection, modify flow, and double-book prevention.
- **Telegram** (`telegram.service.spec.ts`): 4 test cases for `/start` reset behavior and message routing.
- **Utils**: HTML escape, crypto encrypt/decrypt.

---

## Security Notes

| Area | Implementation |
|---|---|
| **Webhook authentication** | `X-Telegram-Bot-Api-Secret-Token` header validation on `POST /webhook/telegram`. |
| **Token encryption** | Google OAuth access/refresh tokens stored AES-256-GCM encrypted (per-value IV, inline `iv:tag:ciphertext`). |
| **Input validation** | `telegramId` regex-validated before flowing into OAuth state (`^\d{6,15}$`). |
| **Validation pipes** | NestJS `ValidationPipe` with `whitelist: true` strips unknown properties. |
| **HTML escape** | All user-generated text escaped before HTML-mode Telegram messages to prevent injection. |

> **Production note:** Set `TOKEN_ENCRYPTION_KEY` to a strong random value. The default dev key is only for local testing. Re-encrypt tokens with the production key before switching environments.

---

## Architecture Decisions

- **SQLite** chosen for simplicity — zero external DB setup, single-file storage. Replace `@prisma/adapter-better-sqlite3` with `@prisma/adapter-pg` to switch to PostgreSQL.
- **Regex parser over LLM** as default: zero API cost, instant response, works offline. The LLM path activates only when `LLM_API_KEY` is set.
- **`PENDING` vs `SCHEDULED` status**: Only confirmed (`SCHEDULED`) tasks count as busy slots. Unconfirmed recommendations (`PENDING`) don't block future scheduling — prevents stale recommendations from corrupting slot availability.
- **In-memory modify state** (`pendingModify` + `latestRecommendation`): scoped per-user, cleared on `/start`. Single-instance bot assumed. For multi-instance deployment, move to Redis.

---

## License

This project is for personal/educational use. No license specified.
