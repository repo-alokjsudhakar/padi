// Runtime for Padi (படி) outside claude.ai.
// The app was first built as a Claude artifact, which talks to a `window.claude` runtime.
// This file provides the same small interface (db, user, sample, downloads) backed by
// this project's server, so the app code in index.html runs unchanged.
// It also adds an "Owner sign in" link for the person who manages the question bank.
(function () {
  "use strict";
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };

  // A random id per browser, so each visitor keeps their own scores.
  let uid = LS.get("padi:uid");
  if (!uid) { uid = "u" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); LS.set("padi:uid", uid); }
  const headers = (json) => {
    const h = { "x-padi-user": uid };
    const k = LS.get("padi:admin"); if (k) h["x-padi-admin"] = k;
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
  const config = fetch("/api/config", { headers: headers(false) }).then((r) => r.json()).catch(() => ({ admin: false, ai: false, images: { maxCount: 2, maxBytes: 1200000 } }));

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
    id: async () => uid,
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

  /* ---------- owner sign in ---------- */
  document.addEventListener("DOMContentLoaded", async () => {
    const c = await config;
    if (!c.passwordSet) return; // running locally without a password: you are already the owner
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = c.admin ? "Sign out (owner)" : "Owner sign in";
    link.style.cssText = "position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:15;font:600 .8rem var(--body,system-ui);color:var(--ink-2,#555);background:var(--surface,#fff);border:1px solid var(--line,#ccc);border-radius:999px;padding:6px 12px;cursor:pointer;opacity:.85";
    link.onclick = async () => {
      if (c.admin) { LS.set("padi:admin", null); location.reload(); return; }
      const pw = prompt("Owner password");
      if (!pw) return;
      const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
      if (r.ok) { LS.set("padi:admin", pw); location.reload(); } else alert("That password isn’t right.");
    };
    document.body.appendChild(link);
  });
})();
