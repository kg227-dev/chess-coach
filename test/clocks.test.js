const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

const pgn = (tc, movetext) => [
  '[Event "Live Chess"]',
  '[White "KushG29"]',
  tc === null ? '[Site "Chess.com"]' : `[TimeControl "${tc}"]`,
  '',
  movetext,
].join('\n');

describe('timeControlOf', () => {
  test('reads a plain base time', () => {
    assert.deepEqual(L.timeControlOf(pgn('600', '1. e4 *')), { baseMs: 600000, incMs: 0 });
  });

  test('reads a base time with increment', () => {
    assert.deepEqual(L.timeControlOf(pgn('180+2', '1. e4 *')), { baseMs: 180000, incMs: 2000 });
  });

  test('handles a bullet control', () => {
    assert.deepEqual(L.timeControlOf(pgn('60', '1. e4 *')), { baseMs: 60000, incMs: 0 });
  });

  test('gives up on correspondence controls', () => {
    assert.equal(L.timeControlOf(pgn('1/259200', '1. e4 *')), null);
  });

  test('gives up when there is no clock', () => {
    assert.equal(L.timeControlOf(pgn('-', '1. e4 *')), null);
    assert.equal(L.timeControlOf(pgn(null, '1. e4 *')), null);
  });

  test('survives rubbish', () => {
    assert.equal(L.timeControlOf(null), null);
    assert.equal(L.timeControlOf(''), null);
    assert.equal(L.timeControlOf(pgn('abc', '1. e4 *')), null);
  });
});

describe('thinkTimesFromPgn', () => {
  test('measures each side from the start of its own clock', () => {
    const p = pgn('600', '1. e4 {[%clk 0:09:57]} 1... e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} 1-0');
    assert.deepEqual(L.thinkTimesFromPgn(p), [3000, 5000, 7000]);
  });

  test('adds the increment back before comparing', () => {
    // 600 -> thought 8s -> 592 -> +5 increment -> 597 on the clock.
    const p = pgn('600+5', '1. e4 {[%clk 0:09:57]} 1... e5 {[%clk 0:09:57]} 1-0');
    assert.deepEqual(L.thinkTimesFromPgn(p), [8000, 8000]);
  });

  test('reads tenths of a second', () => {
    const p = pgn('600', '1. e4 {[%clk 0:09:57.5]} 1-0');
    assert.deepEqual(L.thinkTimesFromPgn(p), [2500]);
  });

  test('reads clocks over an hour', () => {
    const p = pgn('5400', '1. e4 {[%clk 1:29:30]} 1-0');
    assert.deepEqual(L.thinkTimesFromPgn(p), [30000]);
  });

  test('gives null for a ply with no clock, and for the one after it', () => {
    const p = pgn('600', '1. e4 {[%clk 0:09:57]} 1... e5 2. Nf3 {[%clk 0:09:50]} 2... Nc6 {[%clk 0:09:40]} 1-0');
    // black ply 1 has no tag; black ply 3 has nothing to measure against.
    assert.deepEqual(L.thinkTimesFromPgn(p), [3000, null, 7000, null]);
  });

  test('handles castling and promotion without losing its place', () => {
    const p = pgn('600', '1. O-O {[%clk 0:09:58]} 1... e8=Q+ {[%clk 0:09:56]} 2. O-O-O {[%clk 0:09:54]} 1-0');
    assert.deepEqual(L.thinkTimesFromPgn(p), [2000, 4000, 4000]);
  });

  test('discards a clock that goes backwards', () => {
    const p = pgn('600', '1. e4 {[%clk 0:09:57]} 1... e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:59]} 1-0');
    assert.deepEqual(L.thinkTimesFromPgn(p), [3000, 5000, null]);
  });

  test('without a time control the first move of each side is unknowable', () => {
    const p = pgn(null, '1. e4 {[%clk 0:09:57]} 1... e5 {[%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} 2... Nc6 {[%clk 0:09:45]} 1-0');
    assert.deepEqual(L.thinkTimesFromPgn(p), [null, null, 7000, 10000]);
  });

  test('ignores move numbers, results and annotations', () => {
    const p = pgn('600', '1. e4! {[%clk 0:09:57]} 1... e5?! $2 {[%clk 0:09:55]} 1/2-1/2');
    assert.deepEqual(L.thinkTimesFromPgn(p), [3000, 5000]);
  });

  test('survives rubbish', () => {
    assert.deepEqual(L.thinkTimesFromPgn(null), []);
    assert.deepEqual(L.thinkTimesFromPgn(''), []);
    assert.deepEqual(L.thinkTimesFromPgn(pgn('600', '1-0')), []);
  });
});
