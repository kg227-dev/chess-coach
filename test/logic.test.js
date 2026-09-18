const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');
const { Chess } = require('../vendor/chess.js');

const START = new Chess().fen();

/* ------------------------------------------------------------------ */
describe('parseInfo', () => {
  test('reads depth, score and pv', () => {
    const i = L.parseInfo('info depth 12 seldepth 18 multipv 1 score cp 34 nodes 5000 pv e2e4 e7e5 g1f3');
    assert.equal(i.depth, 12);
    assert.equal(i.multipv, 1);
    assert.equal(i.cp, 34);
    assert.deepEqual(i.pv, ['e2e4', 'e7e5', 'g1f3']);
  });

  test('reads negative cp and mate scores', () => {
    assert.equal(L.parseInfo('info depth 8 score cp -250 pv d2d4').cp, -250);
    assert.equal(L.parseInfo('info depth 8 score mate 3 pv d1h5').mate, 3);
    assert.equal(L.parseInfo('info depth 8 score mate -2 pv d1h5').mate, -2);
  });

  test('defaults multipv to 1 and tolerates a missing pv', () => {
    const i = L.parseInfo('info depth 4 score cp 10');
    assert.equal(i.multipv, 1);
    assert.equal(i.pv, undefined);
  });

  test('reads multipv index', () => {
    assert.equal(L.parseInfo('info depth 10 multipv 3 score cp 5 pv b1c3').multipv, 3);
  });

  test('pv stops at the first non-move token', () => {
    // Some builds append trailing fields after the pv.
    const i = L.parseInfo('info depth 9 score cp 12 pv e2e4 e7e5 string hello');
    assert.deepEqual(i.pv, ['e2e4', 'e7e5']);
  });

  test('keeps promotion suffixes in the pv', () => {
    assert.deepEqual(L.parseInfo('info depth 9 score cp 900 pv a7a8q b8c6').pv, ['a7a8q', 'b8c6']);
  });
});

/* ------------------------------------------------------------------ */
describe('infoToCp', () => {
  test('passes centipawns through', () => {
    assert.equal(L.infoToCp({ cp: 45 }), 45);
    assert.equal(L.infoToCp({ cp: -45 }), -45);
    assert.equal(L.infoToCp({ cp: 0 }), 0);
  });

  test('mate keeps distance ordering and stays outside real ranges', () => {
    assert.equal(L.infoToCp({ mate: 1 }), 9999);
    assert.equal(L.infoToCp({ mate: 5 }), 9995);
    assert.ok(L.infoToCp({ mate: 1 }) > L.infoToCp({ mate: 5 }), 'mate in 1 beats mate in 5');
    assert.equal(L.infoToCp({ mate: -1 }), -9999);
    assert.ok(L.infoToCp({ mate: -1 }) < L.infoToCp({ mate: -5 }), 'being mated sooner is worse');
  });

  test('returns null when there is no score at all', () => {
    assert.equal(L.infoToCp(null), null);
    assert.equal(L.infoToCp(undefined), null);
    assert.equal(L.infoToCp({ depth: 5 }), null);
  });

  test('does not confuse a cp of 0 with a missing score', () => {
    assert.strictEqual(L.infoToCp({ cp: 0 }), 0);
    assert.notStrictEqual(L.infoToCp({ cp: 0 }), null);
  });
});

/* ------------------------------------------------------------------ */
describe('winPct', () => {
  test('an equal position is 50%', () => {
    assert.equal(L.winPct(0), 50);
  });

  test('is symmetric about 50', () => {
    for (const cp of [50, 200, 800]) {
      assert.ok(Math.abs((L.winPct(cp) - 50) + (L.winPct(-cp) - 50)) < 1e-9);
    }
  });

  test('increases with evaluation', () => {
    const xs = [-900, -300, -50, 0, 50, 300, 900];
    for (let i = 1; i < xs.length; i++) assert.ok(L.winPct(xs[i]) > L.winPct(xs[i - 1]));
  });

  test('a forced mate reads as essentially 100%', () => {
    assert.ok(L.winPct(L.infoToCp({ mate: 2 })) > 99.9, 'mate should not be capped below a big edge');
    assert.ok(L.winPct(L.infoToCp({ mate: -2 })) < 0.1);
  });

  test('stays within 0..100', () => {
    for (const cp of [-99999, -10000, 0, 10000, 99999]) {
      const v = L.winPct(cp);
      assert.ok(v >= 0 && v <= 100, `winPct(${cp}) = ${v}`);
    }
  });
});

