const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');
const { Chess } = require('../vendor/chess.js');

const DAY = 86400000;

describe('phaseOf', () => {
  test('the start position is the opening', () => {
    assert.equal(L.phaseOf(new Chess().fen(), 0), 'opening');
  });

  test('a full board late in the game is a middlegame', () => {
    assert.equal(L.phaseOf(new Chess().fen(), 30), 'middlegame');
  });

  test('a bare-bones position is an endgame whatever the move number', () => {
    const fen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    assert.equal(L.phaseOf(fen, 5), 'endgame');
    assert.equal(L.phaseOf(fen, 80), 'endgame');
  });

  test('queens off with a rook each is an endgame', () => {
    assert.equal(L.phaseOf('r3k3/pppp4/8/8/8/8/PPPP4/R3K3 w - - 0 1', 25), 'endgame');
  });

  test('pawns never push a position out of the endgame', () => {
    const many = 'pppppppp/pppppppp';
    assert.equal(L.phaseOf('4k3/' + many + '/8/8/8/4K3 w - - 0 1', 40), 'endgame');
  });

  test('survives a malformed fen without throwing', () => {
    assert.doesNotThrow(() => L.phaseOf(null, 4));
    assert.equal(L.phaseOf('', 4), 'endgame');
  });
});

describe('scheduleReview', () => {
  const now = 1_700_000_000_000;

  test('a first solve schedules one day out', () => {
    const r = L.scheduleReview({ interval: 0, solves: 0 }, true, now);
    assert.equal(r.interval, 1);
    assert.equal(r.due, now + DAY);
    assert.equal(r.solves, 1);
    assert.equal(r.retired, false);
  });

  test('intervals grow with each solve', () => {
    let rec = { interval: 0, solves: 0 };
    const seen = [];
    for (let i = 0; i < 5; i++) { rec = L.scheduleReview(rec, true, now); seen.push(rec.interval); }
    assert.deepEqual(seen, [1, 3, 7, 15, 33]);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1]);
  });

  test('failing resets the interval and returns it in ten minutes', () => {
    const r = L.scheduleReview({ interval: 15, solves: 4, lapses: 0 }, false, now);
    assert.equal(r.interval, 0);
    assert.equal(r.due, now + 600000);
    assert.equal(r.lapses, 1);
    assert.equal(r.solves, 4, 'a failure must not count as a solve');
  });

  test('a card that survives two months retires', () => {
    const r = L.scheduleReview({ interval: 33, solves: 5 }, true, now);
    assert.ok(r.interval >= 60);
    assert.equal(r.retired, true);
  });

  test('failing un-retires nothing that was already retired', () => {
    const r = L.scheduleReview({ interval: 80, solves: 6, retired: true }, false, now);
    assert.equal(r.retired, false);
    assert.equal(r.interval, 0);
  });

  test('copes with a brand new record', () => {
    const r = L.scheduleReview({}, true, now);
    assert.equal(r.interval, 1);
    assert.equal(r.solves, 1);
  });
});

describe('isDue / dueList', () => {
  const now = 1_700_000_000_000;

  test('a card is due at or after its due time', () => {
    assert.equal(L.isDue({ due: now - 1 }, now), true);
    assert.equal(L.isDue({ due: now }, now), true);
    assert.equal(L.isDue({ due: now + 1 }, now), false);
  });

  test('a card with no due date is due immediately', () => {
    assert.equal(L.isDue({}, now), true);
  });

  test('retired cards are never due', () => {
    assert.equal(L.isDue({ due: 0, retired: true }, now), false);
  });

  test('dueList returns only due cards, soonest first', () => {
    const list = [
      { id: 'a', due: now + DAY },
      { id: 'b', due: now - 2 * DAY },
      { id: 'c', due: now - DAY },
      { id: 'd', due: 0, retired: true },
    ];
    assert.deepEqual(L.dueList(list, now).map((r) => r.id), ['b', 'c']);
  });

  test('handles an empty or missing list', () => {
    assert.deepEqual(L.dueList([], now), []);
    assert.deepEqual(L.dueList(null, now), []);
  });
});

