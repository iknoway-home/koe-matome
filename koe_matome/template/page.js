(() => {
  'use strict';
  // 商品データは koe-matome が作ってこのファイルに埋め込んだもの（#koeData）。
  // 購入記録は選択肢のID（ストアの商品ID）で保存するので、データを作り直しても記録は消えない。
  const PAGE_SIZE = 80;
  let DATA;
  try { DATA = JSON.parse(document.querySelector('#koeData').textContent); } catch { DATA = null; }
  const prefix = `koe-matome:${DATA && DATA.site}:`;
  const notice = document.querySelector('#storageNotice');
  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(prefix + key) || 'null') ?? fallback; }
    catch { notice.hidden = false; return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(prefix + key, JSON.stringify(value)); }
    catch { notice.hidden = false; }
  }
  const idSet = value => new Set(Array.isArray(value) ? value.filter(x => typeof x === 'string') : []);
  const bought = idSet(read('v2', []));
  const wished = idSet(read('wish:v1', []));
  const legacy = idSet(read('v1', []));
  const flags = read('limited:v1', {});
  const limited = flags && typeof flags === 'object' && !Array.isArray(flags) ? flags : {};
  // 初めて開いたときは、データを作るときに指定したライバーを選んでおく。
  const picked = idSet(read('members:v1', DATA ? DATA.defaultPicked : []));
  const number = new Intl.NumberFormat('ja-JP');
  const yen = value => `${number.format(value)}円`;
  const $ = selector => document.querySelector(selector);
  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const jstDay = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
  const jstTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
  const jstFull = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  const search = $('#search');
  const hideBought = $('#hideBought');
  const limitedOnly = $('#limitedOnly');
  const onSaleOnly = $('#onSaleOnly');
  const wishOnly = $('#wishOnly');
  const filters = $('#filters');
  const table = $('#purchaseTable');
  const more = $('#moreGroups');
  const confirmBox = $('#buyConfirm');
  const confirmHome = $('#confirmHome');
  const confirmText = $('#confirmText');
  const confirmYes = $('#confirmYes');
  const loadState = $('#loadState');

  let members = [], memberByKey = new Map(), groups = [], itemById = new Map();
  let active = 'all', pending = null, shownLimit = PAGE_SIZE;

  // ---- データの読み込み ----

  function parse(data) {
    members = data.members.map(([key, name, branch, listed, selectable]) => ({ key, name, branch, listed: listed === 1, selectable: selectable === 1, count: 0 }));
    memberByKey = new Map(members.map(m => [m.key, m]));
    groups = data.groups.map(([id, title, isLimited, start, end, onSale, , rows]) => {
      const g = {
        id, title, limitedByShop: isLimited === 1,
        start: start ? Date.parse(start) : NaN, end: end ? Date.parse(end) : NaN,
        startText: start, endText: end, shopEnded: onSale === 0, body: null, items: []
      };
      for (const [itemId, name, price, liverIndexes, pid, gone] of rows) {
        const livers = liverIndexes.map(i => members[i]).filter(Boolean);
        const item = {
          id: itemId, name, price, pid, gone: gone === 1, group: g, row: null,
          livers: livers.map(m => m.key), text: `${title} ${name} ${livers.map(m => m.name).join(' ')}`.toLocaleLowerCase('ja')
        };
        g.items.push(item);
        itemById.set(itemId, item);
      }
      g.livers = new Set(g.items.flatMap(item => item.livers));
      g.livers.forEach(key => memberByKey.get(key).count++);
      return g;
    });
  }

  // ---- 状態の判定 ----

  function flagged(g) { return g.limitedByShop || limited[g.id] === true; }
  function phase(g, now) {
    if (Number.isFinite(g.end) && now > g.end) return 'ended';
    if (Number.isFinite(g.start) && now < g.start) return 'before';
    if (Number.isFinite(g.end)) return 'on';
    return g.shopEnded ? 'ended' : 'open';
  }
  // 販売期間が分からない常設品は購入できるものとして残す。ストアから消えた選択肢は販売終了。
  function purchasable(item, now) {
    const p = phase(item.group, now);
    return !item.gone && (p === 'on' || p === 'open');
  }
  function memberMatch(item) {
    if (active === 'all' || active === 'both') return item.livers.some(key => picked.has(key));
    return item.livers.includes(active);
  }
  function pickedInGroup(g) {
    let n = 0;
    for (const key of g.livers) if (picked.has(key)) n++;
    return n;
  }

  // ---- 描画 ----

  function renderGroup(g) {
    const body = make('tbody');
    body.dataset.group = g.id;
    const head = make('tr', 'group-row');
    const th = make('th');
    th.colSpan = 6;
    th.scope = 'rowgroup';
    const heading = make('div', 'group-heading');
    heading.append(make('span', '', g.title));
    g.badge = heading.appendChild(make('span', 'sale-badge', '期間限定'));
    g.status = heading.appendChild(make('span', 'sale-status'));
    g.clock = heading.appendChild(make('span', 'countdown'));
    g.clock.hidden = true;
    const meta = make('div', 'group-meta');
    g.count = make('span', 'group-progress');
    meta.append(g.count);
    if (g.startText || g.endText) {
      const range = `${g.startText ? jstFull.format(g.start) : ''} 〜 ${g.endText ? jstFull.format(g.end) : ''}（日本時間）`;
      meta.append(` · ${range}`);
    }
    th.append(heading, meta);
    if (legacy.has(g.id)) th.append(make('span', 'legacy-note', '旧チェックあり：以前は企画単位のため、購入した商品を下で確認してください。'));
    if (!g.limitedByShop) {
      const label = make('label', 'manual-flag');
      g.flag = make('input', 'limited-check');
      g.flag.type = 'checkbox';
      label.append(g.flag, '期間限定マーク');
      th.append(label);
    }
    head.append(th);
    body.append(head);
    g.head = head;
    g.body = body;
    return body;
  }

  function renderItem(item) {
    const row = make('tr');
    row.dataset.item = item.id;
    const check = make('input', 'buy-check');
    check.type = 'checkbox';
    check.setAttribute('aria-label', `${item.name}を購入済みにする`);
    const product = make('td', 'product', item.name);
    if (item.gone) product.append(make('small', 'gone-note', 'ストアの選択肢から消えた商品'));
    const voices = make('td', 'voices-cell');
    for (const key of item.livers) {
      const m = memberByKey.get(key);
      voices.append(make('span', `voice${picked.has(key) ? ' is-picked' : ''}`, m.name), ' ');
    }
    const wish = make('button', 'wish-btn', 'ほしい');
    wish.type = 'button';
    wish.setAttribute('aria-label', `${item.name}をほしいに入れる`);
    const link = make('a', 'shop-link', '販売ページ');
    link.href = DATA.productUrl.replace('{pid}', encodeURIComponent(item.pid));
    link.target = '_blank';
    link.rel = 'noopener';
    const cells = [make('td', 'check-cell'), product, voices, make('td', 'price-cell', yen(item.price)), make('td', 'wish-cell'), make('td', 'links-cell')];
    cells[0].append(check);
    cells[4].append(wish);
    cells[5].append(link);
    row.append(...cells);
    Object.assign(item, { row, check, wish });
    return row;
  }

  function closeConfirm(focusBack) {
    if (!pending) return;
    const item = pending.item;
    pending = null;
    confirmBox.hidden = true;
    confirmHome.append(confirmBox);
    item.check.checked = bought.has(item.id);
    if (focusBack) item.check.focus();
  }
  function openConfirm(item, next) {
    closeConfirm(false);
    pending = { item, next };
    item.check.checked = bought.has(item.id);
    confirmText.textContent = next
      ? `「${item.name}」を購入済みにしますか？`
      : `「${item.name}」の購入済みを取り消しますか？`;
    confirmYes.textContent = next ? '購入済みにする' : '取り消す';
    item.row.querySelector('.product').append(confirmBox);
    confirmBox.hidden = false;
    confirmYes.focus();
  }

  function refresh() {
    const q = search.value.trim().toLocaleLowerCase('ja');
    const now = Date.now();
    let visible = 0, visibleYen = 0, purchased = 0, purchasedYen = 0;
    let wantCount = 0, wantYen = 0, groupCount = 0;
    const order = [];
    for (const g of groups) {
      if (active === 'both' && pickedInGroup(g) < 2) { g.shown = []; continue; }
      const isFlagged = flagged(g);
      const shown = g.items.filter(item => {
        const checked = bought.has(item.id);
        return memberMatch(item)
          && (!q || item.text.includes(q))
          && (!hideBought.checked || !checked)
          && (!limitedOnly.checked || isFlagged)
          && (!onSaleOnly.checked || purchasable(item, now))
          && (!wishOnly.checked || wished.has(item.id));
      });
      g.shown = shown;
      if (!shown.length) continue;
      groupCount++;
      order.push(g);
      for (const item of shown) {
        visible++; visibleYen += item.price;
        if (bought.has(item.id)) { purchased++; purchasedYen += item.price; }
        else if (wished.has(item.id)) { wantCount++; wantYen += item.price; }
      }
    }

    // 表示する企画だけDOMに置く。件数が多いので PAGE_SIZE 企画ずつ出す。
    const rendered = order.slice(0, shownLimit);
    const keep = new Set(rendered);
    for (const g of groups) if (g.body && !keep.has(g) && g.body.isConnected) g.body.remove();
    let anchor = table.tHead;
    for (const g of rendered) {
      if (!g.body) renderGroup(g);
      if (anchor.nextSibling !== g.body) anchor.after(g.body);
      anchor = g.body;
      paintGroup(g, now);
    }
    if (pending && !pending.item.row.isConnected) closeConfirm(false);
    const rest = order.length - rendered.length;
    more.hidden = rest <= 0;
    more.textContent = `残り ${rest}企画を表示（次の${Math.min(rest, PAGE_SIZE)}企画）`;

    $('#visibleCount').textContent = visible;
    $('#visibleYen').textContent = `合計 ${yen(visibleYen)}`;
    $('#boughtCount').textContent = purchased;
    $('#boughtYen').textContent = yen(purchasedYen);
    $('#remainingCount').textContent = visible - purchased;
    $('#remainingYen').textContent = yen(visibleYen - purchasedYen);
    $('#wishCount').textContent = wantCount;
    $('#wishYen').textContent = yen(wantYen);
    $('#resultText').textContent = picked.size ? `${groupCount}企画・${visible}点を表示` : 'ライバーを選ぶと商品が表示されます';
    $('#empty').classList.toggle('show', visible === 0);
    tick();
  }

  function paintGroup(g, now) {
    const isFlagged = flagged(g);
    if (g.flag) g.flag.checked = isFlagged;
    g.badge.hidden = !isFlagged;
    const p = phase(g, now);
    g.status.textContent = p === 'ended' ? '販売終了' : p === 'before' ? '販売開始前' : p === 'on' ? '期間内' : isFlagged ? '販売期間未確認' : '';
    // 行は表示する商品の分だけ作る（大人数の企画は数百行あるため）。並びは元データの順を保つ。
    const shown = new Set(g.shown);
    let done = 0, total = 0, want = 0, wantSum = 0, prev = g.head;
    for (const item of g.items) {
      const checked = bought.has(item.id);
      const isWished = wished.has(item.id);
      if (item.livers.some(key => picked.has(key))) {
        total++;
        if (checked) done++;
        if (isWished && !checked) { want++; wantSum += item.price; }
      }
      if (!item.row && !shown.has(item)) continue;
      if (!item.row) renderItem(item);
      if (prev.nextSibling !== item.row) prev.after(item.row);
      prev = item.row;
      if (!pending || pending.item !== item) item.check.checked = checked;
      item.wish.setAttribute('aria-pressed', String(isWished));
      item.row.classList.toggle('is-bought', checked);
      item.row.classList.toggle('is-wished', isWished && !checked);
      item.row.hidden = !shown.has(item);
      item.row.querySelectorAll('.voice').forEach((el, i) => el.classList.toggle('is-picked', picked.has(item.livers[i])));
    }
    g.count.textContent = `${done} / ${total}点 購入済み` + (want ? ` · ほしい ${want}点 ${yen(wantSum)}` : '');
  }

  // ---- ライバー選択 ----

  const pickPanel = $('#pickPanel');
  const pickToggle = $('#pickToggle');
  const pickSearch = $('#pickSearch');
  const pickLists = $('#pickLists');

  function renderPicker() {
    const sections = [
      ['にじさんじ', m => m.listed && m.branch === 'JP'],
      ['NIJISANJI EN', m => m.listed && m.branch === 'EN'],
      ['ストアの一覧にいないライバー（卒業など）', m => !m.listed]
    ];
    pickLists.replaceChildren(...sections.map(([title, test]) => [title, members.filter(m => test(m) && m.selectable && m.count > 0)])
      .filter(([, list]) => list.length).map(([title, list]) => {
      const box = make('fieldset', 'pick-group');
      box.append(make('legend', '', `${title}（${list.length}人）`));
      const grid = make('div', 'pick-grid');
      for (const m of list) {
        const label = make('label', 'pick-item');
        const input = make('input');
        input.type = 'checkbox';
        input.value = m.key;
        input.checked = picked.has(m.key);
        label.dataset.name = m.name.toLocaleLowerCase('ja');
        const text = make('span', 'pick-text');
        text.append(make('b', '', m.name), make('small', '', `${m.count}企画`));
        label.append(input, text);
        grid.append(label);
      }
      box.append(grid);
      return box;
    }));
  }

  function renderFilters() {
    const chips = [['all', `選択中すべて（${picked.size}人）`]];
    for (const m of members) if (picked.has(m.key)) chips.push([m.key, m.name]);
    if (picked.size >= 2) chips.push(['both', '複数人いる企画']);
    if (!chips.some(([key]) => key === active)) active = 'all';
    filters.replaceChildren(...chips.map(([key, label]) => {
      const button = make('button', '', label);
      button.type = 'button';
      button.dataset.filter = key;
      button.setAttribute('aria-pressed', String(key === active));
      return button;
    }));
  }

  function setPicked() {
    save('members:v1', [...picked]);
    shownLimit = PAGE_SIZE;
    renderFilters();
    refresh();
  }

  pickToggle.addEventListener('click', () => {
    const open = pickPanel.hidden;
    pickPanel.hidden = !open;
    pickToggle.setAttribute('aria-expanded', String(open));
    if (open) pickSearch.focus();
  });
  $('#pickClose').addEventListener('click', () => {
    pickPanel.hidden = true;
    pickToggle.setAttribute('aria-expanded', 'false');
    pickToggle.focus();
  });
  $('#pickClear').addEventListener('click', () => {
    picked.clear();
    pickLists.querySelectorAll('input').forEach(input => input.checked = false);
    setPicked();
  });
  pickLists.addEventListener('change', event => {
    const input = event.target;
    input.checked ? picked.add(input.value) : picked.delete(input.value);
    setPicked();
  });
  pickSearch.addEventListener('input', () => {
    const q = pickSearch.value.trim().toLocaleLowerCase('ja');
    pickLists.querySelectorAll('.pick-item').forEach(label => label.hidden = !!q && !label.dataset.name.includes(q));
  });

  // ---- 操作 ----

  filters.addEventListener('click', event => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    active = button.dataset.filter;
    filters.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    shownLimit = PAGE_SIZE;
    refresh();
  });
  more.addEventListener('click', () => { shownLimit += PAGE_SIZE; refresh(); });
  table.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('.buy-check')) {
      const item = itemById.get(target.closest('tr').dataset.item);
      if (item) openConfirm(item, target.checked);
    } else if (target.matches('.limited-check')) {
      limited[target.closest('tbody').dataset.group] = target.checked;
      save('limited:v1', limited);
      refresh();
    }
  });
  table.addEventListener('click', event => {
    const button = event.target.closest('.wish-btn');
    if (!button) return;
    const id = button.closest('tr').dataset.item;
    wished.has(id) ? wished.delete(id) : wished.add(id);
    save('wish:v1', [...wished]);
    refresh();
  });
  confirmYes.addEventListener('click', () => {
    if (!pending) return;
    const { item, next } = pending;
    next ? bought.add(item.id) : bought.delete(item.id);
    save('v2', [...bought]);
    closeConfirm(true);
    alertKey = '';
    refresh();
  });
  $('#confirmNo').addEventListener('click', () => closeConfirm(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeConfirm(true);
  });
  for (const input of [search, hideBought, onSaleOnly, limitedOnly, wishOnly]) {
    input.addEventListener('input', () => { shownLimit = PAGE_SIZE; refresh(); });
  }

  // ---- カウントダウン ----
  // 選んだライバーの、未購入が残っている販売中の企画を締切が近い順に上部へ出す。

  const alertBox = $('#deadlineAlert');
  const alertTop = $('#daTop');
  const alertList = $('#daList');
  const pad = n => String(n).padStart(2, '0');
  const DAY = 86400000;
  function left(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(sec / 86400);
    const hms = `${pad(Math.floor(sec % 86400 / 3600))}:${pad(Math.floor(sec % 3600 / 60))}:${pad(sec % 60)}`;
    return d ? `${d}日 ${hms}` : hms;
  }
  function untilLabel(end, now) {
    const day = jstDay.format(end);
    const when = day === jstDay.format(now) ? '今日' : day === jstDay.format(now + DAY) ? '明日' : day;
    return `${when} ${jstTime.format(end)}まで`;
  }
  let alertKey = '', lastPhaseKey = '';
  function tick() {
    const now = Date.now();
    const urgent = [];
    let phaseKey = '';
    for (const g of groups) {
      if (!Number.isFinite(g.end)) continue;
      const p = phase(g, now);
      phaseKey += p[0];
      if (g.clock && g.body && g.body.isConnected) {
        g.clock.hidden = p === 'ended';
        if (p === 'before') {
          g.clock.className = 'countdown is-before';
          g.clock.textContent = `開始まで ${left(g.start - now)}`;
        } else if (p === 'on') {
          const rest = g.end - now;
          g.clock.className = 'countdown' + (rest <= DAY ? ' is-urgent' : rest <= 3 * DAY ? ' is-soon' : '');
          g.clock.textContent = `⏰ 残り ${left(rest)}`;
        }
      }
      if (p !== 'on') continue;
      const unbought = g.items.filter(item => !item.gone && item.livers.some(key => picked.has(key)) && !bought.has(item.id));
      if (unbought.length) urgent.push({ g, rest: g.end - now, unbought });
    }
    urgent.sort((a, b) => a.rest - b.rest);
    const shown = urgent.slice(0, 3);
    const key = shown.map(u => `${u.g.id}:${u.unbought.length}`).join('|');
    if (key !== alertKey) {
      alertKey = key;
      alertList.replaceChildren(...shown.map(u => {
        const li = make('li', 'da-row');
        li.innerHTML = '<span class="da-clock"></span><span class="da-what"><b></b><small></small></span><a class="da-go" target="_blank" rel="noopener">今すぐ買う →</a>';
        li.querySelector('b').textContent = u.g.title;
        li.querySelector('.da-go').href = DATA.productUrl.replace('{pid}', encodeURIComponent(u.unbought[0].pid));
        li.dataset.rest = `未購入 ${u.unbought.length}点・${yen(u.unbought.reduce((sum, item) => sum + item.price, 0))}`;
        return li;
      }));
    }
    alertBox.hidden = shown.length === 0;
    shown.forEach((u, i) => {
      const li = alertList.children[i];
      li.classList.toggle('is-later', u.rest > DAY);
      li.querySelector('.da-clock').textContent = left(u.rest);
      li.querySelector('small').textContent = `${untilLabel(u.g.end, now)} · ${li.dataset.rest}`;
    });
    if (shown.length) {
      const first = shown[0];
      alertTop.textContent = first.rest > DAY ? '販売終了が近い商品'
        : jstDay.format(first.g.end) === jstDay.format(now) ? '本日終了！ 買い逃し注意' : 'まもなく販売終了！ 買い逃し注意';
    }
    // 販売開始・終了をまたいだら表示対象が変わるので一覧を作り直す。
    if (lastPhaseKey && phaseKey !== lastPhaseKey) { lastPhaseKey = phaseKey; refresh(); return; }
    lastPhaseKey = phaseKey;
  }

  // ---- 購入履歴から取り込む ----
  // ストアの購入履歴ページや注文確認メールを貼り付けてもらい、書かれた商品名から購入済みの候補を探す。
  // 文章はこのページの中で照合するだけで、保存も送信もしない。同じ商品が何度出てきても1回として数え、
  // すでに購入済みの商品は変えないので、同じ文章を何度貼っても記録は壊れない。

  const historyStatus = $('#historyStatus');
  const historyResult = $('#historyResult');
  const historyList = $('#historyList');
  let historyMatches = [];
  let historyIndex = null;
  const normText = text => text.normalize('NFKC').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').toLowerCase();
  const coreTitle = title => normText(title.replace(/^(【[^】]*】\s*)+/, '').replace(/\s*[-－–‐]\s*(?:[A-Z]|EN)グループ$/, '')).trim();
  function historyTell(text, isError) {
    historyStatus.textContent = text;
    historyStatus.classList.toggle('is-error', !!isError);
  }
  // 商品名 → 同じ名前の商品。長い名前から照合し、「EX 〇〇」の中の「〇〇」を二重に拾わないようにする。
  function buildHistoryIndex() {
    const byName = new Map();
    for (const g of groups) {
      for (const item of g.items) {
        const key = normText(item.name).trim();
        if (key.length < 4) continue;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(item);
      }
    }
    return [...byName.entries()].sort((a, b) => b[0].length - a[0].length);
  }
  function matchHistory(text) {
    historyIndex = historyIndex || buildHistoryIndex();
    const src = normText(text);
    const used = new Uint8Array(src.length);
    const found = new Map();
    for (const [key, items] of historyIndex) {
      for (let pos = src.indexOf(key); pos !== -1; pos = src.indexOf(key, pos + 1)) {
        if (used.subarray(pos, pos + key.length).some(Boolean)) continue;
        used.fill(1, pos, pos + key.length);
        let pick = items;
        if (items.length > 1) {
          // 同じ名前の商品が複数あるとき（再販や「コンプリートセット」など）は、近くに企画名があるものに絞る。
          const around = src.slice(Math.max(0, pos - 300), pos + key.length + 300);
          const narrowed = items.filter(item => {
            const title = coreTitle(item.group.title);
            return title.length >= 2 && around.includes(title);
          });
          if (narrowed.length) pick = narrowed;
          else if (items.length > 3) continue; // 名前だけでは決めようがない
        }
        const ambiguous = pick.length > 1;
        for (const item of pick) {
          const seen = found.get(item.id);
          if (!seen) found.set(item.id, { item, ambiguous });
          else if (!ambiguous) seen.ambiguous = false;
        }
      }
    }
    const order = new Map(groups.map((g, i) => [g, i]));
    return [...found.values()].sort((a, b) => order.get(a.item.group) - order.get(b.item.group) || a.item.name.localeCompare(b.item.name, 'ja'));
  }
  function renderHistory() {
    const fresh = historyMatches.filter(m => !bought.has(m.item.id));
    $('#historySummary').textContent = `見つかった商品 ${historyMatches.length}点（うち購入済み ${historyMatches.length - fresh.length}点）。`
      + (fresh.length ? '購入済みにする商品にチェックを付けて確定してください。' : '新しく購入済みにする商品はありません。');
    historyList.replaceChildren(...historyMatches.map(({ item, ambiguous }) => {
      const li = make('li');
      const label = make('label');
      const done = bought.has(item.id);
      const box = make('input');
      box.type = 'checkbox';
      box.value = item.id;
      box.checked = !done && !ambiguous;
      box.disabled = done;
      const text = make('span', 'history-text');
      text.append(make('b', '', item.name), make('small', '', `${item.group.title} · ${yen(item.price)}`));
      if (done) text.append(make('small', 'history-note', '購入済み（変更なし）'));
      else if (ambiguous) text.append(make('small', 'history-note', '同じ名前の商品がほかにもあるため、確かめてからチェックしてください'));
      label.append(box, text);
      li.append(label);
      return li;
    }));
    $('#historyApply').hidden = fresh.length === 0;
    historyResult.hidden = false;
  }
  $('#historyMatch').addEventListener('click', () => {
    const text = $('#historyIn').value;
    if (!text.trim()) { historyTell('購入履歴の文章を貼り付けてください。', true); return; }
    historyMatches = matchHistory(text);
    historyTell('');
    if (!historyMatches.length) {
      historyResult.hidden = true;
      historyTell('商品名が見つかりませんでした。購入履歴ページの商品名が入るように、ページ全体をコピーしてください。', true);
      return;
    }
    renderHistory();
  });
  $('#historyApply').addEventListener('click', () => {
    const ids = [...historyList.querySelectorAll('input:checked:not(:disabled)')].map(box => box.value);
    if (!ids.length) { historyTell('購入済みにする商品にチェックを付けてください。', true); return; }
    const before = bought.size;
    ids.forEach(id => bought.add(id));
    save('v2', [...bought]);
    alertKey = '';
    refresh();
    renderHistory();
    historyTell(`${bought.size - before}点を購入済みにしました。`);
  });
  $('#historyCancel').addEventListener('click', () => {
    historyResult.hidden = true;
    historyMatches = [];
    historyTell('');
  });

  // ---- 記録の引き継ぎ ----
  // 書き出し形式（ファイル・コード共通）。項目を足すときは version を上げ、古い形式も読めるようにする。
  // コードは JSON を deflate で圧縮して base64url にし、先頭に形式を付ける（圧縮できないブラウザは NVP0）。

  const APP = 'koe-matome';
  // 旧形式（nijisanji-voice-purchases）の記録も読める。そちらのIDは「企画:ライバー:選択肢」なので末尾だけ使う。
  const LEGACY_APP = 'nijisanji-voice-purchases';
  // 利用者に見せてよい理由だけ user を付けて投げる。それ以外（壊れたデータなど）は共通の文言にする。
  const fail = text => Object.assign(new Error(text), { user: true });
  const reason = (e, fallback) => e && e.user ? e.message : fallback;
  const transferStatus = $('#transferStatus');
  function tell(text, isError) {
    transferStatus.textContent = text;
    transferStatus.classList.toggle('is-error', !!isError);
  }
  function snapshot() {
    return {
      app: APP, site: DATA.site, version: 1, exportedAt: new Date().toISOString(),
      bought: [...bought], wished: [...wished], limited: { ...limited },
      members: [...picked], legacy: [...legacy]
    };
  }
  const toBase64Url = bytes => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromBase64Url = text => {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, ch => ch.charCodeAt(0));
  };
  async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }
  async function encode(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    if (typeof CompressionStream === 'function') return 'NVP1:' + toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')));
    return 'NVP0:' + toBase64Url(bytes);
  }
  async function decode(code) {
    const text = code.replace(/\s+/g, '');
    const [head, body] = [text.slice(0, 5), text.slice(5)];
    if (head === 'NVP0:') return JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    if (head !== 'NVP1:') throw fail('このページの引き継ぎコードではありません。');
    if (typeof DecompressionStream !== 'function') throw fail('このブラウザは圧縮されたコードを読めません。ファイルで移してください。');
    return JSON.parse(new TextDecoder().decode(await pipe(fromBase64Url(body), new DecompressionStream('deflate-raw'))));
  }
  // 外から来たデータは形を確かめ、文字列IDだけを取り出す。
  function validate(data) {
    const isLegacy = data && data.app === LEGACY_APP;
    if (!data || !(data.app === APP || isLegacy) || typeof data.version !== 'number') throw fail('このページの記録ではありません。');
    if (data.site && data.site !== DATA.site) throw fail('別のサイトの記録です。');
    if (data.version > 1) throw fail('新しい形式の記録です。ページを最新にしてから読み込んでください。');
    const ids = value => (Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.length < 200) : [])
      .map(x => isLegacy ? x.slice(x.lastIndexOf(':') + 1) : x);
    const flagsIn = data.limited && typeof data.limited === 'object' && !Array.isArray(data.limited) ? data.limited : {};
    const cleanFlags = {};
    for (const [key, value] of Object.entries(flagsIn)) if (typeof value === 'boolean' && key.length < 200) cleanFlags[key] = value;
    return { bought: ids(data.bought), wished: ids(data.wished), limited: cleanFlags, members: isLegacy ? [] : ids(data.members), legacy: ids(data.legacy) };
  }
  function apply(data) {
    const replace = document.querySelector('input[name="importMode"]:checked').value === 'replace';
    const before = bought.size;
    const pairs = [[bought, data.bought], [wished, data.wished], [picked, data.members], [legacy, data.legacy]];
    for (const [set, list] of pairs) {
      if (replace) set.clear();
      list.forEach(id => set.add(id));
    }
    if (replace) for (const key of Object.keys(limited)) delete limited[key];
    Object.assign(limited, data.limited);
    for (const key of [...picked]) if (!memberByKey.has(key)) picked.delete(key);
    save('v2', [...bought]);
    save('wish:v1', [...wished]);
    save('limited:v1', limited);
    save('members:v1', [...picked]);
    save('v1', [...legacy]);
    // 描画済みの行は古い状態を持つので捨てて作り直す。
    for (const g of groups) {
      if (g.body) g.body.remove();
      g.body = null;
      g.items.forEach(item => { item.row = null; });
    }
    closeConfirm(false);
    alertKey = '';
    renderPicker();
    setPicked();
    const known = data.bought.filter(id => itemById.has(id)).length;
    tell(`${replace ? '置き換えました' : '足しました'}。購入済み ${before}点 → ${bought.size}点（読み込んだ記録 ${data.bought.length}点のうち、今の一覧にある商品 ${known}点）。`);
  }

  $('#exportFile').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 1)], { type: 'application/json' });
    const link = make('a');
    link.href = URL.createObjectURL(blob);
    link.download = `nijisanji-voice-record-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    tell(`ファイルに保存しました（購入済み ${bought.size}点・ほしい ${wished.size}点）。`);
  });
  $('#exportCode').addEventListener('click', async () => {
    const out = $('#codeOut');
    out.value = await encode(snapshot());
    out.hidden = false;
    out.select();
    try {
      await navigator.clipboard.writeText(out.value);
      tell(`引き継ぎコードをコピーしました（${out.value.length}文字）。別の端末の「読み込む」に貼り付けてください。`);
    } catch {
      tell('コピーできなかったので、下の欄のコードを選んでコピーしてください。');
    }
  });
  $('#importFile').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 5e6) throw fail('ファイルが大きすぎます。');
      apply(validate(JSON.parse(await file.text())));
    } catch (e) {
      tell(`読み込めませんでした：${reason(e, 'ファイルの中身が壊れています。')}`, true);
    }
  });
  $('#importCode').addEventListener('click', async () => {
    const input = $('#codeIn');
    if (!input.value.trim()) { tell('引き継ぎコードを貼り付けてください。', true); return; }
    try {
      apply(validate(await decode(input.value)));
      input.value = '';
    } catch (e) {
      tell(`読み込めませんでした：${reason(e, 'コードが途中で切れているか、壊れています。')}`, true);
    }
  });

  // ---- 起動 ----

  if (!DATA || DATA.format !== 1) {
    loadState.textContent = '商品データを読み込めませんでした。koe-matome でファイルを作り直してください。';
    loadState.classList.add('is-error');
    return;
  }
  parse(DATA);
  for (const key of [...picked]) if (!memberByKey.has(key)) picked.delete(key);
  renderPicker();
  renderFilters();
  loadState.hidden = true;
  document.querySelectorAll('[data-interactive]').forEach(el => el.disabled = false);
  refresh();
  setInterval(tick, 1000);
})();