/* ------------------------------------------------------------------ */
describe('moveAccuracy', () => {
  test('keeping the evaluation scores 100', () => {
    assert.equal(Math.round(L.moveAccuracy(60, 60)), 100);
  });

  test('improving the position also scores 100, never above', () => {
    const a = L.moveAccuracy(40, 80);
    assert.equal(Math.round(a), 100);
    assert.ok(a <= 100);
  });

  test('a big drop scores low', () => {
    assert.ok(L.moveAccuracy(70, 20) < 20);
  });

  test('falls monotonically as the drop grows', () => {
    let prev = Infinity;
    for (const after of [80, 70, 60, 50, 30, 10]) {
      const a = L.moveAccuracy(80, after);
      assert.ok(a <= prev, `accuracy should not rise as win% falls (${after})`);
      prev = a;
    }
  });

  test('never leaves 0..100', () => {
    for (const [b, a] of [[100, 0], [0, 100], [50, 50], [99, 1]]) {
      const v = L.moveAccuracy(b, a);
      assert.ok(v >= 0 && v <= 100, `${b}->${a} = ${v}`);
    }
  });
});

/* ------------------------------------------------------------------ */
describe('classify', () => {
  test('best move wins regardless of measured loss', () => {
    assert.equal(L.classify(0, true).key, 'Best');
    assert.equal(L.classify(500, true).key, 'Best');
  });

  test('threshold boundaries are exact, in win-percentage points', () => {
    assert.equal(L.classify(0, false).key, 'Excellent');
    assert.equal(L.classify(1.99, false).key, 'Excellent');
    assert.equal(L.classify(2, false).key, 'Good');
    assert.equal(L.classify(9.99, false).key, 'Good');
    assert.equal(L.classify(10, false).key, 'Inaccuracy');
    assert.equal(L.classify(19.99, false).key, 'Inaccuracy');
    assert.equal(L.classify(20, false).key, 'Mistake');
    assert.equal(L.classify(29.99, false).key, 'Mistake');
    assert.equal(L.classify(30, false).key, 'Blunder');
    assert.equal(L.classify(100, false).key, 'Blunder');
  });

  test('a negative or missing drop is treated as no loss', () => {
    assert.equal(L.classify(-5, false).key, 'Excellent');
    assert.equal(L.classify(undefined, false).key, 'Excellent');
  });

  test('the same centipawn loss is judged by what it actually costs', () => {
    // 1.5 pawns thrown away from equal really hurts...
    const fromEqual = L.winPct(0) - L.winPct(-150);
    assert.equal(L.classify(fromEqual, false).key, 'Inaccuracy');
    // ...but the same 1.5 pawns while already winning by a rook does not.
    const whileWinning = L.winPct(800) - L.winPct(650);
    assert.equal(L.classify(whileWinning, false).key, 'Good');
  });

  test('every class carries a colour and an icon', () => {
    for (const k of Object.keys(L.CLASSES)) {
      assert.ok(L.CLASSES[k].color, `${k} needs a colour`);
      assert.ok(L.CLASSES[k].icon, `${k} needs an icon`);
    }
  });
});

/* ------------------------------------------------------------------ */
describe('fmtEval', () => {
  test('formats from white perspective', () => {
    assert.equal(L.fmtEval(0, true), '0.00');
    assert.equal(L.fmtEval(35, true), '+0.35');
    assert.equal(L.fmtEval(-120, true), '-1.20');
  });

  test('flips sign for black perspective', () => {
    assert.equal(L.fmtEval(35, false), '-0.35');
    assert.equal(L.fmtEval(-120, false), '+1.20');
  });

  test('formats mate with its distance', () => {
    assert.equal(L.fmtEval(L.infoToCp({ mate: 3 }), true), '#3');
    assert.equal(L.fmtEval(L.infoToCp({ mate: 1 }), true), '#1');
    assert.equal(L.fmtEval(L.infoToCp({ mate: -3 }), true), '-#3');
  });

  test('mate flips perspective too', () => {
    assert.equal(L.fmtEval(L.infoToCp({ mate: 3 }), false), '-#3');
  });
});

/* ------------------------------------------------------------------ */
describe('sameMove', () => {
  test('matches on from/to and ignores promotion piece', () => {
    assert.ok(L.sameMove('e2e4', 'e2e4'));
    assert.ok(L.sameMove('a7a8q', 'a7a8'));
    assert.ok(L.sameMove('a7a8', 'a7a8n'));
  });

  test('rejects different moves and missing values', () => {
    assert.ok(!L.sameMove('e2e4', 'd2d4'));
    assert.ok(!L.sameMove(null, 'e2e4'));
    assert.ok(!L.sameMove('e2e4', undefined));
    assert.ok(!L.sameMove('', 'e2e4'));
  });
});

