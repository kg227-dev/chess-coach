/* Chess Coach — play a bot, get Stockfish feedback on every move,
   take moves back, and track accuracy game over game.
   All scoring maths lives in logic.js so it can be unit tested. */
(() => {
'use strict';

const L = window.CoachLogic;
const ENGINE_URL = 'vendor/stockfish.js';
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };  // fallback only
const PIECES_URL = 'pieces.svg';

// Cburnett piece set, inlined once so every board piece is a <use> reference.
async function loadPieces() {
  try {
    const svg = await (await fetch(PIECES_URL)).text();
    const host = document.createElement('div');
    host.id = 'piece-sprite';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    host.innerHTML = svg;
    document.body.appendChild(host);
    return true;
  } catch (e) {
    console.warn('[pieces] sprite unavailable, falling back to text glyphs:', e.message);
    return false;
  }
}

let spriteReady = false;

function pieceMarkup(color, type, cls) {
  const klass = cls || 'piece';
  if (!spriteReady) return `<span class="${klass} txt ${color}">${GLYPH[type]}</span>`;
  return `<svg class="${klass}" viewBox="0 0 40 40" aria-hidden="true"><use href="#${color}${type}"></use></svg>`;
}
const STORE_KEY = 'chesscoach.games.v1';
const PUZZLE_KEY = 'chesscoach.puzzles.v1';
const OPENING_KEY = 'chesscoach.openings.v1';
const BOOK = window.CoachBook;
const SETTINGS_KEY = 'chesscoach.settings.v1';

const DEFAULTS = {
  depth: 12,        // analysis depth
  botMs: 450,       // bot think time
  showEval: true,   // eval bar visible during play
  showArrows: true, // draw arrows when the answer is revealed
  timeMin: 10,      // clock per side, 0 = unlimited
  retryCap: 3,      // take-backs before the answer is shown
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(CFG)); } catch (e) { /* quota */ }
}
const CFG = loadSettings();

/* ==========================================================================
   Engine — UCI worker with a serialised search queue
   ========================================================================== */

class Engine {
  constructor(worker) {
    this.w = worker;
    this.ready = new Promise((res) => { this._ready = res; });
    this.chain = Promise.resolve();
    this.cur = null;
    this.opts = {};
    this.w.onmessage = (e) => {
      this._line(typeof e.data === 'string' ? e.data : (e.data && e.data.line) || '');
    };
    this.failed = new Promise((_, rej) => { this._fail = rej; });
    this.failed.catch(() => {});   // nothing to warn about if no one is racing it
    this.w.onerror = (e) => {
      console.error('[engine]', e.message || e);
      this._fail(new Error(e.message || 'worker blocked'));
    };
    this.w.postMessage('uci');
  }

  _line(l) {
    if (l === 'uciok') { this._ready(); return; }
    if (!this.cur) return;
    if (l.startsWith('info')) {
      const i = L.parseInfo(l);
      if (i.pv && (i.cp !== undefined || i.mate !== undefined)) {
        const prev = this.cur.pvs[i.multipv];
        if (!prev || (i.depth || 0) >= (prev.depth || 0)) this.cur.pvs[i.multipv] = i;
      }
    } else if (l.startsWith('bestmove')) {
      const bm = l.split(/\s+/)[1];
      const c = this.cur;
      this.cur = null;
      clearTimeout(c.timer);
      c.resolve({ bestmove: bm && bm !== '(none)' ? bm : null, pvs: c.pvs });
    }
  }

  _set(name, value) {
    if (this.opts[name] === value) return;
    this.opts[name] = value;
    this.w.postMessage(`setoption name ${name} value ${value}`);
  }

  // `depth` for analysis (evals only compare at equal depth), `movetime` for the bot.
  search(fen, { movetime = null, depth = null, multipv = 1, skill = null } = {}) {
    this.chain = this.chain.then(() => new Promise(async (resolve) => {
      await this.ready;
      this._set('MultiPV', multipv);
      if (skill !== null) this._set('Skill Level', skill);
      this.cur = { pvs: {}, resolve };
      const budget = depth ? depth * 2000 + 8000 : (movetime || 800) + 6000;
      this.cur.timer = setTimeout(() => {
        if (this.cur) {
          const c = this.cur; this.cur = null;
          this.w.postMessage('stop');
          c.resolve({ bestmove: null, pvs: c.pvs });
        }
      }, budget);
      this.w.postMessage('position fen ' + fen);
      this.w.postMessage(depth ? 'go depth ' + depth : 'go movetime ' + (movetime || 800));
    }));
    return this.chain;
  }
}

/* ==========================================================================
   State
   ========================================================================== */

const S = {
  chess: new Chess(),
  me: 'w',
  flip: false,
  engine: null,
  botLevel: 'casual',
  reviewMode: 'every',
  playing: false,
  locked: true,
  resigned: false,
  flagged: null,
  pre: null,
  preFen: null,
  scored: {},
  curve: [],
  retries: 0,
  retryAt: {},     // ply -> take-backs used
  revealed: {},    // ply -> answer has been shown
  lastMove: null,
  sel: null,
  legal: [],
  drag: null,
  pendingPromo: null,
  mode: 'game',      // 'game' | 'puzzle' | 'opening'
  puzzle: null,
  trainer: null,
  opening: null,
};

const analyse = (fen, opts = {}) => S.engine.search(fen, Object.assign({ skill: 20, depth: CFG.depth }, opts));
// Full-strength search with candidates; the weakening happens in chooseBotMove,
// so the bot plays a plausible move rather than a randomly broken one.
const botSearch = (fen) => {
  const lvl = L.botLevel(S.botLevel);
  return S.engine.search(fen, { skill: 20, depth: lvl.depth, multipv: 5 });
};

/* ==========================================================================
   Clock
   ========================================================================== */

const Clock = {
  ms: { w: 0, b: 0 },
  running: null,
  last: 0,
  timer: null,

  enabled() { return CFG.timeMin > 0; },

  reset() {
    const total = CFG.timeMin * 60000;
    this.ms.w = this.ms.b = total;
    this._halt();
    renderClocks();
  },
  start(color) {
    if (!this.enabled() || !S.playing) return;
    this._halt();
    this.running = color;
    this.last = performance.now();
    this.timer = setInterval(() => this._tick(), 200);
    renderClocks();
  },
  stop() { this._halt(); renderClocks(); },

  _halt() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) { this._drain(); this.running = null; }
  },
  _drain() {
    const now = performance.now();
    this.ms[this.running] = Math.max(0, this.ms[this.running] - (now - this.last));
    this.last = now;
  },
  _tick() {
    if (!this.running) return;
    this._drain();
    if (this.ms[this.running] <= 0) {
      const flagged = this.running;
      this._halt();
      renderClocks();
      S.flagged = flagged;
      endGame();
      return;
    }
    renderClocks();
  },
};

function renderClocks() {
  const set = (el, color) => {
    if (!el) return;
    el.textContent = L.fmtClock(Clock.ms[color]);
    el.classList.toggle('active', Clock.running === color);
    el.classList.toggle('low', Clock.ms[color] < 30000);
  };
  set(document.querySelector('#playerTop .pclock'), S.me === 'w' ? 'b' : 'w');
  set(document.querySelector('#playerBottom .pclock'), S.me);
}

/* ==========================================================================
   Board rendering
   ========================================================================== */

const boardEl = $('board');
const arrowsEl = $('arrows');
let squareEls = {};

