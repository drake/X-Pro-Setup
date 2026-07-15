/**
 * Short starter flow: connect → signal dials → propose lists → create → open Pro.
 * Not a Pro replacement — just a way to get first list columns on the board.
 */
const state = {
  user: null,
  pool: null,
  // 0–100 UI scale; mapped to analyzer weights server-side
  weights: {
    bookmark: 75,
    like: 40,
    follow: 50,
    reply: 90,
    dm: 85, // people you messaged (outbound only)
  },
  run: null,
  proposal: null,
};

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || res.statusText);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function setHost(text) {
  const el = $("host-line");
  if (!el) return;
  el.textContent = text;
}

function panel(html) {
  const el = $("panel");
  if (!el) return;
  el.innerHTML = html;
}

function show(id, on = true) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

function setFlowStep(n) {
  document.querySelectorAll(".flow-step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("is-on", s === n);
    el.classList.toggle("is-done", s < n);
  });
}

function bindEnter(inputId, buttonId) {
  const input = $(inputId);
  const btn = $(buttonId);
  if (!input || !btn) return;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      btn.click();
    }
  });
}

function restartFlow() {
  stopProWalkthrough();
  show("proposal-panel", false);
  show("done-panel", false);
  show("stage", true);
  state.run = state.proposal = null;
  state.weights = { bookmark: 75, like: 40, follow: 50, reply: 90, dm: 85 };
  if (!state.user) {
    setFlowStep(0);
    setHost("Connect again — free host pool or your own X developer app for ongoing use.");
    panel(renderConnectPanel());
    bindConnectPanel();
    return;
  }
  startDials();
}

async function boot() {
  setFlowStep(0);
  try {
    const me = await api("/api/me");
    state.pool = me.pool;
    state.sessionTtlMin = me.session_ttl_minutes || 60;
    state.disconnectAfterApply = me.disconnect_after_apply !== false;
    state.sessionExpiresAt = me.session_expires_at || null;
    renderPool(me.pool, me.free_remaining_for_user);
    renderSessionBanner();

    state.hasByo = !!me.has_byo_x_app;
    state.billing = me.billing || null;
    state.byoHint = me.byo_x_app?.client_id_hint || null;

    if (!me.ok || !me.user) {
      setHost("Connect with X — free host pool (limited) or your own X developer app (you pay X, unlimited on this host).");
      panel(renderConnectPanel());
      bindConnectPanel();
      setFlowStep(0);
      return;
    }

    state.user = me.user;
    const who = $("who");
    if (who) who.textContent = "@" + me.user.username;
    const logout = $("logout");
    if (logout) {
      logout.classList.remove("hidden");
      logout.textContent = "Disconnect";
    }
    startSessionTicker();
    startDials();
  } catch (e) {
    setHost("Couldn’t reach the server. If you’re local, run wrangler dev.");
    panel(
      `<p class="hint">${escapeHtml(e.message)}</p>
       <a class="btn btn-ghost" href="/">Back home</a>`
    );
  }

  const logout = $("logout");
  if (logout) {
    logout.onclick = async () => {
      await hardDisconnect();
      location.href = "/";
    };
  }
  const createBtn = $("create-lists");
  if (createBtn) createBtn.onclick = applyLists;
  const restart = $("restart");
  if (restart) restart.onclick = restartFlow;
  const restartDone = $("restart-done");
  if (restartDone) restartDone.onclick = restartFlow;
}

function renderPool(pool, userFreeLeft) {
  const el = $("pool-banner");
  if (!el) return;
  el.classList.remove("is-open", "is-locked", "is-empty");
  if (!pool) {
    el.textContent = "Free pool status unavailable.";
    return;
  }
  if (!pool.unlocked) {
    const h = Math.floor(pool.seconds_until_unlock / 3600);
    const m = Math.floor((pool.seconds_until_unlock % 3600) / 60);
    el.textContent = `Free builds unlock in ~${h}h ${m}m (random daily drop) · then ${pool.max} host-paid slots`;
    el.classList.add("is-locked");
  } else if (pool.remaining <= 0) {
    el.textContent = `Free pool used up today (${pool.max}) · self-host or come back after tomorrow’s unlock`;
    el.classList.add("is-empty");
  } else {
    const yours =
      userFreeLeft == null
        ? ""
        : userFreeLeft <= 0
          ? " · you’ve used today’s free build"
          : ` · your free builds left: ${userFreeLeft}`;
    el.textContent = `Free pool open: ${pool.remaining}/${pool.max} left${yours}`;
    el.classList.add(userFreeLeft === 0 ? "is-empty" : "is-open");
  }
}

