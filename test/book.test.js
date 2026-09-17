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