function buildBoard() {
  boardEl.innerHTML = '';
  squareEls = {};
  L.boardSquares(S.flip).forEach((sq, idx) => {
    const el = document.createElement('div');
    el.className = 'sq ' + (L.isLightSquare(sq) ? 'light' : 'dark');
    el.dataset.sq = sq;
    if (idx % 8 === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
    if (idx >= 56) el.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
    boardEl.appendChild(el);
    squareEls[sq] = el;
  });
  sizeBoard();
}

function sizeBoard() {
  const vw = window.innerWidth;
  let sq;
  if (vw <= 700) {
    // Phone: the board fills the width and the panel scrolls beneath it.
    const gutters = 16;                       // .main side padding
    const evalW = CFG.showEval ? 24 : 0;      // eval bar + gap
    sq = Math.floor((vw - gutters - evalW) / 8);
  } else {
    const main = document.querySelector('.main');
    const mainW = (main ? main.clientWidth : vw) - 40;
    const stacked = vw <= 900;
    const byWidth = mainW - (stacked ? 0 : 352) - 32;
    const byHeight = window.innerHeight - (stacked ? 300 : 250);
    sq = Math.floor(Math.min(byWidth, byHeight, 680) / 8);
  }
  document.documentElement.style.setProperty('--sq', Math.max(30, sq) + 'px');
}

function render() {
  const board = S.chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = 'abcdefgh'[f] + (8 - r);
      const el = squareEls[sq];
      if (!el) continue;
      el.querySelectorAll('.piece, .dot, .ring').forEach((n) => n.remove());
      el.classList.remove('hl', 'sel', 'check');
      const p = board[r][f];
      if (p) el.insertAdjacentHTML('beforeend', pieceMarkup(p.color, p.type));
    }
  }

  if (S.lastMove) {
    squareEls[S.lastMove.from]?.classList.add('hl');
    squareEls[S.lastMove.to]?.classList.add('hl');
  }
  if (S.sel) squareEls[S.sel]?.classList.add('sel');

  for (const m of S.legal) {
    const el = squareEls[m.to];
    if (!el) continue;
    const d = document.createElement('div');
    d.className = (m.captured || m.flags.includes('e')) ? 'ring' : 'dot';
    el.appendChild(d);
  }

  if (S.chess.in_check()) {
    const turn = S.chess.turn();
    for (const sq in squareEls) {
      const p = S.chess.get(sq);
      if (p && p.type === 'k' && p.color === turn) squareEls[sq].classList.add('check');
    }
  }

  renderPlayers();
}

function playerStrip(name, color, captured, diff) {
  const adv = color === 'w' ? diff : -diff;
  const counts = {};
  captured.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
  const oppClass = color === 'w' ? 'b' : 'w';
  const glyphs = ['p', 'n', 'b', 'r', 'q']
    .filter((t) => counts[t])
    .map((t) => `<span class="takengroup">${
      Array.from({ length: counts[t] }, () => pieceMarkup(oppClass, t, 'taken')).join('')}</span>`)
    .join('');
  return `
    <div class="pavatar ${color}">${GLYPH.p}</div>
    <div class="pinfo">
      <div class="pname">${name}</div>
      <div class="ptaken">${glyphs}${adv > 0 ? `<span class="padv">+${adv}</span>` : ''}</div>
    </div>
    ${Clock.enabled() ? '<span class="pclock">--:--</span>' : ''}`;
}

function renderPlayers() {
  const { capturedBy, diff } = L.materialFromHistory(S.chess.history({ verbose: true }));
  const topColor = S.me === 'w' ? 'b' : 'w';
  const label = $('botLevel').options[$('botLevel').selectedIndex].textContent;
  $('playerTop').innerHTML = playerStrip(label, topColor, capturedBy[topColor], diff);
  $('playerBottom').innerHTML = playerStrip('You', S.me, capturedBy[S.me], diff);
  renderClocks();
}

function drawArrows(list) {
  arrowsEl.innerHTML = '';
  if (!CFG.showArrows) return;
  const NS = 'http://www.w3.org/2000/svg';
  list.forEach(({ uci, color, width = 0.13, opacity = 0.9 }) => {
    if (!uci || uci.length < 4) return;
    const a = L.squareToXY(uci.slice(0, 2), S.flip);
    const b = L.squareToXY(uci.slice(2, 4), S.flip);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const tx = b.x - ux * 0.1, ty = b.y - uy * 0.1;
    const bx = tx - ux * 0.3, by = ty - uy * 0.3;
    const px = -uy, py = ux, hw = 0.15;

    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', bx); line.setAttribute('y2', by);
    line.setAttribute('stroke', color); line.setAttribute('stroke-width', width);
    line.setAttribute('stroke-linecap', 'round'); line.setAttribute('opacity', opacity);

    const tri = document.createElementNS(NS, 'polygon');
    tri.setAttribute('points', `${tx},${ty} ${bx + px * hw},${by + py * hw} ${bx - px * hw},${by - py * hw}`);
    tri.setAttribute('fill', color); tri.setAttribute('opacity', opacity);

    arrowsEl.appendChild(line);
    arrowsEl.appendChild(tri);
  });
}

const clearArrows = () => { arrowsEl.innerHTML = ''; };

// Slide the piece from where it came instead of teleporting it. Runs after the
// board has been repainted, so it never fights the render.
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateMove(from, to) {
  if (REDUCED_MOTION || !from || !to) return;
  const fromEl = squareEls[from], toEl = squareEls[to];
  if (!fromEl || !toEl) return;
  const piece = toEl.querySelector('.piece');
  if (!piece) return;
  const dx = fromEl.offsetLeft - toEl.offsetLeft;
  const dy = fromEl.offsetTop - toEl.offsetTop;
  if (!dx && !dy) return;
  piece.style.transition = 'none';
  piece.style.transform = `translate(${dx}px, ${dy}px)`;
  // Two frames, not a forced reflow: getBoundingClientRect() does NOT flush a
  // style recalc on an SVG element, so both writes coalesce and nothing moves.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    piece.style.transition = 'transform 170ms cubic-bezier(.22,.61,.36,1)';
    piece.style.transform = 'translate(0, 0)';
    setTimeout(() => { piece.style.transition = ''; piece.style.transform = ''; }, 240);
  }));
}

/* ==========================================================================
   Input
   ========================================================================== */

function myTurn() {
  return S.playing && !S.locked && S.chess.turn() === S.me && !S.chess.game_over();
}

function selectSquare(sq) {
  const p = S.chess.get(sq);
  if (!p || p.color !== S.me) return false;
  S.sel = sq;
  S.legal = S.chess.moves({ square: sq, verbose: true });
  render();
  return true;
}

function clearSelection() { S.sel = null; S.legal = []; }

function tryMove(from, to) {
  const cand = S.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!cand.length) return false;
  if (cand.some((m) => m.flags.includes('p'))) {
    S.pendingPromo = { from, to };
    showPromo();
    return true;
  }
  clearSelection();
  playUserMove({ from, to });
  return true;
}

boardEl.addEventListener('pointerdown', (e) => {
  if (!myTurn()) return;
  S.draggedMove = false;
  const el = e.target.closest('.sq');
  if (!el) return;
  const sq = el.dataset.sq;

  if (S.sel && S.sel !== sq && tryMove(S.sel, sq)) return;

  const p = S.chess.get(sq);
  if (!p || p.color !== S.me) { clearSelection(); render(); return; }

  selectSquare(sq);

  const pieceEl = el.querySelector('.piece');
  if (!pieceEl) return;
  const ghost = pieceEl.cloneNode(true);
  ghost.classList.add('floating');
  ghost.style.display = 'none';
  document.body.appendChild(ghost);
  S.drag = { from: sq, ghost, moved: false, pieceEl };
  boardEl.setPointerCapture(e.pointerId);
});

boardEl.addEventListener('pointermove', (e) => {
  if (!S.drag) return;
  if (!S.drag.moved) {
    S.drag.moved = true;
    S.drag.ghost.style.display = '';
    S.drag.pieceEl.style.opacity = '0.25';
  }
  S.drag.ghost.style.left = e.clientX + 'px';
  S.drag.ghost.style.top = e.clientY + 'px';
});

boardEl.addEventListener('pointerup', (e) => {
  if (!S.drag) return;
  const d = S.drag; S.drag = null;
  d.ghost.remove();
  d.pieceEl.style.opacity = '';
  if (!d.moved) return;
  S.draggedMove = true;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  const el = target && target.closest ? target.closest('.sq') : null;
  if (!el || el.dataset.sq === d.from) return;
  if (!tryMove(d.from, el.dataset.sq)) { clearSelection(); render(); }
});

boardEl.addEventListener('pointercancel', () => {
  if (!S.drag) return;
  S.drag.ghost.remove();
  S.drag.pieceEl.style.opacity = '';
  S.drag = null;
});

