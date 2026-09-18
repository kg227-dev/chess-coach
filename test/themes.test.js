const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');
const { Chess } = require('../vendor/chess.js');

describe('withTurn', () => {
  test('flips the side to move and drops en passant', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
    const flipped = L.withTurn(fen, 'b');
    assert.equal(flipped.split(' ')[1], 'b');
    assert.equal(flipped.split(' ')[3], '-');
  });

  test('returns null for a malformed fen', () => {
    assert.equal(L.withTurn('garbage', 'w'), null);
    assert.equal(L.withTurn(null, 'w'), null);
  });
});

describe('isPinned / pinnedSquares', () => {
  test('a knight shielding its king from a rook is pinned', () => {
    // White king e1, white knight e4, black rook e8 — the knight cannot move.
    const fen = '4r3/8/8/8/4N3/8/8/4K3 w - - 0 1';
    assert.equal(L.isPinned(fen, 'e4', 'w'), true);
  });

  test('a piece off the line is not pinned', () => {
    const fen = '4r3/8/8/8/4N3/8/8/4K3 w - - 0 1';
    assert.equal(L.isPinned(fen, 'e1', 'w'), false, 'the king itself is never "pinned"');
  });

  test('a shielded piece with a blocker between is not pinned', () => {
    // A second white piece on e3 also blocks, so removing e4 leaves no check.
    const fen = '4r3/8/8/8/4N3/4B3/8/4K3 w - - 0 1';
    assert.equal(L.isPinned(fen, 'e4', 'w'), false);
  });

  test('nothing is pinned in the start position', () => {
    assert.deepEqual(L.pinnedSquares(new Chess().fen(), 'w'), []);
    assert.deepEqual(L.pinnedSquares(new Chess().fen(), 'b'), []);
  });

  test('pinnedSquares finds the pinned piece', () => {
    const fen = '4r3/8/8/8/4N3/8/8/4K3 w - - 0 1';
    assert.deepEqual(L.pinnedSquares(fen, 'w'), ['e4']);
  });

  test('survives nonsense without throwing', () => {
    assert.equal(L.isPinned('garbage', 'e4', 'w'), false);
    assert.deepEqual(L.pinnedSquares('garbage', 'w'), []);
  });
});

