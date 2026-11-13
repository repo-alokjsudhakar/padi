#!/usr/bin/env node
// Add questions to the app's question bank (data/seed.json).
//
//   node scripts/add-questions.js <file.json> --category "Chemistry" --section "Solutions"
//
// <file.json> can be either:
//   1. A simple list:   [ { "q": "...", "options": ["a","b","c","d"], "answer": 1, "explanation": "..." }, ... ]
//      ("answer" is 0-3, or a letter A-D.)  --category and --section are required.
//   2. the app's own format: { "papers/<id>": {...}, "questions/<id>": {...}, ... }
//      Each question's own "topic" is used as its section unless you pass --section.
//
// Options:
//   --category "<name>"   Subject, exactly as listed in the syllabus (e.g. "Biology").
//   --section  "<name>"   Section (topic) name shown in the app.
//   --id       "<id>"     Short id for the set (letters, digits, dashes). Made from the section name if omitted.
//   --dry-run             Check the file and show what would happen, without saving.
//   --allow-duplicates    Add questions even if the same question is already in that section.
//
// Full mock tests (shown under "Full Mock Test" on the home page):
//   node scripts/add-questions.js <file.json> --mock "Technical Services Interview - 2026"
//   --mock "<title or id>"  Add the questions to that mock test. Its title or id both work, e.g.
//                           tnpsc-group2a-prelims-2026, tnpsc-group2a-2026-paper2 (Mains),
//                           tnpsc-technical-non-interview-2026,
//                           tnpsc-technical-interview-2026, tnpsc-public-prosecutor-2026,
//                           tnpsc-technical-iti-2025. --category/--section are optional
//                           here (a question's own "category"/"topic" are used if it has them).
//                           New questions are numbered after the ones already in the test, and
//                           questions already in that test are skipped, so re-running is safe.
//   --keep-numbers          Use each question's own "n" as its number in the test (replaces
//                           whatever question had that number).
//   --new-mock "<title>"    Create a new mock test with that title (if it doesn't exist yet).
//                           The tests above come back by themselves if they were removed.
//
// Other commands:
//   node scripts/add-questions.js --check            List duplicate questions in the bank.
//   node scripts/add-questions.js --remove <set id>  Remove a whole set (its id is shown when you add it).
//                                                    For a mock test only its questions go; the test stays.
//   node scripts/add-questions.js --mocks            List the mock tests and their question counts.
//   node scripts/add-questions.js --clear <mock id>  Remove every question from a mock test but keep the test.
const fs = require("fs");
const path = require("path");

/* ---------- text cleanup: turns LaTeX-style maths and escape codes into plain text ---------- */
const SUP = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","+":"⁺","-":"⁻","=":"⁼","(":"⁽",")":"⁾","n":"ⁿ","i":"ⁱ","a":"ᵃ","x":"ˣ","y":"ʸ","t":"ᵗ","/":"ᐟ" };
const SUB = { "0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉","+":"₊","-":"₋","=":"₌","(":"₍",")":"₎","a":"ₐ","e":"ₑ","o":"ₒ","x":"ₓ" };
const tr = (s, map) => [...s].map((c) => map[c]).join("");
const allIn = (s, map) => [...s].every((c) => c in map);
const SYM = [["\\rightleftharpoons","⇌"],["\\rightarrow","→"],["\\Rightarrow","⇒"],["\\leftarrow","←"],["\\approx","≈"],["\\propto","∝"],["\\times","×"],["\\cdot","·"],["\\div","÷"],["\\pm","±"],["\\leq","≤"],["\\geq","≥"],["\\neq","≠"],["\\infty","∞"],["\\circ","°"],["\\degree","°"],
  ["\\Delta","Δ"],["\\delta","δ"],["\\theta","θ"],["\\tau","τ"],["\\rho","ρ"],["\\mu","μ"],["\\lambda","λ"],["\\omega","ω"],["\\pi","π"],["\\alpha","α"],["\\beta","β"],["\\gamma","γ"],["\\eta","η"],["\\sigma","σ"],["\\sum","Σ"],["\\sin","sin"],["\\cos","cos"],["\\tan","tan"],["\\log","log"],["\\%","%"],["\\,"," "],["\\:"," "],["\\lor","∨"],["\\land","∧"],["\\iff","⇔"],["\\implies","⇒"],["\\equiv","≡"],["\\oplus","⊕"],["\\cup","∪"],["\\cap","∩"],["\\AA","Å"],["\\Omega","Ω"],["\\Phi","Φ"],["\\phi","φ"],["\\epsilon","ε"],["\\varepsilon","ε"],["\\odot","⊙"],["\\int","∫"],["\\ln","ln"],["\\;"," "],["\\!",""],["\\ "," "]];
