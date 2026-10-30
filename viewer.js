(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const sb = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  let notes = [];
  const urls = {};          // audio_path -> URL firmada
  let poll = null;
  let page = 1;
  let perPage = 10;

  const LANGS = { "en-US": "English", "en-GB": "English (UK)", "es-ES": "Spanish", "es-MX": "Spanish (MX)", "es-US": "Spanish (US)", "pt-BR": "Portuguese", "fr-FR": "French" };
  const langName = (l) => (l ? LANGS[l] || l : "Unknown");

  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  function showLogin() { $("login").hidden = false; $("dash").hidden = true; clearInterval(poll); }
  function showDash() { $("login").hidden = true; $("dash").hidden = false; }

  // ---------- Sesión ----------
  async function init() {
    if (!sb) { $("setup-warn").hidden = false; showLogin(); return; }
    const { data } = await sb.auth.getSession();
    if (data.session) load(); else showLogin();
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) return;
    $("login-error").textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    if (error) { $("login-error").textContent = "Wrong email or password."; return; }
    $("password").value = "";
    load();
  });
  $("logout").addEventListener("click", async () => { await sb.auth.signOut(); showLogin(); });
  $("refresh").addEventListener("click", () => load());

  // Filtros: cualquier cambio vuelve a la página 1
  let searchTimer = null;
  $("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; renderNotes(); }, 200); });
  for (const id of ["f-name", "f-lang", "f-status", "f-sort"]) $(id).addEventListener("change", () => { page = 1; renderNotes(); });
  $("f-clear").addEventListener("click", () => {
    $("search").value = ""; for (const id of ["f-name", "f-lang", "f-status"]) $(id).value = ""; $("f-sort").value = "new";
    page = 1; renderNotes();
  });

  // ---------- Datos ----------
  async function load() {
    const { data, error } = await sb.from("notes")
      .select("id,name,lang,transcript,duration,audio_path,created_at")
      .order("created_at", { ascending: false });
    if (error) { console.error(error); showLogin(); $("login-error").textContent = "Couldn't load notes. Is this email listed as a viewer in setup.sql?"; return; }
    notes = data || [];
    showDash();
    render();
    clearInterval(poll);
    poll = setInterval(() => { if (!document.hidden) load(); }, 30000); // no recarga si la pestaña está oculta
  }

  // Firma solo los audios de la página visible (antes se firmaban todos)
  async function signUrls(list) {
    const missing = list.map((n) => n.audio_path).filter((p) => p && !urls[p]);
    if (!missing.length) return;
    const { data: signed } = await sb.storage.from("recordings").createSignedUrls(missing, 60 * 60 * 6);
    for (const s of signed || []) if (s.signedUrl) urls[s.path] = s.signedUrl;
  }

  function fillSelect(id, values, label) {
    const s = $(id), cur = s.value;
    s.replaceChildren(el("option", { value: "", text: label }), ...values.map(([v, t]) => el("option", { value: v, text: t })));
    s.value = values.some(([v]) => v === cur) ? cur : "";
  }

  function render() {
    $("s-total").textContent = notes.length;
    $("s-done").textContent = notes.filter((n) => n.transcript).length;
    $("s-people").textContent = new Set(notes.map((n) => n.name.toLowerCase())).size;
    $("s-time").textContent = fmt(notes.reduce((a, n) => a + (n.duration || 0), 0));
    const names = [...new Map(notes.map((n) => [n.name.trim().toLowerCase(), n.name.trim()])).values()].sort((a, b) => a.localeCompare(b));
    fillSelect("f-name", names.map((n) => [n.toLowerCase(), n]), "All names");
    const langs = [...new Set(notes.map((n) => n.lang || ""))].sort();
    fillSelect("f-lang", langs.map((l) => [l || "__none", langName(l)]), "All languages");
    renderNotes();
  }

  function filtered() {
    const q = $("search").value.trim().toLowerCase();
    const fn = $("f-name").value, fl = $("f-lang").value, fs = $("f-status").value, sort = $("f-sort").value;
    const list = notes.filter((n) =>
      (!q || n.name.toLowerCase().includes(q) || (n.transcript || "").toLowerCase().includes(q)) &&
      (!fn || n.name.trim().toLowerCase() === fn) &&
      (!fl || (fl === "__none" ? !n.lang : n.lang === fl)) &&
      (!fs || (fs === "with" ? !!n.transcript : !n.transcript)));
    if (sort === "old") list.reverse();
    if (sort === "long") list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    return list;
  }

  async function renderNotes() {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / perPage));
    page = Math.min(page, pages);
    const slice = list.slice((page - 1) * perPage, page * perPage);
    const withT = list.filter((n) => n.transcript).length;
    $("copy").disabled = !withT;
    $("copy").textContent = withT ? `Copy for Claude (${withT})` : "Copy for Claude";
    $("result-count").textContent = list.length === notes.length ? `${notes.length} notes` : `${list.length} of ${notes.length} notes`;

    const box = $("notes");
    const keep = new Map([...box.querySelectorAll("audio[data-id]")].map((a) => [a.dataset.id, a]));
    if (!list.length) {
      box.replaceChildren(el("div", { class: "empty", text: notes.length ? "No notes match these filters." : "No voice notes yet. Share the link to start collecting!" }));
      renderPager(0, 1); return;
    }
    await signUrls(slice);
    box.replaceChildren();
    for (const n of slice) {
      let audio = keep.get(String(n.id));
      if (!audio) audio = el("audio", { controls: "", preload: "none", src: urls[n.audio_path] || "", "data-id": n.id });
      const body = n.transcript
        ? el("div", { class: "transcript", text: n.transcript })
        : el("span", { class: "badge", text: "No transcript (browser couldn't transcribe)" });
      box.append(el("article", { class: "note" },
        el("div", { class: "note-head" },
          el("span", { class: "note-name" }, n.name, el("span", { class: "note-lang", text: langName(n.lang) })),
          el("span", { class: "note-date", text: `${fmtDate(n.created_at)}${n.duration ? " · " + fmt(n.duration) : ""}` })),
        audio, body,
        el("div", { class: "note-actions" }, confirmDelete(n))));
    }
    renderPager(list.length, pages);
  }

  function renderPager(total, pages) {
    const nav = $("pager"); nav.replaceChildren();
    if (!total) return;
    const go = (p) => { page = p; renderNotes(); $("notes").scrollIntoView({ behavior: "smooth", block: "start" }); };
    const btn = (label, p, opts = {}) => el("button", { type: "button", text: label, ...(opts.current ? { "aria-current": "page" } : {}), ...(opts.disabled ? { disabled: "" } : {}), onclick: () => go(p) });
    nav.append(btn("‹ Prev", page - 1, { disabled: page === 1 }));
    const nums = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
    let last = 0;
    for (const p of [...nums].sort((a, b) => a - b)) {
      if (p - last > 1) nav.append(el("span", { class: "gap", text: "…" }));
      nav.append(btn(String(p), p, { current: p === page })); last = p;
    }
    nav.append(btn("Next ›", page + 1, { disabled: page === pages }));
    const sel = el("select", { class: "select", "aria-label": "Notes per page" }, ...[10, 25, 50].map((v) => el("option", { value: v, text: `${v} / page` })));
    sel.value = String(perPage);
    sel.addEventListener("change", () => { perPage = +sel.value; page = 1; renderNotes(); });
    nav.append(sel);
  }

  function confirmDelete(n) {
    const btn = el("button", { class: "linkbtn", text: "Delete" });
    let armed = false;
    btn.addEventListener("click", async () => {
      if (!armed) { armed = true; btn.textContent = "Click again to delete"; setTimeout(() => { armed = false; btn.textContent = "Delete"; }, 3000); return; }
      await sb.storage.from("recordings").remove([n.audio_path]);
      await sb.from("notes").delete().eq("id", n.id);
      load();
    });
    return btn;
  }

  // ---------- Copiar para Claude (usa los filtros activos) ----------
  function buildPrompt(withText) {
    const corpus = withText
      .map((n, i) => `<note index="${i + 1}" speaker="${n.name.replace(/"/g, "'")}" language="${langName(n.lang)}">\n${n.transcript}\n</note>`)
      .join("\n");
    return `Below ${withText.length === 1 ? "is 1 transcript" : `are ${withText.length} transcripts`} of voice notes in which people describe the snacks they tasted to a friend who has never tried them, highlight what they like most, and say what they didn't like. The transcripts were made automatically by a web browser, so expect some misheard words.

${corpus}

Please analyze ONLY what is in these transcripts and give me:

1. **Overview** — 2-4 sentences on how people describe the snacks overall.
2. **Adjectives ranked** — a table with every adjective used to describe the snacks (not adjectives about other things), with columns: adjective · number of notes that used it · a short example quote · sentiment (positive/neutral/negative). Normalize variants (e.g. "tastier" → "tasty") and sort from most to least used. If a transcript is in another language, keep the original word and add the English translation.
3. **What people like most** — a ranked list, most-cited first.
4. **What people didn't like** — a ranked list of complaints or dislikes, most-cited first, with a short example quote for each. If nobody mentioned a dislike, say so.
5. **Themes** — up to 6 recurring themes, one sentence each, with how many notes mention them.

Then offer to turn the adjective ranking into a chart.`;
  }

  $("copy").addEventListener("click", async () => {
    const withText = filtered().filter((n) => n.transcript).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const text = buildPrompt(withText);
    const n = withText.length;
    try {
      await navigator.clipboard.writeText(text);
      $("copy-fallback").hidden = true;
      $("copy-msg").textContent = `Copied ${n} transcript${n === 1 ? "" : "s"}. Paste it into a new chat at claude.ai.`;
    } catch {
      const ta = $("copy-fallback");
      ta.hidden = false; ta.value = text; ta.focus(); ta.select();
      $("copy-msg").textContent = "Your browser blocked automatic copying — the text is selected below, press Ctrl+C / ⌘C.";
    }
    setTimeout(() => { $("copy-msg").textContent = ""; }, 8000);
  });

  init();
})();
