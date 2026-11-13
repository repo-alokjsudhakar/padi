// The question bank, served a few questions at a time.
//
// The bank is read from data/seed.json once and kept in memory. The app never downloads
// it whole: it asks for a small catalogue (subjects, sections, counts), then for a list of
// question ids for a test, then for the questions themselves ten at a time.
//
// Questions added or edited inside the app are kept in the database ("overlay") and are
// laid over the bank: same id replaces, new id adds, { deleted: true } removes.
const fs = require("fs");
const path = require("path");

const SEED = path.join(__dirname, "..", "data", "seed.json");
const OTHER = "Other questions";
let base = null;          // { questions: Map, papers: Map }
let view = null;          // bank with overlay applied + indexes
let overlayAt = 0;

function loadBase() {
  if (base) return base;
  const questions = new Map(), papers = new Map();
  if (fs.existsSync(SEED)) {
    const docs = JSON.parse(fs.readFileSync(SEED, "utf8")).docs || {};
    for (const k in docs) {
      if (k.startsWith("questions/")) questions.set(k.slice(10), docs[k]);
      else if (k.startsWith("papers/")) papers.set(k.slice(7), docs[k]);
    }
  }
  base = { questions, papers };
  return base;
}
const answerable = (q) => q && Array.isArray(q.options) && Number.isInteger(q.answer) && String(q.q || "").trim();

function build(overlayQ, overlayP) {
  const b = loadBase();
  let questions = b.questions, papers = b.papers;
  if (overlayQ.length || overlayP.length) {
    questions = new Map(b.questions); papers = new Map(b.papers);
    const gone = new Set();
    for (const { id, data } of overlayP) { if (data && data.deleted) { papers.delete(id); gone.add(id); } else papers.set(id, data); }
    for (const { id, data } of overlayQ) { if (data && data.deleted) questions.delete(id); else questions.set(id, data); }
    if (gone.size) for (const [id, q] of questions) if (gone.has(q.paperId)) questions.delete(id);   // a deleted source takes its questions with it
  }
  const cats = new Map();      // category -> Map(section -> [ids])
  const byPaper = new Map();   // paperId -> [ids]
  for (const [id, q] of questions) {
    if (!byPaper.has(q.paperId)) byPaper.set(q.paperId, []);
    byPaper.get(q.paperId).push(id);
    if (!answerable(q)) continue;
    const p = papers.get(q.paperId);
    if (p && p.kind === "official") continue;   // past papers are mock tests, not section practice
    const c = q.category || "Uncategorised", t = q.topic || OTHER;
    if (!cats.has(c)) cats.set(c, new Map());
    const m = cats.get(c); if (!m.has(t)) m.set(t, []);
    m.get(t).push(id);
  }
  for (const ids of byPaper.values()) ids.sort((x, y) => (questions.get(x).n || 0) - (questions.get(y).n || 0));
  view = { questions, papers, cats, byPaper };
  return view;
}

// Returns the bank with the latest in-app changes applied.
// Every 30 seconds at most, it asks the database for one small version number; the in-app
// additions are read again (in pages) only when that number has changed. The seed questions
// themselves always come from data/seed.json, never from the database.
let overlayVer = null;
async function bank(store, force) {
  if (view && !force && Date.now() - overlayAt < 30000) return view;
  if (!store) { overlayAt = Date.now(); return view || build([], []); }
  let ver;
  try { ver = await store.version(); } catch (e) { if (view) { overlayAt = Date.now(); return view; } }
  overlayAt = Date.now();
  if (view && !force && ver !== undefined && ver === overlayVer) return view;
  let oq = [], op = [];
  try { [oq, op] = await Promise.all([store.list("questions"), store.list("papers")]); }
  catch (e) { if (view) return view; }
  overlayVer = ver;
  return build(oq, op);
}

function catalogue(v) {
  const cats = [];
  for (const [cat, m] of v.cats) {
    const sections = [...m].map(([name, ids]) => ({ name, n: ids.length }));
    cats.push({ cat, n: sections.reduce((s, x) => s + x.n, 0), sections });
  }
  const papers = [...v.papers].map(([id, p]) => ({ id, title: p.title, year: p.year || "", kind: p.kind || "practice", order: p.order, note: p.note || "", n: (v.byPaper.get(id) || []).length }));
  return { total: cats.reduce((s, c) => s + c.n, 0), cats, papers };
}

function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Which questions make up a test. Returns ids only; the questions are fetched in pages.
function pick(v, spec) {
  spec = spec || {};
  let ids;
  if (Array.isArray(spec.ids)) ids = spec.ids.filter((id) => answerable(v.questions.get(id)));
  else if (spec.paper) ids = (v.byPaper.get(spec.paper) || []).filter((id) => answerable(v.questions.get(id)));
  else if (spec.cat && spec.cat !== "all") {
    const m = v.cats.get(spec.cat);
    ids = !m ? [] : spec.topic && spec.topic !== "all" ? (m.get(spec.topic) || []).slice() : [].concat(...m.values());
  } else ids = [].concat(...[...v.cats.values()].map((m) => [].concat(...m.values())));
  if (spec.shuffle !== false && !spec.paper) ids = shuffle(ids);
  const limit = Number(spec.limit) || 0;
  return limit > 0 ? ids.slice(0, limit) : ids;
}

const withId = (v, id) => { const q = v.questions.get(id); return q ? Object.assign({ id }, q) : null; };
function byIds(v, ids) { return (ids || []).slice(0, 50).map((id) => withId(v, String(id))).filter(Boolean); }
function page(v, ids, offset, limit) {
  offset = Math.max(0, Number(offset) || 0); limit = Math.min(50, Math.max(1, Number(limit) || 20));
  return { total: ids.length, offset, items: ids.slice(offset, offset + limit).map((id) => withId(v, id)).filter(Boolean) };
}
function sectionIds(v, cat, topic) { const m = v.cats.get(cat); return (m && m.get(topic)) || []; }

function invalidate() { overlayAt = 0; }   // re-check the version on the next request
function inSeed(kind, id) { const b = loadBase(); return (kind === "papers" ? b.papers : b.questions).has(id); }
module.exports = { invalidate, inSeed, bank, catalogue, pick, byIds, page, sectionIds, loadBase, OTHER };