function braced(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
  }
  return [s.slice(i + 1), s.length];
}
function unwrap(cmd, t, fn, two) {
  let out = "", i = 0;
  for (;;) {
    const k = t.indexOf(cmd, i);
    if (k < 0) return out + t.slice(i);
    out += t.slice(i, k); let j = k + cmd.length;
    while (j < t.length && t[j] === " ") j++;
    if (j < t.length && t[j] === "{") {
      let a; [a, j] = braced(t, j);
      if (two) {
        while (j < t.length && t[j] === " ") j++;
        let b = ""; if (j < t.length && t[j] === "{") [b, j] = braced(t, j);
        out += fn(a, b);
      } else out += fn(a);
    } else out += cmd.slice(1);
    i = j;
  }
}
const par = (x) => { x = x.trim(); return /[\s+\-×·]/.test(x) && !(x.startsWith("(") && x.endsWith(")")) ? "(" + x + ")" : x; };
function latex(t) {
  for (const c of ["\\text","\\mathrm","\\mathbf","\\textbf","\\operatorname","\\vec","\\overline","\\boxed","\\bar","\\tilde","\\hat"]) t = unwrap(c, t, (a) => a);
  t = unwrap("\\sqrt", t, (a) => "√" + par(a));
  for (let n = 0; n < 3; n++) { t = unwrap("\\frac", t, (a, b) => par(a) + "/" + par(b), true); t = unwrap("\\dfrac", t, (a, b) => par(a) + "/" + par(b), true); }
  t = t.replace(/\\xrightarrow\{([^}]*)\}/g, " →($1) ");
  t = t.replace(/\\left(?![a-zA-Z])/g, "").replace(/\\right(?![a-zA-Z])/g, "");
  for (const [a, b] of SYM) t = t.split(a).join(b);
  t = t.replace(/\^\{([^}]*)\}/g, (m, g) => (allIn(g, SUP) ? tr(g, SUP) : "\u0000(" + g + ")"));
  t = t.replace(/\^([\s\S])/gu, (m, g) => (g in SUP ? SUP[g] : "^" + g));
  t = t.split("\u0000").join("^");
  t = t.replace(/_\{([^}]*)\}/g, (m, g) => (allIn(g, SUB) ? tr(g, SUB) : g));
  t = t.replace(/_([\s\S])/gu, (m, g) => (g in SUB ? SUB[g] : g));
  t = t.split("{").join("").split("}").join("");
  t = t.replace(/\\([a-zA-Z]+)/g, "$1");
  return t.replace(/ {2,}/g, " ").trim();
}
function clean(s) {
  s = String(s == null ? "" : s);
  s = s.replace(/\\+n(?![a-zA-Z])/g, "\n");
  s = s.replace(/(?<=[}\w])\$\$(?=[_^])/g, "$\u0001$");          // $^{14}$$_{7}$N is two inline spans
  s = s.replace(/\\+neg(?![a-zA-Z])/g, "¬").replace(/\\+lor(?![a-zA-Z])/g, "∨").replace(/\\+land(?![a-zA-Z])/g, "∧").replace(/\\+iff(?![a-zA-Z])/g, "⇔");
  s = s.replace(/\\x([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\+/g, "\\");
  s = s.replace(/\\nu(?![a-zA-Z])/g, "ν").replace(/\\neq(?![a-zA-Z])/g, "≠").replace(/\\nabla(?![a-zA-Z])/g, "∇");
  s = s.split("\\n").join("\n").split('\\"').join('"').split("\\'").join("'");
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, g) => "\n" + latex(g) + "\n");
  s = s.replace(/\$([^$\n]{1,400})\$/g, (m, g) => latex(g));
  s = s.split("$").join("").split("\\ ").join(" ");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.split("\u0001").join("").split("K^(sp)").join("Ksp").split("^(°)").join("°").split("^°").join("°");
}
module.exports = { clean };
if (require.main !== module) return;

