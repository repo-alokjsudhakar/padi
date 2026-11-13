// Runtime for Vetri Paathai (வெற்றிப் பாதை) outside claude.ai.
// The app was first built as a Claude artifact, which talks to a `window.claude` runtime.
// This file provides the same small interface (db, user, sample, downloads) backed by
// this project's server, so the app code in index.html runs unchanged.
// It also adds an "Owner sign in" link for the person who manages the question bank.
(function () {
  "use strict";
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };

  // Guests get a random id per browser so their scores are kept; signed-in people use their account.
  let guestId = LS.get("padi:uid");
  if (!guestId) { guestId = "g" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); LS.set("padi:uid", guestId); }
  LS.set("padi:admin", null);
  const headers = (json) => {
    const h = { "x-padi-user": guestId };
    if (json) h["Content-Type"] = "application/json";
    return h;
  };
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: headers(!!body), body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const e = new Error(j.message || r.statusText); e.code = j.code || "unavailable"; throw e;
    }
    return r.status === 204 ? null : r.json();
  }
  const config = fetch("/api/config", { headers: headers(false) }).then((r) => r.json()).catch(() => ({ admin: false, ai: false, user: null, images: { maxCount: 2, maxBytes: 1200000 } }));

  /* ---------- db ---------- */
  const listeners = {}, pending = {};
  const parentOf = (p) => p.split("/").slice(0, -1).join("/");
  async function snapshot(col) {
    const rows = await api("GET", "/api/collection?path=" + encodeURIComponent(col));
    return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })), metadata: { fromCache: false } };
  }
  function notify(col) {
    if (!listeners[col] || !listeners[col].size) return;
    clearTimeout(pending[col]);
    pending[col] = setTimeout(async () => {
      try { const s = await snapshot(col); listeners[col].forEach((l) => l.cb(s)); }
      catch (e) { listeners[col].forEach((l) => l.err && l.err(e)); }
    }, 150);
  }
  // The question bank is no longer fetched through this interface: the app asks the
  // server for a catalogue and for small pages of questions (see /api/catalogue,
  // /api/quiz, /api/questions, /api/section). Only questions added or edited inside
  // the app live in these collections.
  const db = {
    collection(col) {
      return {
        onSnapshot(cb, err) {
          const l = { cb, err };
          (listeners[col] || (listeners[col] = new Set())).add(l);
          snapshot(col).then(cb, (e) => err && err(e));
          return () => listeners[col].delete(l);
        },
        get: () => snapshot(col),
      };
    },
    doc(p) {
      const q = "/api/doc?path=" + encodeURIComponent(p);
      return {
        async get() { const r = await api("GET", q); return { id: p.split("/").pop(), exists: r.exists, data: () => r.data }; },
        async set(data) { await api("PUT", q, data); notify(parentOf(p)); },
        async delete() { await api("DELETE", q); notify(parentOf(p)); },
      };
    },
  };

  /* ---------- user ---------- */
  const user = {
    id: async () => { const c = await config; return c.user ? c.user.id : guestId; },
    canEdit: async () => !!(await config).admin,
    can: async () => !!(await config).admin,
  };

  /* ---------- sample: ask Claude through the server ---------- */
  const fail = (code, message, text) => ({ code, message, text });
  async function toBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer()); let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function ask(input, opts, wantJson) {
    opts = opts || {};
    const list = !opts.images ? [] : opts.images instanceof Blob ? [opts.images] : Array.from(opts.images);
    const images = await Promise.all(list.map(async (b) => ({ media_type: b.type || "image/jpeg", data: await toBase64(b) })));
    if (opts.signal && opts.signal.aborted) throw fail("cancelled", "Stopped.");
    let r;
    try {
      r = await fetch("/api/claude", { method: "POST", headers: headers(true), body: JSON.stringify({ input, images, json: wantJson }), signal: opts.signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw fail("cancelled", "Stopped.");
      throw fail("unavailable", "Couldn’t reach the server.");
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(j.code || "unavailable", j.message || (r.status === 413 ? "The page images were too large to send." : "Server error " + r.status));
    if (opts.onText) opts.onText({ text: j.text, delta: j.text });
    return { text: j.text, truncated: !!j.truncated };
  }
  function parseLoose(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch (e) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
    const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    return undefined;
  }
  const sample = (input, opts) => ask(input, opts, false);
  sample.json = async (input, opts) => {
    const { text, truncated } = await ask(input, opts, true);
    if (truncated) throw fail("invalid_json", "The answer was cut short. Raise MAX_TOKENS.", text);
    const v = parseLoose(text); if (v === undefined) throw fail("invalid_json", "Claude’s answer wasn’t valid JSON.", text);
    return v;
  };
  sample.limits = async () => {
    const c = await config;
    return { maxInputBytes: 262144, images: { maxCount: c.images.maxCount, maxBytes: c.images.maxBytes, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } };
  };

  /* ---------- downloads ---------- */
  const downloads = {
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename || "download";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
  };

  window.claude = {
    async use(name) {
      const c = await config;
      if (name === "sample") return c.admin && c.ai ? sample : null;
      if (name === "downloads") return c.admin ? downloads : null;
      return { db, user }[name] || null;
    },
  };

  /* ---------- accounts ---------- */
  async function post(url, body) {
    let r;
    try { r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ guestId }, body || {})) }); }
    catch (e) { return { error: "Couldn’t reach the server. Check your connection." }; }
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.message || "Something went wrong (" + r.status + ")." };
  }
  window.padiAuth = {
    ready: config.then((c) => ({ user: c.user || null, owner: !!c.admin, googleClientId: c.googleClientId || null, accounts: c.accounts !== false })),
    signup: (name, email, password) => post("/api/signup", { name, email, password }),
    login: (email, password) => post("/api/login", { email, password }),
    google: (credential) => post("/api/google", { credential }),
    logout: () => post("/api/logout"),
  };
})();
