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
let mode = 'idle'; // 'idle' | 'selected' | 'bonus' | 'over'
let selected = null;
let legalMoves = [];
let swapTargets = [];
let winner = null; // 'P1' | 'P2' | 'draw'
let captured = { 1: [], 2: [] }; // pieces captured FROM this player (i.e. shown in their graveyard)
let vsCPU = false; // when true, Player 2 is controlled by the bot in ai.js

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
      list.push({ id: id++, owner, type, role, row, col, alive: true });
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

function getLegalMoves(piece, boardRef = board) {
  const stats = PIECE_STATS[piece.type][piece.role];
  const moves = [];
  for (const [dr, dc] of stats.dirs) {
    for (let step = 1; step <= stats.range; step++) {
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

function placePiece(piece, r, c) {
  piece.row = r;
  piece.col = c;
  board[r][c] = piece;
}

function killPiece(piece) {
  piece.alive = false;
  removeFromBoard(piece.row, piece.col);
  captured[piece.owner].push(piece);
}

// ---------- Turn actions ----------

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
    killPiece(piece);
    concludeTurn();
    return;
  }

  placePiece(piece, dest.row, dest.col);

  if (outcome === 'advantage' && !isBonus) {
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
  currentPlayer = currentPlayer === 1 ? 2 : 1;
  mode = 'idle';
  render();
  maybeTriggerCPU();
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
  if (mode === 'over') return;
  if (vsCPU && currentPlayer === 2) return; // CPU's turn, ignore human input
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
  if (vsCPU && currentPlayer === 2) return; // CPU decides its own bonus moves
  skipBonusMove();
}

// ---------- Rendering ----------

const boardEl = document.getElementById('board');
const pieceLayerEl = document.getElementById('pieceLayer');
const statusText = document.getElementById('statusText');
const turnDotEl = document.querySelector('.turn-indicator .turn-dot');
const p1LeadersEl = document.getElementById('p1Leaders');
const p2LeadersEl = document.getElementById('p2Leaders');
const skipBonusBtn = document.getElementById('skipBonusBtn');
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

function pieceLabel(p) {
  return p.type;
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
  inner.className = `piece owner-${piece.owner}${piece.role === 'leader' ? ' leader' : ''}`;
  inner.textContent = pieceLabel(piece);
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
  return vsCPU && owner === 2 ? 'CPU' : `Player ${owner}`;
}

function renderStatus() {
  p1LeadersEl.textContent = countLeaders(1);
  p2LeadersEl.textContent = countLeaders(2);

  turnDotEl.className = `turn-dot p${currentPlayer}`;

  if (mode === 'over') {
    const winnerLabel = winner === 'draw' ? null : playerLabel(winner === 'P1' ? 1 : 2);
    statusText.textContent = winner === 'draw' ? 'Draw!' : `${winnerLabel} wins!`;
    skipBonusBtn.classList.add('hidden');
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

  const isCPUTurn = vsCPU && currentPlayer === 2;

  if (mode === 'bonus') {
    statusText.textContent = `${playerLabel(currentPlayer)}: Bonus move available!`;
    skipBonusBtn.classList.toggle('hidden', isCPUTurn);
    hintEl.textContent = isCPUTurn
      ? 'CPU is thinking…'
      : 'Move again with the same piece, or skip to end your turn.';
    return;
  }

  skipBonusBtn.classList.add('hidden');
  statusText.textContent = `${playerLabel(currentPlayer)}’s turn`;
  if (isCPUTurn) {
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
  el.className = `grave-piece owner-${p.owner}${p.role === 'leader' ? ' leader' : ''}`;
  el.textContent = pieceLabel(p);
  return el;
}

// ---------- Event wiring ----------

boardEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  onCellClick(parseInt(cell.dataset.row, 10), parseInt(cell.dataset.col, 10));
});

skipBonusBtn.addEventListener('click', onSkipBonus);

document.getElementById('newGameBtn').addEventListener('click', newGame);
document.getElementById('overlayNewGameBtn').addEventListener('click', newGame);

const modeBtn = document.getElementById('modeBtn');
modeBtn.addEventListener('click', () => {
  vsCPU = !vsCPU;
  modeBtn.textContent = vsCPU ? 'vs CPU' : '2 Player';
  newGame();
});

const rulesDialog = document.getElementById('rulesDialog');
document.getElementById('rulesBtn').addEventListener('click', () => rulesDialog.showModal());
document.getElementById('closeRulesBtn').addEventListener('click', () => rulesDialog.close());

newGame();
