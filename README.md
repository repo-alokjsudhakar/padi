# படி (Padi)

*Study, step by step.* படி means both “study” and “step” in Tamil.

Padi is a practice app for TNPSC Group 4 past papers. Practise by subject or take full mock
tests, track your accuracy and mistakes, and add new papers by uploading their PDFs: Claude
reads each page (scanned or not) and the questions go straight into the test section.

The question bank starts with the 2025 Group 4 (CCSE-IV) paper and a 20-question starter set.

---

## Run it on your computer

You need [Node.js](https://nodejs.org/) 18.17 or newer.

```
npm install
cp .env.example .env      # then put your API key in .env
npm start                 # opens on http://localhost:3000
```

On your own computer, if `ADMIN_EMAILS` is empty everyone is treated as the owner. The
question bank is saved in `data/bank.json`, with a dated copy in `data/backups/` each day.

---

## Deploy with GitHub and Vercel

### 1. Put the code on GitHub

1. Create a new **private** repository on github.com (for example `padi`). Don’t add a README.
2. In VS Code’s terminal, inside this folder:
   ```
   git init
   git add .
   git commit -m "Padi first version"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/padi.git
   git push -u origin main
   ```
   `.env` is listed in `.gitignore`, so your API key and password are never uploaded.
   You can also use VS Code’s **Source Control** panel → **Publish to GitHub** instead.

### 2. Import the project into Vercel

1. Sign in at vercel.com with your GitHub account.
2. **Add New… → Project**, pick the `padi` repository, and press **Import**.
3. Leave **Framework Preset** as **Other**. The settings in `vercel.json` handle the rest
   (the `public` folder is the website, `api/index.js` runs the server code).
4. Don’t deploy yet; first add a database and your settings.

### 3. Add a database (Upstash Redis)

Vercel has no permanent disk, so the question bank needs a database.

1. In the Vercel project, open **Storage** (or the **Marketplace**) and add **Upstash → Redis**.
   The free plan is plenty for this app.
2. Connect it to the project. Vercel adds the connection settings
   (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`) automatically; the app accepts either pair.

The first time the app runs, it copies `data/seed.json` into the database. After that, whenever you deploy a new `seed.json` (for example from a new `padi.zip`), the app adds its new questions automatically on the first visit. Your visitors’ progress and any papers you added yourself in the app are kept. Questions that came from `seed.json` are replaced by the newer copy, so make lasting corrections in `seed.json` rather than only in the app.

### 4. Add your settings

In **Settings → Environment Variables**, add:

| Name | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
| `ADMIN_EMAILS` | your email address (the owner account) |
| `GOOGLE_CLIENT_ID` | optional, for “Continue with Google” (see below) |
| `CLAUDE_MODEL` | optional, defaults to `claude-sonnet-5-5` |

### 5. Deploy

Press **Deploy** (or **Deployments → Redeploy** if you already deployed). Vercel gives you a
link like `https://padi-yourname.vercel.app`. Every `git push` to `main` redeploys automatically.

### 6. Sign in as the owner

Open your site, press **Sign in**, and create an account (or continue with Google) using the
email you put in `ADMIN_EMAILS`. That account can add, edit and delete questions and read PDFs.
Everyone else can create their own account, or practise as a guest. Each person’s scores and
mistakes are saved to their account and follow them to every device. A guest’s scores move
into their account the first time they sign in.

### Optional: Continue with Google

1. Go to console.cloud.google.com → **APIs & Services → Credentials**.
2. **Create credentials → OAuth client ID**, application type **Web application**.
3. Under **Authorised JavaScript origins**, add your site address (for example
   `https://padi-yourname.vercel.app`) and `http://localhost:3000`.
4. Copy the client ID into `GOOGLE_CLIENT_ID` (in `.env` locally, and in Vercel’s
   environment variables), then restart or redeploy.

---

## Things to know on Vercel

- **PDF reading is slower than locally.** Vercel limits each request to about 4.5 MB, so the
  app sends 2 page images per step instead of 3. A 120-page scan takes around 120 steps.
- **Long steps.** `vercel.json` allows each step up to 300 seconds. If Vercel rejects that on
  your plan, lower `maxDuration` (for example to 60) and redeploy; check
  [Vercel’s function limits](https://vercel.com/docs/functions/limitations) for current values.
- **Costs.** Vercel’s Hobby plan and Upstash’s free plan are enough for personal use. Claude
  API usage is billed by Anthropic, separately from any Claude.ai subscription.
- **Backups.** Use **Question bank → Download backup** in the app now and then.
  **Add questions → Import a JSON file** restores it.

## Adding questions yourself

The question bank lives in `data/seed.json`. The easiest way to add to it is the helper script,
which checks your file, tidies maths notation, saves the questions, and registers the section.

### 1. Put your questions in a JSON file

Either a simple list (see `scripts/example-questions.json`):

```json
[
  {
    "q": "Which organelle is known as the powerhouse of the cell?",
    "options": ["Nucleus", "Mitochondria", "Ribosome", "Golgi body"],
    "answer": "B",
    "explanation": "Mitochondria produce most of the cell's ATP."
  }
]
```

`answer` is the correct option: `0`–`3`, or a letter `A`–`D`. `explanation` is optional and may
use `**bold**` and `* bullet` lines. Maths such as `H$_{2}$O` or `10$^{-7}$` is converted to H₂O and 10⁻⁷.

Or a file in Padi's own format (`"papers/…"` and `"questions/…"` keys), like the TNPSC Master
files. Each question's own `topic` is used as its section.

### 2. Run the script

```
node scripts/add-questions.js my-questions.json --category "Biology" --section "Cell Biology"
```

- `--category` must be a subject from the syllabus, spelled exactly (for example `Biology`,
  `Indian Polity`, `Geography of India`). The script lists them if you get it wrong.
- `--section` is the section name shown in the app. A new name creates a new section.
- Add `--dry-run` to check the file without saving anything.
- For a Padi-format file with several sections, pass only `--category`.

A subject switches from **Coming soon** to live as soon as it has questions.
Running the script again with the same file replaces those questions rather than duplicating them.

### Avoiding and fixing duplicates

- The script refuses to add a file if most of its questions are already in the bank under
  another set, and tells you which set. This is what causes duplicates: the same questions
  added twice under two different section names or ids.
- `node scripts/add-questions.js --check` lists any identical questions in the bank.
- `node scripts/add-questions.js --remove <set id>` removes a whole set. The set id is shown
  when you add it (for example `tm-biology-cell-biology`).
- Your local database and the Vercel database mirror `seed.json`: anything you remove from it
  (or rename) is removed from them on the next start or deploy. Your users' progress and any
  questions added inside the app are kept.
- `http://localhost:3000/api/status` (or the same address on your Vercel site) shows
  `duplicateQuestionsInOneSection` and `questionsNotFromSeedFile`, so you can see whether the
  live database has anything `seed.json` doesn't.

### 3. Check, then publish

```
npm start
```

Open http://localhost:3000 (and http://localhost:3000/api/status for the counts). Then commit and
push; Vercel picks up the new questions on the first visit after deploying.

### Editing by hand

You can also edit `data/seed.json` directly. Each question is one entry under `"docs"`:

```json
"questions/tm-biology-cell-biology-001": {
  "paperId": "tm-biology-cell-biology",
  "n": 1,
  "q": "Question text",
  "options": ["A", "B", "C", "D"],
  "answer": 1,
  "explanation": "",
  "category": "Biology",
  "topic": "Cell Biology"
}
```

Rules: the key after `questions/` must be unique; `answer` is `0`–`3`; `category` must match a
syllabus subject exactly; `paperId` should match an entry `"papers/<paperId>"` with a `title`
and `"kind": "practice"`. Section order within a subject comes from the `TOPICS` list near the
top of the script in `public/index.html`; the helper script updates it for you.
To remove something, delete its entry and add its key to the `"removed"` list at the end of
`seed.json`, so it is also removed from the Vercel database.

---

## How the question bank is served

With tens of thousands of questions, the app never downloads the bank. `data/seed.json` is read
once into memory on the server, and the app asks for small pieces:

| Request | What it returns |
| --- | --- |
| `GET /api/catalogue` | Subjects, sections and counts (about 40 KB). The home page needs nothing else. |
| `POST /api/quiz` | The question **ids** that make up a test, in order. A test holds at most 200 questions. |
| `POST /api/questions` | Up to 50 questions by id. The app asks for 10 at a time and fetches the next 10 about five questions ahead. |
| `GET /api/section` | One section or source, 20 questions per page (the owner's Question bank view). |
| `GET /api/status` | Counts per subject and section, for checking a deployment. |

The database (local file or Upstash Redis) holds only people's progress and any questions added
or edited inside the app. Those are laid over the bank from `seed.json`, so editing a question in
the app keeps working.

To make a test longer or shorter than 200 questions, change `MAX_TEST` near the top of the
question-bank routes in `app.js`; to change how many arrive per request, change `PAGE` and
`AHEAD` in `public/index.html`.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (none) | Needed for reading PDFs |
| `ADMIN_EMAILS` | (none) | Owner email addresses, comma-separated; required on Vercel |
| `GOOGLE_CLIENT_ID` | (none) | Enables “Continue with Google” |
| `SESSION_SECRET` | derived | Signs login cookies |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model for extraction; see https://docs.claude.com for current names |
| `MAX_TOKENS` | `8000` | Raise if answers for dense pages get cut off |
| `PORT` | `3000` | Local port only |

## Project layout

```
app.js                  API routes, permissions and the Claude API proxy (Express)
server.js               Starts app.js on your computer
api/index.js            Starts app.js on Vercel
lib/store.js            Storage: Upstash Redis on Vercel, data/bank.json locally
lib/bank.js             The question bank in memory, served in small pages
public/index.html       The whole app (HTML, CSS and JavaScript in one file)
public/claude-local.js  Browser runtime: storage, Claude, downloads, owner sign-in
data/seed.json          The question bank
scripts/add-questions.js  Adds questions from a JSON file
vercel.json             Vercel settings
```

The app was first built as a Claude artifact. `claude-local.js` provides the same small
`window.claude.use(...)` interface the artifact runtime offers, so `index.html` runs unchanged.
Your API key stays on the server and never reaches the browser.

## Troubleshooting

- **“No database is connected”** on Vercel: add Upstash Redis (step 3) and redeploy.
- **No “Add questions” tab after signing in**: your account’s email isn’t in `ADMIN_EMAILS`.
  Check the spelling, then redeploy after changing environment variables.
- **“No API key”**: set `ANTHROPIC_API_KEY` and restart (locally) or redeploy (Vercel).
- **“Claude needs a short break”**: you hit the API rate limit. Wait a minute and press Continue.
- **“The page images were too large”**: the request passed Vercel’s size limit; try again or
  read that part of the PDF on your own computer with `npm start`.
