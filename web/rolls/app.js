// Roll Odds — UI wiring. All maths lives in odds.js; this file only reads
// controls, renders, and keeps the URL shareable.
'use strict';

(function () {
  const O = window.RollOdds;

  const $ = (id) => document.getElementById(id);
  const levelSeg = $('levelSeg');
  const costSeg = $('costSeg');
  const goldEl = $('gold');
  const takenEl = $('taken');
  const contestedEl = $('contested');

  const state = { level: 8, cost: 4, gold: 50, taken: 0, contested: 0 };

  // ---- URL state so a setup can be linked ------------------------------
  function readUrl() {
    const q = new URLSearchParams(location.search);
    const num = (k, lo, hi, dflt) => {
      const v = parseInt(q.get(k), 10);
      return Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
    };
    state.level = num('lv', O.MIN_LEVEL, O.MAX_LEVEL, state.level);
    state.cost = num('c', 1, 5, state.cost);
    state.gold = num('g', 0, 100, state.gold);
    state.taken = num('t', 0, 9, state.taken);
    state.contested = num('x', 0, 200, state.contested);
  }

  function writeUrl() {
    const q = new URLSearchParams();
    q.set('lv', state.level);
    q.set('c', state.cost);
    q.set('g', state.gold);
    if (state.taken) q.set('t', state.taken);
    if (state.contested) q.set('x', state.contested);
    history.replaceState(null, '', '?' + q.toString());
  }

  // ---- build controls --------------------------------------------------
  for (let lv = O.MIN_LEVEL; lv <= O.MAX_LEVEL; lv++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = lv;
    b.dataset.level = lv;
    b.addEventListener('click', () => { state.level = lv; render(); });
    levelSeg.appendChild(b);
  }

  for (let c = 1; c <= 5; c++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c + '\u00A0cost';
    b.dataset.cost = c;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      state.cost = c;
      render();
    });
    costSeg.appendChild(b);
  }

  goldEl.addEventListener('input', () => { state.gold = +goldEl.value; render(); });
  takenEl.addEventListener('input', () => { state.taken = +takenEl.value; render(); });
  contestedEl.addEventListener('input', () => { state.contested = +contestedEl.value; render(); });

  // ---- static reference table -----------------------------------------
  function renderOddsTable() {
    const body = $('oddsBody');
    body.innerHTML = '';
    for (let lv = O.MIN_LEVEL; lv <= O.MAX_LEVEL; lv++) {
      const tr = document.createElement('tr');
      tr.dataset.level = lv;
      const th = document.createElement('th');
      th.textContent = lv;
      tr.appendChild(th);
      O.levelOdds(lv).forEach((pct, i) => {
        const td = document.createElement('td');
        td.textContent = pct + '%';
        if (pct === 0) td.className = 'z';
        td.dataset.cost = i + 1;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    const parts = [];
    for (let c = 1; c <= 5; c++) {
      parts.push(`${O.POOL_TYPES[c]}\u00D7${O.POOL_COPIES[c]}`);
    }
    $('poolLine').textContent =
      parts.join('  ·  ') + `  (${totalPool()} units)`;
  }

  function totalPool() {
    let n = 0;
    for (let c = 1; c <= 5; c++) n += O.POOL_TYPES[c] * O.POOL_COPIES[c];
    return n;
  }

  // ---- chart -----------------------------------------------------------
  function renderChart(rolls) {
    const svg = $('chart');
    const W = 600, H = 200, PAD = 6;
    svg.innerHTML = '';

    const ns = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    };

    // horizontal guides at 25/50/75/100%
    [0.25, 0.5, 0.75, 1].forEach((f) => {
      const y = H - PAD - f * (H - PAD * 2);
      svg.appendChild(mk('line', {
        x1: 0, x2: W, y1: y, y2: y,
        stroke: 'var(--edge)', 'stroke-width': 1,
      }));
    });

    if (rolls < 1) return;

    const pts = O.curve(state.cost, state.level, rolls);
    const stepX = W / Math.max(1, rolls);
    let d = '';
    pts.forEach((p, i) => {
      const x = (i + 1) * stepX;
      const y = H - PAD - p.chance * (H - PAD * 2);
      d += (i === 0 ? `M ${(0).toFixed(1)} ${H - PAD} L ` : '') + `${x.toFixed(1)} ${y.toFixed(1)} `;
    });

    svg.appendChild(mk('path', {
      d: d + `L ${W} ${H - PAD} Z`,
      fill: 'var(--acc)', 'fill-opacity': '.13',
    }));
    svg.appendChild(mk('path', {
      d: d.replace(/ Z$/, ''),
      fill: 'none', stroke: 'var(--acc)', 'stroke-width': 2.5,
      'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
    }));
  }

  // ---- main render -----------------------------------------------------
  function render() {
    const row = O.levelOdds(state.level);

    // A cost the level can't roll is impossible, not merely unlikely -- show
    // that in the control itself rather than letting someone read a 0% and
    // wonder if the tool is broken.
    //
    // The currently-selected cost is deliberately left enabled even when its
    // odds are zero: disabling the pressed button strands you on a dead 0%
    // with nothing visibly wrong, and (worse) an aria-pressed disabled control
    // is unreachable by keyboard. Selected stays clickable; the zero state is
    // explained in the headline instead.
    [...costSeg.children].forEach((b) => {
      const c = +b.dataset.cost;
      b.disabled = row[c - 1] === 0 && c !== state.cost;
      b.setAttribute('aria-pressed', String(c === state.cost));
    });
    [...levelSeg.children].forEach((b) => {
      b.setAttribute('aria-pressed', String(+b.dataset.level === state.level));
    });

    // Clamp `taken` to the copies that actually exist at this cost.
    const maxCopies = O.POOL_COPIES[state.cost];
    takenEl.max = maxCopies;
    if (state.taken > maxCopies) state.taken = maxCopies;

    goldEl.value = state.gold;
    takenEl.value = state.taken;
    contestedEl.value = state.contested;

    const rolls = Math.floor(state.gold / 2);
    const opts = { taken: state.taken, contested: state.contested };

    $('goldEcho').textContent = state.gold + 'g';
    $('takenEcho').textContent = state.taken;
    $('contestedEcho').textContent = state.contested;
    $('takenName').textContent = `a ${state.cost}-cost`;

    const perSlot = O.slotChance(state.cost, state.level, opts);
    const perShop = O.shopChance(state.cost, state.level, opts);
    const total = O.rollChance(state.cost, state.level, rolls, opts);
    const exp = O.expectedCopies(state.cost, state.level, rolls, opts);

    const pct = (x) => (x * 100).toFixed(1) + '%';
    const big = $('bigPct');
    big.textContent = row[state.cost - 1] === 0 ? '0%' : pct(total);
    big.className = 'big' + (total >= 0.6 ? '' : total >= 0.3 ? ' warn' : ' bad');

    $('bigSub').textContent = row[state.cost - 1] === 0
      ? `level ${state.level} shops never contain ${state.cost}-costs`
      : rolls === 0
        ? 'spend some gold to see your odds'
        : `chance to hit at least one copy in ${rolls} roll${rolls === 1 ? '' : 's'}`;

    $('perShop').textContent = pct(perShop);
    $('rollCount').textContent = rolls;
    $('expCopies').textContent = exp.toFixed(2);
    $('tierPct').textContent = row[state.cost - 1] + '%';

    $('axMid').textContent = Math.floor(state.gold / 2) + 'g';
    $('axEnd').textContent = state.gold + 'g';

    renderChart(rolls);

    // confidence table
    const body = $('confBody');
    body.innerHTML = '';
    [0.5, 0.75, 0.9, 0.99].forEach((conf) => {
      const tr = document.createElement('tr');
      const res = O.goldFor(state.cost, state.level, conf, opts);
      const cells = res
        ? [Math.round(conf * 100) + '%', res.rolls, res.gold + 'g']
        : [Math.round(conf * 100) + '%', '—', 'impossible'];
      cells.forEach((txt, i) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (i === 2) td.className = res ? 'g' : 'none';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    // highlight the live row/column in the reference table
    document.querySelectorAll('#oddsBody tr').forEach((tr) => {
      tr.classList.toggle('on', +tr.dataset.level === state.level);
      tr.querySelectorAll('td').forEach((td) => {
        td.classList.toggle('hi',
          +tr.dataset.level === state.level && +td.dataset.cost === state.cost);
      });
    });

    writeUrl();
  }

  readUrl();
  renderOddsTable();
  render();
})();
