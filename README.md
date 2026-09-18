# Chess Coach

A self-contained chess trainer: play full games against a Stockfish bot, get the
engine's verdict on **every** move, take moves back and retry, and track your
accuracy game over game the way chess.com does.

Everything runs locally — Stockfish and chess.js are vendored into `vendor/`, so
after the first load there is no network dependency at all and nothing is sent
anywhere.

## Run it

```bash
cd /Users/kushgulati/Desktop/chess-coach && python3 serve.py
```

Then open <http://localhost:8777>. `serve.py` sends no-cache headers so edits
always show up on reload — plain `http.server` caches aggressively and will
serve you stale JS.

## Live

**<https://kg227-dev.github.io/chess-coach/>**

Served free from GitHub Pages off the `main` branch. Push to `main` and the site
rebuilds in a couple of minutes:

```bash
git add -A && git commit -m "..." && git push
```

`artifact.html` is an alternative entry point for Claude Artifact hosting (same
app without the outer `<html>` wrapper); it isn't used by the Pages deploy.

## On your phone

Open <https://kg227-dev.github.io/chess-coach/> in Safari, tap **Share → Add to
Home Screen**. It launches full-screen with its own icon and no browser chrome —
close enough to a native app, with no App Store and no build step. Android
Chrome offers the same through *Install app*.

The phone layout puts the board at full width with the clocks above and below
it, drops the control labels to two compact rows, and stacks the review buttons.
Safe-area insets are handled, so nothing hides under the notch or home indicator.

It works **offline**. A service worker precaches the shell and the engine on
first visit, so the home-screen app opens cold with no connection. The worker is
registered over https only, so `localhost` stays uncached while you're editing.

## Test it

```bash
cd /Users/kushgulati/Desktop/chess-coach && npm test
```

208 unit tests covering scoring, board geometry, the opening book and trainer
lines, game phases, spaced repetition, weakness aggregation, tactical themes,
backup merging and bot move selection.

## What it does

- **Play a bot** at seven strengths from Beginner (~800) to full strength, with
  a clock (10 minutes a side by default).
- **Opening trainer** — 20 mainline openings, ten for each colour, each with a
  **Tutorial** and a **Practice** mode. In the tutorial you play the moves
  yourself following an arrow, so the line goes into your hands and not just
  your eyes; the opponent replies automatically, and **Watch it** plays the
  whole line through if you'd rather just see it first. Practice then has you play your side from memory, refusing wrong moves
  rather than letting them into the line, with the answer after two slips or on
  request. Openings you've seen default to Practice, ones you haven't default to
  Tutorial, and you can jump back to the tutorial from inside practice.
- **Per-move review** — Brilliant / Best / Excellent / Good / Inaccuracy / Mistake / Blunder,
  how much you gave up in pawns, your accuracy for that move, and the engine's
  top candidate moves with evals and follow-up lines.
- **Plain-English reasons** where they can be proven from the board —
  "bxa6 takes your bishop", "This lets the bot force mate", "You had a forced
  mate with Qh5".