function renderSessionBanner() {
  let el = $("session-banner");
  if (!el) {
    const pool = $("pool-banner");
    if (!pool || !pool.parentNode) return;
    el = document.createElement("p");
    el.id = "session-banner";
    el.className = "session-banner";
    el.setAttribute("role", "status");
    pool.insertAdjacentElement("afterend", el);
  }
  const ttl = state.sessionTtlMin || 60;
  if (!state.sessionExpiresAt) {
    el.textContent = `Connections last ~${ttl} min on this host. No long-lived X logins.`;
    el.classList.remove("is-urgent");
    return;
  }
  const leftMs = Date.parse(state.sessionExpiresAt) - Date.now();
  if (leftMs <= 0) {
    el.textContent = "Session ended — reconnect if you need another build.";
    el.classList.add("is-urgent");
    return;
  }
  const m = Math.max(1, Math.ceil(leftMs / 60000));
  el.textContent =
    m <= 10
      ? `Session ends in ~${m} min · then X tokens are wiped from this host`
      : `Connected ~${m} min remaining · short sessions only (not permanent login)`;
  el.classList.toggle("is-urgent", m <= 10);
}

let sessionTicker = null;
function startSessionTicker() {
  if (sessionTicker) clearInterval(sessionTicker);
  renderSessionBanner();
  sessionTicker = setInterval(() => {
    if (!state.sessionExpiresAt) return;
    if (Date.parse(state.sessionExpiresAt) < Date.now()) {
      clearInterval(sessionTicker);
      state.user = null;
      const who = $("who");
      if (who) who.textContent = "";
      const logout = $("logout");
      if (logout) logout.classList.add("hidden");
      renderSessionBanner();
      // Don't yank the done panel mid-Pro setup
      if (!$("done-panel")?.classList.contains("hidden")) return;
      if (!$("proposal-panel")?.classList.contains("hidden")) {
        setHost("Your short session ended. Reconnect to create lists or start over.");
        return;
      }
      setHost("Session ended — the connection on this host is cleared.");
      panel(
        `<a class="btn btn-primary" href="/api/auth/x/start">Connect again</a>
         <p class="hint">Short sessions by design. Lists already created stay on your X account.</p>`
      );
      return;
    }
    renderSessionBanner();
  }, 30000);
}

async function hardDisconnect() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (_) {
    /* ignore */
  }
  state.user = null;
  state.sessionExpiresAt = null;
  // Keep hasByo — credentials stay for next connect with same app
  if (sessionTicker) clearInterval(sessionTicker);
  const who = $("who");
  if (who) who.textContent = "";
  const logout = $("logout");
  if (logout) logout.classList.add("hidden");
  renderSessionBanner();
}

function renderConnectPanel() {
  const ttl = state.sessionTtlMin || 60;
  const cb = "https://xpro.howtomovetheneedle.com/api/auth/x/callback";
  return `
    <div class="connect-grid">
      <div class="connect-card">
        <p class="card-kicker">Host free pool</p>
        <h3 class="connect-title">Quick start (host pays X)</h3>
        <p class="hint">Limited free builds. Short session · tokens wiped after create.</p>
        <a class="btn btn-primary" href="/api/auth/x/start">Connect with host app</a>
      </div>
      <div class="connect-card connect-card-byo">
        <p class="card-kicker">Bring your own X app</p>
        <h3 class="connect-title">Ongoing use (you pay X)</h3>
        <p class="hint">
          Paste OAuth 2.0 <strong>Client ID + Secret</strong> from
          <a href="https://developer.x.com" target="_blank" rel="noopener">developer.x.com</a>.
          Callback must be exactly:
        </p>
        <code class="callback-code">${cb}</code>
        <label class="field-label" for="byo-client-id">Client ID</label>
        <input class="field" id="byo-client-id" autocomplete="off" spellcheck="false" placeholder="OAuth 2.0 Client ID" />
        <label class="field-label" for="byo-client-secret">Client Secret</label>
        <input class="field" id="byo-client-secret" type="password" autocomplete="off" spellcheck="false" placeholder="OAuth 2.0 Client Secret" />
        <button type="button" class="btn btn-primary" id="byo-connect">Save &amp; connect with my app</button>
        <p class="hint" id="byo-status"></p>
      </div>
    </div>
    <a class="btn btn-ghost" href="https://pro.x.com" target="_blank" rel="noopener">Open pro.x.com instead</a>
    <p class="hint"><strong>Not required · not affiliated with X or X Corp.</strong>
      Built by <a href="https://x.com/JonathanDrake" target="_blank" rel="noopener">@JonathanDrake</a>.
      ~${ttl} min sessions · secrets encrypted on this host · never commit secrets to git.</p>
  `;
}

function bindConnectPanel() {
  const btn = $("byo-connect");
  if (!btn) return;
  btn.onclick = async () => {
    const client_id = ($("byo-client-id")?.value || "").trim();
    const client_secret = ($("byo-client-secret")?.value || "").trim();
    const status = $("byo-status");
    if (!client_id || !client_secret) {
      if (status) status.textContent = "Client ID and Client Secret are both required.";
      return;
    }
    btn.disabled = true;
    if (status) status.textContent = "Saving credentials…";
    try {
      const data = await api("/api/auth/x/byo", {
        method: "POST",
        body: JSON.stringify({ client_id, client_secret }),
      });
      if (status) status.textContent = "Redirecting to X…";
      location.href = data.start_url || "/api/auth/x/start?mode=byo";
    } catch (e) {
      btn.disabled = false;
      if (status) status.textContent = e.message || "Could not save credentials.";
    }
  };
}

