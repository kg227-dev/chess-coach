const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');
const { Chess } = require('../vendor/chess.js');
const DB = require('../puzzles.json');

describe('puzzle database', () => {
  test('has all ten categories populated', () => {
    assert.equal(DB.categories.length, 10);
    for (const cat of DB.categories) {
      const n = L.puzzlesInCategory(DB.puzzles, cat.key).length;
      assert.ok(n >= 100, `${cat.key} only has ${n}`);
    }
  });

  test('credits its source', () => {
    assert.match(DB.source, /Lichess/i);
    assert.match(DB.source, /CC0/i);
  });

  test('every puzzle replays legally from its FEN', () => {
    for (const p of DB.puzzles) {
      const c = new Chess();
      assert.ok(c.load(p.fen), `${p.id}: bad FEN`);
      for (const u of p.moves.split(' ')) {
        const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
        assert.ok(m, `${p.id}: illegal move ${u}`);
      }
    }
  });

  test('every puzzle has a rating in range and at least one category', () => {
    for (const p of DB.puzzles) {
      assert.ok(p.rating >= 600 && p.rating <= 2400, `${p.id}: rating ${p.rating}`);
      assert.ok(p.cats && p.cats.length, `${p.id}: no category`);
    }
  });

  test('mate puzzles really do end in mate', () => {
    const mates = L.puzzlesInCategory(DB.puzzles, 'mate1').slice(0, 40);
    for (const p of mates) {
      const c = new Chess(); c.load(p.fen);
      p.moves.split(' ').forEach((u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' }));
      assert.ok(c.in_checkmate(), `${p.id} should finish in checkmate`);
    }
  });

  test('mate-in-1 really is one move for the solver', () => {
    for (const p of L.puzzlesInCategory(DB.puzzles, 'mate1').slice(0, 40)) {
      assert.equal(L.puzzleSolutionLength(p), 1, `${p.id}`);
    }
  });

  test('mate-in-2 asks for two', () => {
    for (const p of L.puzzlesInCategory(DB.puzzles, 'mate2').slice(0, 40)) {
      assert.equal(L.puzzleSolutionLength(p), 2, `${p.id}`);
    }
  });
});

describe('puzzleStartPosition', () => {
  test('plays the opponent move and hands you the position after it', () => {
    const p = DB.puzzles[0];
    const start = L.puzzleStartPosition(p);
    const moves = p.moves.split(' ');
    const c = new Chess(); c.load(p.fen);
    c.move({ from: moves[0].slice(0, 2), to: moves[0].slice(2, 4), promotion: moves[0][4] || 'q' });
    assert.equal(start.fen, c.fen());
    assert.deepEqual(start.solution, moves.slice(1));
    assert.equal(start.sideToMove, c.turn());
  });

  test('rejects malformed input instead of guessing', () => {
    assert.equal(L.puzzleStartPosition(null), null);
    assert.equal(L.puzzleStartPosition({ fen: 'nonsense', moves: 'e2e4' }), null);
    assert.equal(L.puzzleStartPosition({ fen: new Chess().fen(), moves: '' }), null);
    assert.equal(L.puzzleStartPosition({ fen: new Chess().fen(), moves: 'a1a8' }), null);
  });
});

describe('puzzleAccepts', () => {
  const start = new Chess().fen();

  test('accepts the intended move', () => {
    assert.equal(L.puzzleAccepts(start, 'e2e4', 'e2e4'), true);
  });

  test('rejects a different move', () => {
    assert.equal(L.puzzleAccepts(start, 'e2e4', 'd2d4'), false);
  });

  test('accepts any move that mates, not just the listed one', () => {
    // Back-rank mate: Ra8# and Rb8# both finish it.
    const fen = '6k1/5ppp/8/8/8/8/8/R1R3K1 w - - 0 1';
    assert.equal(L.puzzleAccepts(fen, 'a1a8', 'c1c8'), true);
  });

  test('a non-mating alternative is still wrong', () => {
    const fen = '6k1/5ppp/8/8/8/8/8/R1R3K1 w - - 0 1';
    assert.equal(L.puzzleAccepts(fen, 'a1a8', 'a1a4'), false);
  });

  test('promotion piece has to match', () => {
    const fen = '8/P7/8/8/7k/8/8/K7 w - - 0 1';
    assert.equal(L.puzzleAccepts(fen, 'a7a8q', 'a7a8n'), false);
    assert.equal(L.puzzleAccepts(fen, 'a7a8q', 'a7a8q'), true);
  });

  test('handles missing arguments', () => {
    assert.equal(L.puzzleAccepts(start, null, 'e2e4'), false);
    assert.equal(L.puzzleAccepts(start, 'e2e4', null), false);
    assert.equal(L.puzzleAccepts('garbage', 'e2e4', 'd2d4'), false);
  });
});

describe('category filtering and picking', () => {
  test('filters to the asked-for category', () => {
    const forks = L.puzzlesInCategory(DB.puzzles, 'fork');
    assert.ok(forks.length > 100);
    for (const p of forks) assert.ok(p.cats.includes('fork'));
  });

  test('"all" returns everything', () => {
    assert.equal(L.puzzlesInCategory(DB.puzzles, 'all').length, DB.puzzles.length);
  });

  test('an unknown category is empty, not everything', () => {
    assert.deepEqual(L.puzzlesInCategory(DB.puzzles, 'nope'), []);
  });

  test('picks near your rating when it can', () => {
    const pool = [{ rating: 800 }, { rating: 820 }, { rating: 850 }, { rating: 870 }, { rating: 890 }, { rating: 2300 }];
    for (let i = 0; i < 40; i++) {
      const p = L.pickPuzzle(pool, 850, Math.random);
      assert.ok(Math.abs(p.rating - 850) <= 300, 'picked ' + p.rating);
    }
  });

  test('falls back to the whole pool when nothing is near', () => {
    const pool = [{ rating: 2300 }, { rating: 2400 }];
    assert.ok(L.pickPuzzle(pool, 700));
  });

  test('empty pool gives null', () => {
    assert.equal(L.pickPuzzle([], 1200), null);
    assert.equal(L.pickPuzzle(null, 1200), null);
  });
});

describe('nextPuzzleRating', () => {
  test('solving pushes your rating up', () => {
    assert.ok(L.nextPuzzleRating(1200, 1300, true) > 1200);
  });

  test('missing pulls it down', () => {
    assert.ok(L.nextPuzzleRating(1200, 1100, false) < 1200);
  });

  test('stays inside the range the database covers', () => {
    let r = 2400;
    for (let i = 0; i < 50; i++) r = L.nextPuzzleRating(r, 2400, true);
    assert.ok(r <= 2400);
    let low = 600;
    for (let i = 0; i < 50; i++) low = L.nextPuzzleRating(low, 600, false);
    assert.ok(low >= 600);
  });

  test('starts somewhere sensible with no history', () => {
    assert.ok(L.nextPuzzleRating(null, 1400, true) > 1200);
  });
});
