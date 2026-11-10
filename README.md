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
public/index.html       The whole app (HTML, CSS and JavaScript in one file)
public/claude-local.js  Browser runtime: storage, Claude, downloads, owner sign-in
data/seed.json          Starting question bank
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