/** Connected: go straight to signal dials (no quiz). */
function startDials() {
  show("proposal-panel", false);
  show("done-panel", false);
  show("stage", true);
  setFlowStep(1);
  const ttl = state.sessionTtlMin || 60;
  const billing =
    state.billing === "user_x_app" || state.hasByo
      ? `Billing: your X developer app${state.byoHint ? ` (${state.byoHint})` : ""} — host free pool not used.`
      : "Billing: host free pool (limited). For unlimited ongoing use, disconnect and connect with your own X app.";
  setHost(
    `@${state.user.username} — set how much each signal should count. Includes people you DMed (outbound only). Starter lists for pro.x.com — not a Pro replacement.`
  );
  panel(`
    <p class="billing-banner ${state.hasByo ? "is-byo" : "is-host"}">${billing}</p>
    <div class="sliders" id="sliders">
      ${sliderRow("bookmark", "Bookmarks", "Accounts from posts you saved (strong intent)", state.weights.bookmark)}
      ${sliderRow("like", "Likes", "Accounts from posts you liked recently (broader)", state.weights.like)}
      ${sliderRow("follow", "Recent follows", "People you just added to your feed", state.weights.follow)}
      ${sliderRow("reply", "Replies", "People you actually talk to in replies", state.weights.reply)}
      ${sliderRow("dm", "DMs you sent", "1:1 chats you messaged (not inbound spam · ~30 days)", state.weights.dm)}
    </div>
    <div class="row presets">
      <button type="button" class="chip" data-preset="balanced">Balanced</button>
      <button type="button" class="chip" data-preset="intent">Saves first</button>
      <button type="button" class="chip" data-preset="social">Conversations first</button>
      <button type="button" class="chip" data-preset="discovery">Follows first</button>
      <button type="button" class="chip" data-preset="dms">DMs first</button>
    </div>
    <p class="hint">Higher = more weight when ranking people. Zero a dial to ignore that signal. <strong>Reconnect X</strong> if DMs fail (new <code>dm.read</code> permission). Session ~${ttl} min.</p>
    <button type="button" class="btn btn-primary" id="scan">Scan & propose lists</button>
    <p class="hint" style="margin-top:0.85rem">Or skip this app and build lists manually in
      <a href="https://pro.x.com" target="_blank" rel="noopener">pro.x.com</a>.</p>
  `);

  bindSliders();
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.onclick = () => {
      const p = btn.dataset.preset;
      if (p === "balanced")
        state.weights = { bookmark: 75, like: 40, follow: 50, reply: 90, dm: 85 };
      if (p === "intent")
        state.weights = { bookmark: 100, like: 45, follow: 30, reply: 55, dm: 40 };
      if (p === "social")
        state.weights = { bookmark: 40, like: 35, follow: 50, reply: 100, dm: 90 };
      if (p === "discovery")
        state.weights = { bookmark: 45, like: 40, follow: 100, reply: 35, dm: 30 };
      if (p === "dms")
        state.weights = { bookmark: 20, like: 15, follow: 20, reply: 40, dm: 100 };
      syncSliderUI();
      document.querySelectorAll("[data-preset]").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
    };
  });
  $("scan").onclick = startScan;
}

function sliderRow(key, label, hint, value) {
  return `
    <div class="slider-row" data-key="${key}">
      <div class="slider-head">
        <label for="w-${key}">${label}</label>
        <span class="slider-val" id="v-${key}">${value}</span>
      </div>
      <input type="range" min="0" max="100" step="5" id="w-${key}" value="${value}" />
      <p class="slider-hint">${hint}</p>
    </div>
  `;
}

function bindSliders() {
  ["bookmark", "like", "follow", "reply", "dm"].forEach((key) => {
    const input = $("w-" + key);
    if (!input) return;
    input.oninput = () => {
      state.weights[key] = Number(input.value);
      $("v-" + key).textContent = String(input.value);
    };
  });
}

function syncSliderUI() {
  ["bookmark", "like", "follow", "reply", "dm"].forEach((key) => {
    const input = $("w-" + key);
    if (!input) return;
    input.value = state.weights[key];
    $("v-" + key).textContent = String(state.weights[key]);
  });
}

