'use strict';

// ---------- Board / direction constants ----------

const SIZE = 9;
const ORTHOGONAL = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAGONAL = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const OMNI = ORTHOGONAL.concat(DIAGONAL);

const PIECE_STATS = {
  A: { squadron: { range: 3, dirs: ORTHOGONAL }, leader: { range: 4, dirs: ORTHOGONAL } },
  B: { squadron: { range: 3, dirs: DIAGONAL }, leader: { range: 4, dirs: DIAGONAL } },
  C: { squadron: { range: 2, dirs: OMNI }, leader: { range: 3, dirs: OMNI } },
};

const BEATS = { A: 'B', B: 'C', C: 'A' };

// Row 0 = Rank 9 (Player 2 back row) ... Row 8 = Rank 1 (Player 1 back row)
const LAYOUT_P2_BACK = ['B', 'A_L', 'B', 'A', 'C_L', 'A', 'C', 'B_L', 'C'];   // Rank 9
const LAYOUT_P2_FRONT = ['C', 'C', 'C', 'B', 'B', 'B', 'A', 'A', 'A'];        // Rank 8
const LAYOUT_P1_FRONT = ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C'];        // Rank 2
const LAYOUT_P1_BACK = ['C', 'B_L', 'C', 'A', 'C_L', 'A', 'B', 'A_L', 'B'];   // Rank 1

// ---------- Game state ----------

let pieces = [];
let board = [];
let currentPlayer = 1;
let mode = 'idle'; // 'idle' | 'selected' | 'bonus' | 'animating' | 'over'
let selected = null;
let legalMoves = [];
let swapTargets = [];
let winner = null; // 'P1' | 'P2' | 'draw'
let captured = { 1: [], 2: [] }; // pieces captured FROM this player (i.e. shown in their graveyard)
// 'pvp' = both players human | 'vsCPU' = Player 2 is a bot | 'spectator' = both
// players are bots and only advance one action at a time via the Next button.
let gameMode = 'pvp';
let cpuDifficulty = 'easy'; // 'easy' (ai.js, greedy) | 'hard' (ai-hard.js, lookahead)
let turnCount = 1;

function isCPUControlled(owner) {
  if (gameMode === 'spectator') return true;
  if (gameMode === 'vsCPU') return owner === 2;
  return false;
}

// ---------- Setup ----------

function parseCode(code) {
  if (code.endsWith('_L')) return { type: code[0], role: 'leader' };
  return { type: code, role: 'squadron' };
}

function buildInitialPieces() {
  const rows = [
    { row: 0, owner: 2, layout: LAYOUT_P2_BACK },
    { row: 1, owner: 2, layout: LAYOUT_P2_FRONT },
    { row: 7, owner: 1, layout: LAYOUT_P1_FRONT },
    { row: 8, owner: 1, layout: LAYOUT_P1_BACK },
  ];
  const list = [];
  let id = 0;
  for (const { row, owner, layout } of rows) {
    layout.forEach((code, col) => {
      const { type, role } = parseCode(code);
      list.push({ id: id++, owner, type, role, row, col, alive: true, promoted: false });
    });
  }
  return list;
}

function buildBoard(pieceList) {
  const b = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const p of pieceList) {
    if (p.alive) b[p.row][p.col] = p;
  }
  return b;
}

function newGame() {
  pieces = buildInitialPieces();
  board = buildBoard(pieces);
  currentPlayer = 1;
  mode = 'idle';
  selected = null;
  legalMoves = [];
  swapTargets = [];
  winner = null;
  captured = { 1: [], 2: [] };
  turnCount = 1;
  pieceLayerEl.innerHTML = '';
  pieceEls.clear();
  skipIndicatorEl.classList.remove('show');
  render();
}

// ---------- Rules engine ----------

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function resolveCombat(attackerType, defenderType) {
  if (attackerType === defenderType) return 'neutral';
  if (BEATS[attackerType] === defenderType) return 'advantage';
  return 'disadvantage';
}

// Every unit's range is reduced by 1 until it has been promoted, at which
// point it moves at its normal (full) range.
function effectiveRange(piece) {
  const base = PIECE_STATS[piece.type][piece.role].range;
  return piece.promoted ? base : base - 1;
}