function showPromo() {
  const el = $('promo');
  el.innerHTML = '';
  ['q', 'r', 'b', 'n'].forEach((t) => {
    const b = document.createElement('button');
    b.innerHTML = pieceMarkup(S.me, t, 'promopiece');
    b.onclick = () => {
      el.hidden = true;
      const pm = S.pendingPromo; S.pendingPromo = null;
      clearSelection();
      playUserMove({ from: pm.from, to: pm.to, promotion: t });
    };
    el.appendChild(b);
  });
  el.hidden = false;
}

/* ==========================================================================
   Game flow
   ========================================================================== */

function setStatus(html) { $('status').innerHTML = html; }

function updateEvalBar(cpWhite) {
  $('evalbar').hidden = !CFG.showEval;
  if (!CFG.showEval) return;
  $('evalFill').style.height = L.winPct(cpWhite) + '%';
  $('evalLabel').textContent = L.fmtEval(cpWhite, true);
}

async function newGame() {
  const choice = $('playColor').value;
  S.me = choice === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : choice;
  S.flip = S.me === 'b';
  S.botLevel = $('botLevel').value;
  S.reviewMode = $('reviewMode').value;

  S.mode = 'game'; S.puzzle = null; S.trainer = null; S.opening = null;
  S.chess = new Chess();
  S.scored = {}; S.curve = []; S.retries = 0; S.retryAt = {}; S.revealed = {};
  S.lastMove = null; S.pre = null; S.preFen = null;
  S.resigned = false; S.flagged = null;
  S.playing = true; S.locked = true;
  clearSelection(); clearArrows();
  $('gameover').hidden = true;
  $('review').hidden = true;
  $('promo').hidden = true;

  Clock.reset();
  buildBoard();
  render();
  updateStats();
  renderMoves();
  updateEvalBar(0);
  setStatus(`You are <b>${S.me === 'w' ? 'White' : 'Black'}</b>.`);

  if (S.chess.turn() === S.me) await beginUserTurn();
  else await botMove();
}

async function beginUserTurn() {
  if (S.chess.game_over()) return endGame();
  S.locked = false;
  clearArrows();
  setStatus('Your move.');
  Clock.start(S.me);
  const fen = S.chess.fen();
  S.preFen = fen;
  S.pre = analyse(fen, { multipv: 4 }).then((r) => {
    if (S.preFen === fen) {
      const cp = L.infoToCp(r.pvs[1]);
      if (cp !== null) {
        const cpWhite = S.chess.turn() === 'w' ? cp : -cp;
        updateEvalBar(cpWhite);
        S.curve = L.recordCurve(S.curve, S.chess.history().length, cpWhite);
      }
    }
    return r;
  });
}

async function playUserMove(move) {
  if (S.mode === 'puzzle') return playPuzzleMove(move);
  if (S.mode === 'opening') return playTrainerMove(move);
  const { from, to, promotion } = move;
  const ply = S.chess.history().length;
  const fenBefore = S.chess.fen();
  const mv = S.chess.move({ from, to, promotion: promotion || 'q' });
  if (!mv) return;

  Clock.stop();
  S.locked = true;
  S.lastMove = { from: mv.from, to: mv.to };
  clearSelection();
  render();
  if (!S.draggedMove) animateMove(mv.from, mv.to);
  S.draggedMove = false;
  renderMoves();

  // Opening theory isn't graded. The engine preferring one normal book move
  // over another says nothing about how well you played.
  const sansSoFar = S.chess.history();
  S.opening = (BOOK && BOOK.openingName(sansSoFar)) || S.opening;
  if (BOOK && BOOK.isBook(sansSoFar)) {
    S.scored[ply] = { acc: null, cls: 'Book', san: mv.san, cpLoss: 0, reason: '', fenBefore, bestSan: null,
      phase: L.phaseOf(fenBefore, ply), hung: null };
    updateStats();
    renderMoves();
    $('review').hidden = true;
    setStatus(`<b>Book</b>${S.opening ? ' — ' + S.opening : ''}`);
    if (S.chess.game_over()) return endGame();
    return botMove();
  }

  setStatus('Analysing…');

  const before = await (S.preFen === fenBefore && S.pre ? S.pre : analyse(fenBefore, { multipv: 4 }));
  const playedUci = mv.from + mv.to + (mv.promotion || '');
  const over = S.chess.game_over();
  const fenAfter = S.chess.fen();
  const args = {
    before, playedUci, gameOver: over, isCheckmate: S.chess.in_checkmate(),
    fenAfter, playedTo: mv.to, playedPiece: mv.piece, playedCaptured: mv.captured,
  };

  let res = L.scoreMove(args);
  if (!res && !over) {
    const after = await analyse(fenAfter, { multipv: 1 });
    res = L.scoreMove(Object.assign({}, args, { afterSearch: after }));
  }

  if (!res) {
    setStatus('Engine returned no evaluation for that position.');
    if (over) return endGame();
    return botMove();
  }

  const why = L.explainMove({
    fenBefore, fenAfter,
    playedLine: res.playedLine, bestUci: res.bestUci,
    cpLoss: res.cpLoss, cpBefore: res.cpBefore, cpAfterMine: res.cpAfterMine,
    playedCaptured: mv.captured,
  });
  const cpWhite = S.me === 'w' ? res.cpAfterMine : -res.cpAfterMine;

  if (S.scored[ply] === undefined) {
    S.scored[ply] = {
      acc: res.accuracy, cls: res.cls.key, san: mv.san, cpLoss: res.cpLoss,
      reason: why.problem || why.answer, fenBefore,
      bestSan: res.bestUci ? L.uciToSan(fenBefore, res.bestUci) : null,
      phase: L.phaseOf(fenBefore, ply),
      hung: why.hung || null,
    };
    if (res.cls.key === 'Mistake' || res.cls.key === 'Blunder') {
      capturePuzzle({ ply, mv, res, fenBefore });
    }
  }
  S.curve = L.recordCurve(S.curve, ply + 1, cpWhite);
  updateStats();
  renderMoves();
  updateEvalBar(cpWhite);

  const shouldReview = S.reviewMode === 'every'
    || (S.reviewMode === 'mistakes' && ['Inaccuracy', 'Mistake', 'Blunder'].includes(res.cls.key));

  if (shouldReview && !over) {
    showReview({ mv, res, before, fenBefore, ply, why });
  } else {
    $('review').hidden = true;
    if (over) return endGame();
    await botMove();
  }
}