/* ---------- command line ---------- */
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };
const sig = (v) => (String(v.q) + "|" + [...v.options].map(String).sort().join("|")).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const rootDir = path.join(__dirname, "..");
const mockList = (sd) => Object.keys(sd.docs).filter((k) => k.startsWith("papers/") && sd.docs[k].kind === "official")
  .map((k) => ({ id: k.slice(7), title: sd.docs[k].title, n: Object.keys(sd.docs).filter((q) => q.startsWith("questions/") && sd.docs[q].paperId === k.slice(7)).length }));
// The app's mock tests. If one of these is missing from seed.json (e.g. after --remove), naming it
// with --mock brings it back automatically.
const KNOWN_MOCKS = [
  { id: "tnpsc-group2a-prelims-2026", title: "Group 2/2A Prelims - 2026", year: 2026, order: 1 },
  { id: "tnpsc-group2a-2026-paper2", title: "Group 2/2A Mains - 2026", year: 2026, order: 2 },
  { id: "tnpsc-technical-non-interview-2026", title: "Technical Services Non Interview - 2026", year: 2026, order: 3 },
  { id: "tnpsc-technical-interview-2026", title: "Technical Services Interview - 2026", year: 2026, order: 4 },
  { id: "tnpsc-public-prosecutor-2026", title: "Public Prosecutor - 2026", year: 2026, order: 5 },
  { id: "tnpsc-technical-iti-2025", title: "Technical ITI - 2025", year: 2025, order: 6 },
];
const isMockPaper = (sd, id) => (sd.docs["papers/" + id] && sd.docs["papers/" + id].kind === "official") || KNOWN_MOCKS.some((m) => m.id === id);
const findMock = (sd, name) => { const t = String(name || "").trim().toLowerCase(); return mockList(sd).find((m) => m.id.toLowerCase() === t || String(m.title).toLowerCase() === t); };
const showMocks = (sd) => "Mock tests:\n  " + mockList(sd).map((m) => m.id + "  (" + m.title + ", " + m.n + " questions)").join("\n  ");
if (args.includes("--mocks") || args.includes("--clear")) {
  const sp = path.join(rootDir, "data", "seed.json"); const sd = JSON.parse(fs.readFileSync(sp, "utf8"));
  if (args.includes("--mocks")) { console.log("\n" + showMocks(sd) + "\n"); process.exit(0); }
  const m = findMock(sd, args[args.indexOf("--clear") + 1]);
  if (!m) { console.error("\n✗ No mock test called \"" + (args[args.indexOf("--clear") + 1] || "") + "\".\n" + showMocks(sd) + "\n"); process.exit(1); }
  const keys = Object.keys(sd.docs).filter((k) => k.startsWith("questions/") && sd.docs[k].paperId === m.id);
  keys.forEach((k) => delete sd.docs[k]);
  sd.removed = [...new Set([...(sd.removed || []), ...keys])];
  fs.writeFileSync(sp, JSON.stringify(sd, null, 1));
  console.log("\n✓ Removed " + keys.length + " questions from " + m.title + " (the test itself is kept).\n");
  process.exit(0);
}
if (args.includes("--check") || args.includes("--remove")) {
  const sp = path.join(rootDir, "data", "seed.json"); const sd = JSON.parse(fs.readFileSync(sp, "utf8"));
  if (args.includes("--remove")) {
    const pid = args[args.indexOf("--remove") + 1];
    // A mock test keeps its place on the home page; only its questions are removed.
    const keepTest = isMockPaper(sd, pid);
    const keys = Object.keys(sd.docs).filter((k) => (k === "papers/" + pid && !keepTest) || (k.startsWith("questions/") && sd.docs[k].paperId === pid));
    if (keepTest && !keys.length) { console.log("\n✓ The mock test " + pid + " has no questions to remove.\n"); process.exit(0); }
    if (!pid || !keys.length) { console.error("\n✗ No set with id \"" + pid + "\". Sets in the bank:\n  " + Object.keys(sd.docs).filter((k) => k.startsWith("papers/")).map((k) => k.slice(7) + "  (" + sd.docs[k].title + ")").join("\n  ") + "\n"); process.exit(1); }
    keys.forEach((k) => delete sd.docs[k]);
    sd.removed = [...new Set([...(sd.removed || []), ...keys])];
    fs.writeFileSync(sp, JSON.stringify(sd, null, 1));
    if (keepTest) { console.log("\n✓ Removed " + keys.length + " questions from the mock test " + pid + ". The test itself is kept, so you can add questions to it again with --mock " + pid + "\n"); process.exit(0); }
    console.log("\n✓ Removed " + (keys.length - 1) + " questions (set " + pid + "). They will also be removed from your local and Vercel databases on the next start.\n");
    process.exit(0);
  }
  const groups = {};
  for (const [k, v] of Object.entries(sd.docs)) if (k.startsWith("questions/")) (groups[sig(v)] = groups[sig(v)] || []).push(k);
  const dups = Object.values(groups).filter((g) => g.length > 1);
  const same = dups.filter((g) => new Set(g.map((k) => sd.docs[k].category + "|" + sd.docs[k].topic)).size === 1);
  console.log("\nQuestions in the bank: " + Object.keys(sd.docs).filter((k) => k.startsWith("questions/")).length);
  console.log("Identical questions repeated inside one section: " + same.length);
  same.slice(0, 40).forEach((g) => console.log("  " + sd.docs[g[0]].category + " → " + sd.docs[g[0]].topic + ": " + g.map((k) => k.slice(10)).join(", ") + "\n     " + String(sd.docs[g[0]].q).slice(0, 80)));
  console.log("Identical questions that appear in two different sections: " + (dups.length - same.length));
  dups.filter((g) => !same.includes(g)).slice(0, 40).forEach((g) => console.log("  " + g.map((k) => k.slice(10) + " (" + sd.docs[k].topic + ")").join("  +  ")));
  console.log("");
  process.exit(0);
}
const FLAGS = ["--dry-run", "--allow-duplicates", "--keep-numbers", "--new-mock"];
const file = args.find((a) => /\.json$/i.test(a) && fs.existsSync(a)) || args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !FLAGS.includes(args[i - 1])));
const dry = args.includes("--dry-run");
const fail = (msg) => { console.error("\n✗ " + msg + "\n"); process.exit(1); };
if (!file) fail('Usage: node scripts/add-questions.js <file.json> --category "Chemistry" --section "Solutions"');
if (!fs.existsSync(file)) fail("File not found: " + file);

