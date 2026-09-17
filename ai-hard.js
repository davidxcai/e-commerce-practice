'use strict';

// Hard CPU opponent for Player 2. Unlike the greedy bot in ai.js (which only
// scores its own immediate action), this one runs a depth-limited minimax
// search with alpha-beta pruning: it plays out its move, the opponent's best
// reply, its own next reply, and so on, so it can spot multi-move tactics
// (forks, defended pieces, traps) instead of just grabbing the best trade in
// front of it. It reuses the board/rules helpers from game.js and the
// snapshot/simulation helpers from ai.js - it never touches the real game
// state while searching.

// Turns of lookahead (each turn = one player's full move, bonus included).
// Iterative deepening + the time budget below bound how deep a search
// actually gets in a busy midgame, so raising this cap is free there - it
// only matters once few pieces remain and the branching factor drops, which
// is exactly when a deeper search is needed to find a forced capture
// sequence instead of just leaning on the heuristics in evaluateSnapshotHard.
const HARD_MAX_DEPTH = 8;
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
  // Checked every 63 nodes rather than less often so a slow device can't
  // blow through the time budget by much before this notices.
  if (!state.aborted && (state.nodes & 63) === 0 && Date.now() > state.deadline) {
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

// Material alone is flat across every quiet (non-capturing) move once the
// armies make contact, which left alpha-beta deterministically picking
// whichever action happened to sort first. An earlier fix added a "maximize
// total army mobility" term to break that flatness, but it backfired: closing
// in on a cornered enemy Leader shrinks YOUR mobility faster than theirs
// (fewer empty squares near a board edge / a clump of pieces), so it actively
// rewarded hanging back in open space instead of hunting - which is exactly
// why the bot kept re-shuffling instead of finishing games off. These terms
// replace it with the real priorities in order: material already ranks
// Leaders far above squadrons (see PIECE_VALUE) and still dominates; on top
// of that, reward cornering the enemy Leader specifically, converging our
// pieces on it, and advancing promotions - small enough to never outweigh a
// real trade, large enough to turn "no legal reason to move" into "move
// toward finishing the game."
const ENEMY_LEADER_MOBILITY_WEIGHT = 0.2; // fewer escape squares for their Leader = closer to a trap
const OWN_LEADER_MOBILITY_WEIGHT = 0.08; // keep some safety margin for ours
const LEADER_PRESSURE_WEIGHT = 0.03; // reward closing the distance from our pieces to their Leader
const PROMOTION_WEIGHT = 0.05; // reward advancing toward (and reaching) promotion

function leaderMobility(snapshot, owner) {
  let total = 0;
  for (const p of snapshot.pieces) {
    if (p.alive && p.owner === owner && p.role === 'leader') total += getLegalMoves(p, snapshot.board).length;
  }
  return total;
}

// Sum, over every one of forOwner's living pieces, of how close it is to the
// nearest enemy Leader (0..SIZE-1, higher = closer) - rises as the army
// converges on it instead of drifting in open space.
function leaderPressure(snapshot, forOwner) {
  const enemyOwner = opponentOf(forOwner);
  const enemyLeaders = snapshot.pieces.filter((p) => p.alive && p.owner === enemyOwner && p.role === 'leader');
  if (enemyLeaders.length === 0) return 0;
  let pressure = 0;
  for (const p of snapshot.pieces) {
    if (!p.alive || p.owner !== forOwner) continue;
    let minDist = Infinity;
    for (const leader of enemyLeaders) {
      const dist = Math.max(Math.abs(p.row - leader.row), Math.abs(p.col - leader.col));
      if (dist < minDist) minDist = dist;
    }
    pressure += SIZE - 1 - minDist;
  }
  return pressure;
}

// Sum, over owner's not-yet-promoted living pieces, of how close each is to
// its promotion rank (0..SIZE-1); an already-promoted piece counts as having
// arrived, so promoting always scores at least as well as approaching it.
function promotionProgress(snapshot, owner) {
  const farRank = owner === 1 ? 0 : SIZE - 1;
  let score = 0;
  for (const p of snapshot.pieces) {
    if (!p.alive || p.owner !== owner) continue;
    score += p.promoted ? SIZE - 1 : SIZE - 1 - Math.abs(p.row - farRank);
  }
  return score;
}

function evaluateSnapshotHard(snapshot, forOwner) {
  const enemyOwner = opponentOf(forOwner);
  let score = evaluateSnapshot(snapshot, forOwner);
  score += leaderMobility(snapshot, forOwner) * OWN_LEADER_MOBILITY_WEIGHT;
  score -= leaderMobility(snapshot, enemyOwner) * ENEMY_LEADER_MOBILITY_WEIGHT;
  score += (leaderPressure(snapshot, forOwner) - leaderPressure(snapshot, enemyOwner)) * LEADER_PRESSURE_WEIGHT;
  score += (promotionProgress(snapshot, forOwner) - promotionProgress(snapshot, enemyOwner)) * PROMOTION_WEIGHT;
  return score;
}

function negamax(snapshot, owner, depth, alpha, beta, state) {
  if (checkAbort(state)) return 0;
  const over = snapshotWinner(snapshot);
  if (over) return terminalScore(over, owner);
  if (depth <= 0) return evaluateSnapshotHard(snapshot, owner);

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
  let lastCompleteResults = null; // every action's score, from the deepest depth that finished in time

  for (let depth = 1; depth <= HARD_MAX_DEPTH; depth++) {
    const state = { nodes: 0, deadline, aborted: false };
    const ordered = withPreferredFirst(actions, bestAction);
    let alpha = -Infinity;
    const beta = Infinity;
    let depthBestAction = null;
    let depthBestScore = -Infinity;
    const results = [];

    for (const action of ordered) {
      const value = evalChildAction(rootSnapshot, owner, action, depth, alpha, beta, state);
      if (state.aborted) break;
      results.push({ action, score: value });
      if (value > depthBestScore) {
        depthBestScore = value;
        depthBestAction = action;
      }
      if (depthBestScore > alpha) alpha = depthBestScore;
    }

    if (state.aborted || !depthBestAction) break;
    bestAction = depthBestAction;
    lastCompleteResults = results;
    if (Date.now() > deadline) break;
  }

  return pickAmongNearBest(owner, lastCompleteResults, bestAction);
}

// The deepest fully-searched depth almost always leaves several actions tied
// (or nearly tied) with the best score, especially in quiet positions where
// material and mobility don't distinguish them. Instead of always taking the
// first one (deterministic, and prone to shuffling into a repeated position),
// prefer whichever tied action leads to the position seen least often so far,
// and break any remaining tie randomly - so the bot doesn't walk an identical
// path every game and doesn't lock itself into a back-and-forth loop.
const ROOT_TIE_EPSILON = 0.5; // smaller than any real material/mobility swing

function pickAmongNearBest(owner, results, fallbackAction) {
  if (!results || results.length === 0) return fallbackAction;
  // Before either side has captured anything the position is symmetric and
  // quiet, so widen the window - otherwise the search's tiny, consistent
  // mobility edge for one piece would make every game open identically.
  const epsilon = isOpeningPhase() ? OPENING_TIE_EPSILON : ROOT_TIE_EPSILON;
  const bestScore = results.reduce((m, r) => Math.max(m, r.score), -Infinity);
  const tied = results.filter((r) => bestScore - r.score < epsilon);
  if (tied.length === 1) return tied[0].action;

  const nextPlayer = opponentOf(owner);
  const withSeenCount = tied.map((r) => ({
    action: r.action,
    seen: positionHistory.get(resultingPositionKey(owner, r.action, nextPlayer)) || 0,
  }));
  const minSeen = Math.min(...withSeenCount.map((r) => r.seen));
  const freshest = withSeenCount.filter((r) => r.seen === minSeen);
  return freshest[Math.floor(Math.random() * freshest.length)].action;
}

// Keys the position `action` would land in (pre-bonus - a repetition loop
// never involves a bonus move, so keying the resting square after the primary
// move/swap is enough to steer away from it).
function resultingPositionKey(owner, action, nextPlayer) {
  const snap = cloneSnapshot(pieces);
  const result = applyActionSimHard(snap, action);
  return snapshotPositionKey(snap.pieces, result.bonus ? owner : nextPlayer);
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