function showReview({ mv, res, before, fenBefore, ply, why }) {
  const el = $('review');
  const tries = S.retryAt[ply] || 0;
  const revealed = !!S.revealed[ply] || tries >= CFG.retryCap || res.cls.key === 'Best' || res.cls.key === 'Brilliant';
  const lines = [1, 2, 3].map((i) => before.pvs[i]).filter((i) => i && i.pv);
  const bestUci = lines[0] ? lines[0].pv[0] : null;

  const answerBlock = revealed
    ? `${why.answer ? `<div class="reason answer">${why.answer}</div>` : ''}
       <div class="best-label">Engine's top choices</div>
       <ol class="best-list">${lines.map((info, idx) => `
         <li><span class="mv">${idx === 0 ? '★ ' : ''}${L.uciToSan(fenBefore, info.pv[0])}</span>
             <span class="ev">${L.fmtEval(L.infoToCp(info), true)}</span>
             <span class="ln">${L.pvToSan(fenBefore, info.pv, 5)}</span></li>`).join('')}</ol>`
    : `<div class="hidden-answer">Answer hidden — try to find it yourself.
         ${CFG.retryCap - tries} ${CFG.retryCap - tries === 1 ? 'try' : 'tries'} left before it's shown.</div>`;

  const canRetry = res.cls.key !== 'Best' && res.cls.key !== 'Brilliant';

  el.innerHTML = `
    <div class="review-head">
      <span class="badge" style="background:${res.cls.color}">${res.cls.icon}</span>
      <div>
        <div class="review-title" style="color:${res.cls.color}">${res.cls.key}</div>
        <div class="review-sub">You played <b>${mv.san}</b> · ${
          res.cpLoss < 5 ? 'no loss' : 'gave up ' + (res.cpLoss / 100).toFixed(2) + ' pawns'
        } · ${res.accuracy.toFixed(0)}% accurate</div>
      </div>
    </div>
    ${why.problem ? `<div class="reason">${why.problem}</div>` : ''}
    ${answerBlock}
    <div class="review-actions">
      ${canRetry ? '<button class="btn" id="btnRetry">↶ Take back &amp; retry</button>' : ''}
      ${!revealed ? '<button class="btn" id="btnShow">Show best</button>' : ''}
      <button class="btn btn-primary" id="btnContinue">Continue →</button>
    </div>`;
  el.hidden = false;

  drawArrows(revealed && bestUci && !L.sameMove(bestUci, mv.from + mv.to)
    ? [{ uci: mv.from + mv.to, color: res.cls.color, width: 0.11, opacity: 0.85 },
       { uci: bestUci, color: '#26c2a3', width: 0.14, opacity: 0.95 }]
    : [{ uci: mv.from + mv.to, color: res.cls.color, width: 0.11, opacity: 0.85 }]);

  setStatus(`<b>${res.cls.key}</b> — ${canRetry ? 'take it back and try again, or continue.' : 'nicely done.'}`);

  const btnShow = $('btnShow');
  if (btnShow) btnShow.onclick = () => {
    S.revealed[ply] = true;
    showReview({ mv, res, before, fenBefore, ply, why });
  };

  const btnRetry = $('btnRetry');
  if (btnRetry) btnRetry.onclick = () => {
    S.chess.undo();
    S.retries++;
    S.retryAt[ply] = (S.retryAt[ply] || 0) + 1;
    if (S.retryAt[ply] >= CFG.retryCap) S.revealed[ply] = true;
    S.lastMove = null;
    el.hidden = true;
    render(); renderMoves(); updateStats();
    updateEvalBar(S.me === 'w' ? res.cpBefore : -res.cpBefore);
    // Only hand over the arrow once the answer is out.
    drawArrows(S.revealed[ply] && bestUci ? [{ uci: bestUci, color: 'rgba(38,194,163,.55)', width: 0.12 }] : []);
    S.locked = false;
    S.preFen = S.chess.fen();
    S.pre = Promise.resolve(before);
    Clock.start(S.me);
    setStatus(S.revealed[ply]
      ? "Try again — the teal arrow is the engine's pick."
      : `Try again — ${CFG.retryCap - S.retryAt[ply]} more before the answer shows.`);
  };

  $('btnContinue').onclick = async () => {
    el.hidden = true;
    clearArrows();
    if (S.chess.game_over()) return endGame();
    await botMove();
  };
}

async function botMove() {
  if (S.chess.game_over()) return endGame();
  S.locked = true;
  setStatus('Bot is thinking…');
  Clock.start(S.me === 'w' ? 'b' : 'w');
  const lvl = L.botLevel(S.botLevel);
  // A shallow search returns instantly; pause anyway so moves don't teleport.
  const [r] = await Promise.all([
    botSearch(S.chess.fen()),
    new Promise((res) => setTimeout(res, CFG.botMs)),
  ]);
  Clock.stop();
  if (!S.playing) return;                    // flagged or resigned while thinking
  let uci = L.chooseBotMove(r.pvs, lvl) || r.bestmove;
  if (!uci) {
    const ms = S.chess.moves({ verbose: true });
    if (!ms.length) return endGame();
    const pick = ms[Math.floor(Math.random() * ms.length)];
    uci = pick.from + pick.to + (pick.promotion || '');
  }
  const mv = S.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  if (mv) S.lastMove = { from: mv.from, to: mv.to };
  render();
  if (mv) animateMove(mv.from, mv.to);
  renderMoves();
  if (S.chess.game_over()) return endGame();
  await beginUserTurn();
}

function endGame() {
  S.playing = false;
  S.locked = true;
  Clock.stop();
  clearArrows();

  let title = 'Game over', sub = '';
  if (S.flagged) {
    const iFlagged = S.flagged === S.me;
    title = iFlagged ? 'Time out' : 'Bot flagged';
    sub = iFlagged ? 'Your clock ran out.' : "The bot's clock ran out — you win on time.";
  }
  else if (S.resigned) { title = 'Resigned'; sub = 'You ended the game early.'; }
  else if (S.chess.in_checkmate()) {
    const youWon = S.chess.turn() !== S.me;
    title = youWon ? 'You win!' : 'Checkmate';
    sub = youWon ? 'You delivered mate.' : 'The bot mated you.';
  }
  else if (S.chess.in_stalemate()) { title = 'Stalemate'; sub = 'Draw — no legal moves.'; }
  else if (S.chess.in_threefold_repetition()) { title = 'Draw'; sub = 'Threefold repetition.'; }
  else if (S.chess.insufficient_material()) { title = 'Draw'; sub = 'Insufficient material.'; }
  else if (S.chess.in_draw()) { title = 'Draw'; sub = '50-move rule.'; }

  const recs = Object.values(S.scored).filter((r) => typeof r.acc === 'number');
  const overall = L.gameAccuracy(recs);

  if (overall !== null) {
    saveGame({
      date: Date.now(), accuracy: +overall.toFixed(1), moves: recs.length,
      retries: S.retries, skill: L.botLevel(S.botLevel).label, result: title,
      breakdown: Object.keys(S.scored).sort((a, b) => a - b).map((k) => {
        const r = S.scored[k];
        return { phase: r.phase, cls: r.cls, acc: r.acc, cpLoss: r.cpLoss, hung: r.hung || null };
      }),
    });
    renderProgress();
  }
  renderPostGame();

  const go = $('gameover');
  go.innerHTML = `<h2>${title}</h2><p>${sub}</p>
    ${overall === null ? '' : `<p style="color:var(--green);font-size:20px;font-weight:700">${overall.toFixed(1)}% accuracy</p>
    <p>${recs.length} moves · ${S.retries} take-back${S.retries === 1 ? '' : 's'}</p>`}
    <button class="btn btn-primary" id="goNew">New game</button>`;
  go.hidden = false;
  $('goNew').onclick = newGame;
  setStatus(`<b>${title}</b>${overall === null ? '' : ` — ${overall.toFixed(1)}% accuracy this game.`}`);
}

/* ==========================================================================
   Panels
   ========================================================================== */

const CLS_COLOR = {
  Book: 'var(--c-book)',
  Brilliant: 'var(--c-brilliant)', Best: 'var(--c-best)', Excellent: 'var(--c-excellent)',
  Good: 'var(--c-good)', Inaccuracy: 'var(--c-inaccuracy)', Mistake: 'var(--c-mistake)',
  Blunder: 'var(--c-blunder)',
};

function updateStats() {
  const recs = Object.values(S.scored);
  const graded = recs.filter((r) => typeof r.acc === 'number');
  const avg = L.gameAccuracy(recs);
  $('accNow').textContent = avg === null ? '—' : avg.toFixed(1) + '%';
  $('moveCount').textContent = graded.length;
  $('retryCount').textContent = S.retries;
}

function renderMoves() {
  const hist = S.chess.history({ verbose: true });
  const rows = [];
  for (let i = 0; i < hist.length; i += 2) {
    const cell = (idx) => {
      const h = hist[idx];
      if (!h) return '<span class="mcell"></span>';
      const rec = S.scored[idx];
      const tag = rec ? `<span class="tag" style="background:${CLS_COLOR[rec.cls] || 'transparent'}"></span>` : '';
      return `<span class="mcell"><span class="san">${h.san}</span>${tag}</span>`;
    };
    rows.push(`<div class="mrow"><span class="mno">${i / 2 + 1}.</span>${cell(i)}${cell(i + 1)}</div>`);
  }
  const ml = $('movelist');
  ml.innerHTML = rows.join('') || '<div class="empty">No moves yet.</div>';
  ml.scrollTop = ml.scrollHeight;
}