- **The answer stays hidden.** The card tells you *what went wrong* ("bxa6 takes
  your bishop") but not what to play. You get 3 take-backs to find it yourself
  before the engine's choice is revealed — or press **Show best** to give up.
  Retries are counted but never change your score.
- **Brilliant (`!!`)** for a best move that gives up material and still holds —
  a real sacrifice, not a trade or a protected poke.
- **Opening theory isn't graded.** While the game follows a known line the move
  is marked *Book* and left out of your accuracy — the engine preferring one
  normal developing move over another says nothing about how you played. A
  64-line book covers what a club player actually reaches.
- **Puzzles from your own mistakes.** Every mistake and blunder is saved as a
  puzzle: the position you actually went wrong in, one move to find, with the
  side to move and the goal stated plainly. The pass mark is the same bar the
  rest of the app uses — a move that gives nothing away (Good or better). Solve
  it and you're told what you originally played and what it cost; **Show me**
  reveals the engine's choice. Solved puzzles chain straight into the next due.
- **Captured pieces and material lead** under each player, chess.com style.
- **Post-game review** — eval graph over the whole game, a count of each move
  quality, and your biggest mistakes with the reason for each.
- **Think-time analysis** — accuracy split by how long you spent, so you can see
  whether your errors come from moving too fast.
- **Blunder-check** (optional) — a nudge to look again before a losing move,
  without saying what's wrong. Your accuracy still records the move you played.
- **Weakness report** — accuracy, pawns lost per move and blunder counts split
  by opening / middlegame / endgame, plus **what kind of tactic beats you**:
  hanging pieces, forks, pins, back rank, allowed and missed mates, missed
  material. Each theme is read off the board rather than guessed, so it never
  names a motif that isn't there. Phase comes from the material left on the board,
  not the move number, so a queenless position is an endgame whenever it happens.
- **Spaced repetition** — solved puzzles come back after 1, 3, 7, 15, 33 days and
  retire after two months; a miss resets them to ten minutes.
- **Progress tab** — bar chart of your last 20 games, average and best accuracy.
- **Export / import** in Settings — one JSON file with games, puzzles and
  settings. Importing *merges* rather than replaces, so pulling a backup onto a
  second device combines the two histories instead of discarding one.
- Eval bar, move list with colour-coded quality tags, legal-move dots, check
  highlighting, drag-or-click movement, promotion picker, board flip, resign.

## Your real chess.com games

Settings → **Your chess.com games**: enter your handle and it pulls your recent
public games and runs the same review over them, so the weakness report and the
puzzle set come from real opponents rather than the bot. Read-only, no password,
nothing is sent anywhere — chess.com's public API allows browser requests
directly. Roughly 10-20 seconds per game at the default depth.

## How the bot is weakened

This Stockfish build exposes only `Skill Level`, which weakens play by
randomising *inside* the search — it plays well and then hangs a piece for no
reason, which teaches the wrong instincts. (`UCI_Elo` isn't available here; the
build has no `UCI_LimitStrength` option at all.)

Instead the bot searches at full strength with MultiPV and the move is chosen
afterwards: `depth` caps how far ahead it sees so it misses deep tactics the way
a weaker player does, `temperature` sets how willing it is to take a slightly
worse move, and `maxLoss` is a hard ceiling so it never throws a piece away at a
level that shouldn't. Levels live in `BOT_LEVELS` in `logic.js`.

## How move quality is judged

Not by raw centipawns, but by how much **winning chance** a move threw away —
the same win-percentage model the accuracy score uses, so the two agree:

| Win% thrown away | Verdict |
| --- | --- |
| under 2 | Excellent |
| 2-10 | Good |
| 10-20 | Inaccuracy |
| 20-30 | Mistake |
| 30+ | Blunder |

This matters because centipawns alone are misleading. Dropping 1.5 pawns from an
equal position is an Inaccuracy; dropping the same 1.5 pawns while already a rook
up is merely Good, because it doesn't change the result. An earlier version
classified on absolute centipawn loss and called ordinary moves mistakes.

## How accuracy is measured

Every position is searched at a **fixed depth** (12) with MultiPV, and the move
you played is scored from *that same search* whenever it appears in the top
lines. This matters: comparing evaluations taken from two searches of different
lengths is the classic way to invent blunders that never happened, and it was a
real bug here before the tests caught it.

```
win%(cp)  = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
accuracy  = 103.1668 * exp(-0.04354 * (win%_before - win%_after)) - 3.1669
```

Game accuracy is the mean over your moves. Only your **first attempt** at each
position counts, so taking a move back to learn from it can't inflate the score.

If the engine returns no evaluation for a position, the move is left unscored
rather than being given a made-up one.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `styles.css` | chess.com-style dark theme |
| `logic.js` | All scoring/geometry maths — pure, no DOM, unit tested |
| `app.js` | Engine worker, game flow, board UI, panels |
| `book.js` | Opening book (64 lines) + 20 trainer lines |
| `pieces.svg` | Cburnett piece sprite (CC BY-SA 3.0) |
| `test/logic.test.js` | 106 tests |
| `test/book.test.js` | 24 tests |
| `test/report.test.js` | 41 tests |
| `test/bot.test.js` | 14 tests |
| `test/themes.test.js` | 23 tests |
| `manifest.webmanifest`, `icons/` | Add-to-Home-Screen metadata and icons |
| `sw.js` | Service worker — offline precache |
| `serve.py` | No-cache dev server |
| `artifact.html` | Entry point for the published version |
| `vendor/` | chess.js and stockfish.js, vendored for offline use |

## Tuning

Most knobs live in the **Settings** tab in the app itself (saved to
localStorage): clock, analysis depth, bot think time, take-backs before the
answer, eval-bar visibility, arrow visibility, and clearing your history.

In `logic.js`: `classify()` holds the move-quality thresholds and
`isSacrifice()` decides what counts as Brilliant.

## Hosting notes

The engine runs in a Web Worker, which some sandboxed hosts forbid. `serve.py`
can reproduce those conditions locally so it can be tested rather than guessed:

```bash
python3 serve.py 8788 --csp            # artifact-like CSP — engine works
python3 serve.py 8789 --csp-noworker   # workers blocked — shows the error panel
```

If workers are blocked the app now fails in about a second with an explanation
and a retry button, rather than spinning forever.

## Where your data lives

In this browser's `localStorage` under three keys — `chesscoach.games.v1`,
`chesscoach.puzzles.v1` and `chesscoach.settings.v1`. Nothing is sent anywhere
and there is no account.

That means it is **per browser, per device, per origin**: your phone and your
laptop keep separate histories, and the live site's data is separate from
`localhost`. Safari can also evict it if you don't open the site for a week.
Use **Settings → Export** for a copy, and **Import** to merge it somewhere else.

## Credits

Piece graphics are the Cburnett set from Wikimedia Commons, used under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/); the licence and
author list are preserved in `pieces.svg`.

## Known gaps

- The book stops at ~10 plies, so long theoretical lines leave book early.
- Puzzle difficulty isn't adaptive — every card uses the same 2-ply rewind.
- The opening trainer drills one mainline per opening, with no sidelines and no
  spaced repetition of its own.
- Theme detection covers the common motifs but not discovered attacks, skewers
  or deflections, which are harder to read off a single position reliably.
- No cross-device sync. Export/import covers moving data by hand.
- Bumping `VERSION` in `sw.js` is manual; forget it and returning visitors keep
  the old assets until the navigation request refreshes them.
