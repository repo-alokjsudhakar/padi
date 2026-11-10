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
      const byCol = {};
      for (const [p, doc] of Object.entries(JSON.parse(raw).docs || {})) {
        const [col, id] = split(p);
        (byCol[col] = byCol[col] || {})[id] = JSON.stringify(doc);
      }
      for (const [col, fields] of Object.entries(byCol)) {
        const ids = Object.keys(fields);
        for (let i = 0; i < ids.length; i += 200) {
          const part = {}; ids.slice(i, i + 200).forEach((k) => (part[k] = fields[k]));
          await redis.hset(key(col), part);
        }
      }
      for (const p of JSON.parse(raw).removed || []) { const [col, id] = split(p); await redis.hdel(key(col), id); }
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
    const seed = JSON.parse(raw).docs || {};
    Object.assign(store.docs, seed);
    for (const p of JSON.parse(raw).removed || []) delete store.docs[p];
    store.seedhash = hash;
    fs.writeFileSync(file, JSON.stringify(store));
    console.log("Synced data/bank.json with data/seed.json (" + Object.keys(seed).filter((k) => k.startsWith("questions/")).length + " questions).");
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