const root = rootDir;
const seedPath = path.join(root, "data", "seed.json");
const htmlPath = path.join(root, "public", "index.html");
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
let html = fs.readFileSync(htmlPath, "utf8");
let input; try { input = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail("That file isn’t valid JSON: " + e.message); }

const slug = (s) => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const syllabus = [...html.matchAll(/cats: \[([^\]]*)\]/g)].flatMap((m) => JSON.parse("[" + m[1] + "]"));
const catArg = opt("category"), secArg = opt("section");
// --mock "<title or id>", or --new-mock "<title or id>" (both forms work)
const val = (name) => { const v = opt(name); return v && !v.startsWith("--") && v !== file ? v : undefined; };
const newMock = args.includes("--new-mock");
const mockArg = val("mock") || val("new-mock");
let mock = null;
if (args.includes("--mock") || newMock) {
  if (!mockArg) fail('Name the mock test: --mock "<title or id>".\n  ' + showMocks(seed));
  mock = findMock(seed, mockArg);
  if (!mock) {
    const t = mockArg.trim().toLowerCase();
    const known = KNOWN_MOCKS.find((m) => m.id === t || m.title.toLowerCase() === t);
    const idLike = /^[a-z0-9]+(-[a-z0-9]+)+$/.test(mockArg.trim());
    let def = null;
    if (known) def = Object.assign({}, known);
    else if (newMock) {
      if (idLike) fail('"' + mockArg + '" looks like an id. Give the new mock test a title instead, e.g. --new-mock "Group 1 Prelims - 2026".');
      def = { id: "tnpsc-" + slug(mockArg).replace(/^tnpsc-/, ""), title: mockArg.trim(), year: Number((mockArg.match(/20\d\d/) || [""])[0]) || "", order: mockList(seed).length + 1 };
    }
    if (def) {
      const old = seed.docs["papers/" + def.id];
      if (old && old.kind !== "official") fail('There is already a practice set with the id "' + def.id + '" (' + old.title + "). Pick another title.");
      seed.docs["papers/" + def.id] = { title: def.title, year: def.year, kind: "official", order: def.order, createdAt: Date.now(), note: "Full mock test. Add questions with: node scripts/add-questions.js <file.json> --mock " + def.id };
      seed.removed = (seed.removed || []).filter((k) => k !== "papers/" + def.id);
      console.log("\n  " + (known ? "Brought back" : "Created") + " the mock test " + def.title + " (id " + def.id + ").");
      mock = findMock(seed, def.id);
    }
  }
  if (!mock) fail('No mock test called "' + mockArg + '". To create a new one, use --new-mock "<title>".\n  ' + showMocks(seed));
}