/* ------------------------------------------------------------------ */
describe('uciToSan / pvToSan', () => {
  test('converts a legal move', () => {
    assert.equal(L.uciToSan(START, 'e2e4'), 'e4');
    assert.equal(L.uciToSan(START, 'g1f3'), 'Nf3');
  });

  test('falls back to the raw uci for an illegal move', () => {
    assert.equal(L.uciToSan(START, 'e2e5'), 'e2e5');
  });

  test('renders a principal variation', () => {
    assert.equal(L.pvToSan(START, ['e2e4', 'e7e5', 'g1f3'], 5), 'e4 e5 Nf3');
  });

  test('respects the max length', () => {
    assert.equal(L.pvToSan(START, ['e2e4', 'e7e5', 'g1f3'], 2), 'e4 e5');
  });

  test('stops cleanly at an illegal continuation', () => {
    assert.equal(L.pvToSan(START, ['e2e4', 'e2e4'], 5), 'e4');
  });

  test('handles promotion', () => {
    const fen = '8/P7/8/8/7k/8/8/K7 w - - 0 1';
    assert.equal(L.uciToSan(fen, 'a7a8q'), 'a8=Q');
    assert.equal(L.uciToSan(fen, 'a7a8n'), 'a8=N');
  });

  test('marks a promotion that gives check', () => {
    const fen = '8/P7/8/8/8/8/8/K6k w - - 0 1';
    assert.equal(L.uciToSan(fen, 'a7a8q'), 'a8=Q+');
  });
});