function renderScanPanel() {
  panel(`
    <div class="scan-box">
      <div class="scan-bar" aria-hidden="true"><i></i></div>
      <ul class="scan-steps" id="scan-steps">
        <li class="is-on" data-scan="0"><span class="scan-dot"></span> Bookmarks</li>
        <li data-scan="1"><span class="scan-dot"></span> Likes (last 50)</li>
        <li data-scan="2"><span class="scan-dot"></span> Follows (last 25)</li>
        <li data-scan="3"><span class="scan-dot"></span> Reply graph</li>
        <li data-scan="4"><span class="scan-dot"></span> DMs you sent (not inbound)</li>
        <li data-scan="5"><span class="scan-dot"></span> Building deck plan…</li>
      </ul>
      <p class="hint" style="margin-top:1rem">Nothing is created on X until you approve the plan.</p>
    </div>
  `);
  let i = 0;
  const tick = () => {
    const items = document.querySelectorAll("#scan-steps li");
    if (!items.length) return;
    items.forEach((el, idx) => {
      el.classList.toggle("is-done", idx < i);
      el.classList.toggle("is-on", idx === i);
    });
    i = Math.min(i + 1, items.length - 1);
  };
  state._scanTimer = setInterval(tick, 900);
}

function stopScanAnim() {
  if (state._scanTimer) {
    clearInterval(state._scanTimer);
    state._scanTimer = null;
  }
}

async function startScan() {
  ["bookmark", "like", "follow", "reply", "dm"].forEach((key) => {
    const input = $("w-" + key);
    if (input) state.weights[key] = Number(input.value);
  });

  const allZero =
    state.weights.bookmark +
      state.weights.like +
      state.weights.follow +
      state.weights.reply +
      state.weights.dm ===
    0;
  if (allZero) {
    setHost("Turn at least one dial above zero so there’s a signal to rank people by.");
    return;
  }

  setHost(
    `Scanning — bookmarks ${state.weights.bookmark}, likes ${state.weights.like}, follows ${state.weights.follow}, replies ${state.weights.reply}, DMs you sent ${state.weights.dm}. Nothing is created until you approve.`
  );
  renderScanPanel();
  const scanBtn = $("scan");
  if (scanBtn) scanBtn.disabled = true;

  try {
    const data = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        weights: state.weights,
      }),
    });
    stopScanAnim();
    state.run = data.run;
    if (data.run.status === "failed") {
      setHost("Hit a snag talking to X.");
      panel(`<p class="hint">${escapeHtml(data.run.error || "Unknown error")}</p>
        <button class="btn btn-primary" id="retry">Try again</button>`);
      $("retry").onclick = startScan;
      return;
    }
    const lists = data.run.proposal?.lists || [];
    if (!lists.length) {
      setHost("Scan finished, but no lists could be built with those dials.");
      panel(`<p class="hint">Raise bookmarks or replies, or try a preset. You can always build lists by hand in Pro.</p>
        <button class="btn btn-primary" id="retry-empty">Adjust dials</button>
        <a class="btn btn-ghost" href="https://pro.x.com" target="_blank" rel="noopener">Open pro.x.com</a>`);
      $("retry-empty").onclick = startDials;
      return;
    }
    try {
      const me = await api("/api/me");
      renderPool(me.pool, me.free_remaining_for_user);
    } catch (_) {
      /* ignore */
    }
    state.proposal = data.run.proposal;
    renderProposal(data.run);
  } catch (e) {
    stopScanAnim();
    if (e.status === 402) {
      const p = e.data?.pool;
      if (p) renderPool(p, 0);
      setHost(
        e.data?.message ||
          "The free pool isn’t available right now. It unlocks at a random time each day."
      );
      panel(`<p class="hint">Host free pool unavailable. For ongoing use without self-hosting: disconnect, then connect with <strong>your own X developer app</strong> (you pay X).</p>
        <button type="button" class="btn btn-primary" id="go-byo-again">Use my X developer app</button>
        <a class="btn btn-ghost" href="https://pro.x.com" target="_blank" rel="noopener">Open pro.x.com</a>
        <a class="btn btn-ghost" href="https://github.com/drake/X-Pro-Setup" target="_blank" rel="noopener">Self-host</a>`);
      const goByo = $("go-byo-again");
      if (goByo) {
        goByo.onclick = async () => {
          await hardDisconnect();
          setHost("Connect with your own X developer app — X API bills your project, not the host free pool.");
          panel(renderConnectPanel());
          bindConnectPanel();
        };
      }
      return;
    }
    setHost("Something broke mid-scan.");
    panel(`<p class="hint">${escapeHtml(e.message)}</p>
      <button class="btn btn-primary" id="retry2">Try again</button>`);
    $("retry2").onclick = startScan;
  }
}

function deckTitle(runOrProposal) {
  const p = runOrProposal?.proposal || runOrProposal || state.proposal || {};
  return (
    p.deck?.name ||
    p.taste?.deck_name ||
    runOrProposal?.taste?.deck_name ||
    "XP · Guideposts"
  );
}