function evalGraph(curve) {
  if (curve.length < 2) return '';
  const W = 100, H = 34, CAP = 600;
  const pts = curve.map((p, i) => {
    const x = (i / (curve.length - 1)) * W;
    const v = Math.max(-CAP, Math.min(CAP, p.cpWhite));
    return `${x.toFixed(2)},${(H / 2 - (v / CAP) * (H / 2)).toFixed(2)}`;
  });
  return `<svg class="evalgraph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="#e9e7e2"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#fff" stroke-width="0.5"/>
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="rgba(129,182,76,.9)" stroke-width="0.4" stroke-dasharray="2 2"/>
  </svg>`;
}

function renderPostGame() {
  const el = $('review');
  const recs = Object.keys(S.scored).sort((a, b) => a - b).map((k) => Object.assign({ ply: +k }, S.scored[k]));
  if (!recs.length) { el.hidden = true; return; }

  const counts = {};
  recs.forEach((r) => { counts[r.cls] = (counts[r.cls] || 0) + 1; });
  const chips = ['Book', 'Brilliant', 'Best', 'Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Blunder']
    .filter((k) => counts[k])
    .map((k) => `<span class="chip"><i style="background:${CLS_COLOR[k]}"></i>${counts[k]} ${k}</span>`).join('');

  const worst = recs.filter((r) => ['Inaccuracy', 'Mistake', 'Blunder'].includes(r.cls))
    .sort((a, b) => b.cpLoss - a.cpLoss).slice(0, 6);
  const rows = worst.map((r) => `
    <li><span class="mv" style="color:${CLS_COLOR[r.cls]}">${Math.floor(r.ply / 2) + 1}. ${r.san}</span>
        <span class="ev" style="color:${CLS_COLOR[r.cls]}">−${(r.cpLoss / 100).toFixed(1)}</span>
        <span class="ln">${r.reason || (r.bestSan ? 'Best was ' + r.bestSan : '')}</span></li>`).join('');

  el.innerHTML = `
    <div class="review-title" style="margin-bottom:8px">Game review</div>
    ${evalGraph(S.curve)}
    <div class="chips">${chips}</div>
    ${worst.length
      ? `<div class="best-label">Biggest mistakes</div><ol class="best-list">${rows}</ol>`
      : '<div class="reason">No inaccuracies — clean game.</div>'}`;
  el.hidden = false;
}

/* ==========================================================================
   Puzzles built from your own mistakes
   ========================================================================== */

function loadPuzzles() {
  try { return JSON.parse(localStorage.getItem(PUZZLE_KEY) || '[]'); } catch (e) { return []; }
}
function savePuzzles(list) {
  try { localStorage.setItem(PUZZLE_KEY, JSON.stringify(list.slice(-200))); } catch (e) { /* quota */ }
}

/* Saved two plies before the mistake, so replaying it means spotting the
   problem before it arrives rather than being handed the critical position. */
function capturePuzzle({ ply, mv, res, fenBefore }) {
  const sans = S.chess.history();
  // Too early to rewind: a puzzle starting from move one isn't a puzzle.
  const back = ply >= 4 ? 2 : 0;
  const p = L.puzzleStart(sans, ply, back);
  if (!p) return;
  const list = loadPuzzles();
  // Identity is where you went wrong, not where the puzzle starts — two
  // different mistakes can rewind to the same position.
  if (list.some((x) => x.fenMistake === fenBefore)) return;
  list.push({
    id: 'pz' + Date.now() + '_' + ply,
    fenStart: p.fenStart,
    fenMistake: fenBefore,
    userMoves: p.userMoves,
    // The moves actually played from the start position back into the mistake,
    // so replaying them reproduces the real position rather than an engine line.
    line: sans.slice(p.startPly, ply),
    playedSan: mv.san,
    cls: res.cls.key,
    cpLoss: Math.round(res.cpLoss),
    bestSan: res.bestUci ? L.uciToSan(fenBefore, res.bestUci) : null,
    created: Date.now(),
    solves: 0,
    lapses: 0,
    interval: 0,
    due: Date.now(),
    retired: false,
  });
  savePuzzles(list);
}

function startPuzzle(rec) {
  S.mode = 'puzzle';
  S.puzzle = { rec, movesLeft: rec.userMoves, step: 0 };
  S.chess = new Chess(rec.fenStart);
  S.me = S.chess.turn();
  S.flip = S.me === 'b';
  S.playing = true;
  S.locked = false;
  S.scored = {}; S.curve = []; S.retries = 0; S.retryAt = {}; S.revealed = {};
  S.lastMove = null; S.resigned = false; S.flagged = null; S.opening = null;
  clearSelection(); clearArrows();
  $('gameover').hidden = true;
  $('promo').hidden = true;
  Clock.stop();

  buildBoard(); render(); renderMoves(); updateStats(); updateEvalBar(0);

  $('review').innerHTML = `
    <div class="review-title" style="margin-bottom:6px">Puzzle</div>
    <div class="reason">You went wrong with <b>${rec.playedSan}</b>${
      rec.userMoves > 1 ? ' a move from here' : ' in this position'}.
      Play the next ${rec.userMoves} move${rec.userMoves > 1 ? 's' : ''} without repeating it.</div>`;
  $('review').hidden = false;

  document.querySelector('[data-tab="game"]').click();
  setStatus(`<b>Puzzle</b> — you are ${S.me === 'w' ? 'White' : 'Black'}. Find the right plan.`);
}

async function playPuzzleMove({ from, to, promotion }) {
  const fenBefore = S.chess.fen();
  const mv = S.chess.move({ from, to, promotion: promotion || 'q' });
  if (!mv) return;

  S.locked = true;
  S.lastMove = { from: mv.from, to: mv.to };
  clearSelection();
  render();
  if (!S.draggedMove) animateMove(mv.from, mv.to);
  S.draggedMove = false;
  renderMoves();
  setStatus('Checking…');

  const before = await analyse(fenBefore, { multipv: 4 });
  const over = S.chess.game_over();
  const args = {
    before, playedUci: mv.from + mv.to + (mv.promotion || ''),
    gameOver: over, isCheckmate: S.chess.in_checkmate(),
    fenAfter: S.chess.fen(), playedTo: mv.to, playedPiece: mv.piece, playedCaptured: mv.captured,
  };
  let res = L.scoreMove(args);
  if (!res && !over) {
    const after = await analyse(S.chess.fen(), { multipv: 1 });
    res = L.scoreMove(Object.assign({}, args, { afterSearch: after }));
  }
  if (!res) { setStatus('No evaluation for that position.'); S.locked = false; return; }

  // Fail only on a real mistake — plenty of reasonable moves exist on the way in.
  if (res.cpLoss >= 100) return showPuzzleResult(false, mv, res, fenBefore);

  const script = S.puzzle.rec.line || [];
  const scriptIdx = S.puzzle.step * 2;
  const followedLine = script[scriptIdx] === mv.san;
  S.puzzle.step++;
  S.puzzle.movesLeft--;
  if (S.puzzle.movesLeft <= 0 || over) return showPuzzleResult(true, mv, res, fenBefore);

  setStatus('Good — the opponent replies.');
  let replied = null;
  if (followedLine && script[scriptIdx + 1]) {
    replied = S.chess.move(script[scriptIdx + 1]);   // the reply from the real game
  }
  if (!replied) {
    const r = await S.engine.search(S.chess.fen(), { skill: 20, movetime: 500, multipv: 1 });
    if (r.bestmove) {
      replied = S.chess.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: r.bestmove[4] || 'q' });
    }
  }
  if (replied) S.lastMove = { from: replied.from, to: replied.to };
  render();
  if (replied) animateMove(replied.from, replied.to);
  renderMoves();
  if (S.chess.game_over()) return showPuzzleResult(true, mv, res, fenBefore);
  S.locked = false;
  setStatus(`Your move — ${S.puzzle.movesLeft} to go.`);
}

