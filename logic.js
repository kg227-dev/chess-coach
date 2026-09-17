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

function classify(cpLoss, wasBest, brilliant) {
  if (brilliant) return CLASSES.Brilliant;
  if (wasBest) return CLASSES.Best;
  if (cpLoss < 20) return CLASSES.Excellent;
  if (cpLoss < 50) return CLASSES.Good;
  if (cpLoss < 110) return CLASSES.Inaccuracy;
  if (cpLoss < 270) return CLASSES.Mistake;
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

  // Brilliant: the engine's own move, giving material away, and still fine after.
  var brilliant = false;
  if (wasBest && cpAfterMine > -100 && opts.fenAfter && opts.playedTo && opts.playedPiece) {
    brilliant = isSacrifice(opts.fenAfter, opts.playedTo, opts.playedPiece, opts.playedCaptured);
  }

  return {
    cpBefore: cpBefore,
    cpAfterMine: cpAfterMine,
    cpLoss: cpLoss,
    wasBest: wasBest,
    brilliant: brilliant,
    bestUci: bestUci,
    playedLine: playedLine,
    cls: classify(cpLoss, wasBest, brilliant),
    accuracy: moveAccuracy(winPct(cpBefore), winPct(cpAfterMine)),
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
    });
  });

  var out = { total: finishBucket(total), phases: {}, hung: hung, gamesWithData: gamesWithData };
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

  return out;
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
