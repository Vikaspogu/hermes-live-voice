(function () {
  "use strict";
  // talk-desktop — Web/PWA voice client. Ports the codex-live WebRTC flow from
  // desktop/plugin.js into the dashboard plugin convention (IIFE, SDK global,
  // cookie-auth same-origin fetch). No build step, no desktop-only SDK APIs.
  // ponytail: no waveform, mic-device picker, engine fallback, or barge-in —
  // add by porting from desktop/plugin.js if the phone needs them.
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;
  const React = SDK.React;
  const h = React.createElement;
  const API = "/api/plugins/talk-desktop";

  const IDLE_MS = 2600;

  async function rest(path, body) {
    const r = await fetch(API + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(r.status + ": " + (await r.text()).slice(0, 200));
    return r.json();
  }
  async function apiGet(path) {
    const r = await fetch(API + path, { method: "GET", credentials: "same-origin" });
    if (!r.ok) throw new Error(r.status + ": " + (await r.text()).slice(0, 200));
    return r.json();
  }

  function playChime(kind) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      const notes = kind === "connect" ? [523.25, 659.25, 783.99] : [659.25, 523.25, 392.0];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0, now + i * 0.08);
        g.gain.linearRampToValueAtTime(0.12, now + i * 0.08 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.28);
        o.connect(g); g.connect(ctx.destination);
        o.start(now + i * 0.08); o.stop(now + i * 0.08 + 0.3);
      });
      setTimeout(() => { try { ctx.close(); } catch {} }, 900);
    } catch {}
  }

  function VoicePanel() {
    const [stage, setStage] = React.useState("");
    const [err, setErr] = React.useState("");
    const [muted, setMuted] = React.useState(false);
    const [live, setLive] = React.useState(false);
    const [items, setItems] = React.useState([]);
    const [micLevel, setMicLevel] = React.useState(0);
    const [login, setLogin] = React.useState(null); // {url, code, message, done}
    const [engine, setEngine] = React.useState("codex"); // codex = gpt-live-1, hermes = gpt-realtime-2.1 (existing login)
    const refs = React.useRef(null); // {pc, stream, dc, threadId, timers, audioCtx}

    const push = (who, text) => {
      setItems(prev => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.who === who && !last.done) last.text += text;
        else next.push({ who, text, at: Date.now(), done: false });
        return next;
      });
    };
    const sys = (text) => setItems(prev => prev.concat([{ who: "sys", text, at: Date.now(), done: true }]));
    const finalize = (who, text) => {
      setItems(prev => {
        const next = prev.slice();
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].who === who && !next[i].done) { next[i] = { ...next[i], text, done: true }; break; }
        }
        return next;
      });
    };

    React.useEffect(() => {
      const iv = setInterval(() => {
        setItems(prev => {
          const now = Date.now();
          let changed = false;
          for (const it of prev) if (!it.done && now - it.at > IDLE_MS) { it.done = true; changed = true; }
          return changed ? prev.slice() : prev;
        });
      }, 1000);
      return () => clearInterval(iv);
    }, []);

    const stop = async () => {
      const r = refs.current;
      refs.current = null;
      setLive(false); setMuted(false); setStage("");
      if (!r) return;
      r.timers.forEach(t => clearInterval(t));
      try { r.stream.getTracks().forEach(t => t.stop()); } catch {}
      try { r.pc.close(); } catch {}
      try { r.audioCtx && r.audioCtx.close(); } catch {}
      if (r.threadId) { try { await rest("/codexlive/stop", { threadId: r.threadId }); } catch {} }
      playChime("end");
    };

    const start = async () => {
      setErr(""); setItems([]); setStage("requesting mic…");
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        setErr("Microphone blocked: " + (e && e.name || "") + " — allow mic access and try again.");
        return;
      }

      const pc = new RTCPeerConnection();
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      const dc = pc.createDataChannel("oai-events");
      dc.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const t = msg && msg.type;
        if (!t) return;
        if (t === "input_transcript.added") { const tx = (msg.item || {}).text; if (tx) push("user", tx); }
        else if (t === "output_transcript.added") { const tx = (msg.item || {}).text; if (tx) push("bot", tx); }
        else if (t === "turn.done") {
          const tu = msg.turn || {};
          if (tu.role === "user") finalize("user", tu.transcript || "");
          else if (tu.role === "assistant") finalize("bot", tu.transcript || "");
        }
        else if (t === "session.usage.updated") { /* ponytail: track live minutes later if a cap matters */ }
        else if (t === "error") { const m = msg.error && (msg.error.message || msg.error.code); if (m) sys("error: " + String(m).slice(0, 160)); }
        // ── Hermes engine (gpt-realtime-2.1, existing Hermes login) ──
        else if (t === "conversation.item.input_audio_transcription.delta") push("user", msg.delta || "");
        else if (t === "conversation.item.input_audio_transcription.completed") finalize("user", msg.transcript || "");
        else if (t === "response.output_audio_transcript.delta") push("bot", msg.delta || "");
        else if (t === "response.output_audio_transcript.done") finalize("bot", msg.transcript || "");
        else if (t === "response.function_call_arguments.done") { /* ponytail: voice tools not wired in the web client yet */ }
        else if (t === "delegation.created") {
          // Codex Live lane-v3 delegation: run the task server-side and feed
          // the result back so the voice model can read it aloud.
          const item = (msg.item || {});
          let dreq = "";
          try { if (Array.isArray(item.content)) dreq = item.content.map(c => (c && c.text) || "").join(""); } catch {}
          dreq = String(dreq || "").trim() || (msgs.length ? String(msgs[msgs.length - 1].text || "").slice(0, 500) : "");
          push("tool", "delegation: " + dreq.slice(0, 180));
          (async () => {
            let out = "";
            try { const r = await rest("/codexlive/delegate", { prompt: dreq, language: "en" }); out = (r && r.output) || ""; }
            catch (e) { out = "delegation failed: " + String(e.message || e).slice(0, 140); }
            out = String(out || "The task could not be completed.")
              .replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/\*([^*]+)\*/g, "$1").trim();
            push("tool", "result: " + out.slice(0, 160));
            try { refs.current.dc && refs.current.dc.send(JSON.stringify({
              type: "delegation.context.append", delegation_item_id: String(item.id || ""),
              content: [{ type: "input_text", text: out.slice(0, 3500) }],
            })); } catch {}
          })().catch(() => {});
        }
        else if (t === "response.output_item.done") {
          const item = msg.item || {};
          if (item.type === "function_call" && item.name === "send_to_chat") {
            let args = {}; try { args = JSON.parse(item.arguments || "{}"); } catch {}
            const dreq = String(args.request || args.text || "").trim() || (msgs.length ? String(msgs[msgs.length - 1].text || "").slice(0, 500) : "");
            push("tool", "delegation: " + dreq.slice(0, 180));
            (async () => {
              let out = "";
              try { const r = await rest("/codexlive/delegate", { prompt: dreq, language: "en" }); out = (r && r.output) || ""; }
              catch (e) { out = "delegation failed: " + String(e.message || e).slice(0, 140); }
              out = String(out || "The task could not be completed.")
                .replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/\*([^*]+)\*/g, "$1").trim();
              push("tool", "result: " + out.slice(0, 160));
              try { refs.current.dc && refs.current.dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: out.slice(0, 3500) } })); refs.current.dc.send(JSON.stringify({ type: "response.create" })); } catch {}
            })().catch(() => {});
          }
        }
      };
      pc.ontrack = (ev) => {
        const audio = new Audio();
        audio.srcObject = ev.streams[0];
        audio.autoplay = true;
        audio.play().catch(() => sys("Tap to play audio (autoplay was blocked)."));
      };
      pc.onconnectionstatechange = () => {
        setStage(pc.connectionState);
        if (pc.connectionState === "connected") { playChime("connect"); sys("Live — start talking."); }
        if (pc.connectionState === "failed") { setErr("Connection lost."); stop(); }
      };

      // mic level meter (WebAudio analyser — simple bar, no waveform)
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      const mute = audioCtx.createGain(); mute.gain.value = 0;
      audioCtx.createMediaStreamSource(stream).connect(an);
      an.connect(mute); mute.connect(audioCtx.destination);
      const buf = new Uint8Array(an.frequencyBinCount);
      const lvlTimer = setInterval(() => {
        an.getByteFrequencyData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
        setMicLevel(Math.min(1, (sum / buf.length) / 90));
      }, 150);

      refs.current = { pc, stream, dc, threadId: null, timers: [lvlTimer], audioCtx };
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        setStage("negotiating…");
        if (engine === "codex") {
          const r2 = await rest("/codexlive/session", {
            language: "en", profile: null, voice: "cove", offer: offer.sdp,
          });
          if (!r2 || !r2.answer) throw new Error("no answer SDP");
          refs.current.threadId = r2.threadId || null;
          await pc.setRemoteDescription({ type: "answer", sdp: r2.answer });
        } else {
          // Hermes engine: mint a session with Hermes's own login, then exchange
          // the SDP against offerUrl with the one-shot clientSecret (same flow
          // as desktop/plugin.js mintSession + startLive else-branch).
          const sess = await rest("/session", { language: "en", profile: null, voice: "verse", allowChat: true });
          if (!sess || !sess.offerUrl || !sess.clientSecret) throw new Error("session response missing offerUrl/clientSecret");
          const res = await fetch(sess.offerUrl + "?model=" + encodeURIComponent(sess.model || ""), {
            method: "POST",
            credentials: "same-origin",
            headers: { Authorization: "Bearer " + sess.clientSecret, "Content-Type": "application/sdp" },
            body: offer.sdp,
          });
          if (!res.ok) throw new Error("offer " + res.status + ": " + (await res.text()).slice(0, 140));
          await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
        }
        setLive(true);
      } catch (e) {
        setErr(String(e.message || e).slice(0, 300));
        stop();
      }
    };

    const toggleMute = () => {
      const r = refs.current;
      if (!r) return;
      const next = !muted;
      setMuted(next);
      try { r.pc.getSenders().forEach(s => { if (s.track && s.track.kind === "audio") s.track.enabled = !next; }); } catch {}
      sys(next ? "Microphone muted." : "Microphone on.");
    };

    const signIn = async () => {
      try {
        setLogin({ message: "Requesting login…" });
        const r = await rest("/codex/login/start", {});
        const lg = (r && r.login) || r || {};
        if (!lg.url) { setLogin({ message: String(lg.message || r || "no login URL returned").slice(0, 200) }); return; }
        setLogin({ url: lg.url, code: lg.code || "" });
        const iv = setInterval(async () => {
          try {
            const st = await apiGet("/codex/status");
            if (st && st.configured) {
              clearInterval(iv);
              setLogin(null);
              sys("Codex login complete — tap Start voice.");
            } else if (st && st.login && st.login.message) {
              setLogin(prev => prev && { ...prev, message: String(st.login.message).slice(0, 200) });
            }
          } catch {}
        }, 3000);
      } catch (e) {
        setLogin({ message: String(e.message || e).slice(0, 200) });
      }
    };

    const lastRef = React.useRef(null);
    React.useEffect(() => { if (lastRef.current) lastRef.current.scrollTop = lastRef.current.scrollHeight; }, [items]);

    const bubble = (it, i) => {
      const style = {
        user: { alignSelf: "flex-end", background: "var(--secondary)", color: "var(--secondary-foreground)" },
        bot: { alignSelf: "flex-start", background: "var(--accent-surface)", color: "var(--accent-surface-foreground)" },
        sys: { alignSelf: "center", color: "var(--muted-foreground)", fontSize: "12px" },
      }[it.who] || {};
      return h("div", { key: i, style: { ...style, maxWidth: "80%", padding: "8px 12px", borderRadius: "14px", margin: "2px 0" } }, it.text);
    };

    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", padding: "12px" } },
      h("div", { style: { fontSize: "13px", color: "var(--muted-foreground)", minHeight: "18px" } }, err || stage || (live ? "Live" : "Ready to talk")),
      login && h("div", { style: { padding: "10px", borderRadius: "10px", background: "var(--secondary)", color: "var(--secondary-foreground)", fontSize: "13px", marginBottom: "6px", wordBreak: "break-all" } },
        login.url && h("div", null,
          h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "Sign in to ChatGPT (Codex)"),
          h("div", null, "1. Open: ", h("a", { href: login.url, target: "_blank", rel: "noreferrer" }, login.url)),
          login.code && h("div", { style: { marginTop: "4px" } }, "2. Enter code: ", h("b", null, login.code)),
          h("div", { style: { marginTop: "4px", color: "var(--muted-foreground)" } }, "Waiting for you to authorize…")),
        !login.url && h("div", null, login.message || "Starting login…")),
      h("div", {
        ref: lastRef,
        style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", padding: "6px 0" },
      }, items.map(bubble)),
      h("div", { style: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 0" } },
        h("div", { style: { width: "6px", height: "28px", borderRadius: "3px", background: live ? "var(--accent)" : "var(--border)", opacity: live ? 0.3 + 0.7 * micLevel : 1 } }),
        !live && h("button", {
          onClick: () => setEngine(engine === "codex" ? "hermes" : "codex"),
          style: { padding: "10px 14px", borderRadius: "10px", border: "1px solid var(--border)", background: engine === "codex" ? "var(--card)" : "var(--accent-surface)", color: "var(--card-foreground)", cursor: "pointer", fontSize: "13px" },
        }, engine === "codex" ? "Engine: Codex" : "Engine: Hermes"),
        !live && err && !login && h("button", {
          onClick: signIn,
          style: { padding: "10px 14px", borderRadius: "10px", border: "1px solid var(--border)", background: "var(--card)", color: "var(--card-foreground)", cursor: "pointer" },
        }, "Sign in to Codex"),
        live && h("button", {
          onClick: toggleMute,
          style: { padding: "10px 14px", borderRadius: "10px", border: "1px solid var(--border)", background: "var(--card)", color: "var(--card-foreground)", cursor: "pointer" },
        }, muted ? "Unmute" : "Mute"),
        h("button", {
          onClick: live ? stop : start,
          style: {
            flex: 1, padding: "12px", borderRadius: "12px", border: "none", cursor: "pointer",
            fontSize: "15px", fontWeight: 600,
            background: live ? "var(--destructive)" : "var(--primary)",
            color: live ? "var(--destructive-foreground)" : "var(--primary-foreground)",
          },
        }, live ? "End call" : "Start voice"),
      ),
    );
  }

  try { window.__HERMES_PLUGINS__.register("talk-desktop", VoicePanel); } catch (e) { console.error("talk-desktop web:", e); }
})();