function showPuzzleResult(solved, mv, res, fenBefore) {
  S.locked = true;
  S.playing = false;
  const rec = S.puzzle.rec;

  const list = loadPuzzles();
  const hit = list.find((x) => x.id === rec.id);
  let sched = null;
  if (hit) {
    sched = L.scheduleReview(hit, solved);
    Object.assign(hit, sched);
    savePuzzles(list);
  }

  const color = solved ? 'var(--c-best)' : 'var(--c-blunder)';
  const bestSan = res.bestUci ? L.uciToSan(fenBefore, res.bestUci) : null;
  $('review').innerHTML = `
    <div class="review-head">
      <span class="badge" style="background:${color}">${solved ? '✓' : '✗'}</span>
      <div>
        <div class="review-title" style="color:${color}">${solved ? 'Solved' : 'Not quite'}</div>
        <div class="review-sub">You played <b>${mv.san}</b> · ${
          solved ? 'accurate' : 'gave up ' + (res.cpLoss / 100).toFixed(2) + ' pawns'}</div>
      </div>
    </div>
    ${!solved && bestSan ? `<div class="reason answer">Best was ${bestSan}.</div>` : ''}
    <div class="review-actions">
      <button class="btn" id="pzRetry">Try again</button>
      <button class="btn btn-primary" id="pzDone">Back to a game</button>
    </div>`;
  $('review').hidden = false;

  if (!solved && res.bestUci) drawArrows([{ uci: res.bestUci, color: '#26c2a3', width: 0.14 }]);

  $('pzRetry').onclick = () => startPuzzle(rec);
  $('pzDone').onclick = () => { $('review').hidden = true; clearArrows(); newGame(); };
  const when = sched && sched.retired ? 'retired — you have this one'
    : sched ? 'back in ' + (sched.interval >= 1 ? sched.interval + ' day' + (sched.interval === 1 ? '' : 's') : '10 minutes')
    : '';
  setStatus(solved
    ? `<b>Solved</b>${when ? ' — ' + when : ''}.`
    : '<b>Not quite</b> — try again, or go back.');
  renderPuzzles();
}

function dueLabel(p, now) {
  if (p.retired) return 'retired';
  const ms = (p.due || 0) - now;
  if (ms <= 0) return 'due now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `due in ${mins} min`;
  const days = Math.round(ms / 86400000);
  return days <= 1 ? 'due tomorrow' : `due in ${days} days`;
}

function renderPuzzles() {
  const pane = $('pane-puzzles');
  if (!pane) return;
  const all = loadPuzzles();
  if (!all.length) {
    pane.innerHTML = '<div class="empty">No puzzles yet. Every mistake or blunder you make is saved here automatically, set two moves earlier so you have to see it coming.</div>';
    return;
  }
  const now = Date.now();
  const due = L.dueList(all, now);
  const active = all.filter((p) => !p.retired);
  const retired = all.filter((p) => p.retired);

  // Due first (soonest), then the rest by next review.
  const ordered = active.slice().sort((a, b) => (a.due || 0) - (b.due || 0)).concat(retired);

  pane.innerHTML = `
    <div class="accrow">
      <div class="accbox"><span class="acclabel">Due now</span><span class="accvalue">${due.length}</span></div>
      <div class="accbox"><span class="acclabel">Learning</span><span class="accvalue small">${active.length}</span></div>
      <div class="accbox"><span class="acclabel">Retired</span><span class="accvalue small">${retired.length}</span></div>
    </div>
    ${due.length ? '<button class="btn btn-primary" id="reviewNext" style="width:100%;margin-bottom:10px">Review next due</button>' : ''}
    <p class="ptitle">From your own games</p>
    ` + ordered.map((p) => `
    <div class="gamerow${p.retired ? ' retired' : ''}">
      <div>
        <div><span style="color:${CLS_COLOR[p.cls]}">${p.cls}</span> — you played ${p.playedSan} (−${(p.cpLoss / 100).toFixed(1)})</div>
        <div class="date">${dueLabel(p, now)} · solved ${p.solves || 0}× · missed ${p.lapses || 0}×</div>
      </div>
      <button class="btn" data-puzzle="${p.id}">${p.retired ? 'Replay' : 'Start'}</button>
    </div>`).join('');

  const next = $('reviewNext');
  if (next) next.onclick = () => startPuzzle(due[0]);
  pane.querySelectorAll('[data-puzzle]').forEach((b) => {
    b.onclick = () => {
      const hit = loadPuzzles().find((x) => x.id === b.dataset.puzzle);
      if (hit) startPuzzle(hit);
    };
  });
}

/* ==========================================================================
   Opening trainer — drill a memorised line
   ========================================================================== */

function loadOpeningStats() {
  try { return JSON.parse(localStorage.getItem(OPENING_KEY) || '{}'); } catch (e) { return {}; }
}
function saveOpeningStats(stats) {
  try { localStorage.setItem(OPENING_KEY, JSON.stringify(stats)); } catch (e) { /* quota */ }
}

function startTrainer(line) {
  S.mode = 'opening';
  S.trainer = { line, idx: 0, misses: 0, totalMisses: 0, revealed: false, wrong: null };
  S.chess = new Chess();
  S.me = line.side;
  S.flip = line.side === 'b';
  S.playing = true;
  S.locked = true;
  S.scored = {}; S.curve = []; S.retries = 0; S.retryAt = {}; S.revealed = {};
  S.lastMove = null; S.resigned = false; S.flagged = null;
  clearSelection(); clearArrows();
  $('gameover').hidden = true;
  $('promo').hidden = true;
  Clock.stop();

  buildBoard(); render(); renderMoves(); updateStats(); updateEvalBar(0);
  document.querySelector('[data-tab="game"]').click();
  advanceTrainer();
}

// Play the opponent's book moves until it is the user's turn again.
function advanceTrainer() {
  const t = BOOK.trainerTurn(S.trainer.line, S.trainer.idx);
  if (t.done) return finishTrainer();
  if (!t.isUser) {
    S.locked = true;
    renderTrainerCard();
    setTimeout(() => {
      if (S.mode !== 'opening') return;
      const mv = S.chess.move(t.expected);
      if (mv) {
        S.lastMove = { from: mv.from, to: mv.to };
        render();
        animateMove(mv.from, mv.to);
        renderMoves();
      }
      S.trainer.idx++;
      advanceTrainer();
    }, 450);
    return;
  }
  S.locked = false;
  renderTrainerCard();
}

function playTrainerMove({ from, to, promotion }) {
  const t = BOOK.trainerTurn(S.trainer.line, S.trainer.idx);
  if (t.done || !t.isUser) return;

  const mv = S.chess.move({ from, to, promotion: promotion || 'q' });
  if (!mv) return;

  if (mv.san !== t.expected) {
    S.chess.undo();                       // wrong move never enters the line
    S.trainer.misses++;
    S.trainer.totalMisses++;
    S.trainer.wrong = mv.san;
    if (S.trainer.misses >= 2) S.trainer.revealed = true;
    S.draggedMove = false;
    clearSelection(); render();
    renderTrainerCard();
    return;
  }

  S.lastMove = { from: mv.from, to: mv.to };
  S.trainer.idx++;
  S.trainer.misses = 0;
  S.trainer.revealed = false;
  S.trainer.wrong = null;
  clearSelection();
  render();
  if (!S.draggedMove) animateMove(mv.from, mv.to);
  S.draggedMove = false;
  renderMoves();
  S.locked = true;
  advanceTrainer();
}

