// Accounts and sign-in for Padi: email + password, or Google.
// Sessions are signed cookies, so no extra database lookups are needed per request.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ON_VERCEL = !!process.env.VERCEL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const COOKIE = "padi_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (tok) return crypto.createHash("sha256").update("padi-session:" + tok).digest("hex");
  // on your own computer: keep a random secret in data/.session-secret
  const f = path.join(__dirname, "..", "data", ".session-secret");
  try { return fs.readFileSync(f, "utf8").trim(); } catch (e) {}
  const s = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(f, s); } catch (e) {}
  return s;
}
const SECRET = secret();

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeSession(user) {
  const payload = b64(JSON.stringify({ id: user.id, email: user.email, name: user.name, picture: user.picture || "", exp: Date.now() + MAX_AGE * 1000 }));
  return payload + "." + sign(payload);
}
function readSession(req) {
  const raw = String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try { const s = JSON.parse(Buffer.from(payload, "base64url").toString()); return s.exp > Date.now() ? s : null; } catch (e) { return null; }
}
function setCookie(res, value, maxAge) {
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${ON_VERCEL ? "; Secure" : ""}`);
}

// The owner can add, edit and delete questions and read PDFs with Claude.
function isOwner(req) {
  const s = readSession(req);
  if (ADMIN_EMAILS.length) return !!(s && ADMIN_EMAILS.includes(String(s.email).toLowerCase()));
  return !ON_VERCEL; // on your own computer with no ADMIN_EMAILS set, everyone is the owner
}

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
const emailKey = (e) => String(e).trim().toLowerCase().replace(/[^a-z0-9_\-.~:@+]/g, "_").slice(0, 190);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

async function verifyGoogle(credential) {
  if (!GOOGLE_CLIENT_ID) throw Object.assign(new Error("Google sign-in isn’t set up on this site."), { status: 400 });
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  const t = await r.json().catch(() => ({}));
  if (!r.ok || t.aud !== GOOGLE_CLIENT_ID || (t.email_verified !== "true" && t.email_verified !== true))
    throw Object.assign(new Error("Google couldn’t confirm that sign-in. Try again."), { status: 401 });
  return { email: String(t.email).toLowerCase(), name: t.name || t.given_name || t.email.split("@")[0], picture: t.picture || "" };
}

// Mounts /api/me, /api/signup, /api/login, /api/google, /api/logout on the Express app.
function mount(app, store, wrap) {
  const fails = new Map();
  const slow = (key) => { const n = (fails.get(key) || 0) + 1; fails.set(key, n); return new Promise((r) => setTimeout(r, Math.min(3000, 400 * n))); };
  const pub = (u, req) => u && { id: u.id, name: u.name, email: u.email, picture: u.picture || "", owner: isOwner(req) };
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

  async function findByEmail(email) {
    const idx = await store.get("_accountemails/" + emailKey(email));
    return idx ? await store.get("_accounts/" + idx.uid) : null;
  }
  async function createAccount(fields) {
    const id = "a" + crypto.randomBytes(8).toString("hex");
    const user = Object.assign({ id, createdAt: Date.now() }, fields);
    await store.set("_accounts/" + id, user);
    await store.set("_accountemails/" + emailKey(fields.email), { uid: id });
    return user;
  }
  // When a guest signs in, carry their scores over if the account has none yet.
  async function adoptGuest(uid, guestId) {
    if (!guestId || !SEG.test(guestId) || guestId === uid) return;
    const from = await store.get("data/users/" + guestId + "/progress");
    if (!from) return;
    const to = await store.get("data/users/" + uid + "/progress");
    if (!to || !(to.history || []).length) await store.set("data/users/" + uid + "/progress", from);
  }
  function startSession(res, req, user) {
    setCookie(res, makeSession(user), MAX_AGE);
    req.headers.cookie = COOKIE + "=" + makeSession(user); // so pub() sees the new session
    res.json({ user: pub(user, req) });
  }

  app.get("/api/me", (req, res) => {
    const s = readSession(req);
    res.json({ user: s ? pub(s, req) : null, owner: isOwner(req), googleClientId: GOOGLE_CLIENT_ID || null, ownerConfigured: ADMIN_EMAILS.length > 0 || !ON_VERCEL });
  });

  app.post("/api/signup", wrap(async (req, res) => {
    if (!store) return res.status(503).json({ message: "No database is connected." });
    const { name, email, password, guestId } = req.body || {};
    if (!String(name || "").trim()) return res.status(400).json({ message: "Enter your name." });
    if (!validEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });
    if (String(password || "").length < 8) return res.status(400).json({ message: "Use a password of at least 8 characters." });
    if (await findByEmail(email)) return res.status(409).json({ message: "An account with this email already exists. Sign in instead." });
    const { salt, hash } = hashPassword(String(password));
    const user = await createAccount({ name: String(name).trim().slice(0, 80), email: String(email).trim().toLowerCase(), provider: "password", salt, hash });
    await adoptGuest(user.id, guestId);
    startSession(res, req, user);
  }));

  app.post("/api/login", wrap(async (req, res) => {
    if (!store) return res.status(503).json({ message: "No database is connected." });
    const { email, password, guestId } = req.body || {};
    const key = emailKey(email || "");
    const user = validEmail(email) ? await findByEmail(email) : null;
    if (!user || !user.hash) { await slow(key); return res.status(401).json({ message: user ? "This account uses Google. Choose Continue with Google." : "That email and password don’t match an account." }); }
    const { hash } = hashPassword(String(password || ""), user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash))) { await slow(key); return res.status(401).json({ message: "That email and password don’t match an account." }); }
    fails.delete(key);
    await adoptGuest(user.id, guestId);
    startSession(res, req, user);
  }));

  app.post("/api/google", wrap(async (req, res) => {
    if (!store) return res.status(503).json({ message: "No database is connected." });
    const { credential, guestId } = req.body || {};
    let g;
    try { g = await verifyGoogle(String(credential || "")); } catch (e) { return res.status(e.status || 401).json({ message: e.message }); }
    let user = await findByEmail(g.email);
    if (!user) user = await createAccount({ name: g.name, email: g.email, picture: g.picture, provider: "google" });
    else if (g.picture && user.picture !== g.picture) { user.picture = g.picture; await store.set("_accounts/" + user.id, user); }
    await adoptGuest(user.id, guestId);
    startSession(res, req, user);
  }));

  app.post("/api/logout", (req, res) => { setCookie(res, "", 0); res.json({ ok: true }); });
}

module.exports = { mount, readSession, isOwner, GOOGLE_CLIENT_ID };
