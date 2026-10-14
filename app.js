(() => {
  'use strict';

  const STORAGE_KEY = 'poker-night-payout:v1';
  const STATE_VERSION = 2;
  const CURRENCIES = ['₪', '$', '€', '£'];
  // Exact minimisation is O(2^n · n); above this many people with a non-zero
  // balance we fall back to the greedy method (at most n-1 payments).
  const EXACT_LIMIT = 18;
  const $ = (sel) => document.querySelector(sel);

  // ---------- State ----------

  const uid = () => Math.random().toString(36).slice(2, 10);
  const blankPlayer = () => ({ id: uid(), name: '', buyIns: 1, final: '' });

  function defaults() {
    return {
      version: STATE_VERSION,
      currency: '₪',
      buyIn: 50,
      useChips: false,
      chipRate: 10, // chips per 1 unit of real money
      autoFix: false,
      mode: 'min',
      players: [blankPlayer(), blankPlayer(), blankPlayer(), blankPlayer()],
      food: [],
      paid: [], // keys of settlement payments marked as paid
    };
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.players)) return migrate({ ...defaults(), ...saved });
    } catch { /* storage unavailable or corrupt: start fresh */ }
    return defaults();
  }

  function migrate(s) {
    if (s.version !== STATE_VERSION) {
      // v1 stored "chips per buy-in" and defaulted to dollars.
      const buyIn = num(s.buyIn);
      const perBuyIn = num(s.chipsPerBuyIn);
      if (buyIn > 0 && perBuyIn > 0) s.chipRate = perBuyIn / buyIn;
      delete s.chipsPerBuyIn;
      s.currency = '₪';
      s.version = STATE_VERSION;
    }
    if (!CURRENCIES.includes(s.currency)) s.currency = '₪';
    return s;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }

  // ---------- Money helpers (all maths in integer cents) ----------

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const toCents = (x) => Math.round(x * 100);

  function fmt(cents, signed = false) {
    const abs = Math.abs(cents) / 100;
    const body = abs.toLocaleString(undefined, {
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    });
    const sign = cents < 0 ? '−' : signed && cents > 0 ? '+' : '';
    return `${sign}${state.currency}${body}`;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const playerName = (p, i) => p.name.trim() || `Player ${i + 1}`;

  // Loaded here, after the helpers that migrate() relies on.
  let state = load();
  if (!Array.isArray(state.food)) state.food = [];
  if (!Array.isArray(state.paid)) state.paid = [];

  // Chips <-> real money at the configured rate (chips per 1 unit of money).
  const chipsToCents = (chips) => {
    const rate = num(state.chipRate);
    return rate > 0 ? Math.round((num(chips) * 100) / rate) : 0;
  };
  const centsToChips = (cents) => (cents / 100) * num(state.chipRate);
  const fmtChips = (chips) =>
    `${(Math.round(chips * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} chips`;

  // ---------- Food ----------

  // Splits each item evenly (to the cent) among the ticked players.
  // Returns per-player paid/share in cents plus per-item status.
  function computeFood() {
    const ids = new Set(state.players.map((p) => p.id));
    const paid = new Map();
    const share = new Map();
    const add = (m, id, c) => m.set(id, (m.get(id) || 0) + c);
    let total = 0;

    const items = state.food.map((f) => {
      const amt = toCents(num(f.amount));
      const split = f.split.filter((id) => ids.has(id));
      if (!amt) return { amt, split, ok: false, why: 'Enter an amount' };
      if (!ids.has(f.payer)) return { amt, split, ok: false, why: 'Choose who paid' };
      if (!split.length) return { amt, split, ok: false, why: 'Tick at least one person' };

      total += amt;
      add(paid, f.payer, amt);
      const base = Math.floor(amt / split.length);
      let rem = amt - base * split.length;
      for (const id of split) {
        add(share, id, base + (rem > 0 ? 1 : 0));
        if (rem > 0) rem--;
      }
      return { amt, split, ok: true, each: amt / split.length };
    });

    return { paid, share, total, items };
  }

  // ---------- Poker + food balances ----------

  function compute() {
    const buyInC = toCents(num(state.buyIn));
    const food = computeFood();

    const rows = state.players.map((p, i) => {
      const outC = state.useChips ? chipsToCents(p.final) : toCents(num(p.final));
      const foodNet = (food.paid.get(p.id) || 0) - (food.share.get(p.id) || 0);
      return {
        id: p.id,
        name: playerName(p, i),
        inC: Math.round(num(p.buyIns) * buyInC),
        outC,
        payC: outC,
        foodNet,
        missing: String(p.final).trim() === '',
      };
    });

    const totalIn = rows.reduce((s, r) => s + r.inC, 0);
    const totalOut = rows.reduce((s, r) => s + r.outC, 0);
    const diff = totalOut - totalIn;

    let adjusted = false;
    if (state.autoFix && diff !== 0 && totalOut > 0) {
      scalePayouts(rows, totalIn, totalOut);
      adjusted = true;
    }

    for (const r of rows) {
      r.pokerNet = r.payC - r.inC;
      r.net = r.pokerNet + r.foodNet;
    }
    const balanced = rows.reduce((s, r) => s + r.payC, 0) === totalIn;

    return { rows, totalIn, totalOut, diff, adjusted, balanced, food };
  }

  // Scale cash-outs so they add up to exactly totalIn, handing leftover
  // cents to the players with the largest rounding remainders.
  function scalePayouts(rows, totalIn, totalOut) {
    const parts = rows.map((r) => {
      const exact = (r.outC * totalIn) / totalOut;
      return { r, floor: Math.floor(exact), frac: exact - Math.floor(exact) };
    });
    let leftover = totalIn - parts.reduce((s, p) => s + p.floor, 0);
    parts.sort((a, b) => b.frac - a.frac);
    for (const p of parts) {
      p.r.payC = p.floor + (leftover > 0 ? 1 : 0);
      if (leftover > 0) leftover--;
    }
  }

  // ---------- Settlement ----------

  // Biggest debtor pays biggest creditor. For a group whose balances sum
  // to zero this needs at most (group size - 1) payments.
  function greedySettle(people) {
    const take = (sign) => people
      .filter((p) => sign * p.amt > 0)
      .map((p) => ({ name: p.name, amt: sign * p.amt }))
      .sort((a, b) => b.amt - a.amt);
    const creditors = take(1);
    const debtors = take(-1);
    const transfers = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const amt = Math.min(debtors[i].amt, creditors[j].amt);
      transfers.push({ from: debtors[i].name, to: creditors[j].name, amt });
      debtors[i].amt -= amt;
      creditors[j].amt -= amt;
      if (debtors[i].amt === 0) i++;
      if (creditors[j].amt === 0) j++;
    }
    return transfers;
  }

  // Provably minimal number of payments.
  //
  // With k people holding non-zero balances, any settlement needs at least
  // k - g payments, where g is the largest number of disjoint groups whose
  // balances each sum to zero (each group of size m settles in m - 1).
  // We find that best partition with a subset DP:
  //   dp[mask] = max over i in mask of dp[mask without i] + (sum[mask] == 0)
  // then walk back through the DP to recover the groups, and settle each
  // group greedily.
  function minimalSettle(people) {
    const list = people.filter((p) => p.amt !== 0);
    const k = list.length;
    if (k === 0) return { transfers: [], exact: true };
    if (k > EXACT_LIMIT) return { transfers: greedySettle(list), exact: false };

    const size = 1 << k;
    const sum = new Float64Array(size);
    const dp = new Int8Array(size);
    for (let m = 1; m < size; m++) {
      const low = m & -m;
      sum[m] = sum[m ^ low] + list[31 - Math.clz32(low)].amt;
      let best = 0;
      for (let i = 0; i < k; i++) {
        if (m & (1 << i) && dp[m ^ (1 << i)] > best) best = dp[m ^ (1 << i)];
      }
      dp[m] = best + (sum[m] === 0 ? 1 : 0);
    }

    const groups = [];
    let current = [];
    let m = size - 1;
    while (m) {
      const bonus = sum[m] === 0 ? 1 : 0;
      let pick = 0;
      while (!(m & (1 << pick)) || dp[m ^ (1 << pick)] + bonus !== dp[m]) pick++;
      current.push(list[pick]);
      m ^= 1 << pick;
      if (sum[m] === 0) { groups.push(current); current = []; }
    }

    return { transfers: groups.flatMap(greedySettle), exact: true };
  }

  // Players settle among themselves: poker result and food in one balance.
  function settleBetweenPlayers(rows) {
    return minimalSettle(rows.map((r) => ({ name: r.name, amt: r.net })));
  }

  // Buy-ins went into a cash pot. The pot pays each player their stack, with
  // the food balance folded in; anyone whose food share is bigger than their
  // stack pays the difference into the pot.
  function settleFromPot(rows) {
    const transfers = rows
      .map((r) => ({ r, amt: r.payC + r.foodNet }))
      .filter((x) => x.amt !== 0)
      .sort((a, b) => b.amt - a.amt)
      .map(({ r, amt }) => amt > 0
        ? { from: 'Pot', to: r.name, amt }
        : { from: r.name, to: 'Pot', amt: -amt });
    return { transfers, exact: true };
  }

  const currentSettlement = (result) =>
    state.mode === 'bank' ? settleFromPot(result.rows) : settleBetweenPlayers(result.rows);

  // ---------- Rendering: players ----------

  const playersEl = $('#players');
  const foodEl = $('#food');

  function renderPlayers() {
    const finalLabel = state.useChips ? 'Final chips' : 'Cash out';
    playersEl.innerHTML = state.players.map((p, i) => `
      <div class="row" data-id="${p.id}">
        <div class="c-name">
          <input type="text" data-field="name" value="${escapeHtml(p.name)}"
                 placeholder="Player ${i + 1}" aria-label="Player ${i + 1} name">
        </div>
        <div class="c-buy" data-label="Buy-ins">
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="One less buy-in">−</button>
            <input type="number" data-field="buyIns" value="${escapeHtml(p.buyIns)}"
                   min="0" step="0.5" inputmode="decimal" aria-label="Buy-ins">
            <button type="button" data-step="1" aria-label="One more buy-in">+</button>
          </div>
        </div>
        <div class="c-fin" data-label="${finalLabel}">
          <input type="number" data-field="final" value="${escapeHtml(p.final)}"
                 min="0" step="any" inputmode="decimal" placeholder="0" aria-label="${finalLabel}">
          <span class="conv"></span>
        </div>
        <div class="c-net num net"></div>
        <div class="c-rm">
          <button type="button" class="remove" data-remove aria-label="Remove player">×</button>
        </div>
      </div>`).join('');
    $('#finalHead').textContent = finalLabel;
    $('#playerCount').textContent = `${state.players.length} player${state.players.length === 1 ? '' : 's'}`;
    renderFood();
  }

  // ---------- Rendering: food ----------

  function renderFood() {
    if (!state.food.length) {
      foodEl.innerHTML = '<p class="muted">No food added yet.</p>';
      update();
      return;
    }
    const options = state.players.map((p, i) =>
      `<option value="${p.id}">${escapeHtml(playerName(p, i))}</option>`).join('');

    foodEl.innerHTML = state.food.map((f) => `
      <div class="food-item" data-food="${f.id}">
        <div class="food-main">
          <input class="f-desc" type="text" data-ffield="desc" value="${escapeHtml(f.desc)}"
                 placeholder="Pizza, beer, snacks…" aria-label="Food item">
          <input type="number" data-ffield="amount" value="${escapeHtml(f.amount)}"
                 min="0" step="any" inputmode="decimal" placeholder="Amount" aria-label="Amount">
          <select data-ffield="payer" aria-label="Paid by">
            <option value="">Paid by…</option>${options}
          </select>
          <button type="button" class="remove f-rm" data-fremove aria-label="Remove food item">×</button>
        </div>
        <div class="split">
          <span class="lbl">Split between:</span>
          ${state.players.map((p, i) => `
            <label class="pill">
              <input type="checkbox" data-split="${p.id}" ${f.split.includes(p.id) ? 'checked' : ''}>
              <span>${escapeHtml(playerName(p, i))}</span>
            </label>`).join('')}
          <span class="food-info"></span>
        </div>
      </div>`).join('');

    for (const f of state.food) {
      foodEl.querySelector(`[data-food="${f.id}"] select`).value = f.payer;
    }
    update();
  }

  // ---------- Rendering: numbers, checks, settlement ----------

  function update() {
    const result = compute();
    const { rows, totalIn, totalOut, diff, adjusted, food } = result;
    const hasFood = food.total > 0;

    for (const el of document.querySelectorAll('.cur')) el.textContent = state.currency;
    const rate = num(state.chipRate);
    $('#rateHint').innerHTML = rate > 0
      ? `<strong>${fmtChips(rate)} = ${fmt(100)}</strong> · one buy-in of ${fmt(toCents(num(state.buyIn)))} = <strong>${fmtChips(centsToChips(toCents(num(state.buyIn))))}</strong>`
      : 'Set how many chips are worth 1 unit of money.';

    for (const r of rows) {
      const conv = playersEl.querySelector(`[data-id="${r.id}"] .conv`);
      if (conv) conv.textContent = state.useChips && !r.missing ? `= ${fmt(r.outC)}` : '';

      const cell = playersEl.querySelector(`[data-id="${r.id}"] .c-net`);
      if (!cell) continue;
      cell.className = `c-net num net ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}`;
      const detail = hasFood
        ? `poker ${fmt(r.pokerNet, true)} · food ${fmt(r.foodNet, true)}`
        : `in ${fmt(r.inC)}`;
      cell.innerHTML = `${fmt(r.net, true)}<span class="detail">${detail}</span>`;
    }

    state.food.forEach((f, i) => {
      const info = foodEl.querySelector(`[data-food="${f.id}"] .food-info`);
      if (!info) return;
      const item = food.items[i];
      info.className = `food-info ${item.ok ? '' : 'warn'}`;
      info.textContent = item.ok
        ? `${fmt(item.amt)} ÷ ${item.split.length} = ${fmt(Math.round(item.each))} each`
        : item.why;
    });
    $('#foodTotal').textContent = hasFood ? `Total ${fmt(food.total)}` : '';

    $('#totalIn').textContent = fmt(totalIn);
    $('#totalOut').textContent = fmt(totalOut);
    const diffEl = $('#diff');
    diffEl.textContent = fmt(diff, true);
    diffEl.className = `value ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}`;

    const msg = $('#balanceMsg');
    const missing = rows.filter((r) => r.missing).map((r) => r.name);
    if (missing.length) {
      msg.className = 'msg warn';
      msg.textContent = `Still waiting on final ${state.useChips ? 'chip counts' : 'amounts'} for: ${missing.join(', ')}.`;
    } else if (diff === 0) {
      msg.className = 'msg ok';
      msg.textContent = 'The bank balances: money in equals money out.';
    } else if (adjusted) {
      msg.className = 'msg warn';
      msg.textContent = `Counts are off by ${fmt(diff, true)}. Every cash-out has been scaled proportionally to make it balance.`;
    } else {
      msg.className = 'msg warn';
      msg.textContent = `Counts are off by ${fmt(diff, true)} (${diff > 0 ? 'more money out than in' : 'money left on the table'}). Recount the stacks, or turn on the fix below.`;
    }

    renderTransfers(result);
    save();
  }

  const transferKey = (t) => `${t.from}→${t.to}:${t.amt}`;

  // Plays the jackpot when the settlement goes from not ready to ready.
  // Starts as null so loading a saved, already-settled game stays silent.
  let wasReady = null;
  function announceReady(ready) {
    if (wasReady === false && ready) Sound.jackpot();
    wasReady = ready;
  }

  function renderTransfers(result) {
    const list = $('#transfers');
    const badge = $('#optimality');
    const tapHint = $('#tapHint');
    $('#modeHint').textContent = state.mode === 'bank'
      ? 'Use this when everyone put cash into a pot at buy-in. The pot pays each player their stack, adjusted for food.'
      : 'Use this when no cash changed hands during the game. Poker results and food are combined into the fewest payments.';

    const showEmpty = (text) => {
      badge.textContent = '';
      tapHint.hidden = true;
      list.innerHTML = `<li class="empty">${text}</li>`;
      announceReady(false);
    };

    if (!result.balanced) return showEmpty('Make the bank balance first. Total in must equal total out.');
    const { transfers, exact } = currentSettlement(result);
    if (!transfers.length) return showEmpty('Nobody owes anything.');

    // Forget "paid" marks for payments that no longer exist.
    const keys = new Set(transfers.map(transferKey));
    state.paid = state.paid.filter((k) => keys.has(k));
    const paid = new Set(state.paid);

    const n = transfers.length;
    const done = transfers.filter((t) => paid.has(transferKey(t))).length;
    badge.textContent = (state.mode === 'bank'
      ? `${n} payout${n === 1 ? '' : 's'} from the pot`
      : exact
        ? `${n} payment${n === 1 ? '' : 's'}: the fewest possible`
        : `${n} payment${n === 1 ? '' : 's'} (near-minimal: too many players for the exact search)`)
      + (done === n ? ' · all paid ✓' : done ? ` · ${done} of ${n} paid` : '');
    tapHint.hidden = false;

    list.innerHTML = transfers.map((t) => {
      const key = transferKey(t);
      const isPaid = paid.has(key);
      return `
      <li>
        <button type="button" class="xfer${isPaid ? ' paid' : ''}" data-key="${escapeHtml(key)}" aria-pressed="${isPaid}">
          <span class="tick" aria-hidden="true">✓</span>
          <strong>${escapeHtml(t.from)}</strong>
          <span class="arrow">pays →</span>
          <strong>${escapeHtml(t.to)}</strong>
          <span class="amt">${fmt(t.amt)}</span>
        </button>
      </li>`;
    }).join('');
    announceReady(true);
  }

  function summaryText() {
    const result = compute();
    const hasFood = result.food.total > 0;
    const lines = [`♠♥ Poker night (${new Date().toLocaleDateString()}) ♣♦`, ''];

    const sorted = [...result.rows].sort((a, b) => b.net - a.net);
    for (const r of sorted) {
      const detail = hasFood
        ? `poker ${fmt(r.pokerNet, true)}, food ${fmt(r.foodNet, true)}`
        : `in ${fmt(r.inC)}, out ${fmt(r.payC)}`;
      lines.push(`${r.name}: ${fmt(r.net, true)} (${detail})`);
    }

    if (hasFood) {
      lines.push('', `Food total: ${fmt(result.food.total)}`);
      state.food.forEach((f, i) => {
        const item = result.food.items[i];
        if (!item.ok) return;
        const payer = result.rows.find((r) => r.id === f.payer);
        lines.push(`• ${f.desc.trim() || 'Food'}: ${fmt(item.amt)}, paid by ${payer.name}, split ${item.split.length} ways`);
      });
    }

    lines.push('');
    if (!result.balanced) {
      lines.push(`Bank is off by ${fmt(result.diff, true)}. Not settled yet.`);
    } else {
      if (result.adjusted) lines.push(`(Cash-outs scaled to fix a ${fmt(result.diff, true)} counting error)`);
      const { transfers } = currentSettlement(result);
      lines.push(state.mode === 'bank' ? 'Pot payouts:' : `Payments (${transfers.length}):`);
      if (!transfers.length) lines.push('Nobody owes anything.');
      const paid = new Set(state.paid);
      for (const t of transfers) {
        lines.push(`• ${t.from} → ${t.to}: ${fmt(t.amt)}${paid.has(transferKey(t)) ? ' ✓ paid' : ''}`);
      }
    }
    return lines.join('\n');
  }

  // ---------- Events: settings ----------

  function bindSetting(id, key, prop = 'value') {
    const el = $(`#${id}`);
    el[prop] = state[key];
    el.addEventListener('input', () => {
      state[key] = el[prop];
      if (key === 'useChips') {
        renderPlayers();
      } else {
        if (key === 'chipRate') syncConverter('money');
        update();
      }
    });
  }

  bindSetting('currency', 'currency');
  bindSetting('buyIn', 'buyIn');
  bindSetting('chipRate', 'chipRate');
  bindSetting('useChips', 'useChips', 'checked');
  bindSetting('autoFix', 'autoFix', 'checked');

  // Two-way converter: typing in one box fills the other.
  const convMoney = $('#convMoney');
  const convChips = $('#convChips');
  const round2 = (x) => String(Math.round(x * 100) / 100);

  function syncConverter(from) {
    const rate = num(state.chipRate);
    if (from === 'money') {
      if (convMoney.value === '') return;
      convChips.value = rate > 0 ? round2(num(convMoney.value) * rate) : '';
    } else {
      if (convChips.value === '') return;
      convMoney.value = rate > 0 ? round2(num(convChips.value) / rate) : '';
    }
  }
  convMoney.addEventListener('input', () => {
    if (convMoney.value === '') convChips.value = '';
    syncConverter('money');
  });
  convChips.addEventListener('input', () => {
    if (convChips.value === '') convMoney.value = '';
    syncConverter('chips');
  });

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === state.mode;
    radio.addEventListener('change', () => { state.mode = radio.value; update(); });
  }

  // ---------- Events: players ----------

  const playerOf = (el) => {
    const row = el.closest('.row');
    return row && state.players.find((p) => p.id === row.dataset.id);
  };

  playersEl.addEventListener('input', (e) => {
    const field = e.target.dataset.field;
    const p = playerOf(e.target);
    if (!field || !p) return;
    p[field] = e.target.value;
    // Names also appear in the food section, so redraw it (focus stays here).
    field === 'name' ? renderFood() : update();
  });

  playersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const p = btn && playerOf(btn);
    if (!p) return;
    if (btn.dataset.step) {
      const before = num(p.buyIns);
      p.buyIns = Math.max(0, before + Number(btn.dataset.step));
      if (p.buyIns > before) Sound.coin();
      else if (p.buyIns < before) Sound.coinDown();
      btn.parentElement.querySelector('input').value = p.buyIns;
      update();
    } else if ('remove' in btn.dataset) {
      state.players = state.players.filter((x) => x !== p);
      for (const f of state.food) {
        f.split = f.split.filter((id) => id !== p.id);
        if (f.payer === p.id) f.payer = '';
      }
      renderPlayers();
    }
  });

  $('#addPlayer').addEventListener('click', () => {
    state.players.push(blankPlayer());
    Sound.coin();
    renderPlayers();
    const inputs = playersEl.querySelectorAll('[data-field="name"]');
    inputs[inputs.length - 1]?.focus();
  });

  // ---------- Events: food ----------

  const foodOf = (el) => {
    const item = el.closest('.food-item');
    return item && state.food.find((f) => f.id === item.dataset.food);
  };

  function onFoodChange(e) {
    const f = foodOf(e.target);
    if (!f) return;
    const { ffield, split } = e.target.dataset;
    if (ffield) {
      f[ffield] = e.target.value;
    } else if (split) {
      f.split = e.target.checked
        ? [...new Set([...f.split, split])]
        : f.split.filter((id) => id !== split);
    } else {
      return;
    }
    update();
  }
  foodEl.addEventListener('input', onFoodChange);

  foodEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fremove]');
    const f = btn && foodOf(btn);
    if (!f) return;
    state.food = state.food.filter((x) => x !== f);
    renderFood();
  });

  $('#addFood').addEventListener('click', () => {
    state.food.push({
      id: uid(),
      desc: '',
      amount: '',
      payer: state.players[0]?.id || '',
      split: state.players.map((p) => p.id),
    });
    Sound.coin();
    renderFood();
    const descs = foodEl.querySelectorAll('[data-ffield="desc"]');
    descs[descs.length - 1]?.focus();
  });

  // ---------- Events: actions ----------

  $('#newGame').addEventListener('click', () => {
    if (!confirm('Start a new game? Names and settings are kept. Buy-ins, stacks and food are reset.')) return;
    state.players = state.players.map((p) => ({ ...p, buyIns: 1, final: '' }));
    state.food = [];
    state.paid = [];
    renderPlayers();
  });

  $('#transfers').addEventListener('click', (e) => {
    const btn = e.target.closest('.xfer');
    if (!btn) return;
    const key = btn.dataset.key;
    if (state.paid.includes(key)) {
      state.paid = state.paid.filter((k) => k !== key);
    } else {
      state.paid.push(key);
      Sound.pay();
    }
    update();
  });

  $('#clearAll').addEventListener('click', () => {
    if (!confirm('Clear all players, food and settings?')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    location.reload();
  });

  // Short message for the group chat: a sign-off plus only the payments
  // still to be made (anything already marked paid is left out).
  function whatsappText() {
    const result = compute();
    if (!result.balanced) return null;
    const paid = new Set(state.paid);
    const { transfers } = currentSettlement(result);
    const open = transfers.filter((t) => !paid.has(transferKey(t)));

    const lines = ['*Good game!* 🃏♠️♥️', `Poker night ${new Date().toLocaleDateString()}`, ''];
    if (!open.length) {
      lines.push(transfers.length ? 'Everyone has paid. All settled ✅' : 'Nobody owes anything. All square ✅');
    } else {
      lines.push(state.mode === 'bank' ? 'Pot payouts:' : 'Payments:');
      for (const t of open) lines.push(`• ${t.from} → ${t.to}: *${fmt(t.amt)}*`);
    }
    return lines.join('\n');
  }

  $('#whatsapp').addEventListener('click', () => {
    const text = whatsappText();
    if (!text) {
      $('#copyMsg').textContent = 'Make the bank balance first, then share.';
      return;
    }
    Sound.pay();
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });

  // ---------- Finale: needed payments dealt onto royal cards ----------

  const finale = $('#finale');
  const royalEl = $('#royalCards');
  const ROYALS = [
    { rank: 'K', title: 'King' },
    { rank: 'Q', title: 'Queen' },
    { rank: 'J', title: 'Jack' },
    { rank: 'A', title: 'Ace' },
  ];
  const ROYAL_SUITS = ['♥', '♠', '♦', '♣'];

  function finaleSubtitle(transfers) {
    const paid = new Set(state.paid);
    const n = transfers.length;
    const left = transfers.filter((t) => !paid.has(transferKey(t))).length;
    if (!n) return 'Nobody owes anything. All square!';
    if (!left) return 'Everyone has paid. All settled!';
    return `${left} of ${n} payment${n === 1 ? '' : 's'} to go. Tap a card when it's paid.`;
  }

  function dealRoyalCards() {
    const { transfers } = currentSettlement(compute());
    const paid = new Set(state.paid);
    $('#finaleSub').textContent = finaleSubtitle(transfers);

    royalEl.innerHTML = transfers.map((t, i) => {
      const royal = ROYALS[i % ROYALS.length];
      const suit = ROYAL_SUITS[i % ROYAL_SUITS.length];
      const black = suit === '♠' || suit === '♣' ? ' black' : '';
      const key = transferKey(t);
      const isPaid = paid.has(key);
      const rot = [-4, 3, -2, 5][i % 4];
      const style = `--rot:${rot}deg;--deal-delay:${(i * 0.16).toFixed(2)}s;`
        + `--float-delay:${(0.75 + i * 0.16 + (i % 3) * 0.5).toFixed(2)}s`;
      const idx = `${royal.rank}<br>${suit}`;
      return `
        <button type="button" class="royal${black}${isPaid ? ' paid' : ''}" style="${style}"
                data-key="${escapeHtml(key)}" aria-pressed="${isPaid}"
                aria-label="${escapeHtml(`${t.from} pays ${t.to} ${fmt(t.amt)}`)}">
          <span class="r-idx" aria-hidden="true">${idx}</span>
          <span class="r-body" aria-hidden="true">
            <span class="r-crown">♚</span>
            <span class="r-title">${royal.title} of ${suit}</span>
            <span class="r-name">${escapeHtml(t.from)}</span>
            <span class="r-pays">pays</span>
            <span class="r-name">${escapeHtml(t.to)}</span>
            <span class="r-amt">${fmt(t.amt)}</span>
          </span>
          <span class="r-idx br" aria-hidden="true">${idx}</span>
          <span class="r-stamp" aria-hidden="true">PAID</span>
        </button>`;
    }).join('');
  }

  function openFinale() {
    if (!compute().balanced) {
      $('#copyMsg').textContent = 'Make the bank balance first, then finish the game.';
      return;
    }
    dealRoyalCards();
    finale.hidden = false;
    document.body.classList.add('no-scroll');
    Sound.jackpot();
    $('#finaleClose').focus();
  }

  function closeFinale() {
    finale.hidden = true;
    document.body.classList.remove('no-scroll');
    $('#finish').focus();
  }

  $('#finish').addEventListener('click', openFinale);
  $('#finaleClose').addEventListener('click', closeFinale);
  $('#finaleShare').addEventListener('click', () => $('#whatsapp').click());
  finale.addEventListener('click', (e) => { if (e.target === finale) closeFinale(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !finale.hidden) closeFinale();
  });

  // Toggle in place (no re-deal) so the other cards keep floating.
  royalEl.addEventListener('click', (e) => {
    const card = e.target.closest('.royal');
    if (!card) return;
    const key = card.dataset.key;
    const nowPaid = !state.paid.includes(key);
    state.paid = nowPaid ? [...state.paid, key] : state.paid.filter((k) => k !== key);
    card.classList.toggle('paid', nowPaid);
    card.setAttribute('aria-pressed', String(nowPaid));
    if (nowPaid) Sound.pay();
    update();
    $('#finaleSub').textContent = finaleSubtitle(currentSettlement(compute()).transfers);
  });

  $('#copy').addEventListener('click', async () => {
    const text = summaryText();
    const msg = $('#copyMsg');
    try {
      await navigator.clipboard.writeText(text);
      msg.textContent = 'Summary copied. Paste it into your group chat.';
      Sound.pay();
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      msg.textContent = ok ? 'Summary copied.' : 'Copy failed. Your browser blocked clipboard access.';
      if (ok) Sound.pay();
    }
  });

  // ---------- Sound toggle ----------

  const soundBtn = $('#soundToggle');
  function syncSoundButton() {
    const on = Sound.enabled;
    soundBtn.textContent = on ? '🔊' : '🔇';
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
    soundBtn.title = on ? 'Sound on: click to mute' : 'Sound off: click to unmute';
  }
  soundBtn.addEventListener('click', () => {
    Sound.setEnabled(!Sound.enabled);
    syncSoundButton();
    Sound.coin(); // only audible when just switched on
  });
  syncSoundButton();

  // ---------- Background decor: cards and chips scattered on the felt ----------

  const DECOR_CARDS = [
    // rank, suit, left %, top %, rotation (an empty rank is a face-down card)
    ['A', '♠', -2, 6, -18], ['K', '♥', 90, 3, 16], ['Q', '♦', 93, 46, -8], ['J', '♣', -3, 50, 12],
    ['10', '♥', 88, 84, 24], ['A', '♦', 2, 86, -26], ['', '', 82, 22, 35], ['', '', 7, 27, -40],
  ];
  const DECOR_CHIPS = [
    // colour, left %, top %, rotation
    ['#b3202a', 10, 16, 10], ['#1a1a1a', 86, 36, 40], ['#1f4fb3', 92, 68, 0],
    ['#b3202a', 4, 70, 20], ['#c9971f', 84, 93, 70], ['#1a1a1a', 13, 94, 30],
  ];

  function renderDecor() {
    const cards = DECOR_CARDS.map(([rank, suit, x, y, r]) => {
      const pos = `left:${x}%;top:${y}%;--r:${r}deg`;
      if (!rank) return `<div class="pcard back" style="${pos}"></div>`;
      const red = suit === '♥' || suit === '♦' ? ' red' : '';
      return `<div class="pcard${red}" style="${pos}">
        <span class="idx">${rank}<br>${suit}</span>
        <span class="pip">${suit}</span>
        <span class="idx br">${rank}<br>${suit}</span>
      </div>`;
    });
    const chips = DECOR_CHIPS.map(([c, x, y, r]) =>
      `<div class="pchip" style="--c:${c};left:${x}%;top:${y}%;--r:${r}deg"></div>`);
    $('#decor').innerHTML = cards.join('') + chips.join('');
  }
  renderDecor();

  renderPlayers();
})();