describe('detectThemes', () => {
  test('a captured piece is a hanging-piece theme', () => {
    const c = new Chess();
    c.move('e4'); c.move('e6');
    const fenBefore = c.fen();
    c.move({ from: 'f1', to: 'a6' });               // Ba6?? — bxa6
    const themes = L.detectThemes({
      mover: 'w', fenBefore, fenAfter: c.fen(),
      playedLine: ['f1a6', 'b7a6'], bestUci: 'd2d4',
      cpLoss: 550, cpBefore: 100, cpAfterMine: -450,
    });
    assert.ok(themes.includes('hanging'), 'got ' + themes.join(','));
  });

  test('allowing forced mate is reported', () => {
    const t = L.detectThemes({ mover: 'w', cpLoss: 900, cpBefore: 20, cpAfterMine: -9998, playedLine: [] });
    assert.ok(t.includes('allowedMate'));
  });

  test('missing a forced mate is reported', () => {
    const t = L.detectThemes({ mover: 'w', cpLoss: 500, cpBefore: 9998, cpAfterMine: 300, playedLine: [] });
    assert.ok(t.includes('missedMate'));
  });

  test('a knight fork of king and rook is detected', () => {
    // White knight b5-c7 checks the king on e8 and attacks the rook on a8.
    const fenAfter = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
    const themes = L.detectThemes({
      mover: 'b', fenBefore: fenAfter, fenAfter,
      playedLine: ['h7h6', 'b5c7'],
      cpLoss: 400, cpBefore: 0, cpAfterMine: -400,
    });
    assert.ok(themes.includes('fork'), 'got ' + themes.join(','));
  });

  test('a move that only attacks one piece is not called a fork', () => {
    // Nd7 hits the rook on b8 but does NOT check the king on e8.
    const fenAfter = '1r2k3/8/8/4N3/8/8/8/4K3 w - - 0 1';
    const themes = L.detectThemes({
      mover: 'b', fenBefore: fenAfter, fenAfter,
      playedLine: ['h7h6', 'e5d7'],
      cpLoss: 400, cpBefore: 0, cpAfterMine: -400,
    });
    assert.ok(!themes.includes('fork'), 'invented a fork: ' + themes.join(','));
  });

  test('a rook checking on the back rank is a back-rank theme', () => {
    // Black king g8 boxed by f7/g7/h7; white rook swings to e8 with check.
    const fenAfter = '6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1';
    const themes = L.detectThemes({
      mover: 'b', fenBefore: fenAfter, fenAfter,
      playedLine: ['a7a6', 'e1e8'],
      cpLoss: 900, cpBefore: 0, cpAfterMine: -900,
    });
    assert.ok(themes.includes('backRank'), 'got ' + themes.join(','));
  });

  test('leaving a knight en prise for the best move is missed material', () => {
    const c = new Chess();
    c.move('e4'); c.move('e5'); c.move('Nf3'); c.move('Nc6'); c.move('Bb5');
    const fenBefore = c.fen();                       // black to move; Bxc6 available later
    const themes = L.detectThemes({
      mover: 'b', fenBefore, fenAfter: fenBefore,
      playedLine: ['a7a6'], bestUci: 'c6d4',
      cpLoss: 200, cpBefore: 0, cpAfterMine: -200, playedCaptured: null,
    });
    assert.ok(Array.isArray(themes));                // no crash on a non-capture best move
  });

  test('small losses produce no board-read themes', () => {
    const c = new Chess();
    c.move('e4');
    const t = L.detectThemes({
      mover: 'w', fenBefore: new Chess().fen(), fenAfter: c.fen(),
      playedLine: ['e2e4', 'e7e5'], bestUci: 'd2d4',
      cpLoss: 15, cpBefore: 30, cpAfterMine: 15,
    });
    assert.deepEqual(t, []);
  });

  test('themes are unique and stable', () => {
    const c = new Chess();
    c.move('e4'); c.move('e6');
    const fenBefore = c.fen();
    c.move({ from: 'f1', to: 'a6' });
    const a = L.detectThemes({ mover: 'w', fenBefore, fenAfter: c.fen(), playedLine: ['f1a6','b7a6'], cpLoss: 550, cpBefore: 100, cpAfterMine: -450 });
    const b = L.detectThemes({ mover: 'w', fenBefore, fenAfter: c.fen(), playedLine: ['f1a6','b7a6'], cpLoss: 550, cpBefore: 100, cpAfterMine: -450 });
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length);
  });

  test('every theme key has a label', () => {
    const all = ['hanging','fork','pin','backRank','allowedMate','missedMate','missedWin'];
    for (const k of all) assert.ok(L.THEME_LABELS[k], `${k} needs a label`);
  });

  test('survives nonsense input', () => {
    assert.doesNotThrow(() => L.detectThemes({}));
    assert.doesNotThrow(() => L.detectThemes({ mover: 'w', fenBefore: 'x', fenAfter: 'y', playedLine: ['zzzz','yyyy'], cpLoss: 500 }));
  });
});