function renderProposal(run) {
  const deck = deckTitle(run);
  setFlowStep(2);
  setHost(
    `Starter lists for deck “${deck}”. Each block can be a Pro column. Tweak names if you want — nothing hits X until you create.`
  );
  panel("");
  show("stage", false);
  show("proposal-panel", true);
  const taste = run.taste || state.proposal?.taste;
  const tasteEl = $("taste");
  if (tasteEl) tasteEl.textContent = taste?.summary || "";
  const dn = $("deck-name");
  if (dn) dn.textContent = `New deck: ${deck}`;
  const lists = run.proposal?.lists || [];
  state.proposal = run.proposal;
  if (state.proposal && !state.proposal.deck) {
    state.proposal.deck = { name: deck };
  }
  const root = $("lists");
  root.innerHTML = "";
  lists.forEach((L, i) => {
    const members = L.members || [];
    const div = document.createElement("div");
    div.className = "list-card";
    const collapse = members.length > 5;
    div.innerHTML = `
      <p class="column-label">Column ${i + 1}</p>
      <h3 contenteditable="true" data-i="${i}" data-f="name" spellcheck="false">${escapeHtml(L.name)}</h3>
      <p class="desc" contenteditable="true" data-i="${i}" data-f="description" spellcheck="false">${escapeHtml(L.description || "")}</p>
      <div class="list-meta">
        <span>${members.length} people</span>
        <span>${escapeHtml(L.key || "list")}</span>
      </div>
      <div class="members${collapse ? " is-collapsed" : ""}" data-members="${i}">
        ${members
          .map(
            (m) =>
              `<div class="member"><span>@${escapeHtml(
                m.username || m.user_id
              )}</span><span class="reason">${escapeHtml(m.reason || "")}</span></div>`
          )
          .join("")}
      </div>
      ${
        collapse
          ? `<button type="button" class="members-toggle" data-toggle="${i}">Show all ${members.length}</button>`
          : ""
      }
    `;
    root.appendChild(div);
  });
  root.querySelectorAll("[contenteditable]").forEach((el) => {
    el.addEventListener("blur", () => {
      const i = Number(el.dataset.i);
      const f = el.dataset.f;
      if (state.proposal?.lists?.[i]) state.proposal.lists[i][f] = el.textContent.trim();
    });
  });
  root.querySelectorAll(".members-toggle").forEach((btn) => {
    btn.onclick = () => {
      const box = root.querySelector(`[data-members="${btn.dataset.toggle}"]`);
      if (!box) return;
      const open = box.classList.toggle("is-collapsed");
      btn.textContent = open
        ? `Show all ${box.querySelectorAll(".member").length}`
        : "Show fewer";
    };
  });
  const createBtn = $("create-lists");
  if (createBtn) {
    createBtn.disabled = false;
    createBtn.focus();
  }
}

function buildDeckRecipe(deckName, lists) {
  const lines = [
    `X Pro deck: ${deckName}`,
    ``,
    `1. Open https://pro.x.com and log in`,
    `2. Optional: left nav More → Tour (X’s in-app walkthrough)`,
    `3. Create a NEW deck named: ${deckName}`,
    `4. Add ONLY these Lists as columns (in order):`,
  ];
  lists.forEach((L, i) => {
    const url = L.url || (L.x_list_id ? `https://x.com/i/lists/${L.x_list_id}` : "");
    lines.push(`   Column ${i + 1}: ${L.name}${url ? ` — ${url}` : ""}`);
  });
  lines.push(``, `Add column → Lists → pick each name above.`);
  lines.push(`Help: https://help.x.com/en/using-x/how-to-use-x-pro`);
  return lines.join("\n");
}

/** Looping visual walkthrough on the thank-you screen. */
let walkTimer = null;
let walkTimeouts = [];
let walkStep = 0;
let walkPaused = false;
let walkCtx = null;

function stopProWalkthrough() {
  if (walkTimer) {
    clearTimeout(walkTimer);
    walkTimer = null;
  }
  walkTimeouts.forEach((t) => clearTimeout(t));
  walkTimeouts = [];
  walkCtx = null;
}

function walkLater(fn, ms) {
  const id = setTimeout(fn, ms);
  walkTimeouts.push(id);
  return id;
}

