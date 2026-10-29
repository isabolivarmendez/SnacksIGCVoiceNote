(() => {
  const MAX_SECONDS = 180;
  const $ = (id) => document.getElementById(id);
  const steps = ["step-name", "step-record", "step-review", "step-done"];
  const show = (id) => steps.forEach((s) => $(s).classList.toggle("active", s === id));

  const cfg = window.WISHERS_CONFIG || {};
  const sb = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
    : null;
  if (!sb) $("setup-warn").hidden = false;

  let name = "";
  try { name = localStorage.getItem("wishers_name") || ""; } catch {}
  $("name").value = name;

  // Idioma por defecto según el navegador
  const navLang = (navigator.language || "en").slice(0, 2);
  $("lang").value = navLang === "es" ? "es-ES" : navLang === "pt" ? "pt-BR" : "en-US";

  let recorder = null, stream = null, chunks = [], blob = null, startedAt = 0, duration = 0;
  let tick = null, audioCtx = null, raf = null;

  // ---------- Transcripción gratis del navegador (Web Speech API) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, wantSR = false, srFinal = "", srInterim = "", srWorked = false, srEnded = null;

  function startSR() {
    srFinal = ""; srInterim = ""; srWorked = false;
    if (!SR) return;
    try {
      rec = new SR();
      rec.lang = $("lang").value;
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        srWorked = true;
        srInterim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) srFinal += t.trim() + " ";
          else srInterim += t;
        }
        const live = $("live");
        live.hidden = false;
        live.textContent = (srFinal + srInterim).trim();
        live.scrollTop = live.scrollHeight;
      };
      rec.onerror = (e) => {
        if (["not-allowed", "service-not-allowed", "language-not-supported"].includes(e.error)) wantSR = false;
      };
      rec.onend = () => {
        // Chrome corta tras silencios: se reinicia mientras se esté grabando
        if (wantSR) { try { rec.start(); } catch {} }
        else if (srEnded) { srEnded(); srEnded = null; }
      };
      wantSR = true;
      rec.start();
    } catch { wantSR = false; }
  }
  function stopSR() {
    return new Promise((resolve) => {
      if (!rec || !wantSR) { wantSR = false; return resolve(); }
      wantSR = false;
      srEnded = resolve;
      try { rec.stop(); } catch { resolve(); }
      setTimeout(resolve, 1500); // no esperar para siempre
    });
  }
  const transcriptText = () => (srFinal + srInterim).replace(/\s+/g, " ").trim();

  // ---------- Paso 1: nombre ----------
  $("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("name").value.trim();
    if (!v) { $("name-error").textContent = "Please enter your name."; return; }
    name = v;
    try { localStorage.setItem("wishers_name", v); } catch {}
    $("hello").textContent = `Nice to meet you, ${v.split(" ")[0]}`;
    resetRecorder();
    show("step-record");
  });

  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  if (!canRecord) $("fallback").hidden = false;

  function pickMime() {
    const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return options.find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  function resetRecorder() {
    $("timer").textContent = "0:00";
    $("rec-hint").textContent = `Tap to start · up to ${MAX_SECONDS / 60} minutes`;
    $("rec-error").textContent = "";
    $("live").hidden = true;
    $("live").textContent = "";
    $("lang").disabled = false;
    $("mic").classList.remove("recording");
    clearWave();
  }

  // ---------- Paso 2: grabar ----------
  $("mic").addEventListener("click", async () => {
    if (recorder && recorder.state === "recording") return stop();
    if (!canRecord) { $("fallback").hidden = false; return; }
    $("rec-error").textContent = "";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      $("rec-error").textContent = "We couldn't access your microphone. Please allow microphone access in your browser and try again.";
      $("fallback").hidden = false;
      return;
    }
    const mime = pickMime();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      blob = new Blob(chunks, { type: (recorder.mimeType || mime || "audio/webm").split(";")[0] });
      stream.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(raf);
      audioCtx?.close();
      await stopSR();
      goReview(transcriptText());
    };
    recorder.start(250);
    startSR();
    startedAt = Date.now();
    $("lang").disabled = true;
    $("mic").classList.add("recording");
    $("mic").setAttribute("aria-label", "Stop recording");
    $("rec-hint").textContent = "Recording… tap to stop";
    tick = setInterval(() => {
      duration = (Date.now() - startedAt) / 1000;
      $("timer").textContent = fmt(duration);
      if (duration >= MAX_SECONDS) stop();
    }, 200);
    drawWave(stream);
  });

  function stop() {
    clearInterval(tick);
    duration = (Date.now() - startedAt) / 1000;
    $("mic").classList.remove("recording");
    $("mic").setAttribute("aria-label", "Start recording");
    if (duration < 2) {
      recorder.onstop = () => { stream.getTracks().forEach((t) => t.stop()); audioCtx?.close(); };
      recorder.stop();
      stopSR();
      resetRecorder();
      $("rec-error").textContent = "That was very short — try again and tell us a bit more!";
      return;
    }
    $("rec-hint").textContent = "Finishing…";
    recorder.stop();
  }

  function drawWave(s) {
    const canvas = $("wave"), ctx = canvas.getContext("2d");
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(s).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = 48;
    const loop = () => {
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const w = canvas.width / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) * data.length * 0.7)] / 255;
        const h = Math.max(4, v * canvas.height);
        ctx.fillStyle = "#e2573b";
        ctx.globalAlpha = 0.35 + v * 0.65;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(i * w + 2, (canvas.height - h) / 2, w - 4, h, 3) : ctx.rect(i * w + 2, (canvas.height - h) / 2, w - 4, h);
        ctx.fill();
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  }
  function clearWave() { const c = $("wave"); c.getContext("2d").clearRect(0, 0, c.width, c.height); }

  // Alternativa: archivo (en el celular abre la grabadora nativa)
  $("file-input").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) { $("rec-error").textContent = "That file is too large (max 25 MB)."; return; }
    blob = f;
    duration = 0;
    srWorked = false;
    goReview("");
    e.target.value = "";
  });

  // ---------- Paso 3: revisar y enviar ----------
  function goReview(text) {
    $("preview").src = URL.createObjectURL(blob);
    $("transcript").value = text;
    $("transcript-label").textContent = srWorked
      ? "Here's what we heard — fix anything we got wrong"
      : "We couldn't transcribe automatically. If you can, type a quick version of what you said (optional)";
    $("send-error").textContent = "";
    $("send").disabled = false;
    $("send").textContent = "Send voice note";
    show("step-review");
  }
  $("redo").addEventListener("click", () => { resetRecorder(); show("step-record"); });

  $("send").addEventListener("click", async () => {
    if (!sb) { $("send-error").textContent = "This page isn't connected to storage yet."; return; }
    $("send").disabled = true;
    $("send").textContent = "Sending…";
    $("send-error").textContent = "";
    const type = (blob.type || "audio/webm").split(";")[0];
    const ext = type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? "m4a"
      : type.includes("ogg") ? "ogg" : type.includes("mpeg") ? "mp3" : type.includes("wav") ? "wav" : "webm";
    const id = crypto.randomUUID();
    const path = `${id}.${ext}`;
    try {
      const up = await sb.storage.from("recordings").upload(path, blob, { contentType: type, upsert: false });
      if (up.error) throw up.error;
      const ins = await sb.from("notes").insert({
        id, name, audio_path: path, mime: type,
        duration: Math.round(duration),
        transcript: $("transcript").value.trim().slice(0, 10000) || null,
        lang: $("lang").value,
      });
      if (ins.error) throw ins.error;
      show("step-done");
    } catch (err) {
      console.error(err);
      $("send-error").textContent = "Something went wrong sending your note. Please try again.";
      $("send").disabled = false;
      $("send").textContent = "Send voice note";
    }
  });

  $("another").addEventListener("click", () => { resetRecorder(); show("step-record"); });
})();
