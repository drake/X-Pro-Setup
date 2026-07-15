/**
 * X Pro Guideposts — xpro.howtomovetheneedle.com
 * Bookmarks + likes + follows + replies → proposed Lists (Jack Principles setup)
 * MIT open source. Free pool: 10 host-paid runs/day after random unlock.
 */

const COOKIE = "xpro_session";
const X_AUTH = "https://twitter.com/i/oauth2/authorize";
const X_TOKEN = "https://api.x.com/2/oauth2/token";
const X_API = "https://api.x.com/2";
// No offline.access — we do not request long-lived refresh tokens.
// Session is short (SESSION_TTL_MINUTES); access token only for the active visit.
const SCOPES = [
  "tweet.read",
  "users.read",
  "bookmark.read",
  "like.read",
  "follows.read",
  "list.read",
  "list.write",
  "dm.read", // people you messaged (outbound only)
].join(" ");

/** Session cookie + DB row lifetime (minutes). Default 60. */
function sessionTtlSec(env) {
  const mins = num(env.SESSION_TTL_MINUTES, 60);
  return Math.max(5, Math.min(24 * 60, mins)) * 60; // clamp 5 min … 24 h
}

function disconnectAfterApply(env) {
  const v = String(env.DISCONNECT_AFTER_APPLY ?? "true").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/api/health") {
        return json({
          ok: true,
          service: "xpro-howtomovetheneedle",
          origin: publicOrigin(env),
          session_ttl_minutes: Math.round(sessionTtlSec(env) / 60),
          disconnect_after_apply: disconnectAfterApply(env),
        });
      }

      if (path.startsWith("/api/")) {
        return handleApi(request, env, url, ctx);
      }

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: err.message || "Server error" }, 500);
    }
  },
};

/* ───────────────────── API router ───────────────────── */

async function handleApi(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/api/pool" && method === "GET") {
    return json(await getPoolStatus(env));
  }

  if (path === "/api/me" && method === "GET") {
    const user = await sessionUser(request, env);
    if (!user) {
      return json({
        ok: false,
        user: null,
        session_ttl_minutes: Math.round(sessionTtlSec(env) / 60),
        disconnect_after_apply: disconnectAfterApply(env),
      });
    }
    const pool = await getPoolStatus(env);
    const freeUsed = await userFreeRunsToday(env, user.id);
    return json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar_url: user.avatar_url,
      },
      pool,
      free_remaining_for_user: Math.max(
        0,
        num(env.FREE_PER_USER_PER_DAY, 1) - freeUsed
      ),
      session_expires_at: user.expires_at || null,
      session_ttl_minutes: Math.round(sessionTtlSec(env) / 60),
      disconnect_after_apply: disconnectAfterApply(env),
      has_xai_key: !!(await env.DB.prepare(
        "SELECT 1 FROM user_keys WHERE user_id = ? AND xai_api_key_enc IS NOT NULL"
      )
        .bind(user.id)
        .first()),
    });
  }

  if (path === "/api/auth/x/start" && method === "GET") {
    return startXAuth(request, env, url);
  }

  if (path === "/api/auth/x/callback" && method === "GET") {
    return callbackXAuth(request, env, url);
  }

  if (path === "/api/auth/logout" && method === "POST") {
    return logout(request, env);
  }

  if (path === "/api/keys/xai" && method === "POST") {
    const user = await requireUser(request, env);
    if (user instanceof Response) return user;
    const body = await request.json().catch(() => ({}));
    const key = String(body.key || "").trim();
    if (!key) {
      await env.DB.prepare("DELETE FROM user_keys WHERE user_id = ?")
        .bind(user.id)
        .run();
      return json({ ok: true, cleared: true });
    }
    const enc = await encrypt(env, key);
    const now = iso();
    await env.DB.prepare(
      `INSERT INTO user_keys (user_id, xai_api_key_enc, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET xai_api_key_enc = excluded.xai_api_key_enc, updated_at = excluded.updated_at`
    )
      .bind(user.id, enc, now)
      .run();
    return json({ ok: true });
  }

  if (path === "/api/runs" && method === "POST") {
    return createRun(request, env, ctx);
  }

  if (path.startsWith("/api/runs/") && method === "GET") {
    const id = path.slice("/api/runs/".length).split("/")[0];
    return getRun(request, env, id);
  }

  if (path.match(/^\/api\/runs\/[^/]+\/apply$/) && method === "POST") {
    const id = path.split("/")[3];
    return applyRun(request, env, id);
  }

  if (path === "/api/demo/analyze" && method === "POST") {
    // Offline demo: paste signal JSON, get proposal (no X write)
    const body = await request.json().catch(() => ({}));
    const quiz = body.quiz || {};
    const weights = normalizeWeights(body.weights || quiz.weights);
    const proposal = analyzeSignals(body.signals || body, quiz, weights);
    return json({ ok: true, proposal });
  }

  return json({ error: "Not found" }, 404);
}

/* ───────────────────── Free pool ───────────────────── */

function dayKeyUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function ensurePoolDay(env, day = dayKeyUTC()) {
  const row = await env.DB.prepare(
    "SELECT day_key, unlock_at, used_count FROM daily_free_pool WHERE day_key = ?"
  )
    .bind(day)
    .first();
  if (row) return row;

  const secret = env.DAILY_POOL_SECRET || env.SESSION_SECRET || "dev-pool";
  const offset = await hmacMod(secret, day, 86400);
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const unlock_at = new Date(dayStart + offset * 1000).toISOString();

  await env.DB.prepare(
    "INSERT OR IGNORE INTO daily_free_pool (day_key, unlock_at, used_count) VALUES (?, ?, 0)"
  )
    .bind(day, unlock_at)
    .run();

  return (
    (await env.DB.prepare(
      "SELECT day_key, unlock_at, used_count FROM daily_free_pool WHERE day_key = ?"
    )
      .bind(day)
      .first()) || { day_key: day, unlock_at, used_count: 0 }
  );
}

