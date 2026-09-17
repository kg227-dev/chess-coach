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

## Test it

```bash
cd /Users/kushgulati/Desktop/chess-coach && npm test
```

150 unit tests covering scoring, board geometry, the opening book, game
phases, spaced repetition and the weakness aggregation.

## What it does

- **Play a bot** at seven strength settings (Skill Level 0–20), with a clock
  (10 minutes a side by default).
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
- **Puzzles from your own mistakes.** Every mistake and blunder is saved
  automatically, set **two plies earlier** so you have to see it coming instead
  of being handed the critical position. Replaying your original move makes the
  opponent answer with the move it actually played, so the exact position comes
  back; deviate and the engine takes over.
- **Captured pieces and material lead** under each player, chess.com style.
- **Post-game review** — eval graph over the whole game, a count of each move
  quality, and your biggest mistakes with the reason for each.
- **Weakness report** — accuracy, pawns lost per move and blunder counts split
  by opening / middlegame / endgame, which phase is costing you most, and which
  piece you hang most often. Phase comes from the material left on the board,
  not the move number, so a queenless position is an endgame whenever it happens.
- **Spaced repetition** — solved puzzles come back after 1, 3, 7, 15, 33 days and
  retire after two months; a miss resets them to ten minutes.
- **Progress tab** — bar chart of your last 20 games, average and best accuracy.
- Eval bar, move list with colour-coded quality tags, legal-move dots, check
  highlighting, drag-or-click movement, promotion picker, board flip, resign.

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
| `book.js` | Opening book (64 lines) |
| `test/logic.test.js` | 106 tests |
| `test/book.test.js` | 15 tests |
| `test/report.test.js` | 29 tests |
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

## Known gaps

- The book stops at ~10 plies, so long theoretical lines leave book early.
- Puzzle difficulty isn't adaptive — every card uses the same 2-ply rewind.
- The weakness report splits by phase but not by theme (pins, forks, back rank).
