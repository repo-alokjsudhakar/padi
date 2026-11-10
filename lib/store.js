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
  let seeded = null;
  async function ensureSeed() {
    if (!seeded) seeded = (async () => {
      const first = await redis.set("padi:seeded", "1", { nx: true });
      if (!first) return;
      const byCol = {};
      for (const [p, doc] of Object.entries(seedDocs())) {
        const [col, id] = split(p);
        (byCol[col] = byCol[col] || {})[id] = JSON.stringify(doc);
      }
      for (const [col, fields] of Object.entries(byCol)) await redis.hset(key(col), fields);
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
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, docs: seedDocs() }));
    console.log("Created data/bank.json from the seed question bank.");
  }
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.docs = store.docs || {};
  // daily backup
  const bdir = path.join(dir, "backups"); fs.mkdirSync(bdir, { recursive: true });
  const bfile = path.join(bdir, "bank-" + new Date().toISOString().slice(0, 10) + ".json");
  if (!fs.existsSync(bfile)) fs.copyFileSync(file, bfile);
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