async function getPoolStatus(env) {
  const day = dayKeyUTC();
  const row = await ensurePoolDay(env, day);
  const max = num(env.FREE_RUNS_PER_DAY, 10);
  const used = Number(row.used_count || 0);
  const now = Date.now();
  const unlockMs = Date.parse(row.unlock_at);
  const unlocked = now >= unlockMs;
  const remaining = Math.max(0, max - used);
  return {
    day_key: day,
    unlock_at: row.unlock_at,
    unlocked,
    seconds_until_unlock: unlocked ? 0 : Math.max(0, Math.floor((unlockMs - now) / 1000)),
    used,
    max,
    remaining: unlocked ? remaining : 0,
    host_create_enabled: unlocked && remaining > 0,
  };
}

async function userFreeRunsToday(env, userId) {
  const day = dayKeyUTC();
  const start = `${day}T00:00:00.000Z`;
  const end = `${day}T23:59:59.999Z`;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM runs
     WHERE user_id = ? AND paid_by = 'host'
       AND created_at >= ? AND created_at <= ?`
  )
    .bind(userId, start, end)
    .first();
  return Number(row?.c || 0);
}

async function tryClaimFreeSlot(env, userId) {
  const pool = await getPoolStatus(env);
  if (!pool.host_create_enabled) {
    return { ok: false, reason: "pool_locked_or_empty", pool };
  }
  const perUser = num(env.FREE_PER_USER_PER_DAY, 1);
  const used = await userFreeRunsToday(env, userId);
  if (used >= perUser) {
    return { ok: false, reason: "user_free_exhausted", pool };
  }
  // Atomic-ish increment with guard
  const res = await env.DB.prepare(
    `UPDATE daily_free_pool SET used_count = used_count + 1
     WHERE day_key = ? AND used_count < ?`
  )
    .bind(pool.day_key, pool.max)
    .run();
  if (!res.meta?.changes) {
    return { ok: false, reason: "pool_race_empty", pool: await getPoolStatus(env) };
  }
  return { ok: true, pool: await getPoolStatus(env) };
}

/* ───────────────────── Auth / session ───────────────────── */

async function startXAuth(request, env, url) {
  if (!env.X_CLIENT_ID) {
    return json(
      {
        error:
          "X_CLIENT_ID not configured. Set wrangler secrets for X OAuth (see README).",
      },
      503
    );
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  );
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = `${publicOrigin(env)}/api/auth/x/callback`;

  // Store PKCE in short-lived cookie (signed-ish blob)
  const pkce = await seal(env, { verifier, state, exp: Date.now() + 15 * 60 * 1000 });

  const authUrl = new URL(X_AUTH);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.X_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirect);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers({ Location: authUrl.toString() });
  headers.append(
    "Set-Cookie",
    `xpro_pkce=${pkce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`
  );
  return new Response(null, { status: 302, headers });
}

async function callbackXAuth(request, env, url) {
  const err = url.searchParams.get("error");
  if (err) {
    return Response.redirect(
      `${publicOrigin(env)}/?error=${encodeURIComponent(err)}`,
      302
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("Cookie"));
  const pkce = cookies.xpro_pkce ? await unseal(env, cookies.xpro_pkce) : null;
  if (!code || !pkce || pkce.state !== state || Date.now() > pkce.exp) {
    return Response.redirect(`${publicOrigin(env)}/?error=auth_state`, 302);
  }

  const redirect = `${publicOrigin(env)}/api/auth/x/callback`;
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirect,
    code_verifier: pkce.verifier,
  });

  const basic = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET || ""}`);
  const tokRes = await fetch(X_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const tok = await tokRes.json();
  if (!tok.access_token) {
    console.error("token error", tok);
    return Response.redirect(`${publicOrigin(env)}/?error=token`, 302);
  }

  const meRes = await fetch(
    `${X_API}/users/me?user.fields=profile_image_url,name,username`,
    { headers: { Authorization: `Bearer ${tok.access_token}` } }
  );
  const me = await meRes.json();
  const u = me.data;
  if (!u?.id) {
    return Response.redirect(`${publicOrigin(env)}/?error=me`, 302);
  }

  const now = iso();
  const userId = await upsertUser(env, u, now);
  const accessEnc = await encrypt(env, tok.access_token);
  // Intentionally do not store refresh tokens — short visits only
  const refreshEnc = null;
  const expiresAt = tok.expires_in
    ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
    : null;

  await env.DB.prepare(
    `INSERT INTO x_tokens (user_id, access_token_enc, refresh_token_enc, expires_at, scope, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       updated_at = excluded.updated_at`
  )
    .bind(userId, accessEnc, refreshEnc, expiresAt, tok.scope || SCOPES, now)
    .run();

  // Drop any older sessions for this user (single short-lived connection)
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
    .bind(userId)
    .run();

  const ttl = sessionTtlSec(env);
  const sessionTok = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const sessExp = new Date(Date.now() + ttl * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(sessionTok, userId, sessExp, now)
    .run();

  const headers = new Headers({
    Location: `${publicOrigin(env)}/app.html`,
  });
  headers.append(
    "Set-Cookie",
    `${COOKIE}=${sessionTok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`
  );
  headers.append(
    "Set-Cookie",
    "xpro_pkce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
  return new Response(null, { status: 302, headers });
}

/** End session and delete stored X tokens for that user. */
async function wipeUserAuth(env, userId, sessionToken = null) {
  if (sessionToken) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?")
      .bind(sessionToken)
      .run();
  }
  if (userId) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
      .bind(userId)
      .run();
    await env.DB.prepare("DELETE FROM x_tokens WHERE user_id = ?")
      .bind(userId)
      .run();
  }
}

async function logout(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const tok = cookies[COOKIE];
  let userId = null;
  if (tok) {
    const row = await env.DB.prepare(
      "SELECT user_id FROM sessions WHERE token = ?"
    )
      .bind(tok)
      .first();
    userId = row?.user_id || null;
    await wipeUserAuth(env, userId, tok);
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.append(
    "Set-Cookie",
    `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  return new Response(
    JSON.stringify({ ok: true, wiped_tokens: !!userId }),
    { headers }
  );
}

async function upsertUser(env, u, now) {
  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE x_user_id = ?"
  )
    .bind(u.id)
    .first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE users SET username = ?, name = ?, avatar_url = ?, last_login_at = ?
       WHERE id = ?`
    )
      .bind(u.username, u.name || null, u.profile_image_url || null, now, existing.id)
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, x_user_id, username, name, avatar_url, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      u.id,
      u.username,
      u.name || null,
      u.profile_image_url || null,
      now,
      now
    )
    .run();
  return id;
}

async function sessionUser(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const tok = cookies[COOKIE];
  if (!tok) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.id, u.x_user_id, u.username, u.name, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  )
    .bind(tok)
    .first();
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    // Session over — drop cookie row and any stored X tokens for this user
    await wipeUserAuth(env, row.user_id, tok);
    return null;
  }
  return row;
}

