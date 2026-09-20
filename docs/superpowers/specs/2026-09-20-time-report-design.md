# Time-per-move report

2026-09-20

## Problem

Every move played in the app already records how long it took. `app.js` stamps
`thinkMs` when your turn starts and stores it as `ms` on the breakdown row.
`logic.js` has `bucketForMs()` and `timeReport()`, both covered by tests.

None of it reaches the screen. `timeReport()` has no caller outside the test
suite, so the analysis runs nowhere and the data accumulates unread.

Imported chess.com games make it worse: they hardcode `ms: null`, so the one
source of real games under real pressure contributes nothing.

## Goal

Show the report, and feed it every game rather than only the ones played here.

## Scope decisions

**All games, including imports.** chess.com PGNs carry `[%clk 0:09:57.1]` after
each move, so think time is recoverable as the drop between one clock reading
and the player's next, plus any increment.

**Buckets relative to each game's pace.** Raw-second thresholds cannot compare a
one-minute bullet game with a thirty-minute rapid one. Pooling them makes
"you blunder when you move fast" true by construction, because bullet offers no
alternative.

The existing thresholds are already pace-relative in disguise: against a
ten-minute clock, 5s / 15s / 30s are exactly 1/120, 1/40 and 1/20 of the base
time. Expressing the buckets as those fractions, with ten minutes as the
reference base, reproduces every current boundary exactly.

## Design

### `logic.js`

`timeControlOf(pgn)` reads the `[TimeControl]` tag and returns
`{ baseMs, incMs }`, or `null` when the tag is missing or is a form we do not
handle (correspondence games read `1/259200`).

`thinkTimesFromPgn(pgn)` returns one entry per ply: the think time in
milliseconds, or `null` where no `[%clk]` tag was present. Think time is the
previous clock reading for that player minus the current one, plus the
increment. The first move of each side measures from `baseMs`.

Returning `null` per ply rather than failing whole-game means a partially
annotated PGN degrades to the moves it can explain.

`bucketForMs(ms, baseMs)` divides by `baseMs` and compares fractions. `baseMs`
defaults to ten minutes, so existing callers and tests are unaffected.

`timeReport(games)` reads each game's `baseMs`, passing it down per game, and
accumulates elapsed milliseconds per bucket so each row can state what the
bucket meant in real seconds.

### Game records

Records gain `baseMs`. Live games take `CFG.timeMin * 60000`, or `null` when the
clock is unlimited. Imports take it from the PGN.

### `app.js`

The import loop stops writing `ms: null` and uses the parsed per-ply value.

`timeHTML()` renders a section in the report panel below "Pieces you hang",
reusing the existing `.wrow` / `.wbar` / `.ptitle` markup, so no new CSS. Bucket
labels become pace names, each row's subtext gives the average real seconds, and
the existing `insight` becomes the headline.

## Decisions

Unlimited-clock games, and older records saved before `baseMs` existed, fall
back to the ten-minute reference. That is exactly today's raw-second behaviour,
so nothing regresses.

Think times that come out negative or implausibly large, from disconnects or
chess.com's own clock corrections, are discarded for that ply rather than
clamped. A clamped value is a number we made up.

## Testing

The clock parsing is pure and full of edge cases, so it is written test-first:
tag forms with and without increment, missing tags, partial annotation, the
first move of each side, and corrupt readings.