function renderTrainerCard() {
  const { line, idx, revealed, wrong, totalMisses } = S.trainer;
  const total = line.moves.length;
  const yourMoveNo = Math.floor(idx / 2) + 1;
  const el = $('review');
  const t = BOOK.trainerTurn(line, idx);

  el.innerHTML = `
    <div class="review-head">
      <span class="badge" style="background:var(--c-book)">♟</span>
      <div>
        <div class="review-title">${line.name}</div>
        <div class="review-sub">Playing <b>${line.side === 'w' ? 'White' : 'Black'}</b> ·
          move ${yourMoveNo} of ${Math.ceil(total / 2)} · ${totalMisses} slip${totalMisses === 1 ? '' : 's'}</div>
      </div>
    </div>
    <div class="trainbar"><i style="width:${Math.round((idx / total) * 100)}%"></i></div>
    ${wrong ? `<div class="reason bad-move"><b>${wrong}</b> isn't this line.</div>` : ''}
    ${revealed && t.expected ? `<div class="reason answer">The move is <b>${t.expected}</b>.</div>` : ''}
    ${!t.isUser && !t.done ? '<div class="hidden-answer">Opponent is replying…</div>' : ''}
    <div class="review-actions">
      ${t.isUser && !revealed ? '<button class="btn" id="trShow">Show me</button>' : ''}
      <button class="btn" id="trRestart">Restart</button>
      <button class="btn btn-primary" id="trExit">Exit</button>
    </div>`;
  el.hidden = false;

  const show = $('trShow');
  if (show) show.onclick = () => { S.trainer.revealed = true; renderTrainerCard(); };
  $('trRestart').onclick = () => startTrainer(line);
  $('trExit').onclick = () => { S.mode = 'game'; S.trainer = null; el.hidden = true; newGame(); };

  setStatus(t.isUser
    ? `<b>${line.name}</b> — your move from memory.`
    : `<b>${line.name}</b> — watching the reply.`);
}

function finishTrainer() {
  S.playing = false;
  S.locked = true;
  const { line, totalMisses } = S.trainer;

  const stats = loadOpeningStats();
  const rec = stats[line.name] || { attempts: 0, completions: 0, bestMisses: null, lastPlayed: 0 };
  rec.attempts++;
  rec.completions++;
  rec.bestMisses = rec.bestMisses === null ? totalMisses : Math.min(rec.bestMisses, totalMisses);
  rec.lastPlayed = Date.now();
  stats[line.name] = rec;
  saveOpeningStats(stats);

  $('review').innerHTML = `
    <div class="review-head">
      <span class="badge" style="background:var(--c-best)">✓</span>
      <div>
        <div class="review-title" style="color:var(--c-best)">Line complete</div>
        <div class="review-sub">${line.name} · ${
          totalMisses === 0 ? 'from memory, no slips' : totalMisses + ' slip' + (totalMisses === 1 ? '' : 's')}</div>
      </div>
    </div>
    <div class="review-actions">
      <button class="btn" id="trAgain">Again</button>
      <button class="btn btn-primary" id="trDone">Back to a game</button>
    </div>`;
  $('review').hidden = false;
  $('trAgain').onclick = () => startTrainer(line);
  $('trDone').onclick = () => { S.mode = 'game'; S.trainer = null; $('review').hidden = true; newGame(); };
  setStatus(`<b>Line complete</b> — ${line.name}.`);
  renderOpenings();
}

function renderOpenings() {
  const pane = $('pane-openings');
  if (!pane) return;
  const stats = loadOpeningStats();
  const group = (side) => BOOK.TRAINER.filter((l) => l.side === side).map((l) => {
    const r = stats[l.name];
    const sub = r
      ? `done ${r.completions}× · best ${r.bestMisses} slip${r.bestMisses === 1 ? '' : 's'}`
      : `${Math.ceil(l.moves.length / 2)} moves to learn`;
    return `<div class="gamerow">
      <div>
        <div>${l.name}${r && r.bestMisses === 0 ? ' <span class="perfect">clean</span>' : ''}</div>
        <div class="date">${sub}</div>
      </div>
      <button class="btn" data-open="${l.name}">Train</button>
    </div>`;
  }).join('');

  const done = Object.keys(stats).filter((k) => stats[k].completions > 0).length;
  pane.innerHTML = `
    <div class="accrow">
      <div class="accbox"><span class="acclabel">Learned</span><span class="accvalue">${done}</span></div>
      <div class="accbox"><span class="acclabel">Of</span><span class="accvalue small">${BOOK.TRAINER.length}</span></div>
    </div>
    <p class="ptitle">As White</p>${group('w')}
    <p class="ptitle" style="margin-top:12px">As Black</p>${group('b')}`;

  pane.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => {
      const line = BOOK.TRAINER.find((l) => l.name === b.dataset.open);
      if (line) startTrainer(line);
    };
  });
}

function loadGames() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
}
function saveGame(g) {
  const all = loadGames();
  all.push(g);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(-100))); } catch (e) { /* quota */ }
}


function weaknessHTML() {
  const rep = L.weaknessReport(loadGames());
  if (!rep.total.moves) {
    return '<p class="ptitle">Where you lose value</p>'
      + '<div class="empty">Finish a game and your phase-by-phase breakdown appears here.</div>';
  }
  const labels = [['opening', 'Opening'], ['middlegame', 'Middlegame'], ['endgame', 'Endgame']];
  const rows = labels.map(([key, label]) => {
    const p = rep.phases[key];
    if (!p.moves) return `<div class="wrow"><span class="wlabel">${label}</span><span class="wnone">no data yet</span></div>`;
    const weak = rep.weakestPhase === key;
    return `<div class="wrow${weak ? ' weak' : ''}">
      <div class="wtop">
        <span class="wlabel">${label}${weak ? '<em>weakest</em>' : ''}</span>
        <span class="wval">${p.accuracy.toFixed(0)}%</span>
      </div>
      <span class="wbar"><i style="width:${Math.max(2, Math.min(100, p.accuracy))}%"></i></span>
      <span class="wsub">${p.moves} moves · ${(p.avgLoss / 100).toFixed(2)} pawns lost per move · ${p.blunders} blunder${p.blunders === 1 ? '' : 's'}</span>
    </div>`;
  }).join('');

  const hungKeys = Object.keys(rep.hung).sort((a, b) => rep.hung[b] - rep.hung[a]);
  const hungChips = hungKeys.map((k) =>
    `<span class="chip"><i style="background:var(--c-blunder)"></i>${rep.hung[k]}× ${L.PIECE_NAME[k]}</span>`).join('');

  const verdict = rep.weakestPhase
    ? `Your ${rep.weakestPhase} is costing you the most${
        rep.mostHungPiece ? `, and the piece you drop most often is your ${L.PIECE_NAME[rep.mostHungPiece]}` : ''}.`
    : 'Not enough moves yet to call out a weakest phase.';

  return `<p class="ptitle">Where you lose value</p>
    <div class="reason">${verdict}</div>
    ${rows}
    ${hungChips ? `<p class="ptitle" style="margin-top:14px">Pieces you hang</p><div class="chips">${hungChips}</div>` : ''}
    <p class="wfoot">From ${rep.gamesWithData} game${rep.gamesWithData === 1 ? '' : 's'} with move-by-move data · ${rep.total.moves} graded moves.</p>`;
}

/* ==========================================================================
   Backup — export / import
   ========================================================================== */

function currentData() {
  return { games: loadGames(), puzzles: loadPuzzles(), settings: CFG };
}

function exportData() {
  const payload = L.makeExport(loadGames(), loadPuzzles(), CFG);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `chess-coach-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return payload;
}

function applyImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("That file isn't valid JSON — pick the .json file Export produced.");
  }
  L.validateExport(data);                  // throws with a readable reason
  const merged = L.mergeData(currentData(), data);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(merged.games));
    localStorage.setItem(PUZZLE_KEY, JSON.stringify(merged.puzzles));
    Object.assign(CFG, merged.settings);
    saveSettings();
  } catch (e) {
    throw new Error('Could not save — browser storage is full or disabled.');
  }
  return merged;
}

function renderProgress() {
  const games = loadGames();
  const pane = $('pane-progress');
  if (!games.length) {
    pane.innerHTML = '<div class="empty">No finished games yet. Play one through to start tracking your accuracy.</div>';
    return;
  }
  const recent = games.slice(-20);
  const max = Math.max(100, ...recent.map((g) => g.accuracy));
  const bars = recent.map((g) => `<div class="bar" style="height:${(g.accuracy / max) * 100}%" title="${g.accuracy}%"></div>`).join('');
  const avg = games.reduce((a, g) => a + g.accuracy, 0) / games.length;
  const best = Math.max(...games.map((g) => g.accuracy));
  const rows = games.slice().reverse().slice(0, 30).map((g) => `
    <div class="gamerow">
      <div>
        <div>${g.result} · skill ${g.skill}</div>
        <div class="date">${new Date(g.date).toLocaleString()} · ${g.moves} moves · ${g.retries} retries</div>
      </div>
      <div class="acc">${g.accuracy}%</div>
    </div>`).join('');

  pane.innerHTML = `
    <p class="ptitle">Last ${recent.length} games</p>
    <div class="bars">${bars}</div>
    <div class="accrow">
      <div class="accbox"><span class="acclabel">Average</span><span class="accvalue">${avg.toFixed(1)}%</span></div>
      <div class="accbox"><span class="acclabel">Best</span><span class="accvalue">${best.toFixed(1)}%</span></div>
      <div class="accbox"><span class="acclabel">Games</span><span class="accvalue small">${games.length}</span></div>
    </div>
    ${weaknessHTML()}
    <p class="ptitle" style="margin-top:14px">History</p>${rows}`;
}