async function requireUser(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ error: "Unauthorized" }, 401);
  return user;
}

/* ───────────────────── Runs ───────────────────── */

async function createRun(request, env, ctx) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;

  if (!env.X_CLIENT_ID) {
    return json({ error: "X OAuth not configured on this host." }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const weights = normalizeWeights(body.weights);
  const quiz = {
    q1: String(body.q1 || body.north_star || "").slice(0, 500),
    q2: String(body.q2 || body.who || "").slice(0, 500),
    chip: String(body.chip || "").slice(0, 80),
    weights,
  };

  const claim = await tryClaimFreeSlot(env, user.id);
  if (!claim.ok) {
    return json(
      {
        error: "free_pool_unavailable",
        reason: claim.reason,
        pool: claim.pool,
        message:
          claim.reason === "user_free_exhausted"
            ? "You already used today’s free build. Come back after tomorrow’s random unlock, self-host, or paste an xAI key for analysis-only."
            : "Free pool is locked or empty. It unlocks at a random time each day (10 host-paid builds).",
      },
      402
    );
  }

  const id = crypto.randomUUID();
  const now = iso();
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, status, paid_by, quiz_json, created_at, updated_at)
     VALUES (?, ?, 'scanning', 'host', ?, ?, ?)`
  )
    .bind(id, user.id, JSON.stringify(quiz), now, now)
    .run();

  // Process inline (Workers: keep under CPU limits; lean caps)
  try {
    await processRun(env, id, user, quiz);
  } catch (e) {
    console.error(e);
    await env.DB.prepare(
      "UPDATE runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
    )
      .bind(String(e.message || e).slice(0, 500), iso(), id)
      .run();
  }

  return getRun(request, env, id);
}

async function getRun(request, env, id) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const row = await env.DB.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  return json({
    ok: true,
    run: {
      id: row.id,
      status: row.status,
      paid_by: row.paid_by,
      quiz: safeJson(row.quiz_json),
      taste: safeJson(row.taste_json),
      proposal: safeJson(row.proposal_json),
      result: safeJson(row.result_json),
      bookmarks_scanned: row.bookmarks_scanned,
      likes_scanned: row.likes_scanned,
      follows_scanned: row.follows_scanned,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  });
}

async function applyRun(request, env, id) {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;

  const row = await env.DB.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  if (row.paid_by !== "host") {
    return json(
      {
        error: "host_create_only_on_free",
        message:
          "One-click create uses the host free pool. Self-host for unlimited creates, or wait for tomorrow’s free drop.",
      },
      402
    );
  }
  if (row.status === "done") {
    return json({ ok: true, result: safeJson(row.result_json) });
  }

  let proposal = safeJson(row.proposal_json);
  const body = await request.json().catch(() => ({}));
  if (body.proposal) proposal = body.proposal;
  if (!proposal?.lists?.length) return json({ error: "No proposal" }, 400);

  await env.DB.prepare(
    "UPDATE runs SET status = 'applying', proposal_json = ?, updated_at = ? WHERE id = ?"
  )
    .bind(JSON.stringify(proposal), iso(), id)
    .run();

  try {
    const token = await getAccessToken(env, user.id);
    const created = [];
    for (const list of proposal.lists.slice(0, num(env.MAX_LISTS, 3))) {
      // Always stamp X Pro brand so lists are findable in a crowded Lists drawer
      const name = ensureBrandedName(list.name);
      const description = ensureBrandedDesc(list.description);
      const createRes = await xFetch(
        env,
        token,
        "/lists",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            description,
            private: list.private !== false,
          }),
        },
        user.id
      );
      const listId = createRes?.data?.id;
      if (!listId) {
        created.push({ name, error: createRes?.errors || createRes });
        continue;
      }
      let members = 0;
      const maxM = num(env.MAX_MEMBERS_PER_LIST, 15);
      for (const m of (list.members || []).slice(0, maxM)) {
        const uid = m.user_id || m.id;
        if (!uid) continue;
        try {
          await xFetch(
            env,
            token,
            `/lists/${listId}/members`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ user_id: String(uid) }),
            },
            user.id
          );
          members++;
        } catch (e) {
          /* skip member errors */
        }
      }
      const recId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO created_lists (id, run_id, user_id, x_list_id, name, member_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(recId, id, user.id, listId, name, members, iso())
        .run();
      created.push({
        name,
        x_list_id: listId,
        url: `https://x.com/i/lists/${listId}`,
        // Same List object Pro loads as a column (Add column → Lists)
        pro_hint: "https://pro.x.com",
        member_count: members,
      });
    }

    const quiz = safeJson(row.quiz_json) || {};
    const proposalDeck = proposal.deck || {};
    const deckName =
      proposalDeck.name ||
      proposal.taste?.deck_name ||
      buildDeckName(quiz);

    const result = {
      lists: created,
      deck: {
        name: deckName,
        url: "https://pro.x.com",
        api_supported: false,
        columns: created
          .filter((L) => L.x_list_id)
          .map((L) => ({
            type: "list",
            title: L.name,
            x_list_id: L.x_list_id,
            url: L.url,
          })),
        steps: [
          `Open pro.x.com`,
          `Create a new deck — name it exactly “${deckName}”`,
          `Add column → Lists`,
          `Add each XP · list as its own column`,
        ],
      },
      pro: {
        url: "https://pro.x.com",
        steps: [
          `Create a new deck named “${deckName}”`,
          "Add column → Lists for each XP · list",
        ],
      },
    };
    await env.DB.prepare(
      "UPDATE runs SET status = 'done', result_json = ?, updated_at = ? WHERE id = ?"
    )
      .bind(JSON.stringify(result), iso(), id)
      .run();

    // Host liability: drop X tokens after lists are created (session cookie cleared in response)
    let disconnected = false;
    const headers = {};
    if (disconnectAfterApply(env)) {
      await wipeUserAuth(env, user.id);
      disconnected = true;
      headers["Set-Cookie"] =
        `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    }

    return json(
      {
        ok: true,
        result,
        disconnected,
        message: disconnected
          ? "Lists created. X connection cleared from this host — finish the Pro deck without staying logged in here."
          : undefined,
      },
      200,
      headers
    );
  } catch (e) {
    await env.DB.prepare(
      "UPDATE runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
    )
      .bind(String(e.message || e).slice(0, 500), iso(), id)
      .run();
    return json({ error: e.message || "apply failed" }, 500);
  }
}

async function processRun(env, runId, user, quiz) {
  const token = await getAccessToken(env, user.id);
  const maxBm = num(env.MAX_BOOKMARKS, 100);
  const maxLikes = num(env.MAX_LIKES, 50);
  const maxFollows = num(env.MAX_FOLLOWS, 25);

  const xUserId = user.x_user_id;

  const bookmarks = await fetchBookmarks(env, token, xUserId, maxBm, user.id);
  await env.DB.prepare(
    "UPDATE runs SET bookmarks_scanned = ?, updated_at = ? WHERE id = ?"
  )
    .bind(bookmarks.posts.length, iso(), runId)
    .run();

  const likes = await fetchLiked(env, token, xUserId, maxLikes, user.id);
  await env.DB.prepare(
    "UPDATE runs SET likes_scanned = ?, updated_at = ? WHERE id = ?"
  )
    .bind(likes.posts.length, iso(), runId)
    .run();

  const follows = await fetchFollowing(env, token, xUserId, maxFollows, user.id);
  await env.DB.prepare(
    "UPDATE runs SET follows_scanned = ?, status = 'analyzing', updated_at = ? WHERE id = ?"
  )
    .bind(follows.users.length, iso(), runId)
    .run();

  let replies = { counts: {} };
  try {
    replies = await fetchReplyTargets(env, token, xUserId, 50, user.id);
  } catch (e) {
    console.error("reply scan", e);
  }

  // Outbound DMs only (sender_id === you). Inbound spam is ignored.
  let dms = { counts: {}, users: {}, events_scanned: 0, note: null };
  try {
    dms = await fetchOutboundDmTargets(
      env,
      token,
      xUserId,
      num(env.MAX_DM_EVENTS, 100),
      user.id
    );
  } catch (e) {
    console.error("dm scan", e);
    dms.note = String(e.message || e).slice(0, 200);
  }

  const signals = {
    bookmarks: bookmarks.posts,
    likes: likes.posts,
    follows: follows.users,
    reply_counts: replies.counts,
    dm_counts: dms.counts,
    dm_meta: {
      events_scanned: dms.events_scanned,
      note: dms.note,
      window: "up to ~30 days (X API retention)",
      filter: "outbound_only_1to1",
    },
    users: {
      ...bookmarks.users,
      ...likes.users,
      ...follows.userMap,
      ...replies.users,
      ...dms.users,
    },
  };

  const weights = normalizeWeights(quiz?.weights);
  let proposal = analyzeSignals(signals, quiz, weights);

  // Optional host Grok rename pass
  if (env.XAI_API_KEY) {
    try {
      proposal = await polishWithGrok(env.XAI_API_KEY, proposal, quiz);
    } catch (e) {
      console.error("grok polish", e);
    }
  }

  await env.DB.prepare(
    `UPDATE runs SET status = 'ready', taste_json = ?, proposal_json = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      JSON.stringify(proposal.taste || {}),
      JSON.stringify(proposal),
      iso(),
      runId
    )
    .run();
}