function getLegalMoves(piece, boardRef = board) {
  const stats = PIECE_STATS[piece.type][piece.role];
  const range = effectiveRange(piece);
  const moves = [];
  for (const [dr, dc] of stats.dirs) {
    for (let step = 1; step <= range; step++) {
      const r = piece.row + dr * step;
      const c = piece.col + dc * step;
      if (!inBounds(r, c)) break;
      const occupant = boardRef[r][c];
      if (!occupant) {
        moves.push({ row: r, col: c, capture: false });
        continue; // both sliders and leapers may continue past empty tiles
      }
      if (occupant.owner === piece.owner) {
        if (piece.role === 'leader') continue; // jump over own piece
        break; // sliders are blocked by own piece
      }
      // enemy piece
      moves.push({ row: r, col: c, capture: true });
      if (piece.role === 'leader') continue; // may also jump over the enemy to land further
      break; // sliders stop upon reaching/capturing an enemy
    }
  }
  return moves;
}

function getSwapTargets(piece, boardRef = board) {
  const targets = [];
  for (const [dr, dc] of OMNI) {
    const r = piece.row + dr;
    const c = piece.col + dc;
    if (!inBounds(r, c)) continue;
    const occupant = boardRef[r][c];
    if (occupant && occupant.owner === piece.owner) targets.push(occupant);
  }
  return targets;
}

function countLeaders(owner) {
  return pieces.filter((p) => p.alive && p.owner === owner && p.role === 'leader').length;
}

function checkGameOver() {
  const p1 = countLeaders(1);
  const p2 = countLeaders(2);
  if (p1 === 0 && p2 === 0) return 'draw';
  if (p1 === 0) return 'P2';
  if (p2 === 0) return 'P1';
  return null;
}

function removeFromBoard(r, c) {
  board[r][c] = null;
}

// A unit reaching the opponent's home rank is promoted once, restoring the
// range lost to the -1 penalty.
function maybePromote(piece) {
  if (piece.promoted) return;
  const farRank = piece.owner === 1 ? 0 : SIZE - 1;
  if (piece.row === farRank) piece.promoted = true;
}

function placePiece(piece, r, c) {
  piece.row = r;
  piece.col = c;
  board[r][c] = piece;
  maybePromote(piece);
}

function killPiece(piece) {
  piece.alive = false;
  removeFromBoard(piece.row, piece.col);
  captured[piece.owner].push(piece);
}

// ---------- Turn actions ----------

// Matches the piece-token position transition in style.css, so a losing
// attacker finishes sliding into the defender's tile before it fades out.
const MOVE_ANIM_MS = 500;

function executeMove(piece, dest, isBonus) {
  const defender = board[dest.row][dest.col];
  removeFromBoard(piece.row, piece.col);

  if (!defender) {
    placePiece(piece, dest.row, dest.col);
    concludeTurn();
    return;
  }

  const outcome = resolveCombat(piece.type, defender.type);
  killPiece(defender);

  if (outcome === 'disadvantage') {
    // Move the attacker onto the defender's tile visually (without placing it
    // on the board) so it's clear the two pieces clashed there, instead of
    // both just vanishing in place. It's killed once the slide finishes.
    piece.row = dest.row;
    piece.col = dest.col;
    selected = null;
    legalMoves = [];
    swapTargets = [];
    mode = 'animating';
    render();
    setTimeout(() => {
      killPiece(piece);
      concludeTurn();
    }, MOVE_ANIM_MS);
    return;
  }

  placePiece(piece, dest.row, dest.col);

  // No bonus move if that capture already ended the game (e.g. it was the
  // opponent's last Leader) - there's nothing left to take a bonus move against.
  if (outcome === 'advantage' && !isBonus && !checkGameOver()) {
    enterBonusMode(piece);
    return;
  }

  concludeTurn();
}

function executeSwap(pieceA, pieceB) {
  const ar = pieceA.row, ac = pieceA.col;
  const br = pieceB.row, bc = pieceB.col;
  placePiece(pieceA, br, bc);
  placePiece(pieceB, ar, ac);
  concludeTurn();
}

function enterBonusMode(piece) {
  mode = 'bonus';
  selected = piece;
  legalMoves = getLegalMoves(piece);
  swapTargets = [];
  render();
  maybeTriggerCPU();
}