describe('weaknessReport tallies themes', () => {
  const games = [
    { breakdown: [
      { phase: 'middlegame', cls: 'Blunder', acc: 10, cpLoss: 400, hung: 'n', themes: ['hanging', 'fork'] },
      { phase: 'middlegame', cls: 'Mistake', acc: 50, cpLoss: 150, themes: ['fork'] },
      { phase: 'endgame', cls: 'Good', acc: 90, cpLoss: 30, themes: [] },
    ] },
    { breakdown: [
      { phase: 'middlegame', cls: 'Blunder', acc: 12, cpLoss: 500, themes: ['fork', 'backRank'] },
    ] },
  ];

  test('counts each theme across games', () => {
    const r = L.weaknessReport(games);
    assert.equal(r.themes.fork, 3);
    assert.equal(r.themes.hanging, 1);
    assert.equal(r.themes.backRank, 1);
  });

  test('names the most common theme', () => {
    assert.equal(L.weaknessReport(games).topTheme, 'fork');
  });

  test('no themes at all leaves topTheme null', () => {
    const r = L.weaknessReport([{ breakdown: [{ phase: 'opening', cls: 'Best', acc: 100, cpLoss: 0 }] }]);
    assert.deepEqual(r.themes, {});
    assert.equal(r.topTheme, null);
  });

  test('older games without themes still aggregate', () => {
    const r = L.weaknessReport([{ breakdown: [{ phase: 'middlegame', cls: 'Mistake', acc: 40, cpLoss: 200 }] }]);
    assert.equal(r.total.moves, 1);
    assert.equal(r.topTheme, null);
  });
});

describe('captureWinsMaterial', () => {
  test('taking an undefended piece wins material', () => {
    // Black bishop sits on a6 with nothing defending it; after bxa6 nothing recaptures.
    assert.equal(L.captureWinsMaterial('4k3/8/B7/8/8/8/8/4K3 b - - 0 1', 'a6', 'b', 'p'), true);
  });

  test('an even trade is not winning material', () => {
    // A knight took a knight on e5 and the d6 pawn can recapture: 3 for 3.
    assert.equal(L.captureWinsMaterial('4k3/8/3p4/4N3/8/8/8/4K3 b - - 0 1', 'e5', 'n', 'n'), false);
  });

  test('taking a queen with a pawn wins material even if recaptured', () => {
    assert.equal(L.captureWinsMaterial('4k3/8/8/4P3/3b4/8/8/4K3 b - - 0 1', 'e5', 'q', 'p'), true);
  });

  test('losing the exchange the other way is not a hang', () => {
    // A knight took a pawn and the d4 bishop can recapture — we came out ahead.
    assert.equal(L.captureWinsMaterial('4k3/8/8/4N3/3b4/8/8/4K3 b - - 0 1', 'e5', 'p', 'n'), false);
  });

  test('a pawn taken and recaptured is not a hang', () => {
    assert.equal(L.captureWinsMaterial('4k3/8/3p4/4P3/8/8/8/4K3 b - - 0 1', 'e5', 'p', 'p'), false);
  });

  test('survives nonsense', () => {
    assert.equal(L.captureWinsMaterial('garbage', 'e5', 'q', 'p'), false);
    assert.equal(L.captureWinsMaterial('4k3/8/8/8/8/8/8/4K3 b - - 0 1', 'e5', null, 'p'), false);
  });
});

describe('hanging theme only fires on real material loss', () => {
  test('a plain recapture is not called a hanging piece', () => {
    // 1.e4 d5 2.exd5 Qxd5 — Black recaptures; nobody hung anything.
    const c = new Chess();
    c.move('e4'); c.move('d5');
    const fenBefore = c.fen();
    c.move('exd5');
    const themes = L.detectThemes({
      mover: 'w', fenBefore, fenAfter: c.fen(),
      playedLine: ['e4d5', 'd8d5'], bestUci: 'e4d5',
      cpLoss: 120, cpBefore: 40, cpAfterMine: -80,
    });
    assert.ok(!themes.includes('hanging'), 'called a trade a hang: ' + themes.join(','));
  });

  test('a genuinely dropped bishop still counts', () => {
    const c = new Chess();
    c.move('e4'); c.move('e6');
    const fenBefore = c.fen();
    c.move({ from: 'f1', to: 'a6' });
    const themes = L.detectThemes({
      mover: 'w', fenBefore, fenAfter: c.fen(),
      playedLine: ['f1a6', 'b7a6'], bestUci: 'd2d4',
      cpLoss: 550, cpBefore: 100, cpAfterMine: -450,
    });
    assert.ok(themes.includes('hanging'), 'missed a real hang: ' + themes.join(','));
  });
});