/* ───────────────────── X API helpers ───────────────────── */

async function getAccessToken(env, userId) {
  const row = await env.DB.prepare(
    "SELECT access_token_enc, refresh_token_enc, expires_at FROM x_tokens WHERE user_id = ?"
  )
    .bind(userId)
    .first();
  if (!row) throw new Error("No X token — reconnect.");
  let access = await decrypt(env, row.access_token_enc);
  if (row.expires_at && Date.parse(row.expires_at) < Date.now() + 60_000) {
    if (row.refresh_token_enc) {
      access = await refreshToken(env, userId, await decrypt(env, row.refresh_token_enc));
    }
  }
  return access;
}

async function refreshToken(env, userId, refresh) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: env.X_CLIENT_ID,
  });
  const basic = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET || ""}`);
  const res = await fetch(X_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error("Token refresh failed — reconnect X.");
  const now = iso();
  await env.DB.prepare(
    `UPDATE x_tokens SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
     expires_at = ?, updated_at = ? WHERE user_id = ?`
  )
    .bind(
      await encrypt(env, tok.access_token),
      tok.refresh_token ? await encrypt(env, tok.refresh_token) : null,
      tok.expires_in
        ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
        : null,
      now,
      userId
    )
    .run();
  return tok.access_token;
}

async function xFetch(env, token, path, init = {}, userId = null) {
  const url = path.startsWith("http") ? path : `${X_API}${path}`;
  let res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (res.status === 401 && userId) {
    const row = await env.DB.prepare(
      "SELECT refresh_token_enc FROM x_tokens WHERE user_id = ?"
    )
      .bind(userId)
      .first();
    if (row?.refresh_token_enc) {
      const access = await refreshToken(
        env,
        userId,
        await decrypt(env, row.refresh_token_enc)
      );
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${access}`,
          ...(init.headers || {}),
        },
      });
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.detail ||
      data?.title ||
      data?.errors?.[0]?.message ||
      `X API ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function fetchBookmarks(env, token, xUserId, max, userId) {
  const posts = [];
  const users = {};
  let tokenNext = null;
  while (posts.length < max) {
    const n = Math.min(100, max - posts.length);
    let path = `/users/${xUserId}/bookmarks?max_results=${n}&tweet.fields=created_at,public_metrics,entities,author_id&expansions=author_id&user.fields=username,name,description,public_metrics,profile_image_url`;
    if (tokenNext) path += `&pagination_token=${tokenNext}`;
    const data = await xFetch(env, token, path, {}, userId);
    for (const t of data.data || []) posts.push(t);
    for (const u of data.includes?.users || []) users[u.id] = u;
    tokenNext = data.meta?.next_token;
    if (!tokenNext || !(data.data || []).length) break;
  }
  return { posts, users };
}

async function fetchLiked(env, token, xUserId, max, userId) {
  const posts = [];
  const users = {};
  let tokenNext = null;
  while (posts.length < max) {
    const n = Math.min(100, max - posts.length);
    let path = `/users/${xUserId}/liked_tweets?max_results=${n}&tweet.fields=created_at,public_metrics,entities,author_id&expansions=author_id&user.fields=username,name,description,public_metrics,profile_image_url`;
    if (tokenNext) path += `&pagination_token=${tokenNext}`;
    const data = await xFetch(env, token, path, {}, userId);
    for (const t of data.data || []) posts.push(t);
    for (const u of data.includes?.users || []) users[u.id] = u;
    tokenNext = data.meta?.next_token;
    if (!tokenNext || !(data.data || []).length) break;
  }
  return { posts, users };
}

async function fetchFollowing(env, token, xUserId, max, userId) {
  const users = [];
  const userMap = {};
  let tokenNext = null;
  while (users.length < max) {
    const n = Math.min(100, max - users.length);
    let path = `/users/${xUserId}/following?max_results=${n}&user.fields=username,name,description,public_metrics,profile_image_url`;
    if (tokenNext) path += `&pagination_token=${tokenNext}`;
    const data = await xFetch(env, token, path, {}, userId);
    for (const u of data.data || []) {
      users.push(u);
      userMap[u.id] = u;
    }
    tokenNext = data.meta?.next_token;
    if (!tokenNext || !(data.data || []).length) break;
  }
  return { users, userMap };
}

async function fetchReplyTargets(env, token, xUserId, maxPosts, userId) {
  const counts = {};
  const users = {};
  let path = `/users/${xUserId}/tweets?max_results=${Math.min(
    100,
    maxPosts
  )}&tweet.fields=created_at,in_reply_to_user_id,referenced_tweets,entities&exclude=retweets`;
  const data = await xFetch(env, token, path, {}, userId);
  for (const t of data.data || []) {
    if (t.in_reply_to_user_id) {
      counts[t.in_reply_to_user_id] = (counts[t.in_reply_to_user_id] || 0) + 1;
    }
    for (const m of t.entities?.mentions || []) {
      if (m.id) counts[m.id] = (counts[m.id] || 0) + 0.5;
    }
  }
  // hydrate top reply targets
  const topIds = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([id]) => id);
  if (topIds.length) {
    try {
      const q = `/users?ids=${topIds.join(
        ","
      )}&user.fields=username,name,description,public_metrics,profile_image_url`;
      const udata = await xFetch(env, token, q, {}, userId);
      for (const u of udata.data || []) users[u.id] = u;
    } catch (e) {
      /* ignore */
    }
  }
  return { counts, users };
}

/**
 * People the authenticated user has messaged (outbound only).
 * - MessageCreate events where sender_id === you
 * - 1:1 conversations only (skip groups)
 * - Never adds someone solely because they DMed you (spam filter)
 * X API retains ~30 days of DM events.
 */
async function fetchOutboundDmTargets(env, token, xUserId, maxEvents, userId) {
  const me = String(xUserId);
  const counts = {};
  const users = {};
  let events_scanned = 0;
  let tokenNext = null;
  const cap = Math.max(10, Math.min(200, maxEvents || 100));

  while (events_scanned < cap) {
    const n = Math.min(100, cap - events_scanned);
    let path =
      `/dm_events?max_results=${n}` +
      `&event_types=MessageCreate` +
      `&dm_event.fields=id,event_type,sender_id,participant_ids,dm_conversation_id,created_at` +
      `&expansions=sender_id,participant_ids` +
      `&user.fields=username,name,description,public_metrics,profile_image_url`;
    if (tokenNext) path += `&pagination_token=${encodeURIComponent(tokenNext)}`;

    const data = await xFetch(env, token, path, {}, userId);
    for (const u of data.includes?.users || []) users[u.id] = u;

    const batch = data.data || [];
    if (!batch.length) break;
    events_scanned += batch.length;

    for (const ev of batch) {
      if (ev.event_type && ev.event_type !== "MessageCreate") continue;
      if (String(ev.sender_id) !== me) continue; // outbound only — skip inbound spam

      let parts = (ev.participant_ids || []).map(String).filter(Boolean);
      // Prefer strict 1:1 so group chats don't pollute the list
      if (parts.length > 2) continue;
      if (parts.length < 2 && ev.dm_conversation_id) {
        // Some payloads omit participants; conversation id is often "id1-id2"
        const bits = String(ev.dm_conversation_id).split(/[-_]/);
        if (bits.length === 2 && bits.every((b) => /^\d+$/.test(b))) {
          parts = bits;
        }
      }
      if (parts.length !== 2) continue;
      if (!parts.includes(me)) continue;

      const other = parts.find((id) => id !== me);
      if (!other || other === me) continue;
      counts[other] = (counts[other] || 0) + 1;
    }

    tokenNext = data.meta?.next_token;
    if (!tokenNext) break;
  }

  // Hydrate any missing usernames for top targets
  const need = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => !users[id])
    .slice(0, 25);
  if (need.length) {
    try {
      const udata = await xFetch(
        env,
        token,
        `/users?ids=${need.join(
          ","
        )}&user.fields=username,name,description,public_metrics,profile_image_url`,
        {},
        userId
      );
      for (const u of udata.data || []) users[u.id] = u;
    } catch (e) {
      /* ignore */
    }
  }

  return { counts, users, events_scanned };
}

/* ───────────────────── Analyzer ───────────────────── */

/** UI sliders are 0–100; defaults match public/app.js */
const DEFAULT_WEIGHTS = {
  bookmark: 75,
  like: 40,
  follow: 50,
  reply: 90,
  dm: 85,
};

/** Base per-signal scores before slider multipliers (slider 100 = 1× base). */
const BASE_SIGNAL = { bookmark: 3, like: 1.5, follow: 2, reply: 4, dm: 5 };

function normalizeWeights(raw) {
  const w = raw && typeof raw === "object" ? raw : {};
  const clamp = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, n));
  };
  return {
    bookmark: clamp(w.bookmark, DEFAULT_WEIGHTS.bookmark),
    like: clamp(w.like, DEFAULT_WEIGHTS.like),
    follow: clamp(w.follow, DEFAULT_WEIGHTS.follow),
    reply: clamp(w.reply, DEFAULT_WEIGHTS.reply),
    dm: clamp(w.dm, DEFAULT_WEIGHTS.dm),
  };
}

/** Map 0–100 slider → score multiplier (0 = ignore signal, 100 = full base weight). */
function weightMul(slider0to100) {
  return Math.max(0, Math.min(100, Number(slider0to100) || 0)) / 100;
}

function analyzeSignals(signals, quiz = {}, weightsIn = {}) {
  const weights = normalizeWeights(
    weightsIn?.bookmark != null || weightsIn?.like != null
      ? weightsIn
      : quiz?.weights || weightsIn
  );
  const mul = {
    bookmark: weightMul(weights.bookmark),
    like: weightMul(weights.like),
    follow: weightMul(weights.follow),
    reply: weightMul(weights.reply),
    dm: weightMul(weights.dm),
  };

  const scores = new Map(); // id -> { score, bookmark, like, follow, reply, dm, ... }

  function bump(id, field, w, userHint) {
    if (!id) return;
    let e = scores.get(id);
    if (!e) {
      e = {
        user_id: id,
        score: 0,
        bookmark: 0,
        like: 0,
        follow: 0,
        reply: 0,
        dm: 0,
        username: userHint?.username,
        name: userHint?.name,
        description: userHint?.description || "",
      };
      scores.set(id, e);
    }
    e[field] = (e[field] || 0) + 1;
    e.score += w;
    if (userHint?.username) e.username = userHint.username;
    if (userHint?.name) e.name = userHint.name;
    if (userHint?.description) e.description = userHint.description;
  }

  const umap = signals.users || {};

  for (const t of signals.bookmarks || []) {
    const u = umap[t.author_id];
    bump(t.author_id, "bookmark", BASE_SIGNAL.bookmark * mul.bookmark, u);
  }
  for (const t of signals.likes || []) {
    const u = umap[t.author_id];
    bump(t.author_id, "like", BASE_SIGNAL.like * mul.like, u);
  }
  for (const u of signals.follows || []) {
    bump(u.id, "follow", BASE_SIGNAL.follow * mul.follow, u);
  }
  for (const [id, c] of Object.entries(signals.reply_counts || {})) {
    bump(id, "reply", BASE_SIGNAL.reply * Number(c) * mul.reply, umap[id]);
  }
  // Outbound DM targets only (already filtered in fetch)
  for (const [id, c] of Object.entries(signals.dm_counts || {})) {
    const n = Number(c) || 0;
    if (n <= 0) continue;
    // One score contribution per person, scaled by how often you messaged them
    bump(id, "dm", BASE_SIGNAL.dm * Math.min(n, 10) * mul.dm, umap[id]);
    // Keep true message count on the row for reasons
    const e = scores.get(id);
    if (e) e.dm = n;
  }

  // quiz boost: simple keyword overlap with bio
  const qtext = `${quiz.q1 || ""} ${quiz.q2 || ""} ${quiz.chip || ""}`.toLowerCase();
  const qTokens = qtext
    .split(/[^a-z0-9#+]+/)
    .filter((t) => t.length > 3)
    .slice(0, 20);
  if (qTokens.length) {
    for (const e of scores.values()) {
      const hay = `${e.username || ""} ${e.name || ""} ${e.description || ""}`.toLowerCase();
      let hits = 0;
      for (const t of qTokens) if (hay.includes(t)) hits++;
      if (hits) {
        e.score += hits * 2;
        e.quiz_hits = hits;
      }
    }
  }

  const ranked = [...scores.values()]
    .filter((e) => e.username || e.user_id)
    .sort((a, b) => b.score - a.score);

  const topAuthors = ranked.slice(0, 12).map((e) => ({
    username: e.username || e.user_id,
    count: e.bookmark + e.like,
    score: Math.round(e.score * 10) / 10,
  }));

  // Build lists (skip categories when that slider is 0)
  const core = ranked
    .filter((e) => (mul.bookmark > 0 && e.bookmark >= 1) || e.score >= 6)
    .slice(0, 15);
  const talk =
    mul.reply > 0 ? ranked.filter((e) => e.reply > 0).slice(0, 15) : [];
  const fresh =
    mul.follow > 0 ? ranked.filter((e) => e.follow > 0).slice(0, 15) : [];
  const messaged =
    mul.dm > 0 ? ranked.filter((e) => e.dm > 0).slice(0, 15) : [];

  // Theme bag from bookmarks+likes text
  const tags = {};
  for (const t of [...(signals.bookmarks || []), ...(signals.likes || [])]) {
    for (const h of t.entities?.hashtags || []) {
      const tag = (h.tag || "").toLowerCase();
      if (tag) tags[tag] = (tags[tag] || 0) + 1;
    }
  }
  const topTags = Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);

  // Signal-based starter lists (no quiz) — clear Pro column names
  const coreLabel = "Bookmarks";
  const talkLabel = "Conversations";
  const followLabel = (() => {
    const tag = topTags[0] || "";
    if (tag.length >= 4 && tag.length <= 12) return `#${tag} follows`;
    return "Recent follows";
  })();

  // Order: bookmarks → outbound DMs → replies → follows (DM list keeps people you messaged)
  const lists = [];
  if (core.length) {
    lists.push({
      key: "core",
      name: brandListName(coreLabel),
      description: brandListDesc(
        "Starter column · accounts from saves & strong signals"
      ),
      private: true,
      members: core.map(memberRow),
    });
  }
  if (messaged.length) {
    lists.push({
      key: "dms",
      name: brandListName("You messaged"),
      description: brandListDesc(
        "People you DMed (outbound only · not inbound spam · ~30 days)"
      ),
      private: true,
      members: messaged.map(memberRow),
    });
  }
  if (talk.length) {
    lists.push({
      key: "replies",
      name: brandListName(talkLabel),
      description: brandListDesc(
        "Starter column · accounts you reply to most"
      ),
      private: true,
      members: talk.map(memberRow),
    });
  }
  if (fresh.length) {
    lists.push({
      key: "follows",
      name: brandListName(followLabel),
      description: brandListDesc(
        "Starter column · recent follows"
      ),
      private: true,
      members: fresh.map(memberRow),
    });
  }

  // Dedup members across lists preference: keep first list membership only for display diversity
  const seen = new Set();
  for (const L of lists) {
    L.members = L.members.filter((m) => {
      if (seen.has(m.user_id)) return false;
      seen.add(m.user_id);
      return true;
    });
  }
  // Drop empty lists after dedup so we don't create hollow shells on X
  for (let i = lists.length - 1; i >= 0; i--) {
    if (!lists[i].members?.length) lists.splice(i, 1);
  }

  const deckName = buildDeckName(quiz);
  const deck = {
    name: deckName,
    // X Pro has no public API to create decks/columns — Lists *are* the columns.
    // User creates a new deck in Pro with this name, then adds each list as a column.
    api_supported: false,
    columns: lists.map((L) => ({
      type: "list",
      key: L.key,
      title: L.name,
      source: "owned_list",
    })),
    how_to: [
      `Open pro.x.com`,
      `Create a new deck named “${deckName}”`,
      `Add column → Lists for each XP · list below`,
    ],
  };

  // Stamp deck name into each list description so columns stay recognizable as one board
  for (const L of lists) {
    if (!/Deck:/i.test(L.description || "")) {
      L.description = brandListDesc(
        `Deck: ${shortLabel(deckName, 28)} · ${(L.description || "").replace(
          /\s*·\s*X Pro Guideposts\s*$/i,
          ""
        )}`
      );
    }
  }

  const taste = {
    summary: buildSummary(topAuthors, topTags, weights),
    top_authors: topAuthors,
    top_topics: topTags,
    quiz,
    weights,
    deck_name: deckName,
  };

  return { taste, lists, weights, deck };
}

