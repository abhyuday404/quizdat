# QR Quiz

A live quiz for a room full of people. The presenter shows questions on a big
screen, participants join by scanning a QR code on their phones, and after each
question the presenter screen shows how the answers were distributed.

Live: <https://qr-quiz.abhyuday404.workers.dev>

## How a session goes

1. **Write the quiz** at `/host`. Each question has 2 to 6 options, an optional
   correct answer and an optional time limit. Leave "correct" unticked to make
   a question a plain poll. Drafts autosave in the browser, and you can import
   or export JSON (see `sample-quiz.json`).
2. **Start session.** The lobby shows a big QR code, the join URL, the room
   code and the names of everyone who joins. Click a name twice to remove them.
3. **Start quiz.** Phones show the answer buttons. The presenter shows the
   question, a countdown and how many people have answered.
4. **Results.** Voting closes when the timer runs out, when everyone has
   answered, or when you click *Show results*. The presenter shows a bar chart
   of how many people picked each option, with the correct one highlighted.
   Phones show whether the player was right and the same chart.
5. **Leaderboard** between questions is optional. After the last question,
   *Final results* shows the ranking.

Presenter keyboard shortcuts: `Space`, `Enter` or `→` press the main button,
and `F` toggles full screen.

Scoring: a correct answer earns 1000 points. On a timed question the points
drop linearly to 500 for an answer given at the very end. Polls score nothing.

Refreshing the presenter page or a phone, or a phone waking from sleep,
reconnects to the running session.

## How it works

It runs entirely on Cloudflare Workers.

- `src/worker.js` serves the static pages from `public/`, creates rooms
  (`POST /api/rooms`, which also renders the QR code) and routes
  `GET /ws?code=XXXXX` WebSockets to the room.
- `src/room.js` is a Durable Object, one per room code. It holds the room
  state in its storage, uses hibernating WebSockets so idle rooms cost nothing,
  and uses storage alarms for question timers and for deleting rooms idle for
  6 hours.
- `src/quiz.js` holds the pure rules: validation, scoring and the views sent
  to the presenter and to each phone. The correct answer never reaches phones
  while voting is open, and the presenter token is never sent back.
- `public/net.js` is a small client with acknowledgements, keep-alive pings and
  automatic reconnects.

## Develop

```bash
npm install
npm run dev     # wrangler dev on http://localhost:8787, reachable on your LAN
npm test        # unit tests + a full session against wrangler dev
npm run deploy  # wrangler deploy
npm run tail    # live logs from production
```

For phones on your Wi-Fi during local development, open the presenter page via
your laptop's LAN address, for example `http://192.168.1.20:8787/host`, so the
QR code points there. `PUBLIC_URL` (a Worker variable) overrides the base URL
used in QR codes.

## Custom domain

The Worker is bound to `quiz.abhyudayrai.com` through the `routes` entry in
`wrangler.jsonc` (a Workers custom domain, so Cloudflare manages the DNS
record and the certificate). It serves there once the zone `abhyudayrai.com`
is active on Cloudflare, which needs the registrar's nameservers pointed at
the two Cloudflare assigns. QR codes follow whichever address the presenter
opened.
