const { test, describe } = require('node:test');
const assert = require('node:assert');
const B = require('../book.js');
const { Chess } = require('../vendor/chess.js');

describe('opening book data', () => {
  test('every line is a legal sequence of moves', () => {
    for (const line of B.LINES) {
      const c = new Chess();
      line.moves.forEach((san, i) => {
        const m = c.move(san);
        assert.ok(m, `${line.name}: illegal move "${san}" at ply ${i + 1} (${line.moves.join(' ')})`);
      });
    }
  });

  test('no duplicate opening names', () => {
    const names = B.LINES.map((l) => l.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('covers both first moves club players actually meet', () => {
    assert.ok(B.isBook(['e4']));
    assert.ok(B.isBook(['d4']));
    assert.ok(B.isBook(['c4']));
    assert.ok(B.isBook(['Nf3']));
  });
});

describe('isBook', () => {
  test('the empty game is in book', () => {
    assert.equal(B.isBook([]), true);
  });

  test('follows a real line', () => {
    assert.equal(B.isBook(['e4', 'c5', 'Nf3', 'd6']), true);
  });

  test('leaves book on a move no line plays', () => {
    assert.equal(B.isBook(['e4', 'c5', 'Nf3', 'Qa5']), false);
  });

  test('a bad first move is not book', () => {
    assert.equal(B.isBook(['h4']), false);
    assert.equal(B.isBook(['a3']), false);
  });

  test('a transposition that leaves every line is not book', () => {
    assert.equal(B.isBook(['e4', 'e5', 'Qh5']), false);
  });

  test('running past the end of every line is not book', () => {
    const longest = B.LINES.reduce((a, b) => (a.moves.length > b.moves.length ? a : b));
    assert.equal(B.isBook(longest.moves.concat(['a3'])), false);
  });
});

describe('openingName', () => {
  test('names the opening as soon as a line is reached', () => {
    assert.equal(B.openingName(['e4', 'c5']), 'Sicilian Defence');
  });

  test('prefers the most specific line reached', () => {
    const najdorf = 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5'.split(' ');
    assert.equal(B.openingName(najdorf), 'Sicilian, Najdorf');
  });

  test('names a line still in progress', () => {
    const name = B.openingName(['e4', 'e6']);
    assert.ok(name && name.startsWith('French'), 'got: ' + name);
  });

  test('returns null once out of book', () => {
    assert.equal(B.openingName(['h4', 'h5']), null);
  });

  test('returns null for no moves', () => {
    assert.equal(B.openingName([]), null);
  });

  test('keeps the name after leaving book', () => {
    // Reached the Ruy Lopez, then played something off-book.
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Qf6'];
    assert.equal(B.openingName(sans), 'Ruy Lopez');
    assert.equal(B.isBook(sans), false);
  });
});

describe('opening trainer', () => {
  test('there are twenty lines, ten per colour', () => {
    assert.equal(B.TRAINER.length, 20);
    assert.equal(B.TRAINER.filter((l) => l.side === 'w').length, 10);
    assert.equal(B.TRAINER.filter((l) => l.side === 'b').length, 10);
  });

  test('every trainer line is legal from the start position', () => {
    for (const line of B.TRAINER) {
      const c = new Chess();
      line.moves.forEach((san, i) => {
        const m = c.move(san);
        assert.ok(m, `${line.name}: illegal move "${san}" at ply ${i + 1}`);
      });
    }
  });

  test('lines are long enough to be worth drilling', () => {
    for (const line of B.TRAINER) {
      assert.ok(line.moves.length >= 10, `${line.name} is only ${line.moves.length} plies`);
    }
  });

  test('names are unique', () => {
    const names = B.TRAINER.map((l) => l.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('a white drill has the user moving first', () => {
    const line = B.TRAINER.find((l) => l.side === 'w');
    const t = B.trainerTurn(line, 0);
    assert.equal(t.isUser, true);
    assert.equal(t.expected, line.moves[0]);
  });

  test('a black drill has the opponent moving first', () => {
    const line = B.TRAINER.find((l) => l.side === 'b');
    assert.equal(B.trainerTurn(line, 0).isUser, false);
    assert.equal(B.trainerTurn(line, 1).isUser, true);
  });

  test('the user plays every other ply throughout', () => {
    for (const line of B.TRAINER) {
      for (let i = 0; i < line.moves.length; i++) {
        const expectUser = ((i % 2 === 0) === (line.side === 'w'));
        assert.equal(B.trainerTurn(line, i).isUser, expectUser, `${line.name} ply ${i}`);
      }
    }
  });

  test('running off the end of a line reports done', () => {
    const line = B.TRAINER[0];
    const t = B.trainerTurn(line, line.moves.length);
    assert.equal(t.done, true);
    assert.equal(t.expected, null);
  });

  test('handles a missing line', () => {
    assert.equal(B.trainerTurn(null, 0).done, true);
  });
});
