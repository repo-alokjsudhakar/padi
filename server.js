// Padi (படி) — run on your own computer: npm start
const app = require("./app");
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log("\nPadi (படி) is running at http://localhost:" + PORT);
  console.log(process.env.ANTHROPIC_API_KEY ? "Claude model: " + (process.env.CLAUDE_MODEL || "claude-sonnet-5-5") : "Note: no ANTHROPIC_API_KEY set, so PDF reading is off. Practising still works.");
});