function concludeTurn() {
  const result = checkGameOver();
  selected = null;
  legalMoves = [];
  swapTargets = [];
  if (result) {
    mode = 'over';
    winner = result;
    render();
    return;
  }
  const nextPlayer = currentPlayer === 1 ? 2 : 1;
  if (nextPlayer === 1) turnCount++; // a full round (both players moved) just completed
  currentPlayer = nextPlayer;
  mode = 'idle';
  render();
  maybeTriggerCPU();
}

// Dispatches to the Easy bot (ai.js) or the Hard bot (ai-hard.js) depending
// on the selected difficulty. A thrown error here (e.g. from the Hard bot's
// search) would otherwise leave "CPU is thinking…" on screen forever, since
// nothing else re-triggers the turn - so fall back to the simpler Easy bot,
// and failing that, just skip, rather than leave the game stuck.
function stepCPU() {
  if (mode === 'over' || mode === 'animating' || !isCPUControlled(currentPlayer)) return;
  try {
    if (cpuDifficulty === 'hard') runHardCPUTurnStep();
    else runCPUTurnStep();
  } catch (err) {
    console.error('CPU turn failed, retrying with the Easy bot:', err);
    try {
      runCPUTurnStep();
    } catch (err2) {
      console.error('CPU turn failed again, skipping turn:', err2);
      if (mode === 'bonus') skipBonusMove();
      else skipEntireTurn();
    }
  }
}

function maybeTriggerCPU() {
  if (mode === 'over' || !isCPUControlled(currentPlayer)) return;
  // Spectator mode only advances when the user taps the Next button.
  if (gameMode === 'spectator') return;
  const delay = cpuDifficulty === 'hard' ? HARD_CPU_MOVE_DELAY_MS : CPU_MOVE_DELAY_MS;
  setTimeout(stepCPU, delay);
}

// Skips are otherwise invisible turn endings (no piece moves) - flag them so
// the other player can tell something happened instead of nothing.
function skipBonusMove() {
  showSkipIndicator(`${playerLabel(currentPlayer)} skipped the bonus move`);
  concludeTurn();
}

function skipEntireTurn() {
  showSkipIndicator(`${playerLabel(currentPlayer)} had no legal moves`);
  concludeTurn();
}

// ---------- Input handling ----------

function selectPiece(piece) {
  selected = piece;
  mode = 'selected';
  legalMoves = getLegalMoves(piece);
  swapTargets = getSwapTargets(piece);
  render();
}

function clearSelection() {
  selected = null;
  mode = 'idle';
  legalMoves = [];
  swapTargets = [];
  render();
}

function onCellClick(r, c) {
  if (mode === 'over' || mode === 'animating') return;
  if (isCPUControlled(currentPlayer)) return; // CPU's turn, ignore human input
  const occupant = board[r][c];

  if (mode === 'bonus') {
    const dest = legalMoves.find((m) => m.row === r && m.col === c);
    if (dest) executeMove(selected, dest, true);
    return;
  }

  if (selected) {
    const dest = legalMoves.find((m) => m.row === r && m.col === c);
    if (dest) {
      executeMove(selected, dest, false);
      return;
    }
    const swapTarget = swapTargets.find((p) => p.id === (occupant && occupant.id));
    if (swapTarget) {
      executeSwap(selected, swapTarget);
      return;
    }
    if (occupant && occupant.owner === currentPlayer) {
      selectPiece(occupant);
      return;
    }
    clearSelection();
    return;
  }

  if (occupant && occupant.owner === currentPlayer) {
    selectPiece(occupant);
  }
}

function onSkipBonus() {
  if (mode !== 'bonus') return;
  if (isCPUControlled(currentPlayer)) return; // CPU decides its own bonus moves
  skipBonusMove();
}

// ---------- Rendering ----------

const boardEl = document.getElementById('board');
const pieceLayerEl = document.getElementById('pieceLayer');
const statusP1El = document.getElementById('statusP1');
const statusP2El = document.getElementById('statusP2');
const p1LabelEl = document.getElementById('p1Label');
const p2LabelEl = document.getElementById('p2Label');
const p1LeaderIconsEl = document.getElementById('p1LeaderIcons');
const p2LeaderIconsEl = document.getElementById('p2LeaderIcons');
const turnNumberEl = document.getElementById('turnNumber');
const turnArrowP1El = document.getElementById('turnArrowP1');
const turnArrowP2El = document.getElementById('turnArrowP2');
const skipBonusBtn = document.getElementById('skipBonusBtn');
const nextBtn = document.getElementById('nextBtn');
const hintEl = document.getElementById('hint');
const overlayEl = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayText = document.getElementById('overlayText');
const graveyardP1 = document.getElementById('graveyardP1');
const graveyardP2 = document.getElementById('graveyardP2');
const skipIndicatorEl = document.getElementById('skipIndicator');

