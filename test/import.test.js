const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

describe('bucketForMs', () => {
  test('sorts think times into the right band', () => {
    assert.equal(L.bucketForMs(0), 'snap');
    assert.equal(L.bucketForMs(4999), 'snap');
    assert.equal(L.bucketForMs(5000), 'quick');
    assert.equal(L.bucketForMs(14999), 'quick');
    assert.equal(L.bucketForMs(15000), 'steady');
    assert.equal(L.bucketForMs(29999), 'steady');
    assert.equal(L.bucketForMs(30000), 'long');
    assert.equal(L.bucketForMs(600000), 'long');
  });
});

describe('timeReport', () => {
  const mk = (ms, acc, cls) => ({ phase: 'middlegame', cls: cls || 'Good', acc, cpLoss: 40, ms });

  test('averages accuracy per band', () => {
    const r = L.timeReport([{ breakdown: [mk(1000, 40), mk(2000, 50), mk(40000, 90), mk(50000, 100)] }]);
    const snap = r.buckets.find((b) => b.key === 'snap');
    const long = r.buckets.find((b) => b.key === 'long');
    assert.equal(snap.moves, 2);
    assert.equal(snap.accuracy, 45);
    assert.equal(long.accuracy, 95);
  });

  test('ignores moves with no recorded time', () => {
    const r = L.timeReport([{ breakdown: [{ acc: 90, cls: 'Good', cpLoss: 10 }, mk(1000, 50)] }]);
    assert.equal(r.timedMoves, 1);
  });

  test('ignores book moves with no accuracy', () => {
    const r = L.timeReport([{ breakdown: [{ acc: null, cls: 'Book', ms: 900 }, mk(1000, 50)] }]);
    assert.equal(r.timedMoves, 1);
  });

  test('flags a real gap between fast and slow play', () => {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(mk(2000, 45, 'Blunder'));
    for (let i = 0; i < 6; i++) rows.push(mk(40000, 92));
    const r = L.timeReport([{ breakdown: rows }]);
    assert.ok(r.insight, 'should report an insight');
    assert.ok(r.insight.gap > 40);
    assert.equal(r.insight.fast, 'Under 5s');
    assert.equal(r.insight.slow, 'Over 30s');
  });

  test('stays quiet when the gap is small', () => {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(mk(2000, 88));
    for (let i = 0; i < 6; i++) rows.push(mk(40000, 90));
    assert.equal(L.timeReport([{ breakdown: rows }]).insight, null);
  });

  test('stays quiet without enough moves to mean anything', () => {
    const r = L.timeReport([{ breakdown: [mk(1000, 10), mk(40000, 100)] }]);
    assert.equal(r.insight, null);
  });

  test('counts blunders per band', () => {
    const r = L.timeReport([{ breakdown: [mk(1000, 10, 'Blunder'), mk(1500, 20, 'Blunder'), mk(40000, 95)] }]);
    assert.equal(r.buckets.find((b) => b.key === 'snap').blunders, 2);
    assert.equal(r.buckets.find((b) => b.key === 'long').blunders, 0);
  });

  test('empty input gives empty bands, not a crash', () => {
    const r = L.timeReport([]);
    assert.equal(r.timedMoves, 0);
    assert.equal(r.buckets.length, 4);
    assert.equal(r.buckets[0].accuracy, null);
    assert.doesNotThrow(() => L.timeReport(null));
  });
});

describe('chessComSide', () => {
  const game = { white: { username: 'KushG29' }, black: { username: 'Someone' } };

  test('finds the player regardless of case', () => {
    assert.equal(L.chessComSide(game, 'kushg29'), 'w');
    assert.equal(L.chessComSide(game, 'SOMEONE'), 'b');
  });

  test('returns null when the player is not in the game', () => {
    assert.equal(L.chessComSide(game, 'nobody'), null);
    assert.equal(L.chessComSide(game, ''), null);
    assert.equal(L.chessComSide(null, 'kushg29'), null);
  });

  test('trims stray whitespace from the username', () => {
    assert.equal(L.chessComSide(game, '  kushg29 '), 'w');
  });
});

describe('importableGames', () => {
  const g = (name, extra) => Object.assign({
    pgn: '1. e4 e5', rules: 'chess', end_time: 100,
    white: { username: name === 'w' ? 'me' : 'them' },
    black: { username: name === 'w' ? 'them' : 'me' },
  }, extra || {});

  test('keeps only games the player was in', () => {
    const games = [g('w'), { pgn: '1. e4', rules: 'chess', white: { username: 'a' }, black: { username: 'b' } }];
    assert.equal(L.importableGames(games, 'me', 10).length, 1);
  });

  test('drops variants', () => {
    const games = [g('w'), g('b', { rules: 'chess960' }), g('w', { rules: 'bughouse' })];
    assert.equal(L.importableGames(games, 'me', 10).length, 1);
  });

  test('drops games with no pgn', () => {
    assert.equal(L.importableGames([g('w', { pgn: '' })], 'me', 10).length, 0);
  });

  test('returns newest first and respects the limit', () => {
    const games = [g('w', { end_time: 1 }), g('w', { end_time: 3 }), g('w', { end_time: 2 })];
    const out = L.importableGames(games, 'me', 2);
    assert.deepEqual(out.map((x) => x.end_time), [3, 2]);
  });

  test('handles empty and missing input', () => {
    assert.deepEqual(L.importableGames([], 'me', 5), []);
    assert.deepEqual(L.importableGames(null, 'me', 5), []);
  });
});

describe('chessComResult', () => {
  test('reads the result from the player point of view', () => {
    const win = { white: { username: 'me', result: 'win' }, black: { username: 'you', result: 'resigned' } };
    assert.equal(L.chessComResult(win, 'me'), 'Win');
    assert.equal(L.chessComResult(win, 'you'), 'Loss');
  });

  test('anything neither side won is a draw', () => {
    const draw = { white: { username: 'me', result: 'agreed' }, black: { username: 'you', result: 'agreed' } };
    assert.equal(L.chessComResult(draw, 'me'), 'Draw');
  });

  test('unknown player gives Unknown', () => {
    assert.equal(L.chessComResult({ white: { username: 'a' }, black: { username: 'b' } }, 'c'), 'Unknown');
  });
});
