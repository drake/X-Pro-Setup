# X Pro Guideposts

**Live (HTMTN):** https://xpro.howtomovetheneedle.com  

**This app is optional.** Lists, members, and Pro decks can all be created manually in X and [pro.x.com](https://pro.x.com). Guideposts is a free starter so people are not stuck on a blank Pro board — not a product Pro depends on.

**Not affiliated with X, X Corp, or pro.x.com.** Independent open-source project built by [@JonathanDrake](https://x.com/JonathanDrake).

Free & open source (MIT). Turns **your** X signals into **private Lists** for Pro:

- Bookmarks (primary intent)
- Last **50** likes  
- Last **25** follows  
- Who you **reply to** most  

Setup uses **Jack Principles** (Jellyvision Interactive Conversation Interface): one task at a time, shared control, responses that acknowledge what you just said.

## Hosted free pool

| Rule | Value |
|------|--------|
| Host-paid runs / day | **10** |
| Unlock | **Random time** each UTC day |
| Per user / day | **1** free full build |
| Over free | Wait for next drop or **self-host** |

One-click list **create** is host-paid only inside the free pool (keeps your X bill bounded).

## Quick start (self-host)

### 1. X developer app (OAuth 2.0 — not “Keys and tokens”)

This app uses **OAuth 2.0 Authorization Code + PKCE**. Consumer Key / API Key / Bearer Token from **Keys and tokens** will **not** work.

1. Open https://developer.x.com → your Project → App (e.g. `x-pro-setup`)
2. **User authentication settings** → Edit / Set up:
   - **App permissions:** Read and write  
   - **Type of App:** Web App, Automated App or Bot  
   - **Callback URI / Redirect URL** (must match exactly):  
     - Hosted: `https://xpro.howtomovetheneedle.com/api/auth/x/callback`  
     - Self-host: `https://YOUR_DOMAIN/api/auth/x/callback`  
     - Local: `http://localhost:8787/api/auth/x/callback`  
   - **Website URL:** your site origin (e.g. `https://xpro.howtomovetheneedle.com`)
3. Save. Copy the **OAuth 2.0 Client ID** and **Client Secret** (not Consumer Key / Secret).
4. Scopes requested by the Worker:  
   `tweet.read users.read bookmark.read like.read follows.read list.read list.write offline.access`
5. Buy X API credits (pay-per-use) on the developer portal.

### 2. Install & D1
```bash
npm install
npx wrangler d1 create xpro-htmtn   # paste id into wrangler.toml
npm run db:migrate:local
```

### 3. Secrets (OAuth 2.0 names)

Never commit secrets. Type each value when prompted:

```bash
npx wrangler secret put X_CLIENT_ID          # OAuth 2.0 Client ID
npx wrangler secret put X_CLIENT_SECRET      # OAuth 2.0 Client Secret
npx wrangler secret put SESSION_SECRET       # e.g. openssl rand -base64 32
npx wrangler secret put TOKEN_ENCRYPTION_KEY # 32+ chars; encrypts X tokens at rest
npx wrangler secret put DAILY_POOL_SECRET    # seeds random daily free-pool unlock
# optional Grok polish on free runs:
npx wrangler secret put XAI_API_KEY
```

**Hosted cutover (OAuth 2.0 only — interactive):**

```bash
npm run secrets:x-oauth
# or: bash scripts/put-x-oauth-secrets.sh
```

That prompts for **Client ID + Client Secret** only. Session/encryption/pool secrets are set separately on the live Worker.

Check what’s set (values are not shown):

```bash
npx wrangler secret list
```

### 4. Dev / deploy
```bash
npm run dev
# open http://localhost:8787

npm run db:migrate:remote
npm run deploy
```

Custom domain: `[[routes]]` in `wrangler.toml` already targets `xpro.howtomovetheneedle.com`.

Smoke checks after deploy:

```bash
curl -s https://xpro.howtomovetheneedle.com/api/health
curl -s https://xpro.howtomovetheneedle.com/api/pool
```

## Stack
- Cloudflare Worker + static assets + D1  
- No framework lock-in  
- Tokens encrypted at rest (AES-GCM)

## Session policy (short by design)

This public host is **not** meant to keep people logged into X forever:

| Control | Default |
|---------|---------|
| Session length | **60 minutes** (`SESSION_TTL_MINUTES`) |
| Long-lived refresh | **Off** — no `offline.access` scope; refresh tokens not stored |
| After list create | **Disconnect** — wipe session cookie + `x_tokens` (`DISCONNECT_AFTER_APPLY=true`) |
| Logout / expiry | Deletes session **and** stored X tokens for that user |

Tune in `wrangler.toml` `[vars]` and redeploy. Lists already created on the user’s X account are unaffected.

## License
MIT — free software. X API and xAI usage are billed by those providers.