// Piece DOM elements persist across renders (keyed by piece id) so that
// changing their left/top position triggers a CSS slide instead of a jump.
const pieceEls = new Map();
const CAPTURE_FADE_MS = 300;

const SHAPE_BY_TYPE = { A: 'square', B: 'diamond', C: 'circle' };

function pieceShape(p) {
  return SHAPE_BY_TYPE[p.type];
}

function render() {
  renderBoard();
  renderPieces();
  renderStatus();
  renderGraveyards();
}

function renderBoard() {
  boardEl.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      cell.dataset.row = r;
      cell.dataset.col = c;

      if (selected && selected.row === r && selected.col === c) {
        cell.classList.add('selected');
      }
      const move = legalMoves.find((m) => m.row === r && m.col === c);
      if (move) cell.classList.add(move.capture ? 'move-capture' : 'move-empty');

      const isSwapTarget = swapTargets.some((p) => p.row === r && p.col === c);
      if (isSwapTarget) cell.classList.add('swap-target');

      frag.appendChild(cell);
    }
  }
  boardEl.appendChild(frag);
}

function createPieceToken(piece) {
  const token = document.createElement('div');
  token.className = 'piece-token';
  token.style.left = `${(piece.col / SIZE) * 100}%`;
  token.style.top = `${(piece.row / SIZE) * 100}%`;

  const inner = document.createElement('div');
  inner.className = `piece${piece.role === 'leader' ? ' leader' : ''}`;

  const shape = document.createElement('div');
  shape.className = `piece-shape owner-${piece.owner} shape-${pieceShape(piece)}${piece.role === 'leader' ? ' leader' : ''}`;
  inner.appendChild(shape);

  token.appendChild(inner);

  return token;
}

function renderPieces() {
  const alive = new Set();

  for (const piece of pieces) {
    if (!piece.alive) continue;
    alive.add(piece.id);

    let token = pieceEls.get(piece.id);
    if (!token) {
      token = createPieceToken(piece);
      pieceEls.set(piece.id, token);
      pieceLayerEl.appendChild(token);
    }
    token.style.left = `${(piece.col / SIZE) * 100}%`;
    token.style.top = `${(piece.row / SIZE) * 100}%`;
    token.querySelector('.piece').classList.toggle('promoted', piece.promoted);
  }

  for (const [id, token] of pieceEls) {
    if (alive.has(id)) continue;
    token.classList.add('captured');
    pieceEls.delete(id);
    setTimeout(() => token.remove(), CAPTURE_FADE_MS);
  }
}

function showSkipIndicator(text) {
  skipIndicatorEl.textContent = text;
  // Restart the CSS transition even if a previous message is still fading.
  skipIndicatorEl.classList.remove('show');
  void skipIndicatorEl.offsetWidth;
  skipIndicatorEl.classList.add('show');
  clearTimeout(showSkipIndicator.timeoutId);
  showSkipIndicator.timeoutId = setTimeout(() => skipIndicatorEl.classList.remove('show'), 1800);
}

function playerLabel(owner) {
  if (!isCPUControlled(owner)) return `Player ${owner}`;
  return cpuDifficulty === 'hard' ? 'CPU (Hard)' : 'CPU';
}

function renderLeaderIcons(container, owner) {
  container.innerHTML = '';
  for (const type of ['A', 'B', 'C']) {
    const leader = pieces.find((p) => p.owner === owner && p.type === type && p.role === 'leader');
    const icon = document.createElement('span');
    icon.className = `status-shape owner-${owner} shape-${SHAPE_BY_TYPE[type]}${leader.alive ? '' : ' dead'}`;
    container.appendChild(icon);
  }
}

