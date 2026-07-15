# X Pro Guideposts

**Live:** https://xpro.howtomovetheneedle.com  
**Source:** https://github.com/drake/X-Pro-Setup  

**Optional starter** for [pro.x.com](https://pro.x.com). Lists, members, and Pro decks can all be created manually in X — this tool only helps draft private Lists from your own activity.

**Not affiliated with X, X Corp, or pro.x.com.** Independent MIT project by [@JonathanDrake](https://x.com/JonathanDrake).

---

## What it does

1. **Connect** X (short session ~60 min)  
2. **Dials** — weight bookmarks, likes, recent follows, replies, and **DMs you sent** (outbound only)  
3. **Lists** — review proposed private Lists; create only after you approve  
4. **Pro** — open pro.x.com, new deck, pin each list as a column (no public deck API)

Nothing is posted as you. Tokens are wiped after create (or disconnect).

---

## Hosted free pool

| | Steady state | Promo day (optional) |
|--|--------------|----------------------|
| Host-paid builds / UTC day | **10** | `FREE_RUNS_PROMO_COUNT` (e.g. 100) |
| Unlock | **Random time** each day (not midnight) | Same |
| Per user / day | **1** | `FREE_PER_USER_PROMO` (e.g. 10) when set |

Config: `wrangler.toml` → `FREE_RUNS_PER_DAY`, `FREE_PER_USER_PER_DAY`, `FREE_RUNS_PROMO_DAY`, `FREE_RUNS_PROMO_COUNT`, `FREE_PER_USER_PROMO`.

After free pool is empty: wait for next unlock, or **bring your own X developer app** (Path B below).

---

## Two ways to connect (same UI)

| Path | Who pays X API | When to use |
|------|----------------|-------------|
| **A · Free host app** | This host | Try a few builds |
| **B · Your X developer app** | You | Ongoing use on this host (no self-hosting Worker) |

Path B: paste OAuth 2.0 **Client ID + Client Secret** in the app (encrypted at rest). Callback must be exactly:

```text
https://xpro.howtomovetheneedle.com/api/auth/x/callback
```

---

## Quick start (self-host the Worker)

### 1. X developer app (OAuth 2.0 — not “Keys and tokens”)

Uses **OAuth 2.0 Authorization Code + PKCE**. Consumer Key / API Key / Bearer Token from **Keys and tokens** will **not** work for user login.

1. https://developer.x.com → Project → App  
2. **User authentication settings**:
   - **App permissions:** Read and write (DM read if using DM lists)  
   - **Type of App:** Web App, Automated App or Bot  
   - **Callback URI:**  
     - Hosted: `https://xpro.howtomovetheneedle.com/api/auth/x/callback`  
     - Self-host: `https://YOUR_DOMAIN/api/auth/x/callback`  
     - Local: `http://localhost:8787/api/auth/x/callback`  
   - **Website URL:** your origin  
3. Save → copy **OAuth 2.0 Client ID** and **Client Secret**  
4. Scopes requested by the Worker (no long-lived refresh):  

```text
tweet.read users.read bookmark.read like.read follows.read list.read list.write dm.read
```

Note: **`offline.access` is not requested** — sessions are short; we do not store long-lived refresh tokens by design.

5. Buy X API credits (pay-per-use).

### 2. Install & D1

```bash
npm install
npx wrangler d1 create xpro-htmtn   # paste id into wrangler.toml
npm run db:migrate:local
npm run db:migrate:remote
```

### 3. Secrets

```bash
npx wrangler secret put X_CLIENT_ID          # OAuth 2.0 Client ID
npx wrangler secret put X_CLIENT_SECRET      # OAuth 2.0 Client Secret
npx wrangler secret put SESSION_SECRET       # e.g. openssl rand -base64 32
npx wrangler secret put TOKEN_ENCRYPTION_KEY # 32+ chars; encrypts tokens + BYO secrets
npx wrangler secret put DAILY_POOL_SECRET    # seeds random daily unlock
# optional Grok rename polish:
npx wrangler secret put XAI_API_KEY
```

Interactive OAuth-only helper:

```bash
npm run secrets:x-oauth
```

```bash
npx wrangler secret list   # names only
```

### 4. Dev / deploy

```bash
npm run dev      # http://localhost:8787
npm run deploy
```

```bash
curl -s https://xpro.howtomovetheneedle.com/api/health
curl -s https://xpro.howtomovetheneedle.com/api/pool
```

---

## Session policy (short by design)

| Control | Default |
|---------|---------|
| Session length | **60 minutes** (`SESSION_TTL_MINUTES`) |
| Long-lived refresh | **Off** — no `offline.access` |
| After list create | **Disconnect** — wipe session + access tokens (`DISCONNECT_AFTER_APPLY=true`) |
| Logout / expiry | Deletes session and stored X tokens |

Lists already on the user’s X account are unaffected. BYO Client ID/Secret can remain encrypted for the next connect until the user clears them.

---

## Stack

- Cloudflare Worker + static assets + D1  
- Golden Ratio Typography tokens in CSS ([grtcalculator.com/math](https://grtcalculator.com/math/))  
- MIT license  

## License

MIT — free software. X API and xAI usage are billed by those providers.