/* ---- developer settings ---- */

const SETTING_ROWS = [
  { key: 'timeMin', label: 'Clock per side', type: 'select', opts: [[0, 'Unlimited'], [3, '3 min'], [5, '5 min'], [10, '10 min'], [30, '30 min']], note: 'Applies from the next new game.' },
  { key: 'depth', label: 'Analysis depth', type: 'select', opts: [[8, '8 — fast'], [10, '10'], [12, '12 — default'], [14, '14'], [16, '16 — slow, strict']], note: 'Higher is more accurate but slower per move.' },
  { key: 'botMs', label: 'Bot response delay', type: 'select', opts: [[0, 'Instant'], [200, '0.2s'], [450, '0.45s — default'], [1000, '1s']], note: 'How long the bot pauses before replying. Its strength is set by the Bot menu, not this.' },
  { key: 'retryCap', label: 'Take-backs before the answer', type: 'select', opts: [[1, '1'], [2, '2'], [3, '3 — default'], [5, '5'], [99, 'Never reveal']] },
  { key: 'showEval', label: 'Show eval bar during play', type: 'bool', note: 'Off makes you judge the position yourself.' },
  { key: 'showArrows', label: 'Show arrows on the board', type: 'bool' },
];

function renderSettings() {
  const pane = $('pane-settings');
  pane.innerHTML = `<p class="ptitle">Developer settings</p>` + SETTING_ROWS.map((row) => {
    const control = row.type === 'bool'
      ? `<input type="checkbox" data-key="${row.key}" ${CFG[row.key] ? 'checked' : ''}>`
      : `<select data-key="${row.key}">${row.opts.map(([v, lbl]) =>
          `<option value="${v}" ${String(CFG[row.key]) === String(v) ? 'selected' : ''}>${lbl}</option>`).join('')}</select>`;
    return `<div class="setrow">
      <div class="setlabel">${row.label}${row.note ? `<span class="setnote">${row.note}</span>` : ''}</div>
      ${control}
    </div>`;
  }).join('') + `
    <div class="setrow">
      <div class="setlabel">Reset saved games<span class="setnote">Clears your accuracy history. Puzzles are kept.</span></div>
      <button class="btn" id="resetStats">Clear</button>
    </div>
    <p class="ptitle" style="margin-top:16px">Backup</p>
    <p class="setnote" style="margin:0 0 8px">Everything lives in this browser only — a different device, or clearing
       site data, starts from scratch. Export to move your history or keep a copy.</p>
    <div class="setrow">
      <div class="setlabel">Export everything<span class="setnote">Games, puzzles and settings as one JSON file.</span></div>
      <button class="btn" id="exportData">Export</button>
    </div>
    <div class="setrow">
      <div class="setlabel">Import a backup<span class="setnote">Merges with what is already here; nothing is overwritten.</span></div>
      <button class="btn" id="importData">Import</button>
    </div>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
    <p class="setnote" id="backupNote"></p>`;

  pane.querySelectorAll('[data-key]').forEach((input) => {
    input.onchange = () => {
      const k = input.dataset.key;
      CFG[k] = input.type === 'checkbox' ? input.checked : Number(input.value);
      saveSettings();
      if (k === 'showEval' || k === 'showArrows') { updateEvalBar(0); if (!CFG.showArrows) clearArrows(); }
      if (k === 'timeMin' && !S.playing) Clock.reset();
      render();
    };
  });
  $('resetStats').onclick = () => {
    if (!confirm('Delete all saved game history?')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    renderProgress();
  };

  $('exportData').onclick = () => {
    const p = exportData();
    $('backupNote').textContent =
      `Saved ${p.games.length} game${p.games.length === 1 ? '' : 's'} and ${p.puzzles.length} puzzle${p.puzzles.length === 1 ? '' : 's'}.`;
    $('backupNote').className = 'setnote ok';
  };

  $('importData').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const note = $('backupNote');
    try {
      const merged = applyImport(await file.text());
      renderProgress();
      renderPuzzles();
      renderSettings();                 // rebuilds the pane, so write the note after
      const fresh = $('backupNote');
      fresh.textContent = `Merged — now ${merged.games.length} games and ${merged.puzzles.length} puzzles `
        + `(${merged.addedGames} and ${merged.addedPuzzles} new).`;
      fresh.className = 'setnote ok';
    } catch (err) {
      note.textContent = err.message;
      note.className = 'setnote bad';
    }
    e.target.value = '';                 // let the same file be picked again
  };
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const name = t.dataset.tab;
    $('pane-game').hidden = name !== 'game';
    $('pane-progress').hidden = name !== 'progress';
    $('pane-puzzles').hidden = name !== 'puzzles';
    $('pane-openings').hidden = name !== 'openings';
    $('pane-settings').hidden = name !== 'settings';
    if (name === 'progress') renderProgress();
    if (name === 'puzzles') renderPuzzles();
    if (name === 'openings') renderOpenings();
    if (name === 'settings') renderSettings();
  };
});

$('newGame').onclick = newGame;
$('resign').onclick = () => {
  if (!S.playing) return;
  S.resigned = true;
  $('review').hidden = true;
  endGame();
};
$('reviewMode').onchange = () => { S.reviewMode = $('reviewMode').value; };
$('botLevel').onchange = () => { S.botLevel = $('botLevel').value; renderPlayers(); };
window.addEventListener('resize', sizeBoard);
window.addEventListener('orientationchange', () => setTimeout(sizeBoard, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', sizeBoard);

/* ==========================================================================
   Boot
   ========================================================================== */

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

// Same-origin worker first (works locally and when published); fall back to a
// blob built from the fetched source if the host blocks direct worker scripts.
// Both paths reject as soon as the worker errors rather than waiting out a timeout.
async function startWorker(makeWorker, label) {
  const engine = new Engine(makeWorker());          // may also throw synchronously
  await withTimeout(Promise.race([engine.ready, engine.failed]), 15000, label + ' timed out');
  return engine;
}

async function makeEngine() {
  try {
    return await startWorker(() => new Worker(ENGINE_URL), 'direct worker');
  } catch (err) {
    console.warn('[engine] direct worker failed, trying a blob:', err.message);
    const code = await (await fetch(ENGINE_URL)).text();
    return await startWorker(
      () => new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))),
      'blob worker');
  }
}

function showBootError(err) {
  $('loading').innerHTML = `
    <div class="booterr">
      <h2>Stockfish couldn't start</h2>
      <p class="why">${err && err.message ? err.message : 'Unknown error'}</p>
      <p>The engine runs in a Web Worker, and this page is being served somewhere
         that blocks them. Opening the page in its own tab usually fixes it; otherwise
         run it locally with <code>python3 serve.py</code>.</p>
      <button class="btn btn-primary" id="retryBoot">Try again</button>
    </div>`;
  const b = $('retryBoot');
  if (b) b.onclick = () => location.reload();
}

(async function boot() {
  spriteReady = await loadPieces();
  buildBoard();
  render();
  try {
    S.engine = await makeEngine();
    $('loading').hidden = true;
    $('app').hidden = false;
    sizeBoard();
    Clock.reset();
    render();
    renderProgress();
    renderPuzzles();
    renderOpenings();
    updateEvalBar(0);
    setStatus('Ready. Press <b>New game</b> to start.');
  } catch (e) {
    showBootError(e);
  }
})();

})();