function startProWalkthrough(deckName, lists) {
  stopProWalkthrough();
  const mock = $("pro-mock");
  const caption = $("pro-walk-caption");
  const counter = $("pro-walk-counter");
  const progress = $("pro-walk-progress-bar");
  const dotsEl = $("pro-walk-dots");
  const cursor = $("pro-cursor");
  const colsEl = $("pro-mock-cols");
  const listMenu = $("pro-mock-list-menu");
  const picker = $("pro-mock-picker");
  const typebox = $("pro-mock-typebox");
  const typeVal = $("pro-mock-type-value");
  const activeDeck = $("pro-mock-active-deck");
  const deckLabel = $("pro-mock-deck-label");
  const newDeck = $("pro-mock-new-deck");
  const addBtn = $("pro-mock-add");
  const optLists = $("pro-mock-opt-lists");
  const empty = $("pro-mock-empty");
  const deckbarTitle = $("pro-mock-deckbar-title");
  const deckbarSub = $("pro-mock-deckbar-sub");
  const walkRoot = $("pro-walk");
  const frame = $("pro-walk-frame");
  const replay = $("pro-walk-replay");
  if (!mock || !caption || !colsEl) return;

  const names = (lists || []).map((L) => L.name).filter(Boolean);
  const demoNames =
    names.length > 0
      ? names.slice(0, 3)
      : ["XP · Core circle", "XP · Conversations", "XP · Fresh follows"];
  const deck = deckName || "XP · Guideposts";
  const n = demoNames.length;

  if (deckLabel) deckLabel.textContent = deck;
  if (activeDeck) activeDeck.title = deck;
  colsEl.innerHTML = "";
  demoNames.forEach((name, i) => {
    const col = document.createElement("div");
    col.className = "pro-mock-col";
    col.dataset.i = String(i);
    col.innerHTML = `
      <div class="pro-mock-col-head">
        <span class="pro-mock-col-badge">List</span>
        <span class="pro-mock-col-title">${escapeHtml(name)}</span>
      </div>
      <div class="pro-mock-col-card">
        <div class="pro-mock-col-line med"></div>
        <div class="pro-mock-col-line short"></div>
      </div>
      <div class="pro-mock-col-card">
        <div class="pro-mock-col-line"></div>
        <div class="pro-mock-col-line med"></div>
      </div>
      <div class="pro-mock-col-card">
        <div class="pro-mock-col-line short"></div>
        <div class="pro-mock-col-line"></div>
      </div>
    `;
    colsEl.appendChild(col);
  });
  if (listMenu) {
    listMenu.innerHTML = "";
    demoNames.forEach((name, i) => {
      const row = document.createElement("div");
      row.className = "pro-mock-list-row";
      row.dataset.i = String(i);
      row.textContent = name;
      listMenu.appendChild(row);
    });
  }
  if (dotsEl) {
    dotsEl.innerHTML = "";
    // base steps + one per list + done
    const totalDots = 5 + n + 1;
    for (let i = 0; i < totalDots; i++) {
      const li = document.createElement("li");
      dotsEl.appendChild(li);
    }
  }

  const reduceMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setCaption(text) {
    caption.classList.add("is-swap");
    walkLater(() => {
      caption.textContent = text;
      caption.classList.remove("is-swap");
    }, 120);
  }

  function placeCursor(left, top, click) {
    if (!cursor) return;
    cursor.style.opacity = "1";
    cursor.style.left = left;
    cursor.style.top = top;
    if (click) {
      cursor.classList.remove("is-click");
      void cursor.offsetWidth;
      cursor.classList.add("is-click");
    }
  }

  function resetVisual() {
    [...colsEl.children].forEach((c) => {
      c.classList.remove("is-on", "is-pop");
    });
    listMenu?.querySelectorAll(".pro-mock-list-row").forEach((r) => {
      r.classList.remove("is-hot", "is-done");
    });
    picker?.classList.remove("is-on");
    listMenu?.classList.remove("is-on");
    typebox?.classList.remove("is-on");
    optLists?.classList.remove("is-hot");
    newDeck?.classList.remove("is-hot");
    addBtn?.classList.remove("is-hot");
    activeDeck?.classList.remove("is-shown");
    empty?.classList.add("is-on");
    if (typeVal) typeVal.textContent = "";
    if (deckbarTitle) deckbarTitle.textContent = "—";
    if (deckbarSub) deckbarSub.textContent = "No columns yet";
    mock.querySelectorAll(".pro-mock-picker-opt").forEach((o) => o.classList.remove("is-hot"));
  }

  function syncChecklist(key) {
    document.querySelectorAll(".pro-steps [data-walk]").forEach((li) => {
      const k = li.getAttribute("data-walk");
      li.classList.toggle("is-walk-on", k === String(key));
      li.classList.toggle("is-walk-done", Number(k) < Number(key));
    });
  }

  function setProgress(i, total) {
    if (counter) counter.textContent = `${i + 1} / ${total}`;
    if (progress) progress.style.width = `${((i + 1) / total) * 100}%`;
    if (dotsEl) {
      [...dotsEl.children].forEach((d, di) => {
        d.classList.toggle("is-on", di === i);
        d.classList.toggle("is-done", di < i);
      });
    }
  }

  function typeDeckName(done) {
    if (!typebox || !typeVal) {
      done();
      return;
    }
    typebox.classList.add("is-on");
    typeVal.textContent = "";
    let i = 0;
    const tick = () => {
      if (walkPaused) {
        walkLater(tick, 100);
        return;
      }
      typeVal.textContent = deck.slice(0, i);
      i++;
      if (i <= deck.length) walkLater(tick, 42);
      else walkLater(done, 400);
    };
    tick();
  }

  // Build timeline: open → new deck → type name → for each list: add → lists → pick → column on → done
  const steps = [];

  steps.push({
    caption: "Open pro.x.com and log in",
    checklist: 0,
    duration: 2000,
    run() {
      resetVisual();
      placeCursor("78%", "12%");
      if (deckbarTitle) deckbarTitle.textContent = "X Pro";
      if (deckbarSub) deckbarSub.textContent = "Pick or create a deck";
    },
  });

  steps.push({
    caption: "Optional: More → Tour (X’s own walkthrough)",
    checklist: 0,
    duration: 2200,
    run() {
      placeCursor("8%", "88%");
      if (deckbarSub) deckbarSub.textContent = "More menu → Tour";
    },
  });

  steps.push({
    caption: "Create a new empty deck",
    checklist: 1,
    duration: 2200,
    run() {
      empty?.classList.add("is-on");
      newDeck?.classList.add("is-hot");
      placeCursor("8%", "36%", true);
    },
  });

  steps.push({
    caption: `Name the deck “${deck}”`,
    checklist: 2,
    duration: 0, // driven by typing
    run(next) {
      newDeck?.classList.remove("is-hot");
      placeCursor("52%", "48%");
      typeDeckName(() => {
        typebox?.classList.remove("is-on");
        activeDeck?.classList.add("is-shown");
        if (deckbarTitle) deckbarTitle.textContent = deck;
        if (deckbarSub) deckbarSub.textContent = "Empty — add list columns";
        empty?.classList.add("is-on");
        placeCursor("10%", "46%");
        next();
      });
    },
  });

  demoNames.forEach((name, idx) => {
    steps.push({
      caption: `Add column ${idx + 1} of ${n}`,
      checklist: 3,
      duration: 1800,
      run() {
        typebox?.classList.remove("is-on");
        picker?.classList.remove("is-on");
        listMenu?.classList.remove("is-on");
        addBtn?.classList.add("is-hot");
        placeCursor("9%", "82%", true);
      },
    });
    steps.push({
      caption: "Choose Lists (not Home)",
      checklist: 3,
      duration: 1800,
      run() {
        addBtn?.classList.remove("is-hot");
        picker?.classList.add("is-on");
        listMenu?.classList.remove("is-on");
        mock.querySelectorAll(".pro-mock-picker-opt").forEach((o) => o.classList.remove("is-hot"));
        optLists?.classList.add("is-hot");
        placeCursor("55%", "48%", true);
      },
    });
    steps.push({
      caption: `Select “${name}”`,
      checklist: 3,
      duration: 2000,
      run() {
        listMenu?.classList.add("is-on");
        optLists?.classList.remove("is-hot");
        const rows = [...(listMenu?.querySelectorAll(".pro-mock-list-row") || [])];
        rows.forEach((r, ri) => {
          r.classList.toggle("is-hot", ri === idx);
          r.classList.toggle("is-done", ri < idx);
        });
        const rowTop = 52 + idx * 8;
        placeCursor("56%", `${Math.min(rowTop, 72)}%`, true);
      },
    });
    steps.push({
      caption: `Column added: ${name}`,
      checklist: 3,
      duration: 1700,
      run() {
        picker?.classList.remove("is-on");
        listMenu?.classList.remove("is-on");
        empty?.classList.remove("is-on");
        const col = colsEl.children[idx];
        if (col) {
          col.classList.add("is-on", "is-pop");
          walkLater(() => col.classList.remove("is-pop"), 700);
        }
        const onCount = idx + 1;
        if (deckbarSub) {
          deckbarSub.textContent = `${onCount} list column${onCount === 1 ? "" : "s"}`;
        }
        placeCursor(`${30 + idx * 22}%`, "40%");
      },
    });
  });

  steps.push({
    caption: "Done — this deck is only your XP · lists",
    checklist: 4,
    duration: 3200,
    run() {
      picker?.classList.remove("is-on");
      empty?.classList.remove("is-on");
      [...colsEl.children].forEach((c) => c.classList.add("is-on"));
      if (deckbarTitle) deckbarTitle.textContent = deck;
      if (deckbarSub) deckbarSub.textContent = `${n} list columns · ready in Pro`;
      activeDeck?.classList.add("is-shown");
      placeCursor("70%", "55%");
      if (cursor) cursor.style.opacity = "0.55";
    },
  });

  const total = steps.length;

  function go(i) {
    if (!walkCtx) return;
    walkStep = ((i % total) + total) % total;
    const s = steps[walkStep];
    setProgress(walkStep, total);
    setCaption(s.caption);
    syncChecklist(s.checklist);

    const advance = () => {
      if (!walkCtx || walkPaused) {
        walkLater(advance, 200);
        return;
      }
      go(walkStep + 1);
    };

    if (typeof s.run === "function" && s.duration === 0) {
      s.run(advance);
      return;
    }
    s.run?.();
    walkTimer = setTimeout(advance, s.duration || 2000);
  }

  walkCtx = { deck, demoNames };
  walkPaused = false;
  walkRoot?.classList.remove("is-paused");

  if (frame) {
    frame.onmouseenter = () => {
      walkPaused = true;
      walkRoot?.classList.add("is-paused");
    };
    frame.onmouseleave = () => {
      walkPaused = false;
      walkRoot?.classList.remove("is-paused");
    };
  }
  if (replay) {
    replay.onclick = () => startProWalkthrough(deck, lists);
  }

  if (reduceMotion) {
    resetVisual();
    activeDeck?.classList.add("is-shown");
    empty?.classList.remove("is-on");
    [...colsEl.children].forEach((c) => c.classList.add("is-on"));
    if (deckbarTitle) deckbarTitle.textContent = deck;
    if (deckbarSub) deckbarSub.textContent = `${n} list columns`;
    setCaption(`Deck “${deck}” with your ${n} lists as columns`);
    setProgress(total - 1, total);
    syncChecklist(4);
    if (cursor) cursor.style.opacity = "0";
    return;
  }

  go(0);
}

