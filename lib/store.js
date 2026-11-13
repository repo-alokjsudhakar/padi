// Storage for Padi. Uses Upstash Redis when its environment variables are set
// (as on Vercel), otherwise a JSON file in data/ (for running on your own computer).
const fs = require("fs");
const path = require("path");

const SEED = path.join(__dirname, "..", "data", "seed.json");
const seedDocs = () => (fs.existsSync(SEED) ? JSON.parse(fs.readFileSync(SEED, "utf8")).docs || {} : {});
const split = (p) => { const i = p.lastIndexOf("/"); return [p.slice(0, i), p.slice(i + 1)]; };

function redisStore(url, token) {
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({ url, token });
  const key = (col) => "padi:c:" + col;
  const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  // Keep the database in step with data/seed.json. Each deploy that ships a changed
  // seed.json adds its new papers and questions (and updates the ones it already
  // shipped) the first time the app runs. Other data, like visitors' progress and
  // papers you add yourself in the app, is left alone.
  const crypto = require("crypto");
  let seeded = null;
  async function ensureSeed() {
    if (!seeded) seeded = (async () => {
      const raw = fs.existsSync(SEED) ? fs.readFileSync(SEED, "utf8") : "";
      if (!raw) return;
      const hash = crypto.createHash("sha1").update(raw).digest("hex");
      if ((await redis.get("padi:seedhash")) === hash) return;
      // The question bank itself is served from data/seed.json and is never copied here;
      // this database holds only what people add in the app, plus their progress.
      const seedDocs = JSON.parse(raw).docs || {};
      const byCol = {};
      for (const [p, doc] of Object.entries(seedDocs)) {
        const [col, id] = split(p);
        if (col === "questions" || col === "papers") continue;
        (byCol[col] = byCol[col] || {})[id] = JSON.stringify(doc);
      }
      // Clear anything an older version copied in from seed.json.
      for (const col of ["questions", "papers"]) {
        const have = (await redis.hgetall(key(col))) || {};
        const drop = Object.keys(have).filter((id) => (col + "/" + id) in seedDocs);
        for (const id of drop) await redis.hdel(key(col), id);
      }
      for (const [col, fields] of Object.entries(byCol)) {
        const ids = Object.keys(fields);
        for (let i = 0; i < ids.length; i += 200) {
          const part = {}; ids.slice(i, i + 200).forEach((k) => (part[k] = fields[k]));
          await redis.hset(key(col), part);
        }
      }
      for (const p of (JSON.parse(raw).removed || [])) { const [col, id] = split(p); await redis.hdel(key(col), id); }
      // Keep the database a mirror of seed.json for everything that came from it:
      // anything an earlier seed.json added that is no longer there is removed.
      const now = Object.keys(seedDocs).filter((p) => !/^(questions|papers)\//.test(p)); const nowSet = new Set(now);
      let prev = await redis.get("padi:seedkeys"); if (typeof prev === "string") { try { prev = JSON.parse(prev); } catch (e) { prev = []; } }
      for (const p of Array.isArray(prev) ? prev : []) if (!nowSet.has(p)) { const [col, id] = split(p); await redis.hdel(key(col), id); }
      // Sets made by scripts/add-questions.js that are no longer in seed.json (from before key tracking)
      const papers = (await redis.hgetall(key("papers"))) || {};
      const stale = Object.entries(papers).filter(([id, v]) => !nowSet.has("papers/" + id) && String(parse(v).note || "").startsWith("Added with scripts/add-questions.js")).map(([id]) => id);
      if (stale.length) {
        const qs = (await redis.hgetall(key("questions"))) || {};
        for (const [id, v] of Object.entries(qs)) if (stale.includes(parse(v).paperId)) await redis.hdel(key("questions"), id);
        for (const id of stale) await redis.hdel(key("papers"), id);
      }
      await redis.set("padi:seedkeys", JSON.stringify(now));
      await redis.set("padi:seedhash", hash);
      console.log("Synced the question bank with data/seed.json");
    })().catch((e) => { seeded = null; throw e; });
    return seeded;
  }
  return {
    kind: "redis",
    async list(col) { await ensureSeed(); const h = (await redis.hgetall(key(col))) || {}; return Object.entries(h).map(([id, v]) => ({ id, data: parse(v) })); },
    async get(p) { await ensureSeed(); const [col, id] = split(p); const v = await redis.hget(key(col), id); return v == null ? undefined : parse(v); },
    async set(p, doc) { await ensureSeed(); const [col, id] = split(p); await redis.hset(key(col), { [id]: JSON.stringify(doc) }); },
    async del(p) { await ensureSeed(); const [col, id] = split(p); await redis.hdel(key(col), id); },
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
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(() => { fs.writeFileSync(file + ".tmp", JSON.stringify(store)); fs.renameSync(file + ".tmp", file); }, 150); };
  return {
    kind: "file",
    async list(col) {
      const pre = col + "/"; const out = [];
      for (const [k, v] of Object.entries(store.docs)) if (k.startsWith(pre) && !k.slice(pre.length).includes("/")) out.push({ id: k.slice(pre.length), data: v });
      return out;
    },
    async get(p) { return store.docs[p]; },
    async set(p, doc) { store.docs[p] = doc; save(); },
    async del(p) { delete store.docs[p]; save(); },
  };
}

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
let store;
if (url && token) store = redisStore(url, token);
else if (process.env.VERCEL) store = null; // no writable disk on Vercel: a database is required
else store = fileStore();
module.exports = store;
