/**
 * Jack Principles flow — one task at a time, shared control, awareness of past answers.
 */
const state = {
  user: null,
  pool: null,
  chip: "",
  q1: "",
  q2: "",
  // 0–100 UI scale; mapped to analyzer weights server-side
  weights: {
    bookmark: 75, // default ~ high intent
    like: 40,
    follow: 50,
    reply: 90,
  },
  run: null,
  proposal: null,
};

const $ = (id) => document.getElementById(id);

const CHIPS = [
  "Find customers",
  "Learn my craft",
  "Spot trends",
  "Keep up with friends",
  "Research competitors",
  "Stay inspired",
];

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
  state.q1 = state.q2 = state.chip = "";
  state.run = state.proposal = null;
  state.weights = { bookmark: 75, like: 40, follow: 50, reply: 90 };
  if (!state.user) {
    setFlowStep(0);
    setHost("Connect with X again for another build — sessions stay short on purpose.");
    panel(
      `<a class="btn btn-primary" href="/api/auth/x/start">Connect with X</a>
       <p class="hint">About ${state.sessionTtlMin || 60} minutes max · tokens wiped after create or disconnect.</p>`
    );
    return;
  }
  beat0();
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

    if (!me.ok || !me.user) {
      setHost("Connect with X to use this shortcut — or skip it and build lists in Pro by hand.");
      panel(
        `<a class="btn btn-primary" href="/api/auth/x/start">Connect with X</a>
         <a class="btn btn-ghost" href="https://pro.x.com" target="_blank" rel="noopener">Open pro.x.com instead</a>
         <p class="hint"><strong>Not required · not affiliated with X or X Corp.</strong> Built by <a href="https://x.com/JonathanDrake" target="_blank" rel="noopener">@JonathanDrake</a>. Everything here can be done manually in X and Pro. Read + list write · ~${state.sessionTtlMin} min session · tokens wiped after.</p>`
      );
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
    beat0();
  } catch (e) {
    setHost("I couldn’t reach the server. If you’re local, run wrangler dev.");
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
  if (sessionTicker) clearInterval(sessionTicker);
  const who = $("who");
  if (who) who.textContent = "";
  const logout = $("logout");
  if (logout) logout.classList.add("hidden");
  renderSessionBanner();
}

/** Beat 0 — awareness of past action (connected) */
function beat0() {
  show("proposal-panel", false);
  show("done-panel", false);
  show("stage", true);
  setFlowStep(0);
  const ttl = state.sessionTtlMin || 60;
  setHost(
    `You’re in, @${state.user.username}. This is a shortcut to private Lists for pro.x.com — not something Pro needs. Two quick things first so the plan fits you.`
  );
  panel(
    `<button type="button" class="btn btn-primary" id="go-q1">Sounds good</button>
     <p class="hint">Optional · about 3 minutes · session ~${ttl} min · disconnects after create. Lists and decks can always be built manually in X.</p>`
  );
  $("go-q1").onclick = q1;
}

function q1() {
  setFlowStep(1);
  setHost("When you open X Pro, what do you most want this feed to help you do?");
  panel(`
    <div class="chips" id="chips"></div>
    <input class="field" id="q1" placeholder="In your own words…" autocomplete="off" />
    <p class="hint">Chips are shortcuts — free text is better if you have it.</p>
    <button type="button" class="btn btn-primary" id="next1">Continue</button>
  `);
  const box = $("chips");
  CHIPS.forEach((label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.onclick = () => {
      [...box.querySelectorAll(".chip")].forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      state.chip = label;
      $("q1").value = label;
      $("q1").focus();
    };
    box.appendChild(b);
  });
  $("next1").onclick = () => {
    const v = $("q1").value.trim();
    if (!v) {
      setHost("Give me anything — even three words. What should this feed help you do?");
      return;
    }
    state.q1 = v;
    if (!state.chip) state.chip = v.slice(0, 40);
    ackQ1ThenQ2();
  };
  bindEnter("q1", "next1");
  $("q1").focus();
}