async function applyLists() {
  if (!state.run?.id) return;
  $("create-lists").disabled = true;
  $("apply-status").textContent = "Creating the lists that will fill your Pro deck…";
  try {
    const data = await api(`/api/runs/${state.run.id}/apply`, {
      method: "POST",
      body: JSON.stringify({ proposal: state.proposal }),
    });
    show("proposal-panel", false);
    show("stage", false);
    show("done-panel", true);
    setFlowStep(3);
    const okLists = (data.result?.lists || []).filter((L) => L.x_list_id || L.url);
    const n = okLists.length;
    const deck =
      data.result?.deck?.name || deckTitle({ proposal: state.proposal });
    setHost(
      n
        ? `Your ${n} list${n === 1 ? " is" : "s are"} on X — those are the columns. Open Pro, make a new deck “${deck}”, and add only these lists so the deck is just your board.`
        : "Something went sideways creating lists. Try again, or self-host if the free pool is tight."
    );
    const doneName = $("done-deck-name");
    if (doneName) {
      doneName.textContent = `New deck “${deck}” should contain:`;
    }
    const stepName = $("deck-name-step");
    if (stepName) stepName.textContent = deck;
    const blurb = $("done-blurb");
    if (blurb && n) {
      const names = okLists.map((L) => L.name).join(" · ");
      blurb.innerHTML = `These Lists are on your account with members already in them: <strong>${escapeHtml(
        names
      )}</strong>. Put <em>exactly those</em> into a new Pro deck as columns (below).`;
    }
    const ul = $("created");
    ul.innerHTML = "";
    okLists.forEach((L, i) => {
      const li = document.createElement("li");
      const listUrl = L.url || `https://x.com/i/lists/${L.x_list_id}`;
      li.innerHTML = `<strong>Column ${i + 1} of deck</strong> —
        <a href="${escapeHtml(listUrl)}" target="_blank" rel="noopener">${escapeHtml(
          L.name
        )}</a>
        · ${L.member_count || 0} people already in list
        <span class="hint">In Pro: Add column → Lists → “${escapeHtml(L.name)}”</span>`;
      ul.appendChild(li);
    });
    for (const L of data.result?.lists || []) {
      if (L.x_list_id || L.url) continue;
      const li = document.createElement("li");
      li.textContent = `${L.name}: ${L.error ? JSON.stringify(L.error) : "failed"}`;
      ul.appendChild(li);
    }

    const recipe = buildDeckRecipe(deck, okLists);
    const copyBtn = $("copy-deck-recipe");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(recipe);
          $("copy-status").textContent = "Checklist copied — paste next to Pro while you build the deck.";
        } catch {
          $("copy-status").textContent = recipe;
        }
      };
    }

    startProWalkthrough(deck, okLists);

    // Host clears X tokens after create; keep TY UI so user can open Pro
    if (data.disconnected || state.disconnectAfterApply !== false) {
      state.user = null;
      state.sessionExpiresAt = null;
      if (sessionTicker) clearInterval(sessionTicker);
      const who = $("who");
      if (who) who.textContent = "";
      const logout = $("logout");
      if (logout) logout.classList.add("hidden");
      const sb = $("session-banner");
      if (sb) {
        sb.textContent =
          "Disconnected from this host — X tokens wiped. New lists stay on your X account.";
        sb.classList.add("is-urgent");
      }
      setHost(
        (n
          ? `Your ${n} list${n === 1 ? " is" : "s are"} on X. `
          : "") +
          `Connection cleared here — no open access held on this host. Finish the Pro deck below; no need to stay logged in.`
      );
    }
  } catch (e) {
    $("apply-status").textContent = e.message;
    $("create-lists").disabled = false;
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

boot();
