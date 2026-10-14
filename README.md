# ♠♥ Poker Night Payout ♣♦

A calculator that works out who pays whom after a home poker game, with the food bill included.
It runs entirely in the browser: no server, no backend, no database, no API keys. It's just HTML, CSS and JavaScript.

## Use it

Open `index.html` in any browser. That's it, and it works offline.

## Features

- **Buy-ins and rebuys**: use the −/+ stepper for each player. Half buy-ins work too.
- **NIS by default**: ₪ is the main currency, and $, € and £ are available.
- **Chip rate**: set what the game money is worth, e.g. *10 chips = ₪1*. The page shows the buy-in in chips
  (₪50 = 500 chips). You can enter final stacks as chip counts, and each one shows its ₪ value.
- **Converter**: two linked boxes that convert between ₪ and chips both ways.
- **Bank check**: checks that total in equals total out. If the chip count is off, it can scale every cash-out proportionally to fix it.
- **Food and drinks**: log each item, who paid for it, and who shares it. It's split evenly to the cent and settled in the same payments as the poker money.
- **Fewest possible payments**: finds the provably minimal set of payments (see below).
- **Cash pot mode**: when buy-ins were paid in cash up front, the pot pays each player their stack, adjusted for food.
- **Copy summary**: copies the results as text to paste into your group chat.
- Saves automatically to the browser's local storage. Works on phones and in dark mode.

## How payments are minimised

Each player ends with one balance: poker result plus food paid minus food share.
Any group of players whose balances add up to zero can settle among themselves in
*(group size − 1)* payments. So the fewest payments is

```
people with a non-zero balance − the largest number of zero-sum groups
```

The app finds that largest number of groups with a subset DP (`O(2ⁿ·n)`), then settles each group
by having the biggest debtor pay the biggest creditor. This is exact for up to 18 people with a non-zero
balance. Above that it falls back to the greedy method, which needs at most *n − 1* payments.

All money is calculated in whole cents, so there are no floating-point rounding errors.