// Build a list of { paperId, n, q, options, answer, explanation, category, topic }
let items = [];
if (mock) {
  const list = Array.isArray(input) ? input : input && typeof input === "object" ? Object.entries(input).filter(([k]) => k.startsWith("questions/")).map(([, v]) => v) : null;
  if (!list) fail("The file should hold a list of questions, or the app’s papers/questions format.");
  const keep = args.includes("--keep-numbers");
  let next = Object.values(seed.docs).filter((v) => v.paperId === mock.id).reduce((m, v) => Math.max(m, Number(v.n) || 0), 0);
  list.forEach((x) => items.push({ paperId: mock.id, n: keep && Number(x.n) ? Number(x.n) : 0, q: x.q || x.question, options: x.options, answer: x.answer, explanation: x.explanation || "",
    category: catArg || x.category || "General Studies", topic: secArg || x.topic || x.section || mock.title }));
  // Skip questions already in this test, then number the rest after the ones already there.
  if (!keep && !args.includes("--allow-duplicates")) {
    const inTest = new Set(Object.values(seed.docs).filter((v) => v.paperId === mock.id && v.q && Array.isArray(v.options)).map((v) => sig(v)));
    const before = items.length;
    items = items.filter((it) => { if (!Array.isArray(it.options)) return true; const k = sig({ q: clean(it.q), options: it.options.map(clean) }); if (inTest.has(k)) return false; inTest.add(k); return true; });
    if (before > items.length) console.log("\n  Skipped " + (before - items.length) + " question(s) already in " + mock.title + ".");
  }
  items.forEach((it) => { if (!it.n) it.n = ++next; });
  if (!items.length) { console.log("\n✓ Nothing new to add to " + mock.title + ".\n"); process.exit(0); }
} else if (Array.isArray(input)) {
  if (!catArg || !secArg) fail('A simple list needs both --category "<subject>" and --section "<section name>".');
  const pid = opt("id") || "tm-" + slug(catArg).slice(0, 12) + "-" + slug(secArg);
  input.forEach((x, i) => items.push({ paperId: pid, n: Number(x.n) || i + 1, q: x.q || x.question, options: x.options, answer: x.answer, explanation: x.explanation || "", category: catArg, topic: secArg }));
} else if (input && typeof input === "object") {
  for (const [k, v] of Object.entries(input)) {
    if (!k.startsWith("questions/")) continue;
    items.push({ paperId: v.paperId || opt("id") || "tm-" + slug(secArg || v.topic || "set"), n: Number(v.n), q: v.q, options: v.options, answer: v.answer, explanation: v.explanation || "", category: catArg || v.category, topic: secArg || v.topic });
  }
} else fail("The file should hold a list of questions, or the app’s papers/questions format.");
if (!items.length) fail("No questions found in that file.");