function ackQ1ThenQ2() {
  const v = state.q1.toLowerCase();
  let ack = `Got it — “${state.q1}.”`;
  if (/customer|sale|lead|buyer|client/.test(v)) {
    ack = "Sales radar. Got it — I’ll bias toward people you engage, not just famous accounts.";
  } else if (/learn|craft|skill|how/.test(v)) {
    ack = "Skill stack. I’ll lean on who you save and like when you’re learning.";
  } else if (/trend|news|pulse/.test(v)) {
    ack = "Pulse check. I’ll overweight fresh follows and active voices.";
  } else if (/friend|keep up|social/.test(v)) {
    ack = "People first. Replies and real conversations get extra weight.";
  } else if (/compet/.test(v)) {
    ack = "Competitive lens. I’ll still prefer accounts you actually interact with.";
  } else if (/inspir/.test(v)) {
    ack = "Inspiration lane. Bookmarks and likes will lead.";
  }

  setHost(ack);
  panel(`<p class="waiting">I’m listening for the next beat…</p>`);
  setTimeout(q2, 900);
}

function q2() {
  setFlowStep(2);
  const v = state.q1.toLowerCase();
  let prompt =
    "Who are the people you never want to miss — in your own words?";
  if (/customer|sale|lead|buyer|client/.test(v)) {
    prompt =
      "Who are the people you never want to miss — owners, buyers, partners… however you’d say it.";
  } else if (/learn|craft|skill/.test(v)) {
    prompt =
      "Who should always make the cut — teachers, builders, operators — in your words?";
  } else if (/inspir/.test(v)) {
    prompt =
      "Who lights you up — builders, storytellers, operators — however you’d name them.";
  }
  setHost(prompt);
  panel(`
    <input class="field" id="q2" placeholder="e.g. lawn care owners in Colorado" autocomplete="off" />
    <p class="hint">Examples: AI agent builders · honest marketing operators · local service pros</p>
    <button type="button" class="btn btn-primary" id="to-weights">Continue</button>
  `);
  $("to-weights").onclick = () => {
    const v2 = $("q2").value.trim();
    if (!v2) {
      setHost("One line is enough — who should never get lost in the feed?");
      return;
    }
    state.q2 = v2;
    setHost(`“${state.q2}.” Locked in. One more thing — how much should each signal count?`);
    panel(`<p class="waiting">Pulling the dials…</p>`);
    setTimeout(weightsBeat, 700);
  };
  bindEnter("q2", "to-weights");
  $("q2").focus();
}