/** Human name for the Pro deck the user will create (not creatable via API). */
function buildDeckName(quiz = {}) {
  const chip = shortLabel(quiz.chip || quiz.q2 || quiz.q1 || "", 16);
  return `XP · ${chip || "Pro starter"}`.slice(0, 40);
}

function memberRow(e) {
  const bits = [];
  if (e.bookmark) bits.push(`${e.bookmark} bookmark${e.bookmark > 1 ? "s" : ""}`);
  if (e.like) bits.push(`${e.like} like${e.like > 1 ? "s" : ""}`);
  if (e.follow) bits.push("recent follow");
  if (e.reply) bits.push("you reply");
  if (e.dm)
    bits.push(
      `you messaged${e.dm > 1 ? ` (${e.dm}×)` : ""}`
    );
  if (e.quiz_hits) bits.push("matches your words");
  return {
    user_id: e.user_id,
    username: e.username,
    name: e.name,
    reason: bits.join(" · ") || "signal",
    score: Math.round(e.score * 10) / 10,
  };
}

function buildSummary(topAuthors, topTags, weights = {}) {
  const names = topAuthors
    .slice(0, 3)
    .map((a) => "@" + a.username)
    .join(", ");
  const topics = topTags.slice(0, 3).join(", ");
  const parts = [];
  if (weights.bookmark > 0) parts.push("bookmarks");
  if (weights.like > 0) parts.push("likes");
  if (weights.follow > 0) parts.push("follows");
  if (weights.reply > 0) parts.push("replies");
  if (weights.dm > 0) parts.push("outbound DMs");
  let s = `Starter lists ranked from ${parts.join(", ") || "your X signals"}.`;
  if (names) s += ` Strong signals around ${names}.`;
  if (topics) s += ` Topics: ${topics}.`;
  s += " Pin each list as a column in a new pro.x.com deck.";
  return s;
}

