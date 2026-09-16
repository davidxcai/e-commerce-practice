# TRI Online — Feature & Tech Plan

Status: planning only, nothing implemented yet. This repo stays the simple/reference
version (vanilla JS, local hotseat + greedy CPU). Online multiplayer will live in a
**separate project** that reuses the game rules but not the DOM-rendering code.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend framework | React + Vite | TypeScript from the start |
| Language | TypeScript | Non-negotiable — see "shared engine" below |
| Client state | Zustand | Local game/UI state (selection, animation, bonus-move mode) |
| Data fetching / cache | TanStack Query | For lobby list, match history, leaderboard, profile — **not** for live move state |
| Routing | TanStack Router | Add once there's more than one screen (lobby, `/game/:id`, profile) — not needed for MVP |
| Backend / BaaS | Supabase | Postgres (source of truth), Auth (incl. anonymous), Realtime, Edge Functions |
| Hosting (frontend) | Vercel | Static Vite build |
| Hosting (backend logic) | Supabase Edge Functions | Colocated with DB, used for move validation |

## Core architecture principle: shared, pure game engine

Extract the current `game.js` rules logic (board, legal moves, combat resolution, turn/bonus
state) into a **pure TypeScript module with no DOM dependencies**. This one module gets reused
in three places:

1. Client — optimistic local move preview / animation
2. CPU opponent — search/heuristics run against it
3. Server — Supabase Edge Function imports the same module to validate every move

This is what makes server-validated moves possible without writing the rules twice.

## Anti-cheat / move validation

Because of ranked ELO and a public leaderboard, moves must be **server-validated**, not
client-to-client:

- Client sends an intended move to a Postgres RPC or Edge Function.
- Server runs it through the shared engine, rejects illegal moves, writes the authoritative
  resulting state to Postgres.
- Clients subscribe to `postgres_changes` (not raw Realtime `broadcast`) so both players (and
  spectators) receive the server-confirmed state, not something a modified client fabricated.

## Accounts & guests

- No account required to play CPU or Quickplay.
- Guests play via Supabase anonymous auth (gets a real user id, just unlinked to an identity).
- A guest can be invited to a match by another user even with no account.
- If a guest later creates an account, their anonymous session/user id is upgraded/linked so
  their guest match history carries over (Supabase supports linking an anonymous user to a
  permanent identity — confirm exact flow when implementing).

## CPU opponent

- Current greedy CPU (from this repo) has exploitable patterns — needs a real difficulty
  upgrade (e.g. minimax/negamax with lookahead + eval function, or at least weighted
  heuristics that avoid the obvious greedy traps) before shipping it as the "no account"
  default opponent.

## Matches

- Visibility: **public by default**, can be set to **private**.
- Public matches are spectatable; private matches are not.
- Two ways into a match: **Quickplay** (matchmaking queue) or **direct invite** (works for
  guests too).

## Player-facing features

- **Leaderboard** — ELO rating, ranked by rating.
- **Match history** — every game recorded; full replay viewable anytime (implies storing the
  move list/log per game, not just final result).
- **Stats** — win/loss ratio, last-10-games record, overall record, current ELO.
- **Spectating** — read-only view of public matches in progress via Realtime.

## Rough data model sketch (to refine at implementation time)

- `profiles` — id, is_guest, display_name, elo, wins, losses
- `games` — id, player1_id, player2_id, visibility (public/private), status, winner_id, created_at
- `moves` — game_id, move_number, move data (from/to/resulting state or notation), timestamp
- `invites` — id, game_id, inviter_id, invitee (user id or guest link), status

## Open questions for later

- Quickplay matchmaking: pure FIFO queue vs. ELO-band matching?
- Reconnect/disconnect handling mid-match (grace period? forfeit timer?)
- Rate limiting / abuse prevention on invites to guests
- Exact anonymous → permanent account linking flow in Supabase Auth

## Suggested phasing

1. Extract pure TS game engine from current `game.js` (still usable standalone).
2. Scaffold new Vite + React + TS + Zustand project; port local hotseat mode using the shared
   engine; upgrade CPU difficulty.
3. Add Supabase: auth (guest + real accounts), schema above, server-validated move RPC/Edge
   Function, Realtime sync for a single live match.
4. Lobby: quickplay queue + direct invites, public/private visibility.
5. Spectating for public matches.
6. Leaderboard/ELO, match history + replay viewer, TanStack Query for lobby/stats, TanStack
   Router once there are multiple routes.
