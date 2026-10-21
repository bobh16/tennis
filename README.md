# Court Sense

A tennis open-play matchmaking, scoring and ratings app for a club. It runs in a
web browser, installs to a phone's home screen, and **works fully offline** at the
court — the organizer pulls the night together with no signal, and results sync
later (sync is a later phase).

## What it does today (Phase 1 — organizer tool)

- **Members roster** stored on the device (IndexedDB), scales to thousands of names.
- **Import members** by pasting a list or CSV (`Name, Level` per line).
- **Tonight's list** — search the roster and add players, or type in walk-ins.
  First come, first served queue.
- **Matchmaking** — builds doubles courts grouped by level, balances the two teams,
  rotates partners/opponents, and seats whoever has played the fewest games.
- **Scoring** — race-to-6 games per court (sudden death at 5–5).
- **Ratings** — a DUPR-style engine moves each player's level up or down from results,
  weighing partner and opponent strength; a reliability score shows how settled a
  rating is. Levels group into bands (Beginner → Advanced) shown as text or class letters.
- **Installable + offline** via a web app manifest and service worker.

Not yet built: central database + online sync (Phase 2), player logins & ranking
boards (Phase 4), and a possible ReClub import hook.

## Run it locally

Any static file server works. For example:

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173 . Installing to a phone home screen requires serving
over HTTPS (e.g. a free host like Netlify or Vercel) — drop this folder in and it deploys.

## Files

- `index.html` — app shell and layout
- `styles.css` — all styling (light + dark)
- `engine.js` — rating + matchmaking logic (no UI)
- `store.js` — IndexedDB storage
- `app.js` — UI, state, and wiring
- `sw.js` / `manifest.webmanifest` / `icon.svg` — PWA offline + install
