/* Pure logic for Chess Coach — no DOM, no worker.
   Loaded as a global (browser) and as a CommonJS module (tests). */
(function (root) {
'use strict';

var Chess = root && root.Chess;
if (!Chess && typeof require === 'function') {
  try { Chess = require('./vendor/chess.js').Chess; } catch (e) { /* browser */ }
}

var FILES = 'abcdefgh';
var PIECE_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/* ---------- UCI parsing ---------- */

function parseInfo(line) {
  var o = {}, m;
  if ((m = /\bdepth (\d+)/.exec(line))) o.depth = +m[1];
  o.multipv = (m = /\bmultipv (\d+)/.exec(line)) ? +m[1] : 1;
  if ((m = /\bscore (cp|mate) (-?\d+)/.exec(line))) {
    if (m[1] === 'cp') o.cp = +m[2]; else o.mate = +m[2];
  }
  if ((m = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?(?:\s+[a-h][1-8][a-h][1-8][qrbn]?)*)/.exec(line))) {
    o.pv = m[1].trim().split(/\s+/);
  }
  return o;
}

// Centipawns from the perspective of the side to move. Mate keeps its distance
// so #1 ranks above #5, and stays far outside any real centipawn range.
function infoToCp(info) {
  if (!info) return null;
  if (info.mate !== undefined) return info.mate > 0 ? 10000 - info.mate : -10000 - info.mate;
  if (info.cp !== undefined) return info.cp;
  return null;
}

var MATE_CP = 9000;
function isMateScore(cp) { return Math.abs(cp) >= MATE_CP; }

/* ---------- evaluation → human numbers ---------- */

// Lichess/chess.com win-probability model. The bound is wide enough that a
// forced mate reads as ~100%, so a mating move can't score below a quiet one.
function winPct(cp) {
  var c = Math.max(-10000, Math.min(10000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

function moveAccuracy(winBefore, winAfter) {
  var drop = Math.max(0, winBefore - winAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

var CLASSES = {
  Brilliant:  { key: 'Brilliant',  color: 'var(--c-brilliant)',  icon: '!!' },
  Best:       { key: 'Best',       color: 'var(--c-best)',       icon: '★'  },
  Excellent:  { key: 'Excellent',  color: 'var(--c-excellent)',  icon: '!'  },
  Good:       { key: 'Good',       color: 'var(--c-good)',       icon: '✓'  },
  Inaccuracy: { key: 'Inaccuracy', color: 'var(--c-inaccuracy)', icon: '?!' },
  Mistake:    { key: 'Mistake',    color: 'var(--c-mistake)',    icon: '?'  },
  Blunder:    { key: 'Blunder',    color: 'var(--c-blunder)',    icon: '??' },
};

/* Move quality is judged on how much winning chance the move threw away, not
   on raw centipawns. The same 1.5 pawns is a catastrophe from an equal position
   and irrelevant when you are already up a rook, and centipawns can't tell the
   difference. Thresholds are win-percentage points, matching the convention
   Lichess and chess.com use. */
var QUALITY_THRESHOLDS = { excellent: 2, good: 10, inaccuracy: 20, mistake: 30 };

function classify(winDrop, wasBest, brilliant) {
  if (brilliant) return CLASSES.Brilliant;
  if (wasBest) return CLASSES.Best;
  var d = Math.max(0, winDrop || 0);
  if (d < QUALITY_THRESHOLDS.excellent) return CLASSES.Excellent;
  if (d < QUALITY_THRESHOLDS.good) return CLASSES.Good;
  if (d < QUALITY_THRESHOLDS.inaccuracy) return CLASSES.Inaccuracy;
  if (d < QUALITY_THRESHOLDS.mistake) return CLASSES.Mistake;
  return CLASSES.Blunder;
}

function fmtEval(cp, forWhite) {
  var v = forWhite ? cp : -cp;
  if (isMateScore(v)) {
    var n = Math.max(1, 10000 - Math.abs(v));
    return (v > 0 ? '#' : '-#') + n;
  }
  return (v > 0 ? '+' : '') + (v / 100).toFixed(2);
}

/* ---------- move notation ---------- */

function sameMove(a, b) { return !!a && !!b && a.slice(0, 4) === b.slice(0, 4); }

function applyUci(chess, uci) {
  if (!uci || uci.length < 4) return null;
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
}

function uciToSan(fen, uci) {
  try {
    var m = applyUci(new Chess(fen), uci);
    return m ? m.san : uci;
  } catch (e) { return uci; }
}

function pvToSan(fen, pv, max) {
  max = max || 5;
  var c, out = [], i;
  try { c = new Chess(fen); } catch (e) { return ''; }
  for (i = 0; i < Math.min(pv.length, max); i++) {
    var m = applyUci(c, pv[i]);
    if (!m) break;
    out.push(m.san);
  }
  return out.join(' ');
}

/* ---------- board geometry ---------- */

// Returns the centre of a square in board units (0..8), honouring orientation.
function squareToXY(sq, flipped) {
  var f = sq.charCodeAt(0) - 97, r = +sq[1];
  var col = flipped ? 7 - f : f;
  var row = flipped ? r - 1 : 8 - r;
  return { x: col + 0.5, y: row + 0.5 };
}

// Display order of squares, top-left first.
function boardSquares(flipped) {
  var out = [], r, c;
  for (r = 0; r < 8; r++) {
    for (c = 0; c < 8; c++) {
      var file = flipped ? FILES[7 - c] : FILES[c];
      var rank = flipped ? r + 1 : 8 - r;
      out.push(file + rank);
    }
  }
  return out;
}

// a1 is dark: file index + rank is odd there, so even means light.
function isLightSquare(sq) {
  return ((sq.charCodeAt(0) - 97) + (+sq[1])) % 2 === 0;
}

/* ---------- brilliancy detection ---------- */

var VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/* chess.js does not throw on a bad FEN — it just fails to load and leaves the
   previous position in place. Always check the return value. */
function loadFen(fen) {
  try {
    var c = new Chess();
    return c.load(fen) ? c : null;
  } catch (e) { return null; }
}

/* True when the moved piece (worth a knight or more) is left where the
   opponent can win material for less, and we can't win it back — i.e. a real
   offer, not a trade or a protected poke. */
function isSacrifice(fenAfter, toSq, movedType, capturedType) {
  var ourValue = VALUE[movedType] || 0;
  if (ourValue < 3) return false;
  if (capturedType && (VALUE[capturedType] || 0) >= ourValue) return false; // a trade, not a gift

  var c;
  try { c = new Chess(fenAfter); } catch (e) { return false; }

  var caps = c.moves({ verbose: true }).filter(function (m) { return m.to === toSq && m.captured; });
  if (!caps.length) return false;
  caps.sort(function (a, b) { return (VALUE[a.piece] || 0) - (VALUE[b.piece] || 0); });

  var cheapest = caps[0];
  var attackerValue = VALUE[cheapest.piece] || 0;   // king counts as 0: it only captures what is undefended
  c.move({ from: cheapest.from, to: cheapest.to, promotion: 'q' });

  var recaptures = c.moves({ verbose: true }).filter(function (m) { return m.to === toSq && m.captured; });
  if (!recaptures.length) return true;              // piece simply hangs
  return attackerValue < ourValue;                  // won by something cheaper
}

/* ---------- scoring a played move ---------- */

/* Given the multi-PV search of the position BEFORE the move, work out what the
   move cost. Using the played move's own line from that same search keeps both
   evaluations at identical depth — comparing two separate searches is what
   invents phantom blunders. Returns null when the search gave us nothing. */
function scoreMove(opts) {
  var before = opts.before;                 // { bestmove, pvs }
  var playedUci = opts.playedUci;
  var gameOver = !!opts.gameOver;
  var isCheckmate = !!opts.isCheckmate;
  var afterSearch = opts.afterSearch || null; // used only if the move isn't in pvs

  var bestInfo = before && before.pvs ? before.pvs[1] : null;
  var cpBefore = infoToCp(bestInfo);
  if (cpBefore === null) return null;

  var bestUci = (before.bestmove) || (bestInfo.pv && bestInfo.pv[0]) || null;
  var wasBest = sameMove(playedUci, bestUci);

  var cpAfterMine = null, playedLine = null, k;
  for (k in before.pvs) {
    var info = before.pvs[k];
    if (info && info.pv && sameMove(info.pv[0], playedUci)) {
      cpAfterMine = infoToCp(info);
      playedLine = info.pv;
      break;
    }
  }

  if (cpAfterMine === null) {
    if (gameOver) {
      cpAfterMine = isCheckmate ? 10000 : 0;
      playedLine = [playedUci];
    } else if (afterSearch && afterSearch.pvs && afterSearch.pvs[1]) {
      var opp = infoToCp(afterSearch.pvs[1]);
      if (opp === null) return null;
      cpAfterMine = -opp;
      playedLine = [playedUci].concat(afterSearch.pvs[1].pv || []);
    } else {
      return null;
    }
  }

  var cpLoss = wasBest ? 0 : Math.max(0, cpBefore - cpAfterMine);
  var winBefore = winPct(cpBefore);
  var winAfter = winPct(cpAfterMine);
  var winDrop = wasBest ? 0 : Math.max(0, winBefore - winAfter);

  // Brilliant: the engine's own move, giving material away, and still fine after.
  var brilliant = false;
  if (wasBest && cpAfterMine > -100 && opts.fenAfter && opts.playedTo && opts.playedPiece) {
    brilliant = isSacrifice(opts.fenAfter, opts.playedTo, opts.playedPiece, opts.playedCaptured);
  }

  return {
    cpBefore: cpBefore,
    cpAfterMine: cpAfterMine,
    cpLoss: cpLoss,
    winDrop: winDrop,
    wasBest: wasBest,
    brilliant: brilliant,
    bestUci: bestUci,
    playedLine: playedLine,
    cls: classify(winDrop, wasBest, brilliant),
    accuracy: moveAccuracy(winBefore, winAfter),
  };
}

/* ---------- plain-English reasons ---------- */

/* Conservative on purpose: it only states things it can read off the board,
   so it never claims a tactic that isn't there.

   Split in two so the UI can teach rather than spoon-feed:
     problem — what is wrong with the move you played (safe to show at once)
     answer  — what you should have played (withheld until you ask). */
function explainMove(o) {
  var problem = [], answer = [], hung = null;
  var bestUci = o.bestUci || null;
  var bestSan = bestUci ? uciToSan(o.fenBefore, bestUci) : null;

  if (o.cpAfterMine <= -MATE_CP) problem.push('This lets the bot force mate.');
  else if (o.cpBefore >= MATE_CP && o.cpAfterMine < MATE_CP && bestSan) {
    answer.push('You had a forced mate with ' + bestSan + '.');
  }

  var refutation = o.playedLine && o.playedLine[1];
  if (refutation && o.cpLoss >= 90 && o.fenAfter) {
    try {
      var r = applyUci(new Chess(o.fenAfter), refutation);
      if (r && r.captured) {
        hung = r.captured;
        problem.push(r.san + ' takes your ' + PIECE_NAME[r.captured] + '.');
      }
      else if (r && o.cpLoss >= 200) problem.push('The bot answers ' + r.san + '.');
    } catch (e) { /* ignore */ }
  }

  if (bestUci && o.cpLoss >= 90 && !o.playedCaptured) {
    try {
      var b = applyUci(new Chess(o.fenBefore), bestUci);
      if (b && b.captured) answer.push(bestSan + ' would have won a ' + PIECE_NAME[b.captured] + '.');
    } catch (e) { /* ignore */ }
  }

  return { problem: problem.slice(0, 2).join(' '), answer: answer.slice(0, 1).join(' '), hung: hung };
}

/* ---------- aggregates ---------- */

/* ---------- captured material ---------- */

/* From chess.js verbose history. `capturedBy[c]` lists the piece types colour c
   has taken; `diff` is white's material lead in pawns (negative = black ahead). */
function materialFromHistory(history) {
  var capturedBy = { w: [], b: [] };
  (history || []).forEach(function (m) {
    if (m && m.captured && capturedBy[m.color]) capturedBy[m.color].push(m.captured);
  });
  function score(c) {
    return capturedBy[c].reduce(function (s, t) { return s + (VALUE[t] || 0); }, 0);
  }
  return { capturedBy: capturedBy, diff: score('w') - score('b') };
}

function gameAccuracy(records) {
  var vals = records.map(function (r) { return r.acc; }).filter(function (v) { return typeof v === 'number'; });
  if (!vals.length) return null;
  return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
}

/* ---------- puzzles from your own mistakes ---------- */

/* Replay the game up to `ply` and return the position there. */
function fenAtPly(sans, ply) {
  var c;
  try { c = new Chess(); } catch (e) { return null; }
  var n = Math.max(0, Math.min(ply, sans.length));
  for (var i = 0; i < n; i++) {
    if (!c.move(sans[i])) return null;
  }
  return c.fen();
}

/* A puzzle starts `back` plies before the mistake, so you have to see it
   coming rather than being handed the critical position. Returns where to
   start and how many moves you have to get right from there. */
function puzzleStart(sans, ply, back) {
  if (back === undefined) back = 2;
  var startPly = Math.max(0, ply - back);
  var fen = fenAtPly(sans, startPly);
  if (!fen) return null;
  return {
    fenStart: fen,
    startPly: startPly,
    userMoves: Math.floor((ply - startPly) / 2) + 1,
  };
}

/* ---------- game phase ---------- */

/* Phase from what is actually left on the board, not just the move number —
   a queenless position on move 15 is an endgame whatever the clock says. */
function phaseOf(fen, ply) {
  var placement = String(fen || '').split(' ')[0];
  var npm = 0;                                  // non-pawn, non-king material, both sides
  for (var i = 0; i < placement.length; i++) {
    var ch = placement[i].toLowerCase();
    if (ch !== 'p' && VALUE[ch]) npm += VALUE[ch];
  }
  if (npm <= 20) return 'endgame';              // roughly a rook and a minor each
  if ((ply || 0) < 20) return 'opening';
  return 'middlegame';
}

/* ---------- spaced repetition ---------- */

var DAY_MS = 86400000;

/* SM-2 in miniature: solving pushes the next review out, failing resets it to
   ten minutes. A card that survives two months is retired. */
function scheduleReview(rec, solved, now) {
  now = now || Date.now();
  var interval = (rec && rec.interval) || 0;
  var out = {
    solves: ((rec && rec.solves) || 0) + (solved ? 1 : 0),
    lapses: ((rec && rec.lapses) || 0) + (solved ? 0 : 1),
    retired: false,
  };
  if (solved) {
    out.interval = interval === 0 ? 1 : (interval === 1 ? 3 : Math.round(interval * 2.2));
    out.due = now + out.interval * DAY_MS;
    out.retired = out.interval >= 60;
  } else {
    out.interval = 0;
    out.due = now + 10 * 60000;
    out.retired = false;
  }
  return out;
}

function isDue(rec, now) {
  if (!rec || rec.retired) return false;
  return (rec.due || 0) <= (now || Date.now());
}

function dueList(list, now) {
  now = now || Date.now();
  return (list || []).filter(function (r) { return isDue(r, now); })
    .sort(function (a, b) { return (a.due || 0) - (b.due || 0); });
}

/* ---------- weakness report ---------- */

function emptyBucket() {
  return { moves: 0, accSum: 0, cpSum: 0, blunders: 0, mistakes: 0, inaccuracies: 0 };
}

function finishBucket(b) {
  return {
    moves: b.moves,
    accuracy: b.moves ? b.accSum / b.moves : null,
    avgLoss: b.moves ? b.cpSum / b.moves : null,
    blunders: b.blunders,
    mistakes: b.mistakes,
    inaccuracies: b.inaccuracies,
    errorRate: b.moves ? (b.blunders + b.mistakes) / b.moves : 0,
  };
}

/* Aggregates the per-move breakdown saved with each finished game. */
function weaknessReport(games) {
  var phases = { opening: emptyBucket(), middlegame: emptyBucket(), endgame: emptyBucket() };
  var total = emptyBucket();
  var hung = {};
  var themes = {};
  var gamesWithData = 0;

  (games || []).forEach(function (g) {
    var rows = (g && g.breakdown) || [];
    if (rows.length) gamesWithData++;
    rows.forEach(function (m) {
      if (!m || typeof m.acc !== 'number') return;
      var bucket = phases[m.phase] || phases.middlegame;
      [bucket, total].forEach(function (b) {
        b.moves++;
        b.accSum += m.acc;
        b.cpSum += m.cpLoss || 0;
        if (m.cls === 'Blunder') b.blunders++;
        else if (m.cls === 'Mistake') b.mistakes++;
        else if (m.cls === 'Inaccuracy') b.inaccuracies++;
      });
      if (m.hung) hung[m.hung] = (hung[m.hung] || 0) + 1;
      (m.themes || []).forEach(function (t) { themes[t] = (themes[t] || 0) + 1; });
    });
  });

  var out = { total: finishBucket(total), phases: {}, hung: hung, themes: themes, gamesWithData: gamesWithData };
  Object.keys(phases).forEach(function (k) { out.phases[k] = finishBucket(phases[k]); });

  // Weakest phase, ignoring buckets too small to mean anything.
  var weakest = null;
  Object.keys(out.phases).forEach(function (k) {
    var p = out.phases[k];
    if (p.moves >= 5 && (weakest === null || p.accuracy < out.phases[weakest].accuracy)) weakest = k;
  });
  out.weakestPhase = weakest;

  var worstPiece = null;
  Object.keys(hung).forEach(function (k) {
    if (worstPiece === null || hung[k] > hung[worstPiece]) worstPiece = k;
  });
  out.mostHungPiece = worstPiece;

  var topTheme = null;
  Object.keys(themes).forEach(function (k) {
    if (topTheme === null || themes[k] > themes[topTheme]) topTheme = k;
  });
  out.topTheme = topTheme;

  return out;
}

/* ---------- backup: export / import ---------- */

var EXPORT_APP = 'chess-coach';
var EXPORT_VERSION = 1;
var MAX_GAMES = 100;
var MAX_PUZZLES = 200;

function makeExport(games, puzzles, settings) {
  return {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exported: Date.now(),
    games: games || [],
    puzzles: puzzles || [],
    settings: settings || {},
  };
}

/* Throws with a readable reason rather than importing nonsense. */
function validateExport(data) {
  if (!data || typeof data !== 'object') throw new Error('That file is not Chess Coach data.');
  if (data.app !== EXPORT_APP) throw new Error('That file is from a different app.');
  if (!Array.isArray(data.games) || !Array.isArray(data.puzzles)) {
    throw new Error('That backup is missing its games or puzzles.');
  }
  if (data.version > EXPORT_VERSION) {
    throw new Error('That backup was made by a newer version of Chess Coach.');
  }
  return true;
}

/* Merge rather than replace, so importing on a second device combines the two
   histories instead of throwing one away. */
function mergeData(current, incoming) {
  current = current || {};
  incoming = incoming || {};

  // Games are identified by their finish time.
  var byDate = {};
  (current.games || []).concat(incoming.games || []).forEach(function (g) {
    if (g && g.date != null) byDate[g.date] = g;
  });
  var games = Object.keys(byDate)
    .map(function (k) { return byDate[k]; })
    .sort(function (a, b) { return a.date - b.date; })
    .slice(-MAX_GAMES);

  // Puzzles are identified by the position you went wrong in.
  var byPos = {};
  (current.puzzles || []).concat(incoming.puzzles || []).forEach(function (p) {
    if (!p) return;
    var key = p.fenMistake || p.id;
    if (!key) return;
    var prev = byPos[key];
    if (!prev) { byPos[key] = p; return; }
    // Keep whichever copy has made more progress.
    var a = (prev.solves || 0), b = (p.solves || 0);
    if (b > a) byPos[key] = p;
    else if (b === a && (p.due || 0) > (prev.due || 0)) byPos[key] = p;
  });
  var puzzles = Object.keys(byPos)
    .map(function (k) { return byPos[k]; })
    .sort(function (a, b) { return (a.created || 0) - (b.created || 0); })
    .slice(-MAX_PUZZLES);

  var settings = Object.assign({}, current.settings || {}, incoming.settings || {});

  return {
    games: games,
    puzzles: puzzles,
    settings: settings,
    addedGames: games.length - ((current.games || []).length),
    addedPuzzles: puzzles.length - ((current.puzzles || []).length),
  };
}

/* ---------- bot strength ---------- */

/* This Stockfish build exposes only "Skill Level", which weakens play by
   randomising inside the search — it plays well and then hangs a piece for no
   reason, which teaches the wrong instincts. Instead we search at full strength
   with MultiPV and pick among the candidates ourselves:

     depth        caps how far ahead it sees, so it misses deep tactics
                  the way a weaker player does
     temperature  how willing it is to prefer a slightly worse move
     maxLoss      a hard ceiling, so it never throws away a piece outright
                  at a level that shouldn't                                   */
var BOT_LEVELS = {
  beginner: { id: 'beginner', label: 'Beginner', elo: 800,  depth: 1,  temperature: 300, maxLoss: 1000 },
  novice:   { id: 'novice',   label: 'Novice',   elo: 1100, depth: 2,  temperature: 200, maxLoss: 700 },
  casual:   { id: 'casual',   label: 'Casual',   elo: 1350, depth: 4,  temperature: 130, maxLoss: 450 },
  club:     { id: 'club',     label: 'Club',     elo: 1600, depth: 6,  temperature: 80,  maxLoss: 300 },
  strong:   { id: 'strong',   label: 'Strong',   elo: 1900, depth: 8,  temperature: 45,  maxLoss: 180 },
  expert:   { id: 'expert',   label: 'Expert',   elo: 2200, depth: 10, temperature: 25,  maxLoss: 100 },
  max:      { id: 'max',      label: 'Max',      elo: null, depth: 14, temperature: 0,   maxLoss: 0 },
};

function botLevel(id) { return BOT_LEVELS[id] || BOT_LEVELS.casual; }

/* Pick the bot's move from a multi-PV search. Candidates further from the best
   move are exponentially less likely, and anything past maxLoss is refused
   outright — including anything that walks into mate, whose loss is enormous. */
function chooseBotMove(pvs, level, rng) {
  rng = rng || Math.random;
  var cands = [], k;
  for (k in pvs) {
    var info = pvs[k];
    if (!info || !info.pv || !info.pv.length) continue;
    var cp = infoToCp(info);
    if (cp === null) continue;
    cands.push({ uci: info.pv[0], cp: cp });
  }
  if (!cands.length) return null;

  cands.sort(function (a, b) { return b.cp - a.cp; });
  var best = cands[0].cp;
  if (!level || !level.temperature) return cands[0].uci;

  var pool = cands.filter(function (c) { return (best - c.cp) <= level.maxLoss; });
  if (!pool.length) pool = [cands[0]];

  var weights = pool.map(function (c) { return Math.exp(-(best - c.cp) / level.temperature); });
  var total = weights.reduce(function (a, b) { return a + b; }, 0);
  if (!(total > 0)) return pool[0].uci;

  var r = rng() * total;
  for (var i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i].uci;
  }
  return pool[pool.length - 1].uci;
}

/* ---------- tactical themes ---------- */

var THEME_LABELS = {
  hanging:     'Hanging pieces',
  fork:        'Forks',
  pin:         'Pins',
  backRank:    'Back rank',
  allowedMate: 'Allowed mate',
  missedMate:  'Missed mate',
  missedWin:   'Missed material',
};

/* Same position, other side to move. En passant is only meaningful for the
   original mover, so it is dropped. */
function withTurn(fen, color) {
  var parts = String(fen || '').split(' ');
  if (parts.length < 4) return null;
  parts[1] = color;
  parts[3] = '-';
  return parts.join(' ');
}

/* Absolutely pinned: lift the piece and the king is left in check. */
function isPinned(fen, square, color) {
  var c = loadFen(fen);
  if (!c) return false;
  var piece = c.get(square);
  if (!piece || piece.color !== color || piece.type === 'k') return false;
  c.remove(square);
  var probe = loadFen(withTurn(c.fen(), color));
  return probe ? probe.in_check() : false;
}

function pinnedSquares(fen, color) {
  var out = [];
  var c = loadFen(fen);
  if (!c) return out;
  var files = 'abcdefgh';
  for (var f = 0; f < 8; f++) {
    for (var r = 1; r <= 8; r++) {
      var sq = files[f] + r;
      var p = c.get(sq);
      if (p && p.color === color && p.type !== 'k' && isPinned(fen, sq, color)) out.push(sq);
    }
  }
  return out;
}

/* What the piece standing on `square` would attack if it moved again. */
function attackedValuablesFrom(fen, square, byColor) {
  var c = loadFen(withTurn(fen, byColor));
  if (!c) return [];
  try {
    return c.moves({ square: square, verbose: true })
      .filter(function (m) { return m.captured && (VALUE[m.captured] || 0) >= 3; })
      .map(function (m) { return m.to; });
  } catch (e) { return []; }
}

/* Did the capture actually win material, or was it just a trade? Compares what
   was taken against the cheapest thing that can recapture. Without this, every
   ordinary exchange looks like a hanging piece. */
function captureWinsMaterial(fenAfterCapture, square, capturedType, attackerType) {
  var capturedVal = VALUE[capturedType] || 0;
  if (!capturedVal) return false;
  var attackerVal = VALUE[attackerType] || 0;
  var c = loadFen(fenAfterCapture);
  if (!c) return false;
  var recaptures = c.moves({ verbose: true }).filter(function (m) {
    return m.to === square && m.captured;
  });
  if (!recaptures.length) return true;               // nothing answers it: material simply gone
  return (capturedVal - attackerVal) > 0;            // still down after trading back
}

/* Name the tactic that actually beat you. Conservative on purpose: each theme
   has to be readable off the board, so it never invents a motif. `mover` is the
   colour that played the mistake. */
function detectThemes(o) {
  var themes = [];
  var mover = o.mover === 'b' ? 'b' : 'w';
  var opponent = mover === 'w' ? 'b' : 'w';
  var cpLoss = o.cpLoss || 0;

  if (o.cpAfterMine <= -MATE_CP) themes.push('allowedMate');
  if (o.cpBefore >= MATE_CP && o.cpAfterMine < MATE_CP) themes.push('missedMate');

  var refutation = o.playedLine && o.playedLine[1];
  if (refutation && o.fenAfter && cpLoss >= 90) {
    try {
      var c = new Chess(o.fenAfter);
      var r = applyUci(c, refutation);
      if (r) {
        var fenAfterRefutation = c.fen();
        if (r.captured && (VALUE[r.captured] || 0) >= 3
            && captureWinsMaterial(fenAfterRefutation, r.to, r.captured, r.piece)) {
          themes.push('hanging');
        }
        var givesCheck = /[+#]$/.test(r.san);
        var hits = attackedValuablesFrom(fenAfterRefutation, r.to, opponent);
        if ((hits.length + (givesCheck ? 1 : 0)) >= 2) themes.push('fork');

        var backRank = mover === 'w' ? '1' : '8';
        if (givesCheck && (r.piece === 'r' || r.piece === 'q') && r.to[1] === backRank) {
          themes.push('backRank');
        }
      }
    } catch (e) { /* ignore */ }
  }

  // A pin you walked into: absent before the move, present after it.
  if (o.fenBefore && o.fenAfter && cpLoss >= 90) {
    var before = pinnedSquares(o.fenBefore, mover).length;
    var after = pinnedSquares(o.fenAfter, mover).length;
    if (after > before) themes.push('pin');
  }

  // Material that was there for the taking and you left it.
  if (o.bestUci && o.fenBefore && cpLoss >= 90 && !o.playedCaptured) {
    try {
      var b = applyUci(new Chess(o.fenBefore), o.bestUci);
      if (b && b.captured && (VALUE[b.captured] || 0) >= 3) themes.push('missedWin');
    } catch (e) { /* ignore */ }
  }

  // Unique, stable order.
  var seen = {}, out = [];
  themes.forEach(function (t) { if (!seen[t]) { seen[t] = 1; out.push(t); } });
  return out;
}

/* ---------- walkthrough helpers ---------- */

function sanToUci(fen, san) {
  try {
    var c = new Chess(fen);
    var m = c.move(san);
    return m ? m.from + m.to + (m.promotion || '') : null;
  } catch (e) { return null; }
}

/* A plain description of a move, read straight off the board — no judgement
   about whether it is good, which would be inventing chess advice. */
function describeMove(fen, san) {
  try {
    var c = new Chess(fen);
    var m = c.move(san);
    if (!m) return san;
    var who = m.color === 'w' ? 'White' : 'Black';
    if (m.flags.indexOf('k') !== -1) return who + ' castles kingside.';
    if (m.flags.indexOf('q') !== -1) return who + ' castles queenside.';

    var subject = m.piece === 'p' ? 'the pawn' : 'the ' + PIECE_NAME[m.piece];
    var txt = who + ' plays ' + m.san + ' — ' + subject + ' to ' + m.to;
    if (m.captured) txt += ', taking the ' + PIECE_NAME[m.captured];
    if (m.flags.indexOf('e') !== -1) txt += ' en passant';
    if (m.promotion) txt += ' and promoting to a ' + PIECE_NAME[m.promotion];
    if (/#$/.test(m.san)) txt += ' — checkmate';
    else if (/\+$/.test(m.san)) txt += ' — check';
    return txt + '.';
  } catch (e) { return san; }
}

/* ---------- think time ---------- */

var TIME_BUCKETS = [
  { key: 'snap',   label: 'Under 5s', max: 5000 },
  { key: 'quick',  label: '5-15s',    max: 15000 },
  { key: 'steady', label: '15-30s',   max: 30000 },
  { key: 'long',   label: 'Over 30s', max: Infinity },
];

function bucketForMs(ms) {
  for (var i = 0; i < TIME_BUCKETS.length; i++) {
    if (ms < TIME_BUCKETS[i].max) return TIME_BUCKETS[i].key;
  }
  return TIME_BUCKETS[TIME_BUCKETS.length - 1].key;
}

/* How your accuracy varies with how long you thought. Only moves that recorded
   a think time count, so games played before timing existed are ignored. */
function timeReport(games) {
  var acc = {};
  TIME_BUCKETS.forEach(function (b) { acc[b.key] = { moves: 0, accSum: 0, blunders: 0, mistakes: 0 }; });
  var timed = 0;

  (games || []).forEach(function (g) {
    ((g && g.breakdown) || []).forEach(function (m) {
      if (!m || typeof m.acc !== 'number' || typeof m.ms !== 'number') return;
      timed++;
      var b = acc[bucketForMs(m.ms)];
      b.moves++;
      b.accSum += m.acc;
      if (m.cls === 'Blunder') b.blunders++;
      else if (m.cls === 'Mistake') b.mistakes++;
    });
  });

  var buckets = TIME_BUCKETS.map(function (def) {
    var b = acc[def.key];
    return {
      key: def.key,
      label: def.label,
      moves: b.moves,
      accuracy: b.moves ? b.accSum / b.moves : null,
      blunders: b.blunders,
      errorRate: b.moves ? (b.blunders + b.mistakes) / b.moves : 0,
    };
  });

  // Worth saying something only when both ends have enough moves to mean it.
  var MIN = 5;
  var fastest = null, slowest = null;
  buckets.forEach(function (b) {
    if (b.moves < MIN) return;
    if (!fastest) fastest = b;
    slowest = b;
  });

  var insight = null;
  if (fastest && slowest && fastest.key !== slowest.key) {
    var gap = slowest.accuracy - fastest.accuracy;
    if (gap >= 8) {
      insight = { gap: gap, fast: fastest.label, slow: slowest.label };
    }
  }

  return { buckets: buckets, timedMoves: timed, insight: insight };
}

/* ---------- chess.com import ---------- */

/* Which colour the named player had, or null if they weren't in the game. */
function chessComSide(game, username) {
  var u = String(username || '').trim().toLowerCase();
  if (!u || !game) return null;
  if (game.white && String(game.white.username || '').toLowerCase() === u) return 'w';
  if (game.black && String(game.black.username || '').toLowerCase() === u) return 'b';
  return null;
}

/* Standard chess only, newest first, capped. Variants and games the player
   isn't in are dropped rather than half-analysed. */
function importableGames(games, username, limit) {
  var out = (games || []).filter(function (g) {
    if (!g || !g.pgn) return false;
    if (g.rules && g.rules !== 'chess') return false;
    return chessComSide(g, username) !== null;
  });
  out.sort(function (a, b) { return (b.end_time || 0) - (a.end_time || 0); });
  return out.slice(0, limit || 10);
}

/* The result from the named player's point of view. */
function chessComResult(game, username) {
  var side = chessComSide(game, username);
  if (!side) return 'Unknown';
  var me = side === 'w' ? game.white : game.black;
  var them = side === 'w' ? game.black : game.white;
  if (me && me.result === 'win') return 'Win';
  if (them && them.result === 'win') return 'Loss';
  return 'Draw';
}

/* ---------- clock ---------- */

function fmtClock(ms) {
  var t = Math.max(0, Math.ceil(ms / 1000));
  var m = Math.floor(t / 60);
  var s = t % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// One point per ply; replaying a ply replaces it and drops anything after.
function recordCurve(curve, ply, cpWhite) {
  var next = curve.filter(function (p) { return p.ply < ply; });
  next.push({ ply: ply, cpWhite: cpWhite });
  return next;
}

var API = {
  parseInfo: parseInfo,
  infoToCp: infoToCp,
  isMateScore: isMateScore,
  winPct: winPct,
  moveAccuracy: moveAccuracy,
  classify: classify,
  QUALITY_THRESHOLDS: QUALITY_THRESHOLDS,
  CLASSES: CLASSES,
  fmtEval: fmtEval,
  sameMove: sameMove,
  uciToSan: uciToSan,
  pvToSan: pvToSan,
  squareToXY: squareToXY,
  boardSquares: boardSquares,
  isLightSquare: isLightSquare,
  scoreMove: scoreMove,
  isSacrifice: isSacrifice,
  explainMove: explainMove,
  gameAccuracy: gameAccuracy,
  recordCurve: recordCurve,
  materialFromHistory: materialFromHistory,
  fmtClock: fmtClock,
  TIME_BUCKETS: TIME_BUCKETS,
  bucketForMs: bucketForMs,
  timeReport: timeReport,
  chessComSide: chessComSide,
  importableGames: importableGames,
  chessComResult: chessComResult,
  sanToUci: sanToUci,
  describeMove: describeMove,
  THEME_LABELS: THEME_LABELS,
  detectThemes: detectThemes,
  isPinned: isPinned,
  loadFen: loadFen,
  captureWinsMaterial: captureWinsMaterial,
  pinnedSquares: pinnedSquares,
  withTurn: withTurn,
  BOT_LEVELS: BOT_LEVELS,
  botLevel: botLevel,
  chooseBotMove: chooseBotMove,
  makeExport: makeExport,
  validateExport: validateExport,
  mergeData: mergeData,
  phaseOf: phaseOf,
  scheduleReview: scheduleReview,
  isDue: isDue,
  dueList: dueList,
  weaknessReport: weaknessReport,
  fenAtPly: fenAtPly,
  puzzleStart: puzzleStart,
  VALUE: VALUE,
  PIECE_NAME: PIECE_NAME,
  MATE_CP: MATE_CP,
};

if (typeof module === 'object' && module.exports) module.exports = API;
if (root) root.CoachLogic = API;

})(typeof globalThis !== 'undefined' ? globalThis : this);
