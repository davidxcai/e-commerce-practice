'use strict';

// Hard CPU opponent for Player 2. Unlike the greedy bot in ai.js (which only
// scores its own immediate action), this one runs a depth-limited minimax
// search with alpha-beta pruning: it plays out its move, the opponent's best
// reply, its own next reply, and so on, so it can spot multi-move tactics
// (forks, defended pieces, traps) instead of just grabbing the best trade in
// front of it. It reuses the board/rules helpers from game.js and the
// snapshot/simulation helpers from ai.js - it never touches the real game
// state while searching.

const HARD_MAX_DEPTH = 4; // turns of lookahead (each turn = one player's full move, bonus included)
const HARD_TIME_BUDGET_MS = 1200;
const HARD_CPU_MOVE_DELAY_MS = 300;
const WIN_SCORE = 1e6;

function opponentOf(owner) {
  return owner === 1 ? 2 : 1;
}

function snapshotWinner(snapshot) {
  const p1 = snapshot.pieces.some((p) => p.alive && p.owner === 1 && p.role === 'leader');
  const p2 = snapshot.pieces.some((p) => p.alive && p.owner === 2 && p.role === 'leader');
  if (!p1 && !p2) return 'draw';
  if (!p1) return 'P2';
  if (!p2) return 'P1';
  return null;
}

function terminalScore(result, owner) {
  if (result === 'draw') return 0;
  const winnerOwner = result === 'P1' ? 1 : 2;
  return winnerOwner === owner ? WIN_SCORE : -WIN_SCORE;
}

function applyActionSimHard(snapshot, action) {
  if (action.type === 'swap') {
    simApplySwap(snapshot, action.pieceId, action.targetId);
    return { bonus: false };
  }
  return simApplyMove(snapshot, action.pieceId, action.dest);
}

// Cheap capture-first ordering so alpha-beta prunes effectively; not used as
// the actual evaluation.
function moveHeuristic(snapshot, action) {
  if (action.type !== 'move') return 0;
  const occupant = snapshot.board[action.dest.row][action.dest.col];
  if (!occupant) return 0;
  const attacker = findById(snapshot.pieces, action.pieceId);
  const outcome = resolveCombat(attacker.type, occupant.type);
  const val = pieceValue(occupant);
  if (outcome === 'advantage') return val * 2;
  if (outcome === 'neutral') return val;
  return val * 0.5;
}

function withPreferredFirst(actions, preferred) {
  if (!preferred) return actions;
  const idx = actions.findIndex(
    (a) =>
      a.type === preferred.type &&
      a.pieceId === preferred.pieceId &&
      (a.type === 'swap' ? a.targetId === preferred.targetId : a.dest.row === preferred.dest.row && a.dest.col === preferred.dest.col)
  );
  if (idx <= 0) return actions;
  const copy = actions.slice();
  const [item] = copy.splice(idx, 1);
  copy.unshift(item);
  return copy;
}

function checkAbort(state) {
  state.nodes++;
  if (!state.aborted && (state.nodes & 511) === 0 && Date.now() > state.deadline) {
    state.aborted = true;
  }
  return state.aborted;
}

// Evaluates the outcome of `owner` taking `action` from `snapshot`, returned
// from `owner`'s perspective. Handles advantage-capture bonus chains inline.
function evalChildAction(snapshot, owner, action, depth, alpha, beta, state) {
  const child = cloneSnapshot(snapshot.pieces);
  const outcome = applyActionSimHard(child, action);
  const over = snapshotWinner(child);
  if (over) return terminalScore(over, owner);
  if (outcome.bonus) return negamaxBonus(child, owner, action.pieceId, depth, alpha, beta, state);
  return -negamax(child, opponentOf(owner), depth - 1, -beta, -alpha, state);
}

function negamax(snapshot, owner, depth, alpha, beta, state) {
  if (checkAbort(state)) return 0;
  const over = snapshotWinner(snapshot);
  if (over) return terminalScore(over, owner);
  if (depth <= 0) return evaluateSnapshot(snapshot, owner);

  const actions = generateAllActions(owner, snapshot.pieces, snapshot.board);
  if (actions.length === 0) {
    return -negamax(snapshot, opponentOf(owner), depth - 1, -beta, -alpha, state);
  }
  actions.sort((a, b) => moveHeuristic(snapshot, b) - moveHeuristic(snapshot, a));

  let best = -Infinity;
  for (const action of actions) {
    const value = evalChildAction(snapshot, owner, action, depth, alpha, beta, state);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta || state.aborted) break;
  }
  return best;
}

