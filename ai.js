'use strict';

// Greedy CPU opponent for Player 2. Reuses the movement/combat rules from
// game.js but never mutates the real game state while searching: every
// candidate action is tried out on a cloned snapshot of the board first.

const CPU_MOVE_DELAY_MS = 500;
const PIECE_VALUE = { leader: 12, squadron: 3 };

function pieceValue(piece) {
  return PIECE_VALUE[piece.role];
}

function findById(pieceList, id) {
  return pieceList.find((p) => p.id === id);
}

function cloneSnapshot(sourcePieces) {
  const clonedPieces = sourcePieces.map((p) => ({ ...p }));
  const clonedBoard = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const p of clonedPieces) {
    if (p.alive) clonedBoard[p.row][p.col] = p;
  }
  return { pieces: clonedPieces, board: clonedBoard };
}

// Applies a move to a snapshot in place. Returns whether it granted a bonus move.
function simApplyMove(snapshot, pieceId, dest) {
  const piece = findById(snapshot.pieces, pieceId);
  const defender = snapshot.board[dest.row][dest.col];
  snapshot.board[piece.row][piece.col] = null;

  if (!defender) {
    piece.row = dest.row;
    piece.col = dest.col;
    snapshot.board[dest.row][dest.col] = piece;
    maybePromote(piece);
    return { bonus: false };
  }

  const outcome = resolveCombat(piece.type, defender.type);
  defender.alive = false;
  snapshot.board[dest.row][dest.col] = null;

  if (outcome === 'disadvantage') {
    piece.alive = false;
    return { bonus: false };
  }

  piece.row = dest.row;
  piece.col = dest.col;
  snapshot.board[dest.row][dest.col] = piece;
  maybePromote(piece);
  return { bonus: outcome === 'advantage' };
}

function simApplySwap(snapshot, idA, idB) {
  const a = findById(snapshot.pieces, idA);
  const b = findById(snapshot.pieces, idB);
  const ar = a.row, ac = a.col, br = b.row, bc = b.col;
  snapshot.board[ar][ac] = b;
  b.row = ar;
  b.col = ac;
  snapshot.board[br][bc] = a;
  a.row = br;
  a.col = bc;
  maybePromote(a);
  maybePromote(b);
}

function evaluateSnapshot(snapshot, forOwner) {
  let score = 0;
  for (const p of snapshot.pieces) {
    if (!p.alive) continue;
    const val = pieceValue(p);
    score += p.owner === forOwner ? val : -val;
  }
  return score;
}

// Penalizes leaving `piece` on a square enemies can strike next turn.
// A free loss (enemy wins outright) costs more than a fair trade.
function threatPenalty(snapshot, piece, forOwner) {
  if (!piece || !piece.alive) return 0;
  const enemyOwner = forOwner === 1 ? 2 : 1;
  let worst = 0;
  for (const enemy of snapshot.pieces) {
    if (!enemy.alive || enemy.owner !== enemyOwner) continue;
    const moves = getLegalMoves(enemy, snapshot.board);
    const hits = moves.some((m) => m.row === piece.row && m.col === piece.col);
    if (!hits) continue;
    const outcome = resolveCombat(enemy.type, piece.type);
    const val = pieceValue(piece);
    if (outcome === 'advantage' || outcome === 'neutral') {
      worst = Math.min(worst, -val * 0.9);
    } else if (outcome === 'disadvantage') {
      worst = Math.min(worst, -val * 0.3);
    }
  }
  return worst;
}

function generateAllActions(owner, sourcePieces, sourceBoard) {
  const actions = [];
  for (const piece of sourcePieces) {
    if (!piece.alive || piece.owner !== owner) continue;
    for (const m of getLegalMoves(piece, sourceBoard)) {
      actions.push({ type: 'move', pieceId: piece.id, dest: { row: m.row, col: m.col } });
    }
    for (const target of getSwapTargets(piece, sourceBoard)) {
      if (piece.id < target.id) {
        actions.push({ type: 'swap', pieceId: piece.id, targetId: target.id });
      }
    }
  }
  return actions;
}

function scoreAction(owner, action) {
  const snap = cloneSnapshot(pieces);

  if (action.type === 'swap') {
    simApplySwap(snap, action.pieceId, action.targetId);
    const a = findById(snap.pieces, action.pieceId);
    const b = findById(snap.pieces, action.targetId);
    return evaluateSnapshot(snap, owner) + threatPenalty(snap, a, owner) + threatPenalty(snap, b, owner);
  }

  const result = simApplyMove(snap, action.pieceId, action.dest);
  const piece = findById(snap.pieces, action.pieceId);

  if (!result.bonus) {
    return evaluateSnapshot(snap, owner) + threatPenalty(snap, piece, owner);
  }

  // Advantage granted a bonus move: assume the best continuation (including skipping it).
  let best = evaluateSnapshot(snap, owner) + threatPenalty(snap, piece, owner);
  for (const bm of getLegalMoves(piece, snap.board)) {
    const snap2 = cloneSnapshot(snap.pieces);
    simApplyMove(snap2, action.pieceId, bm);
    const p2 = findById(snap2.pieces, action.pieceId);
    const s = evaluateSnapshot(snap2, owner) + threatPenalty(snap2, p2, owner);
    if (s > best) best = s;
  }
  return best;
}

function pickBestAction(owner) {
  const actions = generateAllActions(owner, pieces, board);
  if (actions.length === 0) return null;

  const scored = actions.map((action) => ({ action, score: scoreAction(owner, action) }));
  const bestScore = scored.reduce((m, s) => Math.max(m, s.score), -Infinity);
  const epsilon = isOpeningPhase() ? OPENING_TIE_EPSILON : 1e-9;
  const bestActions = scored.filter((s) => bestScore - s.score <= epsilon);
  return bestActions[Math.floor(Math.random() * bestActions.length)].action;
}

function pickBestBonusMove(owner) {
  const skipSnap = cloneSnapshot(pieces);
  const skipPiece = findById(skipSnap.pieces, selected.id);
  let bestScore = evaluateSnapshot(skipSnap, owner) + threatPenalty(skipSnap, skipPiece, owner);
  let bestMove = null;

  for (const m of legalMoves) {
    const snap = cloneSnapshot(pieces);
    simApplyMove(snap, selected.id, m);
    const p = findById(snap.pieces, selected.id);
    const score = evaluateSnapshot(snap, owner) + threatPenalty(snap, p, owner);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      bestMove = m;
    }
  }
  return bestMove;
}

function runCPUTurnStep() {
  if (mode === 'over' || !isCPUControlled(currentPlayer)) return;
  const owner = currentPlayer;

  if (mode === 'bonus') {
    const move = pickBestBonusMove(owner);
    if (move) executeMove(selected, move, true);
    else skipBonusMove(); // bypasses onSkipBonus's human-input guard
    return;
  }

  const action = pickBestAction(owner);
  if (!action) {
    skipEntireTurn();
    return;
  }
  if (action.type === 'move') {
    executeMove(findById(pieces, action.pieceId), action.dest, false);
  } else {
    executeSwap(findById(pieces, action.pieceId), findById(pieces, action.targetId));
  }
}

// maybeTriggerCPU lives in game.js now - it dispatches to this file's
// runCPUTurnStep (Easy) or ai-hard.js's runHardCPUTurnStep (Hard) depending
// on the selected difficulty.