/** X list name max 25 chars. Brand prefix so Pro users can spot our lists. */
const LIST_NAME_MAX = 25;
const BRAND_PREFIX = "XP · "; // 5 chars → 20 for the human label
const BRAND_STAMP = " · X Pro Guideposts"; // description footer

function shortLabel(text, max) {
  text = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  const words = text.split(" ");
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  // Avoid hanging prepositions when we truncated mid-phrase
  out = out
    .replace(/\b(from|for|to|of|the|a|an|and|with|who|that)\s*$/i, "")
    .trim();
  return out || text.slice(0, max).trim();
}

function sliceName(s) {
  return shortLabel(s, LIST_NAME_MAX) || "Guideposts";
}

/** "XP · Baseball scores" — always branded, always ≤ 25. */
function brandListName(label) {
  const maxLabel = LIST_NAME_MAX - BRAND_PREFIX.length;
  const body = shortLabel(label, maxLabel) || "Guideposts";
  return (BRAND_PREFIX + body).slice(0, LIST_NAME_MAX);
}

function brandListDesc(text) {
  const max = 100 - BRAND_STAMP.length;
  const body =
    shortLabel(text, max) || "Curated from your X bookmarks, likes, follows & replies";
  return (body + BRAND_STAMP).slice(0, 100);
}