function renderStatus() {
  p1LabelEl.textContent = playerLabel(1);
  p2LabelEl.textContent = playerLabel(2);
  renderLeaderIcons(p1LeaderIconsEl, 1);
  renderLeaderIcons(p2LeaderIconsEl, 2);
  turnNumberEl.textContent = turnCount;

  if (mode === 'over') {
    const winnerLabel = winner === 'draw' ? null : playerLabel(winner === 'P1' ? 1 : 2);
    statusP1El.classList.remove('active');
    statusP2El.classList.remove('active');
    turnArrowP1El.classList.remove('active');
    turnArrowP2El.classList.remove('active');
    skipBonusBtn.classList.add('hidden');
    nextBtn.classList.add('hidden');
    hintEl.textContent = 'Start a new game to play again.';
    overlayEl.classList.remove('hidden');
    overlayTitle.textContent = winner === 'draw' ? "It's a Draw" : `${winnerLabel} Wins!`;
    overlayText.textContent =
      winner === 'draw'
        ? 'Both sides lost their last Leader in mutual annihilation.'
        : 'All opposing Leaders have been eliminated.';
    return;
  }

  overlayEl.classList.add('hidden');
  statusP1El.classList.toggle('active', currentPlayer === 1);
  statusP2El.classList.toggle('active', currentPlayer === 2);
  turnArrowP1El.classList.toggle('active', currentPlayer === 1);
  turnArrowP2El.classList.toggle('active', currentPlayer === 2);

  const isCPUTurn = isCPUControlled(currentPlayer);
  const isSpectator = gameMode === 'spectator';

  if (mode === 'bonus') {
    skipBonusBtn.classList.toggle('hidden', isCPUTurn);
    nextBtn.classList.toggle('hidden', !isSpectator);
    hintEl.textContent = isSpectator
      ? 'Tap Next to resolve the bonus move.'
      : isCPUTurn
      ? 'CPU is thinking…'
      : 'Move again with the same piece, or skip to end your turn.';
    return;
  }

  skipBonusBtn.classList.add('hidden');
  nextBtn.classList.toggle('hidden', !isSpectator);
  if (isSpectator) {
    hintEl.textContent = 'Tap Next to advance the CPU match.';
  } else if (isCPUTurn) {
    hintEl.textContent = 'CPU is thinking…';
  } else if (mode === 'selected') {
    hintEl.textContent = 'Tap a highlighted tile to move, or a dashed tile to swap.';
  } else {
    hintEl.textContent = 'Tap a piece to select it.';
  }
}

function renderGraveyards() {
  graveyardP1.innerHTML = '';
  graveyardP2.innerHTML = '';
  for (const p of captured[1]) {
    graveyardP1.appendChild(makeGravePiece(p));
  }
  for (const p of captured[2]) {
    graveyardP2.appendChild(makeGravePiece(p));
  }
}

function makeGravePiece(p) {
  const el = document.createElement('div');
  el.className = `grave-piece owner-${p.owner} shape-${pieceShape(p)}${p.role === 'leader' ? ' leader' : ''}`;
  return el;
}

// ---------- Event wiring ----------

boardEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  onCellClick(parseInt(cell.dataset.row, 10), parseInt(cell.dataset.col, 10));
});

skipBonusBtn.addEventListener('click', onSkipBonus);
nextBtn.addEventListener('click', () => {
  if (gameMode !== 'spectator' || mode === 'over') return;
  stepCPU();
});

document.getElementById('newGameBtn').addEventListener('click', newGame);
document.getElementById('overlayNewGameBtn').addEventListener('click', newGame);

const MODE_CYCLE = [
  { mode: 'pvp', difficulty: 'easy', label: '2 Player' },
  { mode: 'vsCPU', difficulty: 'easy', label: 'vs CPU (Easy)' },
  { mode: 'vsCPU', difficulty: 'hard', label: 'vs CPU (Hard)' },
  { mode: 'spectator', difficulty: 'hard', label: 'CPU vs CPU' },
];
let modeIndex = 0;

const modeBtn = document.getElementById('modeBtn');
modeBtn.addEventListener('click', () => {
  modeIndex = (modeIndex + 1) % MODE_CYCLE.length;
  const m = MODE_CYCLE[modeIndex];
  gameMode = m.mode;
  cpuDifficulty = m.difficulty;
  modeBtn.textContent = m.label;
  newGame();
});

const rulesDialog = document.getElementById('rulesDialog');
document.getElementById('rulesBtn').addEventListener('click', () => rulesDialog.showModal());
document.getElementById('closeRulesBtn').addEventListener('click', () => rulesDialog.close());

newGame();
