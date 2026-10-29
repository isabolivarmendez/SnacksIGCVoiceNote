(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const sb = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  let notes = [];
  let urls = {}; // audio_path -> URL firmada
  let poll = null;

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
  $("search").addEventListener("input", renderNotes);

  // ---------- Datos ----------
  async function load() {
    const { data, error } = await sb.from("notes").select("*").order("created_at", { ascending: false });
    if (error) { console.error(error); showLogin(); $("login-error").textContent = "Couldn't load notes. Is this email listed as a viewer in setup.sql?"; return; }
    notes = data || [];
    const missing = notes.map((n) => n.audio_path).filter((p) => !urls[p]);
    if (missing.length) {
      const { data: signed } = await sb.storage.from("recordings").createSignedUrls(missing, 60 * 60 * 6);
      for (const s of signed || []) if (s.signedUrl) urls[s.path] = s.signedUrl;
    }
    showDash();
    render();
    clearInterval(poll);
    poll = setInterval(load, 30000);
  }

  function render() {
    $("s-total").textContent = notes.length;
    $("s-done").textContent = notes.filter((n) => n.transcript).length;
    $("s-people").textContent = new Set(notes.map((n) => n.name.toLowerCase())).size;
    $("s-time").textContent = fmt(notes.reduce((a, n) => a + (n.duration || 0), 0));
    $("copy").disabled = !notes.some((n) => n.transcript);
    renderNotes();
  }

  function renderNotes() {
    const q = $("search").value.trim().toLowerCase();
    const list = notes.filter((n) => !q || n.name.toLowerCase().includes(q) || (n.transcript || "").toLowerCase().includes(q));
    const box = $("notes");
    const keep = new Map([...box.querySelectorAll("audio[data-id]")].map((a) => [a.dataset.id, a]));
    box.replaceChildren();
    if (!list.length) {
      box.append(el("div", { class: "empty", text: notes.length ? "No matches." : "No voice notes yet. Share the link to start collecting!" }));
      return;
    }
    for (const n of list) {
      const audio = keep.get(n.id) || el("audio", { controls: "", preload: "none", src: urls[n.audio_path] || "", "data-id": n.id });
      const body = n.transcript
        ? el("div", { class: "transcript", text: n.transcript })
        : el("span", { class: "badge", text: "No transcript (browser couldn't transcribe)" });
      box.append(el("article", { class: "note" },
        el("div", { class: "note-head" },
          el("span", { class: "note-name", text: n.name }),
          el("span", { class: "note-date", text: `${fmtDate(n.created_at)}${n.duration ? " · " + fmt(n.duration) : ""}` })),
        audio, body,
        el("div", { class: "note-actions" }, confirmDelete(n))));
    }
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

  // ---------- Copiar para Claude ----------
  function buildPrompt() {
    const withText = notes.filter((n) => n.transcript).slice().reverse();
    const corpus = withText
      .map((n, i) => `<note index="${i + 1}" speaker="${n.name.replace(/"/g, "'")}">\n${n.transcript}\n</note>`)
      .join("\n");
    return `Below ${withText.length === 1 ? "is 1 transcript" : `are ${withText.length} transcripts`} of voice notes in which people describe the snacks they tasted to a friend who has never tried them and highlight what they like most. The transcripts were made automatically by a web browser, so expect some misheard words.

${corpus}

Please analyze ONLY what is in these transcripts and give me:

1. **Overview** — 2-4 sentences on how people describe the snacks overall.
2. **Adjectives ranked** — a table with every adjective used to describe the snacks (not adjectives about other things), with columns: adjective · number of notes that used it · a short example quote · sentiment (positive/neutral/negative). Normalize variants (e.g. "tastier" → "tasty") and sort from most to least used. If a transcript is in another language, keep the original word and add the English translation.
3. **What people like most** — a ranked list, most-cited first.
4. **Themes** — up to 6 recurring themes, one sentence each, with how many notes mention them.

Then offer to turn the adjective ranking into a chart.`;
  }

  $("copy").addEventListener("click", async () => {
    const text = buildPrompt();
    const n = notes.filter((x) => x.transcript).length;
    try {
      await navigator.clipboard.writeText(text);
      $("copy-fallback").hidden = true;
      $("copy-msg").textContent = `Copied ${n} transcript${n === 1 ? "" : "s"}. Now paste it into a new Claude chat.`;
    } catch {
      const ta = $("copy-fallback");
      ta.hidden = false;
      ta.value = text;
      ta.focus();
      ta.select();
      $("copy-msg").textContent = "Your browser blocked automatic copying — the text is selected below, press Ctrl+C / ⌘C.";
    }
  });

  init();
})();
