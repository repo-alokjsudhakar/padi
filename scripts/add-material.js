#!/usr/bin/env node
// Add study materials (PDFs etc.) to the Materials page.
//
//   node scripts/add-material.js <file.pdf> --type <type> --title "<title>" [options]
//
// Types:
//   school     School books            (use --class and --medium, e.g. --class 10 --medium English)
//   subject    Subject-wise combined   (use --subject, e.g. --subject "Indian Polity")
//   revision   Recap / revision notes  (--subject is optional; notes are grouped by it)
//
// Options:
//   --title   "<name>"    Shown on the card. Required.
//   --subject "<name>"    Subject, ideally exactly as in the syllabus (e.g. "Physics").
//   --class   <6-12>      Class, for school books.
//   --medium  English|Tamil
//   --pages   <n>         Number of pages (optional, shown on the card).
//   --note    "<text>"    One short line shown under the title (optional).
//   --url     "<link>"    Link to a file hosted elsewhere (Google Drive etc.) instead of a local file.
//   --dry-run             Show what would happen without saving.
//
// The file is copied into public/materials/<type>/ and listed in public/materials.json.
// Adding the same type + title (+ class + medium) again replaces the old entry and file.
//
// Other commands:
//   node scripts/add-material.js --list             List everything on the Materials page.
//   node scripts/add-material.js --remove <id>      Remove an entry (and its file). Ids are shown by --list.
//
// After adding: npm start to check, then commit and push. Large files make the git repository
// and every deploy bigger; GitHub refuses files over 100 MB, so use --url for very large books.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const listPath = path.join(root, "public", "materials.json");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
const fail = (m) => { console.error("\n✗ " + m + "\n"); process.exit(1); };
const slug = (s) => String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const size = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const TYPES = { school: "school", book: "school", books: "school", subject: "subject", combined: "subject", revision: "revision", recap: "revision", notes: "revision" };
const NAMES = { school: "School books", subject: "Subject-wise material", revision: "Recap and revision notes" };

const data = fs.existsSync(listPath) ? JSON.parse(fs.readFileSync(listPath, "utf8")) : { items: [] };
data.items = Array.isArray(data.items) ? data.items : [];
const save = () => fs.writeFileSync(listPath, JSON.stringify(data, null, 1) + "\n");
const describe = (m) => "  " + m.id.padEnd(46) + " " + m.title + (m.class ? " (Class " + m.class + ")" : "") + (m.medium ? " [" + m.medium + "]" : "") + (m.file ? "  " + m.file + (m.size ? ", " + size(m.size) : "") : m.url ? "  " + m.url : "");

if (args.includes("--list")) {
  if (!data.items.length) console.log("\nNo materials yet.\n");
  for (const t of ["school", "subject", "revision"]) {
    const list = data.items.filter((m) => m.type === t);
    if (list.length) console.log("\n" + NAMES[t] + ":\n" + list.map(describe).join("\n"));
  }
  console.log("");
  process.exit(0);
}
if (args.includes("--remove")) {
  const id = opt("remove"); const i = data.items.findIndex((m) => m.id === id);
  if (i < 0) fail('No material with id "' + (id || "") + '". See: node scripts/add-material.js --list');
  const [m] = data.items.splice(i, 1);
  if (m.file && !data.items.some((x) => x.file === m.file)) { const f = path.join(root, "public", m.file); if (fs.existsSync(f)) fs.unlinkSync(f); }
  save(); console.log("\n✓ Removed " + m.title + ".\n"); process.exit(0);
}

const VALUED = ["type", "title", "subject", "class", "medium", "pages", "note", "url"].map((n) => "--" + n);
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.includes(args[i - 1])));
const url = opt("url");
const type = TYPES[String(opt("type") || "").toLowerCase()];
const title = (opt("title") || "").trim();
if (!file && !url) fail('Usage: node scripts/add-material.js <file.pdf> --type school|subject|revision --title "<title>"\n  (or --url "<link>" instead of a file)');
if (file && url) fail("Give either a file or --url, not both.");
if (!type) fail("Pick a --type: school (school books), subject (subject-wise material) or revision (recap/revision notes).");
if (!title) fail('Give it a --title, e.g. --title "Science"');
if (file && !fs.existsSync(file)) fail("File not found: " + file);
if (url && !/^https?:\/\//i.test(url)) fail("--url should start with http:// or https://");
const medium = opt("medium") ? opt("medium").trim().replace(/^./, (c) => c.toUpperCase()).replace(/\s*medium$/i, "") : undefined;
const cls = opt("class") ? String(opt("class")).replace(/\D/g, "") : undefined;
if (type === "school" && !cls) console.log("\n  Tip: school books are grouped by class; add --class 6 … 12.");

// Titles in Tamil have no Latin letters to make an id from, so use a short fingerprint instead.
const titleId = slug(title) || "t" + require("crypto").createHash("sha1").update(title).digest("hex").slice(0, 8);
const id = [type, titleId, cls, medium && slug(medium)].filter(Boolean).join("-");
const entry = { id, type, title };
if (opt("subject")) entry.subject = opt("subject").trim();
if (cls) entry.class = Number(cls);
if (medium) entry.medium = medium;
if (opt("pages")) entry.pages = Number(opt("pages")) || undefined;
if (opt("note")) entry.note = opt("note").trim();
let dest;
if (file) {
  const ext = (path.extname(file) || ".pdf").toLowerCase();
  dest = "materials/" + type + "/" + id.slice(type.length + 1) + ext;
  entry.file = dest; entry.size = fs.statSync(file).size;
  if (entry.size > 95 * 1048576) fail("That file is " + size(entry.size) + ". GitHub refuses files over 100 MB: upload it somewhere (e.g. Google Drive) and use --url instead.");
  if (entry.size > 40 * 1048576) console.log("\n  Note: " + size(entry.size) + " is large; every deploy carries it. Consider --url for very large books.");
} else entry.url = url;
{ const d = new Date(); entry.addedAt = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

const old = data.items.findIndex((m) => m.id === id);
console.log("\n" + (args.includes("--dry-run") ? "Dry run (nothing saved)\n" : "") + (old >= 0 ? "  Replacing:" : "  Adding:") + "\n" + describe(entry) + "\n  Section: " + NAMES[type]);
if (args.includes("--dry-run")) { console.log(""); process.exit(0); }
if (file) {
  const to = path.join(root, "public", dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (path.resolve(file) !== path.resolve(to)) fs.copyFileSync(file, to);
}
if (old >= 0) data.items[old] = entry; else data.items.push(entry);
save();
console.log("\n✓ Saved. It now shows on the Materials page. Next: npm start to check, then commit and push.\n");
