// Vetri Paathai (வெற்றிப் பாதை) — the web server: API routes, storage and the Claude API proxy.
// Used by server.js on your computer and by api/index.js on Vercel.
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const store = require("./lib/store");
const auth = require("./lib/auth");
const Bank = require("./lib/bank");

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
/* ---------- question bank: small requests only ---------- */
// What the home page needs: subjects, sections and counts (no questions).
app.get("/api/catalogue", wrap(async (req, res) => {
  res.json(Bank.catalogue(await Bank.bank(store, req.query.fresh === "1")));
}));
// Which questions make up a test: returns ids only, in test order.
const MAX_TEST = 200;   // one test holds at most this many questions
app.post("/api/quiz", wrap(async (req, res) => {
  const v = await Bank.bank(store); const spec = req.body || {};
  const all = Bank.pick(v, spec);
  const cap = spec.paper ? all.length : Math.min(all.length, Number(spec.limit) || MAX_TEST);
  res.json({ total: cap, available: all.length, ids: all.slice(0, cap) });
}));
// The questions themselves, at most 50 per request (the app asks for 10 at a time).
app.post("/api/questions", wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  res.json({ items: Bank.byIds(await Bank.bank(store), ids) });
}));
// One section or one source of the question bank, a page at a time (owner's Question bank view).
app.get("/api/section", wrap(async (req, res) => {
  const v = await Bank.bank(store);
  const ids = req.query.paper ? (v.byPaper.get(String(req.query.paper)) || []) : Bank.sectionIds(v, String(req.query.cat || ""), String(req.query.topic || ""));
  res.json(Bank.page(v, ids, req.query.offset, req.query.limit));
}));
app.get("/api/status", wrap(async (req, res) => {
  const v = await Bank.bank(store, true); const c = Bank.catalogue(v);
  const bySection = {}; c.cats.forEach((x) => x.sections.forEach((s) => { bySection[x.cat + " / " + s.name] = s.n; }));
  const overlay = store ? await store.count("questions") : 0;
  res.json({ storage: store ? store.kind : "none", questionsInBank: v.questions.size, questionsInSeedFile: Bank.loadBase().questions.size, questionsForPractice: c.total,
    questionsAddedOrEditedInApp: overlay, sources: v.papers.size, subjects: c.cats.map((x) => ({ subject: x.cat, sections: x.sections.length, questions: x.n })), bySection });
}));

app.get("/api/collection", wrap(async (req, res) => {
  if (needStore(res)) return;
  const col = cleanPath(req.query.path, false); if (!col || col.startsWith("_")) return bad(res, "Bad collection path");
  if (col.startsWith("data/users") && !isAdmin(req)) return res.json([]);
  if ((col === "questions" || col === "papers") && !isAdmin(req)) return res.json([]);   // only in-app additions live here, and only the owner needs them
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
  await store.set(p, req.body); if (/^(questions|papers)\//.test(p)) Bank.invalidate(); res.status(204).end();
}));
app.delete("/api/doc", wrap(async (req, res) => {
  if (needStore(res)) return;
  const p = cleanPath(req.query.path, true); if (!p) return bad(res, "Bad document path");
  if (!canWrite(req, p)) return res.status(403).json({ code: "invalid_argument", message: "Only the owner can change the question bank." });
  // Something that came from seed.json can't be deleted from the database, so it is hidden with a marker instead.
  const m = p.match(/^(questions|papers)\/(.+)$/);
  if (m && Bank.inSeed(m[1], m[2])) await store.set(p, { deleted: true }); else await store.del(p);
  if (m) Bank.invalidate();
  res.status(204).end();
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
