# Project Overview

Schrijf Superster — a handwriting practice app built for Isabelle (~7 years old).
Kids practice handwriting and receive AI-generated scoring and feedback on their
attempts. A separate companion app lets an adult (parent/teacher) review a
child's progress and add their own feedback.

# Architecture

- **Kid-facing app** (`schrijf-superster-v1.1.html`): standalone HTML app.
  Handles profile creation, handwriting attempts, and displays AI + adult
  feedback. Shows an orange notification banner (with a bouncing emoji, no
  sound) when new feedback has arrived. Re-checks `/ongelezen` every 2
  minutes while the home screen is the active screen and the tab is visible
  (polling stops the moment she navigates elsewhere or backgrounds the tab).
- **Adult-facing app** (`schrijf-feedback.html`): standalone HTML app, separate
  file, not linked from the kid's app (so a child doesn't stumble into it).
  Lets an adult browse all children's attempts, view the AI's assessment, add
  their own 0–100 score (with a star-rating reference), and write text
  feedback with quick-reply buttons.
- **Backend** (`cloudflare-worker.js`): a single Cloudflare Worker shared by
  both apps. Acts as a proxy to the Anthropic API (keeps the API key
  server-side) and handles all reads/writes to KV: user profiles, attempts
  (photo + metadata stored separately), and feedback per attempt, including
  an unread-feedback flag per user.
- **Persistence**: Cloudflare KV, binding name `SCHRIJF_KV`.
- **Multi-user**: multiple child profiles, all persisted via KV.

Both HTML apps talk to the same Worker URL, entered once per app and saved to
browser localStorage.

# API Endpoints (Worker)

All responses are JSON. CORS is open (`*`). Errors return `{ fout: "..." }`
with an appropriate status code.

| Method | Path | Purpose |
|---|---|---|
| POST | `/` or `/ai` | Proxy to Anthropic API (adds `x-api-key` server-side) |
| POST | `/gebruiker` | Create a child profile `{ naam, emoji }` |
| GET | `/gebruiker?id=` | Fetch one profile |
| GET | `/gebruikers` | List all profiles |
| POST | `/gebruiker/verwijder` | Delete a user entirely: all their attempts, photos, feedback, their index, unread list, and their entry in the global user list |
| POST | `/poging` | Save a handwriting attempt `{ gebruikerId, opdrachtId, aiScore, foto, ... }`. Photo stored separately (`foto:<id>`, 90-day TTL) from metadata (`poging:<id>`). Also updates a per-user index (`pogingen-index:<gebruikerId>`, capped at 100 entries) |
| GET | `/pogingen?gebruikerId=&opdrachtId=` | List a user's attempts, optionally filtered by assignment |
| GET | `/foto?pogingId=` | Fetch a stored photo |
| POST | `/feedback` | Save adult feedback `{ pogingId, gebruikerId, jufScore, tekst }`. Also flips `heeftFeedback: true` on the corresponding `poging` record, and adds the attempt to that user's unread list |
| GET | `/feedback?pogingId=` | Fetch feedback for one attempt |
| GET | `/ongelezen?gebruikerId=` | List attempt IDs with unread feedback |
| POST | `/ongelezen/gelezen` | Mark **all** of a user's feedback as read in one go — clears their entire unread list `{ gebruikerId }` (not a per-attempt mark-as-read) |

# Tech Stack

- Plain HTML/CSS/JS (no build step, no framework) — self-contained files
- Cloudflare Workers (backend/proxy)
- Cloudflare KV (data store, `SCHRIJF_KV` binding)
- Anthropic API (Claude) for handwriting scoring/feedback

# Folder Structure

Current setup (matches the GitHub repo at
`schrijf-superster/`):
```
schrijf-superster/
  CLAUDE.md
  README.md
  schrijf-superster-v1.1.html   # kid-facing app — LIVE, do not move without updating the deployed link
  schrijf-feedback.html          # adult-facing feedback app — LIVE, same caveat
  worker/
    cloudflare-worker.js         # backend source, mirrors what's deployed in the Cloudflare dashboard
```

Note: the two HTML files are deployed as-is (e.g. via GitHub Pages) and may be
bookmarked on devices already in use. Keep them at the repo root — moving them
into a subfolder changes their live URL and breaks existing bookmarks/links.
The `worker/` folder is just for keeping the Worker source under version
control; it still needs to be pasted into the Cloudflare dashboard manually
to deploy (no CI/CD yet). **Keep this file in sync with the dashboard** — if
you edit the Worker directly in Cloudflare, copy the change back here too.

# Coding Conventions

- Never put the Anthropic API key or any secret in frontend code — it only
  ever lives in the Worker's environment variables.
- Keep both HTML apps self-contained (no external build step) unless there's
  a strong reason to introduce one.
- KV key patterns in use: `gebruiker:<id>`, `gebruikers:alle`,
  `poging:<id>`, `pogingen-index:<gebruikerId>`, `foto:<id>`,
  `feedback:<pogingId>`, `ongelezen:<gebruikerId>`. Follow these patterns
  for any new data added to the Worker. Format is always `type:id`,
  colon-separated.
- **Language split**: domain/business terms stay Dutch (`gebruiker`,
  `poging`, `opdracht`, `feedback`, `ongelezen`); JS/framework terms stay
  English (`json`, `fetch`, `request`, `env`, `url`). Keep this split in
  new code rather than translating everything to one language.
- **Error handling**: always return errors via the shared `fout(bericht, status)`
  helper, which produces `{ fout: "..." }` — never throw raw errors or return
  ad-hoc error shapes.
- **Section comments**: mark logical sections in the Worker with
  `// ── SECTION NAME ── ─────────────` style headers, matching the existing
  ones (AI PROXY, GEBRUIKER, POGING OPSLAAN, etc.).
- **Style**: single quotes, semicolons, 2-space indentation, `async/await`
  throughout — avoid `.then()` chains.
- **Change tracking**: notable fixes are marked inline as `// FIX #N: ...`
  comments at the point of change, rather than kept in a separate changelog
  file. Keep using this convention for traceability.

# Commands

No build step currently — these are static HTML files.
```
# Deploying the Worker: paste cloudflare-worker.js contents into
# the Worker's editor at workers.cloudflare.com and click Deploy.
```
[Update this section if a CLI-based workflow (e.g. wrangler) is adopted later.]

# Important Notes

- This app is used directly by a young child (Isabelle) — keep UI copy simple,
  encouraging, and age-appropriate in any generated content or error states.
- `schrijf-feedback.html` is the adult review module, not an older/duplicate
  version of the kid's app — don't merge or deduplicate the two files.
- Treat the Anthropic API key as sensitive at all times; access only through
  the Worker, never client-side.
- The Worker needs a `SCHRIJF_KV` KV namespace binding and an
  `ANTHROPIC_API_KEY` environment variable set in the Cloudflare dashboard.
- `/gebruiker/verwijder` is a destructive, irreversible delete — a UI that
  calls it should confirm with the adult before sending the request.
- `/ongelezen/gelezen` clears ALL unread feedback for a user at once, not a
  single attempt — keep that in mind if building more granular "mark as read"
  behavior later, since it would need a new endpoint or a parameter change.
- Keep this file updated as the architecture evolves — a stale CLAUDE.md
  misleads more than an absent one.