// The bonus move is still `owner`'s decision (no new turn yet), so depth
// doesn't decrement until the turn actually passes - matches the "no 3rd
// move" rule since bonus moves never recurse into another bonus here.
function negamaxBonus(snapshot, owner, pieceId, depth, alpha, beta, state) {
  if (checkAbort(state)) return 0;
  const piece = findById(snapshot.pieces, pieceId);
  const moves = piece && piece.alive ? getLegalMoves(piece, snapshot.board) : [];

  let best = -negamax(snapshot, opponentOf(owner), depth - 1, -beta, -alpha, state); // skip bonus
  if (best > alpha) alpha = best;

  for (const m of moves) {
    if (alpha >= beta || state.aborted) break;
    const child = cloneSnapshot(snapshot.pieces);
    simApplyMove(child, pieceId, m);
    const over = snapshotWinner(child);
    const value = over ? terminalScore(over, owner) : -negamax(child, opponentOf(owner), depth - 1, -beta, -alpha, state);
    if (value > best) best = value;
    if (best > alpha) alpha = best;
  }
  return best;
}

// Iterative deepening: search depth 1, 2, 3... committing each depth's best
// action only if it finished before the time budget runs out. This means the
// bot always has a legal, reasonably-good move ready even if a deeper search
// gets cut off.
function pickBestActionHard(owner) {
  const rootSnapshot = cloneSnapshot(pieces);
  let actions = generateAllActions(owner, rootSnapshot.pieces, rootSnapshot.board);
  if (actions.length === 0) return null;
  actions.sort((a, b) => moveHeuristic(rootSnapshot, b) - moveHeuristic(rootSnapshot, a));

  const deadline = Date.now() + HARD_TIME_BUDGET_MS;
  let bestAction = actions[0];

  for (let depth = 1; depth <= HARD_MAX_DEPTH; depth++) {
    const state = { nodes: 0, deadline, aborted: false };
    const ordered = withPreferredFirst(actions, bestAction);
    let alpha = -Infinity;
    const beta = Infinity;
    let depthBestAction = null;
    let depthBestScore = -Infinity;

    for (const action of ordered) {
      const value = evalChildAction(rootSnapshot, owner, action, depth, alpha, beta, state);
      if (state.aborted) break;
      if (value > depthBestScore) {
        depthBestScore = value;
        depthBestAction = action;
      }
      if (depthBestScore > alpha) alpha = depthBestScore;
    }

    if (state.aborted || !depthBestAction) break;
    bestAction = depthBestAction;
    if (Date.now() > deadline) break;
  }

  return bestAction;
}

function pickBestBonusMoveHard(owner) {
  const rootSnapshot = cloneSnapshot(pieces);
  const piece = findById(rootSnapshot.pieces, selected.id);
  if (!piece || !piece.alive) return null;
  const moves = getLegalMoves(piece, rootSnapshot.board);

  const deadline = Date.now() + HARD_TIME_BUDGET_MS;
  const state = { nodes: 0, deadline, aborted: false };
  const depth = Math.max(HARD_MAX_DEPTH - 1, 1);

  let bestScore = -negamax(rootSnapshot, opponentOf(owner), depth, -Infinity, Infinity, state);
  let bestMove = null;

  for (const m of moves) {
    if (state.aborted) break;
    const child = cloneSnapshot(rootSnapshot.pieces);
    simApplyMove(child, selected.id, m);
    const over = snapshotWinner(child);
    const value = over ? terminalScore(over, owner) : -negamax(child, opponentOf(owner), depth, -Infinity, Infinity, state);
    if (value > bestScore) {
      bestScore = value;
      bestMove = m;
    }
  }
  return bestMove;
}

function runHardCPUTurnStep() {
  if (mode === 'over' || !isCPUControlled(currentPlayer)) return;
  const owner = currentPlayer;

  if (mode === 'bonus') {
    const move = pickBestBonusMoveHard(owner);
    if (move) executeMove(selected, move, true);
    else skipBonusMove();
    return;
  }

  const action = pickBestActionHard(owner);
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