/* ------------------------------------------------------------------ */
describe('board geometry', () => {
  test('unflipped: a1 bottom-left, h8 top-right', () => {
    assert.deepEqual(L.squareToXY('a1', false), { x: 0.5, y: 7.5 });
    assert.deepEqual(L.squareToXY('h8', false), { x: 7.5, y: 0.5 });
  });

  test('flipped: a1 top-right, h8 bottom-left', () => {
    assert.deepEqual(L.squareToXY('a1', true), { x: 7.5, y: 0.5 });
    assert.deepEqual(L.squareToXY('h8', true), { x: 0.5, y: 7.5 });
  });

  test('flipping mirrors through the centre', () => {
    for (const sq of ['a1', 'e4', 'd7', 'h8', 'c2']) {
      const a = L.squareToXY(sq, false), b = L.squareToXY(sq, true);
      assert.ok(Math.abs((a.x + b.x) - 8) < 1e-9, `${sq} x`);
      assert.ok(Math.abs((a.y + b.y) - 8) < 1e-9, `${sq} y`);
    }
  });

  test('boardSquares covers all 64 exactly once in both orientations', () => {
    for (const flip of [false, true]) {
      const sqs = L.boardSquares(flip);
      assert.equal(sqs.length, 64);
      assert.equal(new Set(sqs).size, 64);
    }
  });

  test('boardSquares starts and ends correctly', () => {
    const w = L.boardSquares(false);
    assert.equal(w[0], 'a8');
    assert.equal(w[63], 'h1');
    const b = L.boardSquares(true);
    assert.equal(b[0], 'h1');
    assert.equal(b[63], 'a8');
  });

  test('square colours follow the real board (a1 dark, h1 light)', () => {
    assert.equal(L.isLightSquare('a1'), false);
    assert.equal(L.isLightSquare('h1'), true);
    assert.equal(L.isLightSquare('a8'), true);
    assert.equal(L.isLightSquare('h8'), false);
    assert.equal(L.isLightSquare('e4'), true);
    assert.equal(L.isLightSquare('d4'), false);
  });

  test('adjacent squares always alternate colour', () => {
    for (const sq of L.boardSquares(false)) {
      const f = sq.charCodeAt(0), r = +sq[1];
      if (f < 104) {
        const right = String.fromCharCode(f + 1) + r;
        assert.notEqual(L.isLightSquare(sq), L.isLightSquare(right), `${sq} vs ${right}`);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
describe('scoreMove', () => {
  const before = {
    bestmove: 'e2e4',
    pvs: {
      1: { depth: 12, multipv: 1, cp: 40, pv: ['e2e4', 'e7e5'] },
      2: { depth: 12, multipv: 2, cp: 25, pv: ['d2d4', 'd7d5'] },
      3: { depth: 12, multipv: 3, cp: -60, pv: ['f2f3', 'e7e5'] },
    },
  };

  test('playing the engine move costs nothing and scores 100', () => {
    const r = L.scoreMove({ before, playedUci: 'e2e4' });
    assert.equal(r.cpLoss, 0);
    assert.equal(r.wasBest, true);
    assert.equal(r.cls.key, 'Best');
    assert.equal(Math.round(r.accuracy), 100);
  });

  test('a second-choice move costs the difference', () => {
    const r = L.scoreMove({ before, playedUci: 'd2d4' });
    assert.equal(r.cpBefore, 40);
    assert.equal(r.cpAfterMine, 25);
    assert.equal(r.cpLoss, 15);
    assert.equal(r.wasBest, false);
    assert.equal(r.cls.key, 'Excellent');
  });

  test('a bad move in the list is scored from the same search', () => {
    const r = L.scoreMove({ before, playedUci: 'f2f3' });
    assert.equal(r.cpLoss, 100);              // still reported in pawns for display
    assert.equal(r.cls.key, 'Good');          // but 9 win% from near-equal is not yet an error
    assert.ok(r.winDrop > 8 && r.winDrop < 10);
    assert.deepEqual(r.playedLine, ['f2f3', 'e7e5']);
  });

  test('a move outside the list falls back to the follow-up search, negated', () => {
    const after = { bestmove: 'e7e5', pvs: { 1: { depth: 12, cp: 300, pv: ['e7e5', 'g1f3'] } } };
    const r = L.scoreMove({ before, playedUci: 'b1a3', afterSearch: after });
    // opponent is +300, so we are -300; we gave up 40 - (-300) = 340
    assert.equal(r.cpAfterMine, -300);
    assert.equal(r.cpLoss, 340);
    assert.equal(r.cls.key, 'Mistake');       // ~29 win% points from a near-equal start
    assert.ok(r.winDrop > 25 && r.winDrop < 30);
    assert.deepEqual(r.playedLine, ['b1a3', 'e7e5', 'g1f3']);
  });

  test('delivering checkmate is never penalised', () => {
    const r = L.scoreMove({ before, playedUci: 'b1a3', gameOver: true, isCheckmate: true });
    assert.equal(r.cpLoss, 0);
    assert.equal(Math.round(r.accuracy), 100);
  });

  test('forcing stalemate from a winning position is scored as a loss', () => {
    const r = L.scoreMove({ before, playedUci: 'b1a3', gameOver: true, isCheckmate: false });
    assert.equal(r.cpAfterMine, 0);
    assert.equal(r.cpLoss, 40);
  });

  test('matches the played move even when it carries a promotion suffix', () => {
    const b2 = { bestmove: 'a7a8q', pvs: { 1: { cp: 900, pv: ['a7a8q', 'h1g1'] } } };
    const r = L.scoreMove({ before: b2, playedUci: 'a7a8q' });
    assert.equal(r.wasBest, true);
    assert.equal(r.cpLoss, 0);
  });

  test('returns null rather than guessing when the search produced nothing', () => {
    assert.equal(L.scoreMove({ before: { pvs: {} }, playedUci: 'e2e4' }), null);
    assert.equal(L.scoreMove({ before: { pvs: { 1: { depth: 3 } } }, playedUci: 'e2e4' }), null);
  });

  test('returns null when an unlisted move has no follow-up search', () => {
    assert.equal(L.scoreMove({ before, playedUci: 'b1a3' }), null);
  });

  test('a cp of 0 before the move is not mistaken for a missing score', () => {
    const b0 = { bestmove: 'e2e4', pvs: { 1: { cp: 0, pv: ['e2e4'] } } };
    const r = L.scoreMove({ before: b0, playedUci: 'e2e4' });
    assert.notEqual(r, null);
    assert.equal(r.cpBefore, 0);
  });

  test('loss is never negative even if the follow-up search disagrees', () => {
    const after = { pvs: { 1: { cp: -900, pv: ['e7e5'] } } };
    const r = L.scoreMove({ before, playedUci: 'b1a3', afterSearch: after });
    assert.ok(r.cpLoss >= 0);
  });

  test('uses pvs[1] as the best move when bestmove is absent', () => {
    const b = { pvs: { 1: { cp: 40, pv: ['e2e4', 'e7e5'] } } };
    const r = L.scoreMove({ before: b, playedUci: 'e2e4' });
    assert.equal(r.wasBest, true);
  });
});

/* ------------------------------------------------------------------ */
describe('isSacrifice', () => {
  test('a hanging queen next to the king is a sacrifice', () => {
    // White queen just landed on d7; the black king can simply take it.
    assert.equal(L.isSacrifice('4k3/3Q1p2/8/8/8/8/8/4K3 b - - 0 1', 'd7', 'q', null), true);
  });

  test('a defended piece the opponent cannot profitably take is not', () => {
    // Knight on e5 defended by the d4 pawn; only a pawn can take it: an even trade.
    assert.equal(L.isSacrifice('4k3/8/8/4N3/3P4/8/8/4K3 b - - 0 1', 'e5', 'n', null), false);
  });

  test('an untouched piece is never a sacrifice', () => {
    assert.equal(L.isSacrifice('4k3/8/8/4N3/8/8/8/4K3 b - - 0 1', 'e5', 'n', null), false);
  });

  test('pawn moves are never brilliant', () => {
    assert.equal(L.isSacrifice('4k3/3P1p2/8/8/8/8/8/4K3 b - - 0 1', 'd7', 'p', null), false);
  });

  test('an equal trade is not a sacrifice', () => {
    // We captured a queen with our queen — recapture is just the trade.
    assert.equal(L.isSacrifice('4k3/3Q1p2/8/8/8/8/8/4K3 b - - 0 1', 'd7', 'q', 'q'), false);
  });

  test('survives a malformed position', () => {
    assert.equal(L.isSacrifice('nonsense', 'd7', 'q', null), false);
  });
});

/* ------------------------------------------------------------------ */
describe('Brilliant classification', () => {
  const sacFen = '4k3/3Q1p2/8/8/8/8/8/4K3 b - - 0 1';

  test('the best move that hangs a piece and stays winning is Brilliant', () => {
    const r = L.scoreMove({
      before: { bestmove: 'h3d7', pvs: { 1: { cp: 400, pv: ['h3d7', 'e8d7'] } } },
      playedUci: 'h3d7',
      fenAfter: sacFen, playedTo: 'd7', playedPiece: 'q', playedCaptured: null,
    });
    assert.equal(r.brilliant, true);
    assert.equal(r.cls.key, 'Brilliant');
    assert.equal(r.cpLoss, 0);
  });

  test('the same sacrifice is not Brilliant when it is losing', () => {
    const r = L.scoreMove({
      before: { bestmove: 'h3d7', pvs: { 1: { cp: -500, pv: ['h3d7', 'e8d7'] } } },
      playedUci: 'h3d7',
      fenAfter: sacFen, playedTo: 'd7', playedPiece: 'q', playedCaptured: null,
    });
    assert.equal(r.brilliant, false);
    assert.equal(r.cls.key, 'Best');
  });

  test('a quiet best move stays Best', () => {
    const r = L.scoreMove({
      before: { bestmove: 'e2e4', pvs: { 1: { cp: 40, pv: ['e2e4'] } } },
      playedUci: 'e2e4',
      fenAfter: new Chess().fen(), playedTo: 'e4', playedPiece: 'p',
    });
    assert.equal(r.brilliant, false);
    assert.equal(r.cls.key, 'Best');
  });

  test('a non-best sacrifice is judged on its loss, not its flair', () => {
    const r = L.scoreMove({
      before: { bestmove: 'a1a2', pvs: { 1: { cp: 400, pv: ['a1a2'] }, 2: { cp: -200, pv: ['h3d7'] } } },
      playedUci: 'h3d7',
      fenAfter: sacFen, playedTo: 'd7', playedPiece: 'q', playedCaptured: null,
    });
    assert.equal(r.brilliant, false);
    assert.equal(r.cls.key, 'Blunder');
  });

  test('brilliant detection is skipped when position context is missing', () => {
    const r = L.scoreMove({
      before: { bestmove: 'h3d7', pvs: { 1: { cp: 400, pv: ['h3d7'] } } },
      playedUci: 'h3d7',
    });
    assert.equal(r.brilliant, false);
  });
});

/* ------------------------------------------------------------------ */
describe('fmtClock', () => {
  test('formats minutes and seconds', () => {
    assert.equal(L.fmtClock(600000), '10:00');
    assert.equal(L.fmtClock(65000), '1:05');
    assert.equal(L.fmtClock(9000), '0:09');
  });

  test('never shows a negative clock', () => {
    assert.equal(L.fmtClock(0), '0:00');
    assert.equal(L.fmtClock(-5000), '0:00');
  });

  test('rounds up so the clock only hits 0:00 when time is gone', () => {
    assert.equal(L.fmtClock(1), '0:01');
    assert.equal(L.fmtClock(999), '0:01');
  });
});

/* ------------------------------------------------------------------ */
describe('explainMove', () => {
  test('names the piece the refutation wins, as a problem not an answer', () => {
    // After 1.e4 e6 2.Ba6, black plays bxa6.
    const c = new Chess();
    c.move('e4'); c.move('e6');
    const fenBefore = c.fen();
    c.move({ from: 'f1', to: 'a6' });
    const fenAfter = c.fen();
    const r = L.explainMove({
      fenBefore, fenAfter,
      playedLine: ['f1a6', 'b7a6'],
      bestUci: 'd2d4', cpLoss: 550, cpBefore: 110, cpAfterMine: -440, playedCaptured: null,
    });
    assert.match(r.problem, /takes your bishop/);
  });

  test('warns when the move allows forced mate', () => {
    const r = L.explainMove({
      fenBefore: START, fenAfter: START, playedLine: ['f2f3'],
      bestUci: 'e2e4', cpLoss: 900, cpBefore: 30, cpAfterMine: -9998,
    });
    assert.match(r.problem, /force mate/);
  });

  test('a missed mate is an answer, never leaked as a problem', () => {
    const r = L.explainMove({
      fenBefore: START, fenAfter: START, playedLine: ['a2a3'],
      bestUci: 'e2e4', cpLoss: 400, cpBefore: 9998, cpAfterMine: 200,
    });
    assert.match(r.answer, /forced mate with e4/);
    assert.equal(r.problem, '');
  });

  test('the problem text never names the best move', () => {
    const c = new Chess();
    c.move('e4'); c.move('d5');
    const fenBefore = c.fen();
    c.move('a3');
    const r = L.explainMove({
      fenBefore, fenAfter: c.fen(), playedLine: ['a2a3', 'd5e4'],
      bestUci: 'e4d5', cpLoss: 300, cpBefore: 30, cpAfterMine: -270, playedCaptured: null,
    });
    assert.ok(!/exd5/.test(r.problem), 'problem leaked the answer: ' + r.problem);
    assert.match(r.answer, /exd5/);
  });

  test('stays quiet about small losses', () => {
    const r = L.explainMove({
      fenBefore: START, fenAfter: START, playedLine: ['d2d4', 'd7d5'],
      bestUci: 'e2e4', cpLoss: 15, cpBefore: 40, cpAfterMine: 25,
    });
    assert.equal(r.problem, '');
    assert.equal(r.answer, '');
  });

  test('never returns more than two problem clauses', () => {
    const r = L.explainMove({
      fenBefore: START, fenAfter: START, playedLine: ['f2f3', 'e7e5'],
      bestUci: 'e2e4', cpLoss: 900, cpBefore: 9998, cpAfterMine: -9998,
    });
    assert.ok(r.problem.split('.').filter(Boolean).length <= 2);
  });

  test('survives nonsense input without throwing', () => {
    assert.doesNotThrow(() => L.explainMove({
      fenBefore: 'not-a-fen', fenAfter: 'also-bad', playedLine: ['zzzz'],
      bestUci: 'zzzz', cpLoss: 500, cpBefore: 0, cpAfterMine: -500,
    }));
  });

  test('always returns both fields as strings', () => {
    const r = L.explainMove({ fenBefore: START, fenAfter: START, playedLine: [], cpLoss: 0, cpBefore: 0, cpAfterMine: 0 });
    assert.equal(typeof r.problem, 'string');
    assert.equal(typeof r.answer, 'string');
  });
});

/* ------------------------------------------------------------------ */
describe('materialFromHistory', () => {
  const play = (sans) => { const c = new Chess(); sans.forEach((s) => c.move(s)); return c.history({ verbose: true }); };

  test('an opening with no captures is level', () => {
    const m = L.materialFromHistory(play(['e4', 'e5', 'Nf3', 'Nc6']));
    assert.equal(m.diff, 0);
    assert.deepEqual(m.capturedBy.w, []);
    assert.deepEqual(m.capturedBy.b, []);
  });

  test('records who captured what', () => {
    // 1.e4 d5 2.exd5 — white has taken a pawn.
    const m = L.materialFromHistory(play(['e4', 'd5', 'exd5']));
    assert.deepEqual(m.capturedBy.w, ['p']);
    assert.deepEqual(m.capturedBy.b, []);
    assert.equal(m.diff, 1);
  });

  test('equal trades cancel out', () => {
    const m = L.materialFromHistory(play(['e4', 'd5', 'exd5', 'Qxd5']));
    assert.deepEqual(m.capturedBy.w, ['p']);
    assert.deepEqual(m.capturedBy.b, ['p']);
    assert.equal(m.diff, 0);
  });

  test('values pieces correctly and signs the lead', () => {
    const hist = [
      { color: 'w', captured: 'q' },
      { color: 'b', captured: 'n' },
      { color: 'b', captured: 'p' },
    ];
    const m = L.materialFromHistory(hist);
    assert.equal(m.diff, 9 - 4);
  });

  test('black ahead gives a negative diff', () => {
    const m = L.materialFromHistory([{ color: 'b', captured: 'r' }]);
    assert.equal(m.diff, -5);
  });

  test('counts en-passant as a pawn', () => {
    const m = L.materialFromHistory(play(['e4', 'a6', 'e5', 'd5', 'exd6']));
    assert.deepEqual(m.capturedBy.w, ['p']);
    assert.equal(m.diff, 1);
  });

  test('the king is never scored', () => {
    const m = L.materialFromHistory([{ color: 'w', captured: 'k' }]);
    assert.equal(m.diff, 0);
  });

  test('handles empty and malformed input', () => {
    assert.equal(L.materialFromHistory([]).diff, 0);
    assert.equal(L.materialFromHistory(null).diff, 0);
    assert.equal(L.materialFromHistory([null, { color: 'x', captured: 'q' }]).diff, 0);
  });
});

/* ------------------------------------------------------------------ */
describe('gameAccuracy', () => {
  test('averages the recorded moves', () => {
    assert.equal(L.gameAccuracy([{ acc: 100 }, { acc: 50 }]), 75);
  });

  test('returns null with nothing to average', () => {
    assert.equal(L.gameAccuracy([]), null);
  });

  test('ignores records with no accuracy', () => {
    assert.equal(L.gameAccuracy([{ acc: 80 }, { cls: 'Best' }]), 80);
  });

  test('a single perfect move gives 100', () => {
    assert.equal(L.gameAccuracy([{ acc: 100 }]), 100);
  });
});

/* ------------------------------------------------------------------ */
describe('recordCurve', () => {
  test('appends points in order', () => {
    let c = [];
    c = L.recordCurve(c, 1, 30);
    c = L.recordCurve(c, 2, -10);
    assert.deepEqual(c, [{ ply: 1, cpWhite: 30 }, { ply: 2, cpWhite: -10 }]);
  });

  test('replaying a ply replaces it and drops everything after', () => {
    let c = [];
    c = L.recordCurve(c, 1, 30);
    c = L.recordCurve(c, 2, -10);
    c = L.recordCurve(c, 3, 500);
    c = L.recordCurve(c, 2, 15); // took back and replayed move 2
    assert.deepEqual(c, [{ ply: 1, cpWhite: 30 }, { ply: 2, cpWhite: 15 }]);
  });

  test('never stores duplicate plies', () => {
    let c = [];
    for (const p of [1, 2, 3, 2, 3, 3]) c = L.recordCurve(c, p, p * 10);
    assert.equal(new Set(c.map((x) => x.ply)).size, c.length);
  });

  test('does not mutate the array it is given', () => {
    const a = [{ ply: 1, cpWhite: 5 }];
    const b = L.recordCurve(a, 2, 9);
    assert.equal(a.length, 1);
    assert.equal(b.length, 2);
  });
});

/* ------------------------------------------------------------------ */
describe('end-to-end consistency', () => {
  test('best move always yields 100% accuracy and zero loss', () => {
    for (const cp of [-500, -40, 0, 40, 500, 9998]) {
      const before = { bestmove: 'e2e4', pvs: { 1: { cp: cp < 9000 ? cp : undefined, mate: cp >= 9000 ? 2 : undefined, pv: ['e2e4'] } } };
      const r = L.scoreMove({ before, playedUci: 'e2e4' });
      assert.equal(r.cpLoss, 0, `cpLoss at ${cp}`);
      assert.equal(Math.round(r.accuracy), 100, `accuracy at ${cp}`);
      assert.equal(r.cls.key, 'Best');
    }
  });

  test('worse moves never score higher than better ones', () => {
    const before = {
      bestmove: 'e2e4',
      pvs: {
        1: { cp: 100, pv: ['e2e4'] },
        2: { cp: 40, pv: ['d2d4'] },
        3: { cp: -200, pv: ['f2f3'] },
      },
    };
    const a = L.scoreMove({ before, playedUci: 'e2e4' });
    const b = L.scoreMove({ before, playedUci: 'd2d4' });
    const c = L.scoreMove({ before, playedUci: 'f2f3' });
    assert.ok(a.accuracy >= b.accuracy);
    assert.ok(b.accuracy > c.accuracy);
    assert.ok(a.cpLoss <= b.cpLoss);
    assert.ok(b.cpLoss < c.cpLoss);
  });

  test('classification tracks how much winning chance was thrown away', () => {
    const mk = (playedCp) => L.scoreMove({
      before: { bestmove: 'e2e4', pvs: { 1: { cp: 0, pv: ['e2e4'] }, 2: { cp: playedCp, pv: ['d2d4'] } } },
      playedUci: 'd2d4',
    });
    assert.equal(mk(-10).cls.key, 'Excellent');
    assert.equal(mk(-60).cls.key, 'Good');
    assert.equal(mk(-150).cls.key, 'Inaccuracy');
    assert.equal(mk(-300).cls.key, 'Mistake');
    assert.equal(mk(-500).cls.key, 'Blunder');
  });

  test('severity never decreases as more is thrown away', () => {
    const order = ['Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Blunder'];
    let prev = -1;
    for (const cp of [-5, -40, -120, -250, -450, -900]) {
      const r = L.scoreMove({
        before: { bestmove: 'e2e4', pvs: { 1: { cp: 0, pv: ['e2e4'] }, 2: { cp, pv: ['d2d4'] } } },
        playedUci: 'd2d4',
      });
      const rank = order.indexOf(r.cls.key);
      assert.ok(rank >= prev, `${cp}cp went backwards to ${r.cls.key}`);
      prev = rank;
    }
  });

  test('a real game scores every one of its moves', () => {
    const c = new Chess();
    const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
    const recs = [];
    for (const san of moves) {
      const before = { bestmove: 'e2e4', pvs: { 1: { cp: 30, pv: ['e2e4'] } } };
      const r = L.scoreMove({ before, playedUci: 'e2e4' });
      recs.push({ acc: r.accuracy });
      c.move(san);
    }
    assert.equal(recs.length, moves.length);
    assert.equal(Math.round(L.gameAccuracy(recs)), 100);
    assert.equal(c.history().length, 6);
  });
});

/* ------------------------------------------------------------------ */
describe('puzzles from mistakes', () => {
  const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5'];

  test('fenAtPly rewinds to the right position', () => {
    assert.equal(L.fenAtPly(sans, 0), new Chess().fen());
    const c = new Chess();
    sans.slice(0, 4).forEach((s) => c.move(s));
    assert.equal(L.fenAtPly(sans, 4), c.fen());
  });

  test('fenAtPly clamps past the end of the game', () => {
    const c = new Chess();
    sans.forEach((s) => c.move(s));
    assert.equal(L.fenAtPly(sans, 999), c.fen());
  });

  test('fenAtPly returns null on an illegal history', () => {
    assert.equal(L.fenAtPly(['e4', 'e4'], 2), null);
  });

  test('a puzzle starts two plies before the mistake', () => {
    const p = L.puzzleStart(sans, 6, 2);
    assert.equal(p.startPly, 4);
    assert.equal(p.fenStart, L.fenAtPly(sans, 4));
    assert.equal(p.userMoves, 2, 'you play your earlier move, then the critical one');
  });

  test('a mistake on move one still produces a one-move puzzle', () => {
    const p = L.puzzleStart(sans, 0, 2);
    assert.equal(p.startPly, 0);
    assert.equal(p.userMoves, 1);
  });

  test('the rewind depth is configurable', () => {
    assert.equal(L.puzzleStart(sans, 6, 0).userMoves, 1);
    assert.equal(L.puzzleStart(sans, 6, 4).userMoves, 3);
  });

  test('the side to move at the start is the side that blundered', () => {
    const p = L.puzzleStart(sans, 6, 2);
    const mover = p.fenStart.split(' ')[1];
    const blunderMover = L.fenAtPly(sans, 6).split(' ')[1];
    assert.equal(mover, blunderMover);
  });

  test('returns null when the rewind itself cannot be replayed', () => {
    // The illegal move sits before the start ply, so the rewind fails.
    assert.equal(L.puzzleStart(['e4', 'e4', 'Nf3', 'Nc6'], 4, 2), null);
  });

  test('an illegal tail after the start ply does not matter', () => {
    // Only the position at the start ply is needed to build the puzzle.
    const p = L.puzzleStart(['e4', 'e4'], 2, 2);
    assert.notEqual(p, null);
    assert.equal(p.fenStart, new Chess().fen());
  });
});