// Validate
const problems = [];
items.forEach((it, i) => {
  const label = "Question " + (it.n || i + 1);
  if (typeof it.answer === "string" && /^[A-Da-d]$/.test(it.answer.trim())) it.answer = "ABCD".indexOf(it.answer.trim().toUpperCase());
  if (!String(it.q || "").trim()) problems.push(label + ": no question text");
  if (!Array.isArray(it.options) || it.options.length !== 4 || it.options.some((o) => !String(o || "").trim())) problems.push(label + ": needs exactly 4 non-empty options");
  if (!Number.isInteger(it.answer) || it.answer < 0 || it.answer > 3) problems.push(label + ': "answer" must be 0–3 or A–D');
  if (!it.category) problems.push(label + ": no category (pass --category)");
  if (!it.topic) problems.push(label + ": no section (pass --section)");
});
if (problems.length) fail(problems.length + " problem(s) found:\n  - " + problems.slice(0, 20).join("\n  - ") + (problems.length > 20 ? "\n  …" : ""));
const cats = [...new Set(items.map((i) => i.category))];
if (!mock) cats.forEach((c) => { if (!syllabus.includes(c)) fail('"' + c + '" isn’t a subject in the syllabus. Use one of:\n  ' + syllabus.join("\n  ")); });

// Merge into seed.json
const groups = {};
items.forEach((it) => { (groups[it.paperId + "|" + it.category + "|" + it.topic] = groups[it.paperId + "|" + it.category + "|" + it.topic] || []).push(it); });
let added = 0, updated = 0, skipped = 0; const elsewhere = [];
const allowDup = args.includes("--allow-duplicates");
const existing = {}; // signature -> [keys]
for (const [k, v] of Object.entries(seed.docs)) if (k.startsWith("questions/")) (existing[sig(v)] = existing[sig(v)] || []).push(k);
// Stop if this file is mostly questions that are already in the bank under another set id
if (!mock) {
  const ids = new Set(items.map((it) => "questions/" + it.paperId + "-" + String(it.n).padStart(3, "0")));
  const already = items.filter((it) => (existing[sig({ q: clean(it.q), options: it.options.map(clean) })] || []).some((k) => !ids.has(k)));
  const owners = {}; already.forEach((it) => (existing[sig({ q: clean(it.q), options: it.options.map(clean) })] || []).forEach((k) => { const p = seed.docs[k].paperId; owners[p] = (owners[p] || 0) + 1; }));
  const top = Object.entries(owners).sort((a, b) => b[1] - a[1])[0];
  if (!allowDup && already.length >= Math.max(1, Math.ceil(items.length * 0.5)) && top)
    fail(already.length + " of these " + items.length + " questions are already in the bank, mostly in the set \"" + top[0] + "\" (" + seed.docs["papers/" + top[0]].title + ").\n  Adding them again would create duplicates.\n  • To update that set instead, add:  --id " + top[0] + "\n  • To remove the old set first:       node scripts/add-questions.js --remove " + top[0] + "\n  • To add them anyway:               --allow-duplicates");
}
const summary = [];
for (const [key, list] of Object.entries(groups)) {
  const [pid, category, topic] = key.split("|");
  if (!seed.docs["papers/" + pid]) seed.docs["papers/" + pid] = { title: topic, year: "", kind: "practice", createdAt: Date.now(), note: "Added with scripts/add-questions.js" };
  list.forEach((it) => {
    const id = "questions/" + pid + "-" + String(it.n).padStart(3, "0");
    const doc = { paperId: pid, n: it.n, q: clean(it.q), options: it.options.map(clean), answer: it.answer, explanation: clean(it.explanation), category, topic };
    const twins = (existing[sig(doc)] || []).filter((k) => k !== id);
    if (!mock && twins.some((k) => seed.docs[k] && seed.docs[k].category === category && seed.docs[k].topic === topic) && !allowDup) { skipped++; return; }
    if (twins.length && !mock) elsewhere.push(id.slice(10) + " = " + twins[0].slice(10));
    if (seed.docs[id]) updated++; else added++;
    seed.docs[id] = doc; (existing[sig(doc)] = existing[sig(doc)] || []).push(id);
  });
  summary.push((mock ? mock.title + " → " : "") + category + " → " + topic + ": " + list.length + " questions (id " + pid + ")");
  if (mock) continue;   // mock-test questions aren't practice sections, so nothing to register in the app
  // Register the section so it appears in the right order and in the Add questions form
  const re = new RegExp('("' + category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '": \\[)([^\\]]*)(\\])');
  const m = html.match(re);
  if (m) { const list2 = JSON.parse("[" + m[2] + "]"); if (!list2.includes(topic)) { list2.push(topic); html = html.replace(re, (x, a, b, c) => a + list2.map((s) => JSON.stringify(s)).join(",") + c); } }
  else html = html.replace(/(const TOPICS = \{\n)/, (x) => x + "  " + JSON.stringify(category) + ": [" + JSON.stringify(topic) + "],\n");
}
const leftovers = Object.entries(seed.docs).filter(([k, v]) => k.startsWith("questions/") && items.some((it) => k === "questions/" + it.paperId + "-" + String(it.n).padStart(3, "0")) && /[\\${}]/.test([v.q, ...v.options, v.explanation].join(" ")));
console.log("\n" + (dry ? "Dry run (nothing saved)\n" : "") + summary.map((s) => "  " + s).join("\n"));
console.log("\n  New questions: " + added + (updated ? ", replaced: " + updated : "") + (skipped ? ", skipped as duplicates already in that section: " + skipped : ""));
if (elsewhere.length) console.log("  Note: " + elsewhere.length + " of these also appear in another section (kept): " + elsewhere.slice(0, 4).join("; ") + (elsewhere.length > 4 ? " …" : ""));
if (leftovers.length) console.log("  Note: " + leftovers.length + " question(s) still contain code-style symbols (\\ $ { }); check them in the app: " + leftovers.slice(0, 5).map(([k]) => k.slice(10)).join(", "));
if (!dry) {
  if (seed.removed) { const now = new Set(Object.keys(seed.docs)); seed.removed = seed.removed.filter((k) => !now.has(k)); }
  fs.writeFileSync(seedPath, JSON.stringify(seed, null, 1));
  fs.writeFileSync(htmlPath, html);
  const total = Object.keys(seed.docs).filter((k) => k.startsWith("questions/")).length;
  if (mock) console.log("  " + mock.title + " now has " + Object.values(seed.docs).filter((v) => v.paperId === mock.id).length + " questions.");
  console.log("  Question bank now has " + total + " questions.\n\n✓ Saved. Next: npm start to check, then commit and push.\n");
}
