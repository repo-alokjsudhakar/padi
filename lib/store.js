// Storage for Vetri Paathai. Uses Upstash Redis when its environment variables are set
// (as on Vercel), otherwise a JSON file in data/ (for running on your own computer).
const fs = require("fs");
const path = require("path");

const SEED = path.join(__dirname, "..", "data", "seed.json");
const split = (p) => { const i = p.lastIndexOf("/"); return [p.slice(0, i), p.slice(i + 1)]; };

function redisStore(url, token) {
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({ url, token });
  const key = (col) => "padi:c:" + col;
  const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  const BANK = (col) => col === "questions" || col === "papers";   // in-app additions to the question bank
  const VER = "padi:bankver";      // bumped on every change to questions/papers, so servers know when to re-read
  const BATCH = 500;               // fields per HSCAN / HDEL, so no single request is large

  // Read a whole hash a page at a time (never one giant HGETALL).
  async function scanAll(col, each) {
    let cursor = "0";
    do {
      const [next, flat] = await redis.hscan(key(col), cursor, { count: BATCH });
      for (let i = 0; i < flat.length; i += 2) each(String(flat[i]), parse(flat[i + 1]));
      cursor = String(next);
    } while (cursor !== "0");
  }
  async function delMany(col, ids) {
    for (let i = 0; i < ids.length; i += BATCH) await redis.hdel(key(col), ...ids.slice(i, i + BATCH));
  }

  // Keep the database in step with data/seed.json. The question bank itself is served from
  // seed.json and never copied here; this database holds only what people add in the app,
  // plus accounts and progress. When a deploy ships a changed seed.json, this tidies up once:
  // it removes copies an older version of the app made of seed questions, and anything seed.json
  // lists as removed. It runs only for question-bank reads/writes (never for sign-in), only
  // one server does it at a time, and it works in batches.
  const crypto = require("crypto");
  let seeded = null, busyAt = 0;
  async function ensureSeed() {
    if (busyAt && Date.now() - busyAt > 30000) { seeded = null; busyAt = 0; }   // another server was syncing; check again
    if (!seeded) seeded = (async () => {
      const raw = fs.existsSync(SEED) ? fs.readFileSync(SEED, "utf8") : "";
      if (!raw) return;
      const hash = crypto.createHash("sha1").update(raw).digest("hex");
      if ((await redis.get("padi:seedhash")) === hash) return;
      // Another server may be doing this right now; if so, don't pile on.
      if (!(await redis.set("padi:seedlock", "1", { nx: true, ex: 240 }))) { busyAt = Date.now(); return; }
      try {
        const seed = JSON.parse(raw);
        const seedDocs = seed.docs || {};
        let changed = false;
        // Old copies of seed questions/papers: list ids only (HKEYS), delete in batches.
        for (const col of ["questions", "papers"]) {
          const ids = ((await redis.hkeys(key(col))) || []).map(String);
          const drop = ids.filter((id) => (col + "/" + id) in seedDocs);
          if (drop.length) { await delMany(col, drop); changed = true; console.log("Removed " + drop.length + " old copies from " + col); }
        }
        // Other seed documents (not questions/papers), written in batches.
        const byCol = {};
        for (const [p, doc] of Object.entries(seedDocs)) {
          const [col, id] = split(p);
          if (!BANK(col)) (byCol[col] = byCol[col] || {})[id] = JSON.stringify(doc);
        }
        for (const [col, fields] of Object.entries(byCol)) {
          const ids = Object.keys(fields);
          for (let i = 0; i < ids.length; i += 200) { const part = {}; ids.slice(i, i + 200).forEach((k) => (part[k] = fields[k])); await redis.hset(key(col), part); }
        }
        // Anything seed.json says was removed, and seed documents an earlier seed.json had that are gone now.
        const now = Object.keys(seedDocs).filter((p) => !/^(questions|papers)\//.test(p)); const nowSet = new Set(now);
        let prev = await redis.get("padi:seedkeys"); if (typeof prev === "string") { try { prev = JSON.parse(prev); } catch (e) { prev = []; } }
        const gone = {};
        for (const p of (seed.removed || []).concat((Array.isArray(prev) ? prev : []).filter((p) => !nowSet.has(p)))) { const [col, id] = split(p); (gone[col] = gone[col] || []).push(id); }
        for (const [col, ids] of Object.entries(gone)) { await delMany(col, ids); if (BANK(col)) changed = true; }
        // Sets made by scripts/add-questions.js that are no longer in seed.json (from before key tracking)
        const stale = new Set();
        await scanAll("papers", (id, v) => { if (!(("papers/" + id) in seedDocs) && String((v && v.note) || "").startsWith("Added with scripts/add-questions.js")) stale.add(id); });
        if (stale.size) {
          const qs = []; await scanAll("questions", (id, v) => { if (v && stale.has(v.paperId)) qs.push(id); });
          await delMany("questions", qs); await delMany("papers", [...stale]); changed = true;
        }
        await redis.set("padi:seedkeys", JSON.stringify(now));
        if (changed) await redis.incr(VER);
        await redis.set("padi:seedhash", hash);
        console.log("Synced the database with data/seed.json");
      } finally { await redis.del("padi:seedlock"); }
    })().catch((e) => { seeded = null; console.error("Seed sync failed (will retry later):", e.message); });
    return seeded;
  }
  const bankOnly = (col) => (BANK(col) ? ensureSeed() : null);
  return {
    kind: "redis",
    // Reads a whole collection in pages. Used for the (small) in-app additions to the bank.
    async list(col) { await bankOnly(col); const out = []; await scanAll(col, (id, data) => out.push({ id, data })); return out; },
    async count(col) { await bankOnly(col); return Number(await redis.hlen(key(col))) || 0; },
    // A number that changes whenever in-app questions/papers change: one tiny GET.
    async version() { await ensureSeed(); return String((await redis.get(VER)) || "0"); },
    async get(p) { const [col, id] = split(p); await bankOnly(col); const v = await redis.hget(key(col), id); return v == null ? undefined : parse(v); },
    async set(p, doc) { const [col, id] = split(p); await bankOnly(col); await redis.hset(key(col), { [id]: JSON.stringify(doc) }); if (BANK(col)) await redis.incr(VER); },
    async del(p) { const [col, id] = split(p); await bankOnly(col); await redis.hdel(key(col), id); if (BANK(col)) await redis.incr(VER); },
  };
}

function fileStore() {
  const dir = path.join(__dirname, "..", "data");
  const file = path.join(dir, "bank.json");
  const raw = fs.existsSync(SEED) ? fs.readFileSync(SEED, "utf8") : "";
  const hash = raw ? require("crypto").createHash("sha1").update(raw).digest("hex") : "";
  const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, docs: {} };
  store.docs = store.docs || {};
  if (fs.existsSync(file)) {
    // daily backup before any changes
    const bdir = path.join(dir, "backups"); fs.mkdirSync(bdir, { recursive: true });
    const bfile = path.join(bdir, "bank-" + new Date().toISOString().slice(0, 10) + ".json");
    if (!fs.existsSync(bfile)) fs.copyFileSync(file, bfile);
  }
  if (raw && store.seedhash !== hash) {
    // add new questions from seed.json (and update the ones it already shipped);
    // your progress and papers you added in the app are kept
    const seedAll = JSON.parse(raw).docs || {};
    // The bank is served from seed.json; this file keeps only in-app additions and progress.
    for (const p of Object.keys(store.docs)) if (p in seedAll && /^(questions|papers)\//.test(p)) delete store.docs[p];
    const seed = Object.fromEntries(Object.entries(seedAll).filter(([p]) => !/^(questions|papers)\//.test(p)));
    Object.assign(store.docs, seed);
    for (const p of JSON.parse(raw).removed || []) delete store.docs[p];
    // Keep the database a mirror of seed.json for everything that came from it:
    // anything an earlier seed.json added that is no longer there is removed.
    for (const p of store.seedkeys || []) if (!(p in seed)) delete store.docs[p];
    const stale = Object.keys(store.docs).filter((k) => k.startsWith("papers/") && !(k in seed) && String(store.docs[k].note || "").startsWith("Added with scripts/add-questions.js")).map((k) => k.slice(7));
    for (const k of Object.keys(store.docs)) if ((k.startsWith("questions/") && stale.includes(store.docs[k].paperId)) || (k.startsWith("papers/") && stale.includes(k.slice(7)))) delete store.docs[k];
    store.seedkeys = Object.keys(seed);
    store.seedhash = hash;
    fs.writeFileSync(file, JSON.stringify(store));
    console.log("Question bank: " + Object.keys(seedAll).filter((k) => k.startsWith("questions/")).length + " questions ready from data/seed.json.");
  }
  let t = null, ver = 0;
  const save = () => { clearTimeout(t); t = setTimeout(() => { fs.writeFileSync(file + ".tmp", JSON.stringify(store)); fs.renameSync(file + ".tmp", file); }, 150); };
  return {
    kind: "file",
    async list(col) {
      const pre = col + "/"; const out = [];
      for (const [k, v] of Object.entries(store.docs)) if (k.startsWith(pre) && !k.slice(pre.length).includes("/")) out.push({ id: k.slice(pre.length), data: v });
      return out;
    },
    async count(col) { return (await this.list(col)).length; },
    async version() { return String(ver); },
    async get(p) { return store.docs[p]; },
    async set(p, doc) { store.docs[p] = doc; save(); if (/^(questions|papers)\//.test(p)) ver++; },
    async del(p) { delete store.docs[p]; save(); if (/^(questions|papers)\//.test(p)) ver++; },
  };
}

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
let store;
if (url && token) store = redisStore(url, token);
else if (process.env.VERCEL) store = null; // no writable disk on Vercel: a database is required
else store = fileStore();
module.exports = store;
