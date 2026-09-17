const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

// A typical multi-PV result: best is +80, then progressively worse options.
const pvs = {
  1: { pv: ['e2e4'], cp: 80 },
  2: { pv: ['d2d4'], cp: 55 },
  3: { pv: ['g1f3'], cp: 20 },
  4: { pv: ['b1c3'], cp: -140 },
  5: { pv: ['f2f3'], cp: -650 },
};

describe('bot levels', () => {
  test('every level is fully specified', () => {
    for (const k of Object.keys(L.BOT_LEVELS)) {
      const lv = L.BOT_LEVELS[k];
      assert.equal(lv.id, k);
      assert.ok(lv.label, `${k} needs a label`);
      assert.ok(lv.depth >= 1, `${k} needs a depth`);
      assert.ok(lv.temperature >= 0);
      assert.ok(lv.maxLoss >= 0);
    }
  });

  test('stronger levels search deeper and tolerate less loss', () => {
    const order = ['beginner', 'novice', 'casual', 'club', 'strong', 'expert', 'max'];
    for (let i = 1; i < order.length; i++) {
      const prev = L.BOT_LEVELS[order[i - 1]], cur = L.BOT_LEVELS[order[i]];
      assert.ok(cur.depth > prev.depth, `${order[i]} should search deeper than ${order[i - 1]}`);
      assert.ok(cur.temperature <= prev.temperature, `${order[i]} should be less sloppy`);
      assert.ok(cur.maxLoss <= prev.maxLoss, `${order[i]} should cap loss tighter`);
    }
  });

  test('botLevel falls back to casual for anything unknown', () => {
    assert.equal(L.botLevel('nonsense').id, 'casual');
    assert.equal(L.botLevel(undefined).id, 'casual');
    assert.equal(L.botLevel('club').id, 'club');
  });
});

describe('chooseBotMove', () => {
  test('max strength always plays the best move', () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(L.chooseBotMove(pvs, L.BOT_LEVELS.max), 'e2e4');
    }
  });

  test('never plays a move beyond the level cap', () => {
    const lv = L.BOT_LEVELS.expert;            // maxLoss 100
    const allowed = new Set(['e2e4', 'd2d4', 'g1f3']);   // losses 0, 25, 60
    for (let i = 0; i < 300; i++) {
      assert.ok(allowed.has(L.chooseBotMove(pvs, lv)), 'expert played something too weak');
    }
  });

  test('a weak level still refuses the worst move when it is far past the cap', () => {
    const lv = L.BOT_LEVELS.casual;            // maxLoss 450, so f2f3 (-730) is out
    for (let i = 0; i < 300; i++) {
      assert.notEqual(L.chooseBotMove(pvs, lv), 'f2f3');
    }
  });

  test('never walks into mate when a sane move exists', () => {
    const withMate = { 1: { pv: ['e2e4'], cp: 30 }, 2: { pv: ['g2g4'], mate: -2 } };
    for (let i = 0; i < 200; i++) {
      assert.equal(L.chooseBotMove(withMate, L.BOT_LEVELS.beginner), 'e2e4');
    }
  });

  test('takes a mate when it has one', () => {
    const mating = { 1: { pv: ['d1h5'], mate: 1 }, 2: { pv: ['e2e4'], cp: 50 } };
    assert.equal(L.chooseBotMove(mating, L.BOT_LEVELS.casual), 'd1h5');
  });

  test('weaker levels pick the best move less often than stronger ones', () => {
    const rate = (lv) => {
      let best = 0;
      let seed = 1;
      const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      for (let i = 0; i < 2000; i++) if (L.chooseBotMove(pvs, lv, rng) === 'e2e4') best++;
      return best / 2000;
    };
    const beginner = rate(L.BOT_LEVELS.beginner);
    const club = rate(L.BOT_LEVELS.club);
    const expert = rate(L.BOT_LEVELS.expert);
    assert.ok(beginner < club, `beginner ${beginner} should be looser than club ${club}`);
    assert.ok(club < expert, `club ${club} should be looser than expert ${expert}`);
    assert.ok(expert > 0.5, 'expert should usually find the best move');
  });

  test('the best move is always the single most likely choice', () => {
    let seed = 7;
    const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const counts = {};
    for (let i = 0; i < 3000; i++) {
      const m = L.chooseBotMove(pvs, L.BOT_LEVELS.casual, rng);
      counts[m] = (counts[m] || 0) + 1;
    }
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    assert.equal(top, 'e2e4');
  });

  test('a deterministic rng at 0 gives the best move', () => {
    assert.equal(L.chooseBotMove(pvs, L.BOT_LEVELS.beginner, () => 0), 'e2e4');
  });

  test('returns null when the search produced nothing usable', () => {
    assert.equal(L.chooseBotMove({}, L.BOT_LEVELS.casual), null);
    assert.equal(L.chooseBotMove({ 1: { pv: [] } }, L.BOT_LEVELS.casual), null);
    assert.equal(L.chooseBotMove({ 1: { pv: ['e2e4'] } }, L.BOT_LEVELS.casual), null, 'no score means unusable');
  });

  test('copes with a single candidate', () => {
    assert.equal(L.chooseBotMove({ 1: { pv: ['e2e4'], cp: 12 } }, L.BOT_LEVELS.beginner), 'e2e4');
  });

  test('always returns one of the candidates', () => {
    const all = new Set(['e2e4', 'd2d4', 'g1f3', 'b1c3', 'f2f3']);
    for (const k of Object.keys(L.BOT_LEVELS)) {
      for (let i = 0; i < 100; i++) {
        assert.ok(all.has(L.chooseBotMove(pvs, L.BOT_LEVELS[k])), `${k} returned a stranger`);
      }
    }
  });
});