describe('weaknessReport', () => {
  const games = [
    { breakdown: [
      { phase: 'opening', cls: 'Best', acc: 100, cpLoss: 0 },
      { phase: 'middlegame', cls: 'Blunder', acc: 10, cpLoss: 400, hung: 'n' },
      { phase: 'middlegame', cls: 'Good', acc: 92, cpLoss: 30 },
      { phase: 'endgame', cls: 'Mistake', acc: 55, cpLoss: 150 },
    ] },
    { breakdown: [
      { phase: 'middlegame', cls: 'Blunder', acc: 12, cpLoss: 500, hung: 'n' },
      { phase: 'middlegame', cls: 'Excellent', acc: 98, cpLoss: 10 },
      { phase: 'opening', cls: 'Best', acc: 100, cpLoss: 0 },
      { phase: 'middlegame', cls: 'Inaccuracy', acc: 70, cpLoss: 90, hung: 'b' },
      { phase: 'middlegame', cls: 'Good', acc: 90, cpLoss: 35 },
    ] },
  ];

  test('counts every graded move once', () => {
    const r = L.weaknessReport(games);
    assert.equal(r.total.moves, 9);
    assert.equal(r.gamesWithData, 2);
  });

  test('splits by phase', () => {
    const r = L.weaknessReport(games);
    assert.equal(r.phases.opening.moves, 2);
    assert.equal(r.phases.middlegame.moves, 6);
    assert.equal(r.phases.endgame.moves, 1);
  });

  test('averages accuracy per phase', () => {
    const r = L.weaknessReport(games);
    assert.equal(r.phases.opening.accuracy, 100);
    assert.equal(Math.round(r.phases.middlegame.accuracy), Math.round((10 + 92 + 12 + 98 + 70 + 90) / 6));
  });

  test('names the weakest phase, ignoring buckets with too little data', () => {
    const r = L.weaknessReport(games);
    // endgame has only 1 move so it can't win despite the low score
    assert.equal(r.weakestPhase, 'middlegame');
  });

  test('counts blunders and error rate', () => {
    const r = L.weaknessReport(games);
    assert.equal(r.phases.middlegame.blunders, 2);
    assert.equal(r.total.mistakes, 1);
    assert.ok(r.phases.middlegame.errorRate > 0.3);
  });

  test('finds the piece you hang most', () => {
    const r = L.weaknessReport(games);
    assert.equal(r.hung.n, 2);
    assert.equal(r.hung.b, 1);
    assert.equal(r.mostHungPiece, 'n');
  });

  test('ignores ungraded (book) moves', () => {
    const withBook = [{ breakdown: [
      { phase: 'opening', cls: 'Book', acc: null, cpLoss: 0 },
      { phase: 'opening', cls: 'Best', acc: 100, cpLoss: 0 },
    ] }];
    const r = L.weaknessReport(withBook);
    assert.equal(r.total.moves, 1);
  });

  test('returns an empty shape with no data at all', () => {
    const r = L.weaknessReport([]);
    assert.equal(r.total.moves, 0);
    assert.equal(r.total.accuracy, null);
    assert.equal(r.weakestPhase, null);
    assert.equal(r.mostHungPiece, null);
    assert.equal(r.gamesWithData, 0);
  });

  test('tolerates games saved before breakdowns existed', () => {
    const r = L.weaknessReport([{ accuracy: 80 }, { accuracy: 90, breakdown: [] }]);
    assert.equal(r.total.moves, 0);
    assert.equal(r.gamesWithData, 0);
  });

  test('survives null input', () => {
    assert.doesNotThrow(() => L.weaknessReport(null));
  });
});

describe('explainMove reports the hung piece', () => {
  test('sets hung to the captured piece type', () => {
    const c = new Chess();
    c.move('e4'); c.move('e6');
    const fenBefore = c.fen();
    c.move({ from: 'f1', to: 'a6' });
    const r = L.explainMove({
      fenBefore, fenAfter: c.fen(), playedLine: ['f1a6', 'b7a6'],
      bestUci: 'd2d4', cpLoss: 550, cpBefore: 110, cpAfterMine: -440,
    });
    assert.equal(r.hung, 'b');
  });

  test('hung is null when nothing was taken', () => {
    const r = L.explainMove({
      fenBefore: new Chess().fen(), fenAfter: new Chess().fen(),
      playedLine: ['d2d4', 'd7d5'], bestUci: 'e2e4', cpLoss: 15, cpBefore: 40, cpAfterMine: 25,
    });
    assert.equal(r.hung, null);
  });
});
