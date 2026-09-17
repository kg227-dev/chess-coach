/* A compact opening book. Not exhaustive — it covers the lines a club player
   actually reaches, which is enough to stop the engine docking you accuracy
   for playing normal theory. Every line is validated legal by the test suite. */
(function (root) {
'use strict';

var LINES = [
  // --- 1.e4 e5 ---
  ['Italian Game',            'e4 e5 Nf3 Nc6 Bc4'],
  ['Giuoco Piano',            'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4'],
  ['Two Knights Defence',     'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5'],
  ['Evans Gambit',            'e4 e5 Nf3 Nc6 Bc4 Bc5 b4'],
  ['Ruy Lopez',               'e4 e5 Nf3 Nc6 Bb5'],
  ['Ruy Lopez, Morphy',       'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1'],
  ['Ruy Lopez, Berlin',       'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4'],
  ['Ruy Lopez, Exchange',     'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6'],
  ['Scotch Game',             'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nc3'],
  ['Four Knights Game',       'e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5'],
  ['Petrov Defence',          'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4'],
  ['Philidor Defence',        'e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6'],
  ["King's Gambit",           'e4 e5 f4 exf4 Nf3'],
  ['Vienna Game',             'e4 e5 Nc3 Nf6 f4'],
  ["Bishop's Opening",        'e4 e5 Bc4 Nf6 d3'],

  // --- Sicilian ---
  ['Sicilian Defence',        'e4 c5'],
  ['Open Sicilian',           'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3'],
  ['Sicilian, Najdorf',       'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5'],
  ['Sicilian, Dragon',        'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7'],
  ['Sicilian, Classical',     'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5'],
  ['Sicilian, Sveshnikov',    'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6'],
  ['Accelerated Dragon',      'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 Nc3 Bg7'],
  ['Sicilian, Taimanov',      'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7'],
  ['Sicilian, Alapin',        'e4 c5 c3 Nf6 e5 Nd5 d4'],
  ['Closed Sicilian',         'e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7'],
  ['Sicilian, Rossolimo',     'e4 c5 Nf3 Nc6 Bb5 g6'],
  ['Smith-Morra Gambit',      'e4 c5 d4 cxd4 c3'],

  // --- French / Caro-Kann / others vs 1.e4 ---
  ['French Defence',          'e4 e6 d4 d5'],
  ['French, Advance',         'e4 e6 d4 d5 e5 c5 c3 Nc6'],
  ['French, Tarrasch',        'e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7'],
  ['French, Winawer',         'e4 e6 d4 d5 Nc3 Bb4 e5 c5'],
  ['French, Classical',       'e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7'],
  ['French, Exchange',        'e4 e6 d4 d5 exd5 exd5'],
  ['Caro-Kann Defence',       'e4 c6 d4 d5'],
  ['Caro-Kann, Advance',      'e4 c6 d4 d5 e5 Bf5 Nf3 e6'],
  ['Caro-Kann, Classical',    'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6'],
  ['Caro-Kann, Exchange',     'e4 c6 d4 d5 exd5 cxd5 Bd3'],
  ['Scandinavian Defence',    'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6'],
  ['Pirc Defence',            'e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7'],
  ['Modern Defence',          'e4 g6 d4 Bg7 Nc3 d6'],
  ['Alekhine Defence',        'e4 Nf6 e5 Nd5 d4 d6 Nf3'],

  // --- 1.d4 ---
  ["Queen's Gambit",          'd4 d5 c4'],
  ["Queen's Gambit Declined", 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7'],
  ["Queen's Gambit Accepted", 'd4 d5 c4 dxc4 Nf3 Nf6 e3'],
  ['Slav Defence',            'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4'],
  ['Semi-Slav Defence',       'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3'],
  ['London System',           'd4 d5 Bf4 Nf6 e3 e6 Nf3'],
  ['Trompowsky Attack',       'd4 Nf6 Bg5 Ne4 Bf4'],
  ["King's Indian Defence",   'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6'],
  ['Nimzo-Indian Defence',    'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O'],
  ["Queen's Indian Defence",  'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7'],
  ['Bogo-Indian Defence',     'd4 Nf6 c4 e6 Nf3 Bb4+'],
  ['Grünfeld Defence',        'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5'],
  ['Catalan Opening',         'd4 Nf6 c4 e6 g3 d5 Bg2'],
  ['Benoni Defence',          'd4 Nf6 c4 c5 d5 e6 Nc3 exd5'],
  ['Benko Gambit',            'd4 Nf6 c4 c5 d5 b5'],
  ['Budapest Gambit',         'd4 Nf6 c4 e5 dxe5 Ng4'],
  ['Dutch Defence',           'd4 f5 g3 Nf6 Bg2 e6'],

  // --- flank ---
  ['English Opening',         'c4'],
  ['English, Symmetrical',    'c4 c5 Nf3 Nf6 Nc3 Nc6'],
  ['English, Reversed Sicilian', 'c4 e5 Nc3 Nf6 Nf3 Nc6'],
  ['Réti Opening',            'Nf3 d5 c4 e6 g3'],
  ["King's Indian Attack",    'Nf3 d5 g3 Nf6 Bg2 e6 O-O'],
  ["Bird's Opening",          'f4 d5 Nf3 Nf6'],
];

var BOOK = LINES.map(function (l) { return { name: l[0], moves: l[1].split(' ') }; });

function isPrefix(sans, moves) {
  if (sans.length > moves.length) return false;
  for (var i = 0; i < sans.length; i++) if (sans[i] !== moves[i]) return false;
  return true;
}

/* True while the game is still following some known line. */
function isBook(sans) {
  if (!sans || !sans.length) return true;
  for (var i = 0; i < BOOK.length; i++) if (isPrefix(sans, BOOK[i].moves)) return true;
  return false;
}

/* The most specific named opening the game has actually reached. */
function openingName(sans) {
  if (!sans || !sans.length) return null;
  var best = null;
  for (var i = 0; i < BOOK.length; i++) {
    var m = BOOK[i].moves;
    if (m.length <= sans.length && isPrefix(m, sans.slice(0, m.length))) {
      if (!best || m.length > best.len) best = { name: BOOK[i].name, len: m.length };
    }
  }
  // Still inside a line we haven't finished: name the shortest line we match.
  if (!best) {
    for (var j = 0; j < BOOK.length; j++) {
      if (isPrefix(sans, BOOK[j].moves)) {
        if (!best || BOOK[j].moves.length < best.len) best = { name: BOOK[j].name, len: BOOK[j].moves.length };
      }
    }
  }
  return best ? best.name : null;
}

var API = { LINES: BOOK, isBook: isBook, openingName: openingName };
if (typeof module === 'object' && module.exports) module.exports = API;
if (root) root.CoachBook = API;

})(typeof globalThis !== 'undefined' ? globalThis : this);
