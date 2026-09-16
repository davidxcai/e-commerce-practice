# TRI

A two-player, zero-luck strategy game of spatial control and rapid chain
reactions, played on a 9x9 grid. Built as a static, mobile-friendly web app
(vanilla HTML/CSS/JS, no build step, local pass-and-play).

## Running it

Open `index.html` directly in a browser, or serve the folder:

```
npx serve .
```

Then open the printed URL on desktop or mobile.

## Rules

Full rules are available in-app via the "Rules" button, covering:

- The Triangle of Advantage (A beats B, B beats C, C beats A)
- Squadron (sliding) and Leader (leaping) piece movement
- Bonus moves on an advantage capture
- Mutual annihilation on a disadvantage capture
- Tactical Swaps
- Promotion: every piece moves at a reduced range until it reaches the
  opponent's home rank, where it's promoted and gains its full range
- Win condition: eliminate all 3 of your opponent's Leaders (or draw on
  simultaneous mutual elimination of both sides' last Leaders)
