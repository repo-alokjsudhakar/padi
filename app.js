// Padi (படி) — the web server: API routes, storage and the Claude API proxy.
// Used by server.js on your computer and by api/index.js on Vercel.
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const store = require("./lib/store");
const auth = require("./lib/auth");

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8000;
const ON_VERCEL = !!process.env.VERCEL;
// Vercel limits request bodies to about 4.5 MB, so send fewer, smaller page images there.
const IMAGES = ON_VERCEL ? { maxCount: 2, maxBytes: 1200000 } : { maxCount: 3, maxBytes: 5000000 };

const app = express();
app.use(express.json({ limit: ON_VERCEL ? "4.5mb" : "60mb" }));
if (!ON_VERCEL) app.use(express.static(path.join(__dirname, "public")));

/* ---------- who is asking ---------- */
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const isAdmin = (req) => auth.isOwner(req);
// Signed-in people are identified by their account; guests by a random id their browser keeps.
function identity(req) {
  const s = auth.readSession(req);
  if (s) return s.id;
  const g = req.get("x-padi-user") || "";
  return /^g[A-Za-z0-9]{6,40}$|^u[A-Za-z0-9]{6,40}$/.test(g) ? g : "";
}
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function cleanPath(p, wantDoc) {
  if (typeof p !== "string") return null;
  const parts = p.split("/");
  if (parts.length > 15 || !parts.every((s) => SEG.test(s))) return null;
  if (wantDoc ? parts.length % 2 !== 0 : parts.length % 2 !== 1) return null;
  return parts.join("/");
}
// Anyone may save their own progress (data/users/<their id>/...); everything else needs the owner.
function canWrite(req, p) {
  if (p.startsWith("_")) return false; // account records are never written through this API
  if (isAdmin(req)) return true;
  const uid = identity(req);
  return !!uid && p.startsWith("data/users/" + uid + "/");
}
const bad = (res, msg) => res.status(400).json({ code: "invalid_argument", message: msg });
function needStore(res) {
  if (store) return false;
  res.status(503).json({ code: "unavailable", message: "No database is connected. Add Upstash Redis to this Vercel project (see README)." });
  return true;
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ code: "unavailable", message: e.message }); });

/* ---------- routes ---------- */
app.get("/api/config", (req, res) => {
  const s = auth.readSession(req);
  res.json({ admin: isAdmin(req), user: s ? { id: s.id, name: s.name, email: s.email, picture: s.picture || "", owner: isAdmin(req) } : null,
    googleClientId: auth.GOOGLE_CLIENT_ID || null, accounts: !!store, ai: !!API_KEY, storage: store ? store.kind : "none", images: IMAGES });
});
auth.mount(app, store, wrap);
app.get("/api/status", wrap(async (req, res) => {
  if (needStore(res)) return;
  const fs = require("fs");
  const seedFile = path.join(__dirname, "data", "seed.json");
  const seed = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, "utf8")).docs || {} : {};
  const qs = await store.list("questions"); const ps = await store.list("papers");
  const byTopic = {};
  qs.forEach((q) => { const k = (q.data.category || "?") + " / " + (q.data.topic || "-"); byTopic[k] = (byTopic[k] || 0) + 1; });
  const sig = (v) => (String(v.q) + "|" + [...(v.options || [])].map(String).sort().join("|")).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const groups = {}; qs.forEach((q) => { const k = (q.data.category || "") + "|" + (q.data.topic || "") + "|" + sig(q.data); (groups[k] = groups[k] || []).push(q.id); });
  const dups = Object.values(groups).filter((g) => g.length > 1);
  const notInSeed = qs.filter((q) => !("questions/" + q.id in seed)).length;
  res.json({ storage: store.kind, duplicateQuestionsInOneSection: dups.length, duplicateExamples: dups.slice(0, 10), questionsNotFromSeedFile: notInSeed, questionsInSeedFile: Object.keys(seed).filter((k) => k.startsWith("questions/")).length, questionsInDatabase: qs.length, papersInDatabase: ps.length, byTopic });
}));


app.get("/api/collection", wrap(async (req, res) => {
  if (needStore(res)) return;
  const col = cleanPath(req.query.path, false); if (!col || col.startsWith("_")) return bad(res, "Bad collection path");
  if (col.startsWith("data/users") && !isAdmin(req)) return res.json([]);
  res.json(await store.list(col));
}));
app.get("/api/doc", wrap(async (req, res) => {
  if (needStore(res)) return;
  const p = cleanPath(req.query.path, true); if (!p || p.startsWith("_")) return bad(res, "Bad document path");
  if (p.startsWith("data/users/") && !canWrite(req, p)) return res.json({ exists: false });
  const d = await store.get(p);
  res.json(d === undefined ? { exists: false } : { exists: true, data: d });
}));
app.put("/api/doc", wrap(async (req, res) => {
  if (needStore(res)) return;
  const p = cleanPath(req.query.path, true); if (!p) return bad(res, "Bad document path");
  if (!canWrite(req, p)) return res.status(403).json({ code: "invalid_argument", message: "Only the owner can change the question bank." });
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return bad(res, "Document must be a JSON object");
  await store.set(p, req.body); res.status(204).end();
}));
app.delete("/api/doc", wrap(async (req, res) => {
  if (needStore(res)) return;
  const p = cleanPath(req.query.path, true); if (!p) return bad(res, "Bad document path");
  if (!canWrite(req, p)) return res.status(403).json({ code: "invalid_argument", message: "Only the owner can change the question bank." });
  await store.del(p); res.status(204).end();
}));

app.post("/api/claude", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ code: "not_granted", message: "Only the owner can read PDFs with Claude. Sign in first." });
  if (!API_KEY) return res.status(503).json({ code: "unavailable", message: "No API key. Set ANTHROPIC_API_KEY and restart or redeploy." });
  const { input, images = [], json = false } = req.body || {};
  const imageBlocks = (Array.isArray(images) ? images : []).slice(0, IMAGES.maxCount).map((im) => ({
    type: "image", source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data },
  }));
  const tail = json ? "\n\nReply with only the JSON value, with no other text before or after it." : "";
  let messages;
  if (typeof input === "string") messages = [{ role: "user", content: [...imageBlocks, { type: "text", text: input + tail }] }];
  else if (Array.isArray(input) && input.length) {
    messages = input.map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: [{ type: "text", text: String(t.content) }] }));
    const last = messages[messages.length - 1];
    last.content = [...imageBlocks, ...last.content];
    last.content[last.content.length - 1].text += tail;
  } else return bad(res, "Missing prompt");

  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (body.error && body.error.message) || r.statusText;
      const code = r.status === 429 || r.status === 529 ? "rate_limited" : r.status === 400 ? "invalid_argument" : "unavailable";
      console.error("Claude API error", r.status, msg);
      return res.status(502).json({ code, message: r.status === 401 ? "The API key was rejected. Check ANTHROPIC_API_KEY." : msg });
    }
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    res.json({ text, truncated: body.stop_reason === "max_tokens" });
  } catch (e) {
    if (e.name === "AbortError") return;
    console.error("Claude request failed:", e.message);
    res.status(502).json({ code: "unavailable", message: "Couldn’t reach the Claude API: " + e.message });
  }
});

module.exports = app;