/** Beat: customize signal weights (sliders) — still one focused task */
function weightsBeat() {
  setFlowStep(3);
  const v = state.q1.toLowerCase();
  if (/customer|sale|lead|buyer|client|compet/.test(v)) {
    state.weights = { bookmark: 55, like: 35, follow: 70, reply: 95 };
  } else if (/learn|craft|skill|inspir/.test(v)) {
    state.weights = { bookmark: 90, like: 70, follow: 45, reply: 50 };
  } else if (/friend|keep up|social/.test(v)) {
    state.weights = { bookmark: 50, like: 45, follow: 60, reply: 100 };
  } else if (/trend|news|pulse/.test(v)) {
    state.weights = { bookmark: 60, like: 55, follow: 85, reply: 40 };
  }

  setHost(
    "Drag these to taste. Higher = that behavior matters more when I pick people for your lists."
  );
  panel(`
    <div class="sliders" id="sliders">
      ${sliderRow("bookmark", "Bookmarks", "Saves you meant to come back to", state.weights.bookmark)}
      ${sliderRow("like", "Likes", "What resonated (broader, noisier)", state.weights.like)}
      ${sliderRow("follow", "Recent follows", "Who you added to the feed", state.weights.follow)}
      ${sliderRow("reply", "Replies", "Who you actually talk to", state.weights.reply)}
    </div>
    <div class="row presets">
      <button type="button" class="chip" data-preset="balanced">Balanced</button>
      <button type="button" class="chip" data-preset="intent">Saves first</button>
      <button type="button" class="chip" data-preset="social">Conversations first</button>
      <button type="button" class="chip" data-preset="discovery">Follows first</button>
    </div>
    <p class="hint">Presets are starting points — every slider still counts. Zero a dial to ignore that signal.</p>
    <button type="button" class="btn btn-primary" id="scan">Build my lists</button>
  `);

  bindSliders();
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.onclick = () => {
      const p = btn.dataset.preset;
      if (p === "balanced") state.weights = { bookmark: 75, like: 40, follow: 50, reply: 90 };
      if (p === "intent") state.weights = { bookmark: 100, like: 45, follow: 30, reply: 55 };
      if (p === "social") state.weights = { bookmark: 40, like: 35, follow: 50, reply: 100 };
      if (p === "discovery") state.weights = { bookmark: 45, like: 40, follow: 100, reply: 35 };
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
  ["bookmark", "like", "follow", "reply"].forEach((key) => {
    const input = $("w-" + key);
    if (!input) return;
    input.oninput = () => {
      state.weights[key] = Number(input.value);
      $("v-" + key).textContent = String(input.value);
      // Jack awareness: zero all but one? optional soft host line once
    };
  });
}

function syncSliderUI() {
  ["bookmark", "like", "follow", "reply"].forEach((key) => {
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
        <li data-scan="4"><span class="scan-dot"></span> Building deck plan…</li>
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
  if (!state.q2) {
    setHost("I still need who you never want to miss.");
    return;
  }
  ["bookmark", "like", "follow", "reply"].forEach((key) => {
    const input = $("w-" + key);
    if (input) state.weights[key] = Number(input.value);
  });

  setHost(
    `Perfect. I’ll look for “${state.q2}” with your dials — bookmarks ${state.weights.bookmark}, likes ${state.weights.like}, follows ${state.weights.follow}, replies ${state.weights.reply}.`
  );
  renderScanPanel();
  const scanBtn = $("scan");
  if (scanBtn) scanBtn.disabled = true;

  try {
    const data = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        q1: state.q1,
        q2: state.q2,
        chip: state.chip,
        weights: state.weights,
      }),
    });
    stopScanAnim();
    state.run = data.run;
    if (data.run.status === "failed") {
      setHost("I hit a snag talking to X.");
      panel(`<p class="hint">${escapeHtml(data.run.error || "Unknown error")}</p>
        <button class="btn btn-primary" id="retry">Try again</button>`);
      $("retry").onclick = startScan;
      return;
    }
    const lists = data.run.proposal?.lists || [];
    if (!lists.length) {
      setHost("I scanned your signals but couldn’t assemble lists with those dials.");
      panel(`<p class="hint">Try raising bookmarks or replies, or broaden who you never want to miss.</p>
        <button class="btn btn-primary" id="retry-empty">Adjust dials</button>`);
      $("retry-empty").onclick = weightsBeat;
      return;
    }
    // Refresh pool after claiming free slot
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
      panel(`<p class="hint">Self-host for unlimited builds, or check back after unlock.</p>
        <a class="btn btn-ghost" href="https://github.com/drake/X-Pro-Setup" target="_blank" rel="noopener">Self-host on GitHub</a>
        <a class="btn btn-ghost" href="/">Home</a>`);
      return;
    }
    setHost("Something broke mid-conversation — that’s on me.");
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
  setFlowStep(4);
  setHost(
    `Here’s your Pro deck plan — “${deck}”. Each block is a column. Tweak names if you want; nothing hits X until you create.`
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
    `1. Open https://pro.x.com`,
    `2. Create a NEW deck named: ${deckName}`,
    `3. Add ONLY these Lists as columns (in order):`,
  ];
  lists.forEach((L, i) => {
    const url = L.url || (L.x_list_id ? `https://x.com/i/lists/${L.x_list_id}` : "");
    lines.push(`   Column ${i + 1}: ${L.name}${url ? ` — ${url}` : ""}`);
  });
  lines.push(``, `Add column → Lists → pick each name above.`);
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
    caption: "Open pro.x.com in your browser",
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
    setFlowStep(5);
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
