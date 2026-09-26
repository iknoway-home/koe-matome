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

  // 英語表記（例：Shioriha Ruri）を小文字の語に分ける。ダウンロードしたファイル名との照合に使う。
  const enParts = en => (en || '').normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  function parse(data) {
    members = data.members.map(([key, name, branch, listed, selectable, en]) => ({ key, name, branch, listed: listed === 1, selectable: selectable === 1, count: 0, enParts: enParts(en) }));
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
  // 購入履歴ページや注文確認メールの文章、ダウンロードしたボイスのファイルから、購入済みの候補を探す。
  // 文章やファイルはこのページの中で読むだけで、保存も送信もしない。音声は再生も解析もせず、ファイル名と曲名タグだけ見る。
  // 候補は確かめてから記録する。同じ商品が何度出てきても1回として数え、購入済みの商品は変えないので、何度入れても記録は壊れない。

  const historyStatus = $('#historyStatus');
  const historyResult = $('#historyResult');
  const historyList = $('#historyList');
  let historyMatches = [];   // 商品名がそのまま書かれていたもの [{ item, ambiguous }]
  let historyQuestions = []; // 名前の近い候補 [{ label, candidates: [{ item, score }], pick }]
  let historyIndex = null, gramIndex = null, groupOrder = null;
  const normText = text => text.normalize('NFKC').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').toLowerCase();
  const coreTitle = title => normText(title.replace(/^(【[^】]*】\s*)+/, '').replace(/\s*[-－–‐]\s*(?:[A-Z]|EN)グループ$/, '')).trim();
  const itemText = item => item.norm || (item.norm = normText(`${item.group.title} ${item.name}`));
  const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
  function historyTell(text, isError) {
    historyStatus.textContent = text;
    historyStatus.classList.toggle('is-error', !!isError);
  }
  function byGroupOrder(a, b) {
    groupOrder = groupOrder || new Map(groups.map((g, i) => [g, i]));
    return groupOrder.get(a.group) - groupOrder.get(b.group) || a.name.localeCompare(b.name, 'ja');
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
        // 短い商品名（「ありがとう」など）は普通の文にも出てくるので、近くに企画名があるときだけ数える。
        if (key.length < 8) {
          const around = src.slice(Math.max(0, pos - 300), pos + key.length + 300);
          pick = items.filter(item => {
            const title = coreTitle(item.group.title);
            return title.length >= 2 && title !== key && around.includes(title);
          });
          if (!pick.length) continue;
        } else if (items.length > 1) {
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
          if (!seen) found.set(item.id, { item, ambiguous, key });
          else if (!ambiguous) seen.ambiguous = false;
        }
      }
    }
    return [...found.values()];
  }

  // 名前が少し違う行（「【再販】」の有無、空白や記号の違い、商品名の省略など）は、2文字ずつの並びの重なりで近い商品を探す。
  // どの商品にもよく出てくる並び（「ボイ」「イス」など）は手がかりにならないので数えない。
  function grams(text) {
    const s = normText(text).replace(/[\s【】「」『』()（）\[\]・,、。:：/／\-–—_~〜～]+/g, '');
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  }
  function buildGramIndex() {
    const items = groups.flatMap(g => g.items);
    const index = new Map();
    items.forEach((item, n) => {
      for (const gram of grams(itemText(item))) {
        let list = index.get(gram);
        if (!list) index.set(gram, list = []);
        list.push(n);
      }
    });
    return { items, index, common: Math.max(50, items.length / 12) };
  }
  function similarItems(line, max) {
    gramIndex = gramIndex || buildGramIndex();
    const { items, index, common } = gramIndex;
    const mine = [...grams(line)].filter(gram => !(index.get(gram)?.length > common));
    if (mine.length < 4) return [];
    const hits = new Map();
    for (const gram of mine) for (const n of index.get(gram) || []) hits.set(n, (hits.get(n) || 0) + 1);
    return [...hits]
      .map(([n, count]) => ({ item: items[n], score: count / mine.length }))
      .filter(c => c.score >= 0.6)
      .sort((a, b) => b.score - a.score || byGroupOrder(a.item, b.item))
      .slice(0, max);
  }

  // ダウンロードしたファイルの名前（shioriha-ruri-birthday2026.mp3 など）は英語とローマ字なので、
  // ライバーの英語表記・年・下の対応表の言葉で照合する。商品名を英訳したデータは持たない。
  const WORDS = [
    { file: ['birthday', 'bday', 'tanjobi', 'tanjoubi'], item: ['誕生日', 'birthday'] },
    { file: ['anniversary', 'anniv', 'aniv', 'shunen'], item: ['周年', 'anniversary'] },
    { file: ['christmas', 'xmas'], item: ['クリスマス', 'christmas'] },
    { file: ['valentine', 'valentines'], item: ['バレンタイン', 'valentine'] },
    { file: ['whiteday'], item: ['ホワイトデー', 'white day'] },
    { file: ['halloween'], item: ['ハロウィン', 'halloween'] },
    { file: ['newyear', 'shogatsu', 'oshogatsu'], item: ['正月', '年末年始', '新年', 'new year'] },
    { file: ['situation'], item: ['シチュエーション', 'situation'] },
    { file: ['welcome'], item: ['welcome'] },
    { file: ['debut'], item: ['デビュー', 'debut'] },
    { file: ['graduation'], item: ['卒業', 'graduation'] },
    { file: ['seasonal', 'season', 'kisetsu'], item: ['季節', 'season'] },
    { file: ['spring', 'haru'], item: ['春', 'spring'] },
    { file: ['summer', 'natsu'], item: ['夏', 'summer'] },
    { file: ['autumn', 'fall', 'aki'], item: ['秋', 'autumn'] },
    { file: ['winter', 'fuyu'], item: ['冬', 'winter'] },
    { file: ['sleep', 'goodnight', 'oyasumi'], item: ['睡眠', 'おやすみ', 'sleep'] },
    { file: ['wakeup', 'morning', 'ohayo', 'mezame'], item: ['お目覚め', 'おはよう', 'morning'] },
    { file: ['goods'], item: ['グッズ', 'goods'] },
    { file: ['resale', 'rerun', 'saihan'], item: ['再販'] },
    { file: ['diet'], item: ['ダイエット', 'diet'] },
    { file: ['family', 'kazoku'], item: ['家族', 'family'] },
    { file: ['idol'], item: ['アイドル', 'idol'] },
    { file: ['fairytale', 'douwa'], item: ['童話', 'fairy'] },
    { file: ['parallel'], item: ['パラレル', 'parallel'] },
    { file: ['encourage', 'cheer', 'hagemashi'], item: ['励まし', 'cheer'] },
    { file: ['scold', 'oshikari'], item: ['お叱り', 'scold'] },
    { file: ['pamper', 'amayakashi'], item: ['甘やかし', 'pamper'] },
    { file: ['farewell', 'owakare'], item: ['お別れ', 'farewell'] },
    { file: ['tipsy', 'horoyoi'], item: ['ほろ酔い', 'tipsy'] },
    { file: ['kaiki', 'horror'], item: ['怪奇', 'horror'] },
    { file: ['mini'], item: ['ミニ', 'mini'] },
    // 版の違い。ファイル名にない版は一段下げ、通常版を上に出す。
    { file: ['set', 'complete', 'fullset'], item: ['セット', 'set', 'コンプリート'], edition: true },
    { file: ['ex'], item: ['ex'], edition: true },
    { file: ['another'], item: ['another'], edition: true }
  ];
  const IGNORE_WORDS = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'zip', 'pdf', 'voice', 'voices', 'track', 'the', 'and', 'vol']);
  // 英字の言葉は単語の区切りで照合する（「ex」が「next」に当たらないように）。
  for (const w of WORDS) w.tests = w.item.map(form => /^[a-z ]+$/.test(form) ? new RegExp(`(^|[^a-z])${form}([^a-z]|$)`) : form);
  function itemHas(item, word) {
    const text = itemText(item);
    return word.tests.some(test => typeof test === 'string' ? text.includes(test) : test.test(text));
  }
  function fileWords(text) {
    const tokens = text.normalize('NFKC')
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([a-zA-Z])(\d)/g, '$1 $2').replace(/(\d)([a-zA-Z])/g, '$1 $2')
      .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return { tokens, set: new Set(tokens), compact: tokens.join('') };
  }
  function membersIn(query, words) {
    const jp = normText(query).replace(/[\s・_\-]/g, '');
    return members.filter(m => {
      const name = normText(m.name).replace(/[\s・_\-]/g, '');
      if (name.length >= 2 && jp.includes(name)) return true;
      const parts = m.enParts;
      if (!parts.length) return false;
      if (parts.every(p => words.set.has(p))) return true;
      const joined = parts.join(''), reversed = [...parts].reverse().join('');
      return joined.length >= 6 && (words.compact.includes(joined) || words.compact.includes(reversed));
    });
  }
  function nameCandidates(query) {
    const words = fileWords(query);
    const who = membersIn(query, words);
    const jp = normText(query);
    const found = WORDS.filter(w => w.file.some(f => words.set.has(f) || (f.length >= 6 && words.compact.includes(f)))
      || w.item.some(form => form.length >= 2 && /[^\x00-\x7f]/.test(form) && jp.includes(form)));
    const years = words.tokens.filter(t => /^20\d\d$/.test(t));
    const known = new Set([...members.flatMap(m => m.enParts), ...WORDS.flatMap(w => w.file)]);
    const extra = words.tokens.filter(t => t.length >= 3 && !/^\d+$/.test(t) && !known.has(t) && !IGNORE_WORDS.has(t));
    if (!who.length && !found.length && !extra.length) return [];
    // ライバーが分からないときは、「ライバーを選ぶ」で選んでいる人の商品から探す。
    const keys = new Set(who.length ? who.map(m => m.key) : picked);
    const out = [];
    for (const g of groups) {
      for (const item of g.items) {
        if (keys.size && !item.livers.some(key => keys.has(key))) continue;
        const text = itemText(item);
        let score = who.length ? 2 : 0;
        for (const w of found) if (!w.edition && itemHas(item, w)) score += 2;
        for (const w of WORDS) if (w.edition && itemHas(item, w)) score += found.includes(w) ? 2 : -1;
        const itemYears = text.match(/20\d\d/g);
        if (years.length && itemYears) score += years.some(y => itemYears.includes(y)) ? 3 : -3;
        for (const t of extra) if (text.includes(t)) score += 1;
        if (score >= 4) out.push({ item, score });
      }
    }
    return out.sort((a, b) => b.score - a.score || byGroupOrder(a.item, b.item)).slice(0, 5);
  }

  // 1つのファイル（またはフォルダ）について、商品名の一致・文字の近さ・ファイル名の言葉をまとめて順位をつける。
  function fileQuestion(label, query) {
    const scores = new Map();
    const add = (item, score) => { if (!(scores.get(item) >= score)) scores.set(item, score); };
    for (const { item, ambiguous } of matchHistory(query)) add(item, ambiguous ? 12 : 20);
    if (/[^\x00-\x7f]{3}/.test(query)) for (const { item, score } of similarItems(query, 5)) add(item, 10 * score);
    for (const { item, score } of nameCandidates(query)) add(item, score);
    const candidates = [...scores].map(([item, score]) => ({ item, score }))
      .sort((a, b) => b.score - a.score || byGroupOrder(a.item, b.item)).slice(0, 5);
    return candidates.length ? { label, candidates, pick: clearWinner(candidates, 6, 2) } : null;
  }
  // 1位がはっきり上のときだけ、最初から選んでおく。
  function clearWinner(candidates, least, margin) {
    const [top, next] = candidates;
    if (!top || top.score < least || (next && top.score - next.score < margin) || bought.has(top.item.id)) return null;
    return top.item.id;
  }

  // 貼り付けた文章・メール・保存したページ。商品名がそのまま書かれていればそれを、なければ行ごとに近い商品を出す。
  function textResults(text) {
    const exact = matchHistory(text);
    const keys = exact.map(m => m.key);
    const questions = [];
    const seenLines = new Set();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, ' ').trim();
      const norm = normText(line);
      if (norm.length < 6 || norm.length > 160 || seenLines.has(norm) || keys.some(key => norm.includes(key))) continue;
      seenLines.add(norm);
      const candidates = similarItems(line, 4).map(c => ({ item: c.item, score: 10 * c.score }));
      if (candidates.length) questions.push({ label: clip(line, 70), candidates, pick: clearWinner(candidates, 9, 1.5) });
      if (questions.length >= 40) break;
    }
    return { exact, questions };
  }

  // ---- ファイルの読み取り（ページの中だけで行う） ----
  const TEXT_FILE = /\.(txt|text|eml|html?|csv|tsv|md)$/i;
  const AUDIO_FILE = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;
  const MAX_FILES = 500;
  const bytesToText = (bytes, charset) => {
    try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
    catch { return new TextDecoder().decode(bytes); }
  };
  function htmlText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,template').forEach(el => el.remove());
    doc.querySelectorAll('br,p,div,li,tr,td,th,h1,h2,h3,h4,h5,h6,dt,dd,section,article,table').forEach(el => el.append('\n'));
    return doc.body ? doc.body.textContent : '';
  }
  // 注文確認メール（.eml）。MIME の各パートを文字コードと転送形式に合わせて文字に戻す。
  function mailText(bytes) {
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const toBytes = str => Uint8Array.from(str, ch => ch.charCodeAt(0) & 255);
    const base64 = str => {
      const clean = str.replace(/[^A-Za-z0-9+/]/g, '');
      try { return toBytes(atob(clean + '==='.slice((clean.length + 3) % 4))); } catch { return new Uint8Array(); }
    };
    const qp = str => toBytes(str.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))));
    const out = [];
    raw.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (m, charset, enc, data) => {
      out.push(bytesToText(enc.toLowerCase() === 'b' ? base64(data) : qp(data.replace(/_/g, ' ')), charset));
      return m;
    });
    for (const part of raw.split(/\r?\n--[^\r\n]*/)) {
      const m = part.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
      if (!m) continue;
      const [, head, body] = m;
      const type = (/content-type:\s*([^;\s]+)/i.exec(head) || [, 'text/plain'])[1].toLowerCase();
      if (!type.startsWith('text/')) continue;
      const charset = (/charset="?([^";\s]+)/i.exec(head) || [, 'utf-8'])[1];
      const encoding = (/content-transfer-encoding:\s*([^\s;]+)/i.exec(head) || [, '7bit'])[1].toLowerCase();
      const data = encoding === 'base64' ? base64(body) : encoding === 'quoted-printable' ? qp(body) : toBytes(body);
      const text = bytesToText(data, charset);
      out.push(type === 'text/html' ? htmlText(text) : text);
    }
    return out.join('\n');
  }
  // MP3 の曲名・アルバム名タグ（ID3v2）。ファイルの先頭だけ読む。
  async function audioTags(file) {
    if (!/\.mp3$/i.test(file.name)) return '';
    const buf = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return '';
    const ver = buf[3];
    const safe = p => ((buf[p] & 127) << 21) | ((buf[p + 1] & 127) << 14) | ((buf[p + 2] & 127) << 7) | (buf[p + 3] & 127);
    const be32 = p => ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
    const end = Math.min(buf.length, 10 + safe(6));
    let pos = 10;
    if (buf[5] & 0x40) pos += ver === 4 ? safe(10) : be32(10) + 4;
    const wanted = new Set(['TIT2', 'TALB', 'TT2', 'TAL']);
    const found = [];
    while (pos + 10 <= end) {
      const small = ver === 2;
      const id = String.fromCharCode(...buf.subarray(pos, pos + (small ? 3 : 4)));
      const len = small ? (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5] : ver === 4 ? safe(pos + 4) : be32(pos + 4);
      const head = small ? 6 : 10;
      if (!/^[A-Z0-9]{3,4}$/.test(id) || len <= 0) break;
      if (wanted.has(id)) {
        const body = buf.subarray(pos + head + 1, Math.min(end, pos + head + len));
        const enc = buf[pos + head];
        const charset = enc === 3 ? 'utf-8' : enc === 2 ? 'utf-16be' : enc === 1 ? (body[0] === 0xfe ? 'utf-16be' : 'utf-16le')
          : body.some(b => b >= 0x80) ? 'shift_jis' : 'windows-1252';
        found.push(bytesToText(body, charset).replace(/[\0\ufeff]/g, ' ').trim());
      }
      pos += head + len;
    }
    return found.join(' ');
  }
  // ZIP の中のフォルダ名とファイル名（中央ディレクトリだけ読み、展開はしない）。
  async function zipNames(file) {
    const tailSize = Math.min(file.size, 65557);
    const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return [];
    const count = tail.getUint16(eocd + 10, true), size = tail.getUint32(eocd + 12, true), offset = tail.getUint32(eocd + 16, true);
    if (size > 4e6 || offset + size > file.size) return [];
    const cd = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
    const view = new DataView(cd.buffer);
    const names = [];
    for (let p = 0, n = 0; n < count && p + 46 <= cd.length && view.getUint32(p, true) === 0x02014b50; n++) {
      const utf8 = view.getUint16(p + 8, true) & 0x800, nameLen = view.getUint16(p + 28, true);
      const raw = cd.subarray(p + 46, p + 46 + nameLen);
      let name;
      try { name = new TextDecoder('utf-8', { fatal: !utf8 }).decode(raw); } catch { name = bytesToText(raw, 'shift_jis'); }
      if (!/(^|\/)(__MACOSX|\.)/.test(name)) names.push(name);
      p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    const dirs = new Set(names.flatMap(name => name.split('/').slice(0, -1)));
    const files = names.filter(name => !name.endsWith('/')).slice(0, 3).map(name => name.split('/').pop().replace(/\.[^.]+$/, ''));
    return [...[...dirs].slice(0, 5), ...files];
  }
  // ドロップされたもの。フォルダは中まで見る（深さ4・500ファイルまで）。
  async function droppedFiles(transfer) {
    const entries = [...(transfer.items || [])].map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...transfer.files].map(file => ({ file, path: file.name }));
    const out = [];
    async function walk(entry, depth) {
      if (out.length >= MAX_FILES || entry.name.startsWith('.') || entry.name === '__MACOSX') return;
      if (entry.isFile) {
        out.push({ file: await new Promise((ok, ng) => entry.file(ok, ng)), path: entry.fullPath.replace(/^\//, '') });
      } else if (entry.isDirectory && depth < 4) {
        const reader = entry.createReader();
        for (let batch; (batch = await new Promise((ok, ng) => reader.readEntries(ok, ng))).length;) {
          for (const child of batch) await walk(child, depth + 1);
        }
      }
    }
    for (const entry of entries) await walk(entry, 0);
    return out;
  }
  async function analyzeFiles(list) {
    const exact = new Map();
    const questions = [];
    const addText = text => {
      const result = textResults(text);
      result.exact.forEach(m => { if (!exact.has(m.item.id) || !m.ambiguous) exact.set(m.item.id, m); });
      questions.push(...result.questions);
    };
    // 同じフォルダに入った音声は1つの商品とみなし、フォルダ名とアルバム名でまとめて照合する。
    const folders = new Map();
    for (const { file, path } of list) {
      if (TEXT_FILE.test(file.name)) {
        if (file.size > 5e6) continue;
        if (/\.eml$/i.test(file.name)) addText(mailText(new Uint8Array(await file.arrayBuffer())));
        else if (/\.html?$/i.test(file.name)) addText(htmlText(await file.text()));
        else addText(await file.text());
        continue;
      }
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (dir && AUDIO_FILE.test(file.name)) {
        if (!folders.has(dir)) folders.set(dir, []);
        folders.get(dir).push(file);
        continue;
      }
      let query = path.replace(/\.[^./]+$/, '');
      if (/\.zip$/i.test(file.name)) query += ` ${(await zipNames(file)).join(' ')}`;
      else query += ` ${await audioTags(file)}`;
      const q = fileQuestion(path, query);
      if (q) questions.push(q);
    }
    for (const [dir, files] of folders) {
      const query = files.length > 1 ? `${dir} ${await audioTags(files[0])}` : `${dir}/${files[0].name.replace(/\.[^.]+$/, '')} ${await audioTags(files[0])}`;
      const q = fileQuestion(files.length > 1 ? `${dir}/（${files.length}ファイル）` : `${dir}/${files[0].name}`, query);
      if (q) questions.push(q);
    }
    return { exact: [...exact.values()], questions };
  }
  // 候補が同じ質問はまとめる（同じ商品の別ファイルなど）。商品名が一致した商品は候補から外す。
  function tidyQuestions(questions, exact) {
    const exactIds = new Set(exact.map(m => m.item.id));
    const merged = new Map();
    for (const q of questions) {
      // 1位が商品名の一致で見つかった商品なら、その質問はもう答えが出ている。
      if (exactIds.has(q.candidates[0].item.id)) continue;
      q.candidates = q.candidates.filter(c => !exactIds.has(c.item.id));
      if (!q.candidates.length) continue;
      const key = q.candidates.map(c => c.item.id).join('|');
      const same = merged.get(key);
      if (same) same.labels.push(q.label);
      else merged.set(key, { ...q, labels: [q.label] });
    }
    return [...merged.values()].map(q => ({
      ...q, label: q.labels.length > 1 ? `${clip(q.labels[0], 60)} ほか${q.labels.length - 1}件` : q.labels[0],
      pick: q.pick && q.candidates.some(c => c.item.id === q.pick) ? q.pick : null
    }));
  }
  function showResults({ exact, questions }, emptyText) {
    historyMatches = exact.sort((a, b) => byGroupOrder(a.item, b.item));
    historyQuestions = tidyQuestions(questions, exact);
    if (!historyMatches.length && !historyQuestions.length) {
      historyResult.hidden = true;
      historyTell(emptyText, true);
      return;
    }
    historyTell('');
    renderHistory();
  }

  function historyLine(item, control, note) {
    const label = make('label');
    const text = make('span', 'history-text');
    text.append(make('b', '', item.name), make('small', '', `${item.group.title} · ${yen(item.price)}`));
    if (note) text.append(make('small', 'history-note', note));
    label.append(control, text);
    return label;
  }
  function renderHistory() {
    const freshExact = historyMatches.filter(m => !bought.has(m.item.id));
    const openQuestions = historyQuestions.filter(q => !q.candidates.some(c => bought.has(c.item.id)));
    const parts = [];
    if (historyMatches.length) parts.push(`商品名が一致 ${historyMatches.length}点（うち購入済み ${historyMatches.length - freshExact.length}点）`);
    if (historyQuestions.length) parts.push(`名前の近い候補 ${historyQuestions.length}件`);
    $('#historySummary').textContent = `${parts.join('、')}。`
      + (freshExact.length || openQuestions.length ? '購入済みにする商品を選んで確定してください。' : '新しく購入済みにする商品はありません。');
    const rows = historyMatches.map(({ item, ambiguous }) => {
      const li = make('li');
      const done = bought.has(item.id);
      const box = make('input');
      box.type = 'checkbox';
      box.value = item.id;
      box.checked = !done && !ambiguous;
      box.disabled = done;
      li.append(historyLine(item, box, done ? '購入済み（変更なし）' : ambiguous ? '同じ名前の商品がほかにもあるため、確かめてからチェックしてください' : ''));
      return li;
    });
    historyQuestions.forEach((q, n) => {
      const li = make('li', 'history-question');
      const set = make('fieldset');
      set.append(make('legend', '', `「${q.label}」に近い商品`));
      const radio = (value, checked, disabled) => {
        const input = make('input');
        input.type = 'radio';
        input.name = `historyQ${n}`;
        input.value = value;
        input.checked = checked;
        input.disabled = disabled;
        return input;
      };
      for (const { item } of q.candidates) {
        const done = bought.has(item.id);
        set.append(historyLine(item, radio(item.id, !done && q.pick === item.id, done), done ? '購入済み（変更なし）' : ''));
      }
      const none = make('label', 'history-none');
      none.append(radio('', !q.pick || bought.has(q.pick), false), make('span', '', 'どれでもない'));
      set.append(none);
      li.append(set);
      rows.push(li);
    });
    historyList.replaceChildren(...rows);
    $('#historyApply').hidden = !freshExact.length && !openQuestions.length;
    historyResult.hidden = false;
  }
  $('#historyMatch').addEventListener('click', () => {
    const text = $('#historyIn').value;
    if (!text.trim()) { historyTell('購入履歴の文章を貼り付けてください。', true); return; }
    showResults(textResults(text), '商品名が見つかりませんでした。購入履歴ページの商品名が入るように、ページ全体をコピーしてください。');
  });
  async function takeFiles(list) {
    if (!list.length) return;
    historyTell(`${list.length}件のファイルを読んでいます…`);
    try {
      showResults(await analyzeFiles(list), 'ファイルから商品を見つけられませんでした。手動でチェックするか、購入履歴の文章を貼り付けてください。');
    } catch {
      historyResult.hidden = true;
      historyTell('ファイルを読めませんでした。', true);
    }
  }
  $('#historyFiles').addEventListener('change', event => {
    const list = [...event.target.files].slice(0, MAX_FILES).map(file => ({ file, path: file.webkitRelativePath || file.name }));
    event.target.value = '';
    takeFiles(list);
  });
  // ページのどこにファイルを落としても受け取る（文字のドラッグは今までどおり入力欄へ）。
  const historySection = $('#historyTitle').closest('section');
  const carriesFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (!carriesFiles(event) || $('#historyFiles').disabled) return;
    dragDepth++;
    historySection.classList.add('is-dropping');
  });
  document.addEventListener('dragleave', event => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) historySection.classList.remove('is-dropping');
  });
  document.addEventListener('dragover', event => { if (carriesFiles(event)) event.preventDefault(); });
  document.addEventListener('drop', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    historySection.classList.remove('is-dropping');
    if ($('#historyFiles').disabled) return;
    const reading = droppedFiles(event.dataTransfer);
    historySection.scrollIntoView({ block: 'start', behavior: 'smooth' });
    reading.then(takeFiles, () => historyTell('ファイルを読めませんでした。', true));
  });
  $('#historyApply').addEventListener('click', () => {
    const ids = new Set([...historyList.querySelectorAll('input:checked:not(:disabled)')].map(input => input.value).filter(Boolean));
    if (!ids.size) { historyTell('購入済みにする商品を選んでください。', true); return; }
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
    historyQuestions = [];
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