function ensureBrandedName(name) {
  const n = String(name || "").replace(/\s+/g, " ").trim();
  if (/^XP\s*[·•\-–—]/i.test(n) || /^xpro\b/i.test(n)) {
    return sliceName(n);
  }
  // Strip a bare brand if user typed it mid-string, then re-prefix cleanly
  const cleaned = n.replace(/^XP\s*[·•\-–—]?\s*/i, "").trim();
  return brandListName(cleaned || "Guideposts");
}

function ensureBrandedDesc(desc) {
  const d = String(desc || "").replace(/\s+/g, " ").trim();
  if (/X Pro Guideposts/i.test(d)) return d.slice(0, 100);
  return brandListDesc(d || "Curated from your X signals");
}

async function polishWithGrok(apiKey, proposal, quiz) {
  const payload = {
    model: "grok-4-1-fast-non-reasoning",
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content:
          "Rename X lists to be short, punchy, private-list friendly. Rules: (1) every name MUST start with 'XP · ' then a human label, total max 25 chars; (2) description max 100 chars and MUST end with ' · X Pro Guideposts'; (3) names should reflect the quiz answers (who/what they care about), not generic filler like 'Core saves'; (4) keep members unchanged. Return JSON only: { lists: [{ key, name, description }] } matching input keys.",
      },
      {
        role: "user",
        content: JSON.stringify({
          quiz,
          lists: (proposal.lists || []).map((L) => ({
            key: L.key,
            name: L.name,
            description: L.description,
            sample: (L.members || []).slice(0, 5).map((m) => m.username),
          })),
        }),
      },
    ],
  };
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return proposal;
  const parsed = JSON.parse(m[0]);
  if (!parsed.lists) return proposal;
  const byKey = Object.fromEntries(parsed.lists.map((L) => [L.key, L]));
  proposal.lists = proposal.lists.map((L) => {
    const n = byKey[L.key];
    if (!n) return L;
    return {
      ...L,
      name: ensureBrandedName(n.name || L.name),
      description: ensureBrandedDesc(n.description || L.description),
    };
  });
  return proposal;
}

/* ───────────────────── crypto / util ───────────────────── */

function publicOrigin(env) {
  return String(env.PUBLIC_ORIGIN || "https://xpro.howtomovetheneedle.com").replace(
    /\/$/,
    ""
  );
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function iso() {
  return new Date().toISOString();
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function safeJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function b64url(buf) {
  let bin = "";
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacMod(secret, msg, mod) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))
  );
  // 32-bit from first bytes
  const n =
    ((sig[0] << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3]) >>> 0;
  return n % mod;
}

async function deriveAesKey(env) {
  const material = env.TOKEN_ENCRYPTION_KEY || env.SESSION_SECRET || "dev-insecure-key";
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material)
  );
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encrypt(env, plaintext) {
  const key = await deriveAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext)
    )
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64url(out);
}

async function decrypt(env, blob) {
  const key = await deriveAesKey(env);
  const raw = b64urlToBytes(blob);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

async function seal(env, obj) {
  return encrypt(env, JSON.stringify(obj));
}

async function unseal(env, blob) {
  try {
    return JSON.parse(await decrypt(env, blob));
  } catch {
    return null;
  }
}
