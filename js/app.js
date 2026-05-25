'use strict';

// ── ストレージキー ──
const SETUP_KEY  = 'yamanote_setup_v1';
const STAMP_KEY  = 'yamanote_stamped_v2';
const TIMES_KEY  = 'yamanote_times_v1';

// ── アプリ状態 ──
let config    = { start: 0, dir: 'outer', depart: '07:00' };
let route     = [];   // 外回り/内回り・出発駅に応じた ST インデックス順
let routeKms  = [];   // route[i] に到達するまでの累積km
let routeMins = [];   // route[i] に到達するまでの累積分数（出発からの相対）
const stamped = new Set();
let arrivals  = {};   // { stIdx: "HH:MM" } — 実際の到着時刻
let certName  = '';   // 完歩証に記載する名前
let filterOn  = false;
let restoring = false;

// ── 初期化 ──
(function init() {
  // スタンプ読み込み
  try {
    const s = localStorage.getItem(STAMP_KEY);
    if (s) JSON.parse(s).forEach(i => stamped.add(Number(i)));
  } catch(e) {}

  // 実際の到着時刻読み込み
  try {
    const t = localStorage.getItem(TIMES_KEY);
    if (t) Object.assign(arrivals, JSON.parse(t));
  } catch(e) {}

  // 設定読み込み（旧データとの互換性のため depart が無ければデフォルト維持）
  const savedCfg = localStorage.getItem(SETUP_KEY);
  if (savedCfg) {
    try { config = { ...config, ...JSON.parse(savedCfg) }; } catch(e) {}
  }

  // セットアップUIの選択肢を構築
  buildSetupOptions();

  if (savedCfg) {
    startApp();
  } else {
    // 初回はデフォルト値が入った状態でモーダルを表示
    document.getElementById('setup-modal').style.display = 'flex';
  }
})();

// ── セットアップ画面の構築 ──
function buildSetupOptions() {
  const sel = document.getElementById('setup-start-sel');
  ST.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = s.n + '駅';
    sel.appendChild(opt);
  });
  sel.value = config.start;

  document.getElementById('setup-time').value = config.depart || '07:00';

  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  const activeDir = document.querySelector(`.dir-btn[data-dir="${config.dir}"]`);
  if (activeDir) activeDir.classList.add('active');
}

// ── セットアップ確定 ──
function confirmSetup() {
  const newStart  = parseInt(document.getElementById('setup-start-sel').value);
  const newDir    = (document.querySelector('.dir-btn.active') || {}).dataset?.dir || 'outer';
  const newDepart = document.getElementById('setup-time').value || '07:00';

  const routeChanged  = newStart !== config.start || newDir !== config.dir;
  const departChanged = newDepart !== (config.depart || '07:00');
  const anyChanged    = routeChanged || departChanged;

  if (routeChanged && stamped.size > 0) {
    if (!confirm('出発設定を変更すると、現在のスタンプ記録がリセットされます。よろしいですか？')) return;
    stamped.clear();
    saveStamps();
  }

  config = { start: newStart, dir: newDir, depart: newDepart };
  localStorage.setItem(SETUP_KEY, JSON.stringify(config));
  document.getElementById('setup-modal').style.display = 'none';

  if (anyChanged) {
    document.getElementById('station-list').innerHTML = '';
    document.getElementById('ms-grid').innerHTML = '';
    document.getElementById('lunch-grid').innerHTML = '';
    buildRoute();
    buildMilestones();
    buildStations();
    buildLunch();
    updateHeaderLabels();
    restoreUI();
  } else {
    startApp();
  }
}

// ── セットアップモーダルを開く（設定変更） ──
function openSetup() {
  document.getElementById('setup-start-sel').value = config.start;
  document.getElementById('setup-time').value = config.depart || '07:00';
  const btn = document.querySelector(`.dir-btn[data-dir="${config.dir}"]`);
  if (btn) {
    document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  document.getElementById('setup-modal').style.display = 'flex';
}

// ── アプリ起動 ──
function startApp() {
  buildRoute();
  buildMilestones();
  buildStations();
  buildLunch();
  buildItems(ITEMS.must, 'must', 'items-must');
  buildItems(ITEMS.nice, 'nice', 'items-nice');
  updateHeaderLabels();
  document.getElementById('app').style.display = 'block';
  restoreUI();
}

// ── ルート構築 ──
function buildRoute() {
  const n = ST.length;
  route = [];
  for (let i = 0; i < n; i++) {
    route.push(config.dir === 'outer'
      ? (config.start + i) % n
      : (config.start - i + n) % n);
  }
  routeKms = [0];
  routeMins = [0];
  for (let i = 0; i < n - 1; i++) {
    routeKms.push(routeKms[i] + adjDist(route[i], route[i + 1]));
    routeMins.push(routeMins[i] + adjTime(route[i], route[i + 1]));
  }
  // 最終区間（最後の駅→出発駅）を追加して一周を完成させる
  routeKms.push(routeKms[n - 1] + adjDist(route[n - 1], route[0]));
  routeMins.push(routeMins[n - 1] + adjTime(route[n - 1], route[0]));
}

// ── 隣接駅間距離 ──
function adjDist(a, b) {
  const n = ST.length;
  if ((a + 1) % n === b) return SEG[a];  // 外回り方向
  if ((b + 1) % n === a) return SEG[b];  // 内回り方向
  return 0;
}

// ── 隣接駅間所要時間（分） ──
function adjTime(a, b) {
  const n = ST.length;
  if ((a + 1) % n === b) return SEGT[a];
  if ((b + 1) % n === a) return SEGT[b];
  return 0;
}

// ── 出発時刻 + オフセット分 → "HH:MM" ──
function fmtTime(departStr, offsetMin) {
  const [h, m] = (departStr || '07:00').split(':').map(Number);
  const total  = h * 60 + m + offsetMin;
  return String(Math.floor(total / 60) % 24).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

// ── 実際に歩いたkm（連続してスタンプされたセグメントの合計） ──
function calcWalkedKm() {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    if (stamped.has(route[i]) && stamped.has(route[i + 1])) {
      total += adjDist(route[i], route[i + 1]);
    }
  }
  // ゴールスタンプ済みのときのみ最終区間（最後の駅→出発駅）を加算
  if (stamped.size === route.length && arrivals['__goal__']) {
    total += adjDist(route[route.length - 1], route[0]);
  }
  return Math.round(total * 10) / 10;
}

// ── ヘッダーラベル更新 ──
function updateHeaderLabels() {
  const startName = ST[route[0]].n;
  const dirLabel  = config.dir === 'outer' ? '外回り' : '内回り';
  document.getElementById('prog-start').textContent = startName + ' ' + (config.depart || '07:00') + '出発';
  document.getElementById('prog-goal').textContent  = startName + ' ゴール';
  document.getElementById('cover-sub').textContent  = startName + 'より' + (config.depart || '07:00') + '出発・' + dirLabel;
}

// ── マイルストーン構築 ──
function buildMilestones() {
  const grid = document.getElementById('ms-grid');
  MS.forEach(m => {
    const d = document.createElement('div');
    d.className = 'ms locked';
    d.id = 'ms' + m.km;
    d.innerHTML = `<div class="ms-icon">🔒</div><div class="ms-km">${m.km}km</div><div class="ms-label"></div>`;
    grid.appendChild(d);
  });
}

// ── 駅カード構築 ──
function buildStations() {
  const container = document.getElementById('station-list');
  route.forEach((stIdx, routePos) => {
    const s = ST[stIdx];
    const km = routeKms[routePos];
    const isStart = routePos === 0;

    const allBadges = [
      ...(isStart ? ['start'] : []),
      ...(s.b || []),
    ];
    const badgeHtml = allBadges.map(b => {
      const lbl = { start:'スタート', rest:'休憩', goal:'ゴール！' };
      return `<span class="badge ${b}">${lbl[b] || b}</span>`;
    }).join('');

    const triProse = s.tri.replace(/^・/, '').replace(/<br>・/g, '。');
    const arrivalTime = fmtTime(config.depart, routeMins[routePos]);

    const d = document.createElement('div');
    d.className = 'st-card';
    d.id = 'st' + stIdx;
    d.innerHTML = `
      <div class="stamp-wrap">
        <span class="stamp-time" id="at${stIdx}"></span>
        <button class="stamp-btn u" onclick="tap(${stIdx})">到着<br>スタンプ</button>
      </div>
      <div class="st-info">
        <div class="st-head">
          <span class="st-num">No.${routePos + 1}</span>
          <span class="st-name">${s.n}駅${badgeHtml}</span>
        </div>
        <div class="st-detail">
          <div><span class="st-time">⏱ ${arrivalTime}</span><span class="st-km">${km.toFixed(1)}km</span></div>
          <div class="trivia"><span class="trivia-lbl">📖 トリビア</span>${triProse}</div>
          ${s.m ? `<div class="st-memo">▶ ${s.m}</div>` : ''}
        </div>
      </div>`;
    container.appendChild(d);
  });

  // No.31 ゴールカード（出発駅へのループ帰還）
  const goalStIdx = route[0];
  const goalS     = ST[goalStIdx];
  const goalKm    = routeKms[route.length];
  const goalTime  = fmtTime(config.depart, routeMins[route.length]);
  const gc = document.createElement('div');
  gc.className = 'st-card st-goal-card';
  gc.id = 'st-goal';
  gc.innerHTML = `
    <div class="stamp-wrap">
      <span class="stamp-time" id="at__goal__"></span>
      <button class="stamp-btn u" id="goal-stamp-btn" onclick="tapGoal()">到着<br>スタンプ</button>
    </div>
    <div class="st-info">
      <div class="st-head">
        <span class="st-num">No.31</span>
        <span class="st-name">${goalS.n}駅<span class="badge goal">ゴール！</span></span>
      </div>
      <div class="st-detail">
        <div><span class="st-time">⏱ ${goalTime}</span><span class="st-km">${goalKm.toFixed(1)}km</span></div>
        <div class="st-memo">▶ 山手線一周完全踏破！おめでとう！</div>
      </div>
    </div>`;
  container.appendChild(gc);
}

// ── 昼食カード構築 ──
function buildLunch() {
  const grid = document.getElementById('lunch-grid');
  grid.innerHTML = '';

  // 12:00に最も近いルート上の駅を特定
  const [h, m] = (config.depart || '07:00').split(':').map(Number);
  const departMin = h * 60 + m;
  let noonRoutePos = 0, minDiff = Infinity;
  for (let i = 0; i < route.length; i++) {
    const diff = Math.abs(departMin + routeMins[i] - 720);
    if (diff < minDiff) { minDiff = diff; noonRoutePos = i; }
  }
  const noonStIdx   = route[noonRoutePos];
  const noonArrival = fmtTime(config.depart, routeMins[noonRoutePos]);

  // 12:00駅から円形距離±5駅以内のランチ候補を抽出
  const circDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, ST.length - d); };
  const nearby = LUNCH.filter(l => circDist(l.si, noonStIdx) <= 5);
  const toShow = nearby.length > 0 ? nearby : LUNCH;

  // ヘッダーを更新
  const header = document.getElementById('lunch-header');
  header.innerHTML = `📍 12:00ごろ（${noonArrival}）<strong>${ST[noonStIdx].n}駅</strong>付近を通過予定 — 近くのランチ候補`;
  header.className = 'lunch-noon-header match';

  toShow.forEach(l => {
    const d = document.createElement('div');
    d.className = 'l-card' + (l.local ? ' local' : '');
    const badge = l.local ? `<span class="l-local-badge">⭐ 地元名店</span>` : '';
    d.innerHTML = `<div class="l-name">${l.n}${badge}</div><span class="l-genre">${l.g}</span><span style="font-size:9px;color:var(--brown);margin-left:3px">${l.a}</span><div class="l-rec">推薦：${l.r}</div><div class="l-desc">${l.d}</div><a href="${l.url}" target="_blank" rel="noopener" class="map-btn">📍 地図を開く</a>`;
    grid.appendChild(d);
  });
}

// ── 持ち物リスト構築 ──
function buildItems(list, cls, containerId) {
  const grid = document.createElement('div');
  grid.className = 'items-grid';
  list.forEach(item => {
    const d = document.createElement('div');
    d.className = 'item ' + cls;
    d.innerHTML = `<div class="item-icon">${item.i}</div><div class="item-name">${item.n.replace('\n','<br>')}</div>`;
    grid.appendChild(d);
  });
  document.getElementById(containerId).appendChild(grid);
}

// ── マップタブ構築 ──
function buildMapTab() {
  const container = document.getElementById('map-content');
  container.innerHTML = '';

  // route[0]は出発地点なので i=1 から検索（最初の目的地は route[1]）
  let nextRoutePos = -1;
  for (let i = 1; i < route.length; i++) {
    if (!stamped.has(route[i])) { nextRoutePos = i; break; }
  }

  // 全30駅訪問済みの場合
  if (nextRoutePos === -1) {
    if (!arrivals['__goal__']) {
      // ゴール未打刻 → 出発駅をゴールとして表示
      const goalStIdx = route[0];
      const goalKm   = routeKms[route.length];
      const goalTime = fmtTime(config.depart, routeMins[route.length]);
      const dest = document.createElement('div');
      dest.className = 'map-dest-card';
      dest.innerHTML = `
        <div class="map-dest-label">— 最終目的地 —</div>
        <div class="map-dest-name">${ST[goalStIdx].n}駅（ゴール！）</div>
        <div class="map-dest-meta">No.31 ／ ${goalKm.toFixed(1)}km地点 ／ 目安 ${goalTime}</div>
        <a href="${mapsUrl(ST[goalStIdx].n)}" target="_blank" rel="noopener" class="map-main-btn">📍 Googleマップで徒歩ルートを見る</a>
      `;
      container.appendChild(dest);
    } else {
      container.innerHTML = '<div class="map-complete">🎉 全駅制覇！<br>山手線一周達成！</div>';
    }
    return;
  }

  const nextStIdx = route[nextRoutePos];
  const next = ST[nextStIdx];
  const nextKm = routeKms[nextRoutePos];

  const dest = document.createElement('div');
  dest.className = 'map-dest-card';
  dest.innerHTML = `
    <div class="map-dest-label">— 次の目的地 —</div>
    <div class="map-dest-name">${next.n}駅</div>
    <div class="map-dest-meta">No.${nextRoutePos + 1} ／ ${nextKm.toFixed(1)}km地点 ／ 目安 ${next.t}</div>
    <a href="${mapsUrl(next.n)}" target="_blank" rel="noopener" class="map-main-btn">📍 Googleマップで徒歩ルートを見る</a>
  `;
  container.appendChild(dest);

  // 残りの駅リスト（ゴール渋谷を含む）
  const remainingUnvisited = route.filter((si, pos) => pos > nextRoutePos && !stamped.has(si));
  const goalPending = !arrivals['__goal__'];
  const totalRemaining = remainingUnvisited.length + (goalPending ? 1 : 0);
  if (totalRemaining === 0) return;

  const title = document.createElement('div');
  title.className = 'map-section-title';
  title.textContent = '残りの駅 ' + totalRemaining + '駅';
  container.appendChild(title);

  route.forEach((stIdx, pos) => {
    if (pos <= nextRoutePos || stamped.has(stIdx)) return;
    const s = ST[stIdx];
    const row = document.createElement('div');
    row.className = 'map-station-row';
    row.innerHTML = `
      <span class="map-st-num">No.${pos + 1}</span>
      <span class="map-st-name">${s.n}駅</span>
      <span class="map-st-km">${routeKms[pos].toFixed(1)}km</span>
      <a href="${mapsUrl(s.n)}" target="_blank" rel="noopener" class="map-mini-btn">📍</a>
    `;
    container.appendChild(row);
  });

  // ゴール（出発駅）を残りリストの末尾に追加
  if (goalPending) {
    const goalStIdx = route[0];
    const row = document.createElement('div');
    row.className = 'map-station-row';
    row.innerHTML = `
      <span class="map-st-num">No.31</span>
      <span class="map-st-name">${ST[goalStIdx].n}駅（ゴール）</span>
      <span class="map-st-km">${routeKms[route.length].toFixed(1)}km</span>
      <a href="${mapsUrl(ST[goalStIdx].n)}" target="_blank" rel="noopener" class="map-mini-btn">📍</a>
    `;
    container.appendChild(row);
  }
}

function mapsUrl(name) {
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(name + '駅 東京') + '&travelmode=walking';
}

// ── スタンプ操作 ──
function tap(stIdx) {
  const wasOn = stamped.has(stIdx);
  wasOn ? stamped.delete(stIdx) : stamped.add(stIdx);
  saveStamps();

  // 到着時刻の記録
  if (!wasOn) {
    arrivals[stIdx] = nowHHMM();
  } else {
    delete arrivals[stIdx];
  }
  saveTimes();

  const card = document.getElementById('st' + stIdx);
  const btn  = card.querySelector('.stamp-btn');
  const on   = stamped.has(stIdx);

  btn.className = 'stamp-btn ' + (on ? 's' : 'u');
  btn.innerHTML = on ? '✔' : '到着<br>スタンプ';
  const timeEl = document.getElementById('at' + stIdx);
  if (timeEl) timeEl.textContent = (on && arrivals[stIdx]) ? arrivals[stIdx] : '';

  if (on) {
    card.classList.add('visited');
    toast('⚔ ' + ST[stIdx].n + '駅 征服！');
    setTimeout(() => {
      card.classList.add('collapsed');
      applyFilter();
      setTimeout(scrollToNext, 350);
    }, 700);
  } else {
    card.classList.remove('visited', 'collapsed');
    applyFilter();
  }

  const km = calcWalkedKm();
  updateProg(km);
  updateMS(km);

  // 全30駅制覇 → ゴールカードを解放
  if (on && stamped.size === ST.length) {
    const goalCard = document.getElementById('st-goal');
    if (goalCard) goalCard.classList.add('visited');
    setTimeout(() => {
      toast('🏁 あと1駅！' + ST[route[0]].n + '駅でゴールスタンプを押そう！');
      setTimeout(() => {
        if (goalCard) {
          goalCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          goalCard.style.boxShadow = '0 0 18px rgba(200,146,10,.9)';
          setTimeout(() => { goalCard.style.boxShadow = ''; }, 2100);
        }
      }, 600);
    }, 400);
  } else if (!on && stamped.size < ST.length) {
    const goalCard = document.getElementById('st-goal');
    if (goalCard) goalCard.classList.remove('visited');
  }
}

// ── 次の未訪問駅へスクロール ──
function scrollToNext() {
  for (let i = 0; i < route.length; i++) {
    const stIdx = route[i];
    if (!stamped.has(stIdx)) {
      const el = document.getElementById('st' + stIdx);
      if (el && !el.classList.contains('hidden')) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.boxShadow = '0 0 18px rgba(200,146,10,.9)';
        setTimeout(() => { el.style.boxShadow = ''; }, 2100);
        return;
      }
    }
  }
}

// ── ゴールスタンプ ──
function tapGoal() {
  const wasOn = !!arrivals['__goal__'];
  if (!wasOn) {
    arrivals['__goal__'] = nowHHMM();
  } else {
    delete arrivals['__goal__'];
  }
  saveTimes();

  const on = !!arrivals['__goal__'];
  const btn = document.getElementById('goal-stamp-btn');
  const timeEl = document.getElementById('at__goal__');
  if (btn) {
    btn.className = 'stamp-btn ' + (on ? 's' : 'u');
    btn.innerHTML = on ? '✔' : '到着<br>スタンプ';
  }
  if (timeEl) timeEl.textContent = on ? arrivals['__goal__'] : '';

  const km = calcWalkedKm();
  updateProg(km);
  updateMS(km);

  const certBtn = document.getElementById('cert-open-btn');
  if (on) {
    if (certBtn) certBtn.style.display = 'inline-block';
    setTimeout(() => {
      launchConfetti();
      toast('🎉 山手線一周完全制覇！おめでとう！');
      setTimeout(openCertModal, 2000);
    }, 400);
  } else {
    if (certBtn) certBtn.style.display = 'none';
  }
}

// ── フィルター ──
function toggleFilter() {
  filterOn = !filterOn;
  document.getElementById('filter-btn').classList.toggle('on', filterOn);
  applyFilter();
}
function applyFilter() {
  ST.forEach((_, stIdx) => {
    const el = document.getElementById('st' + stIdx);
    if (!el) return;
    el.classList.toggle('hidden', filterOn && stamped.has(stIdx));
  });
}

// ── タブ切り替え ──
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('#bottom-nav button').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'map') buildMapTab();
}

// ── 進捗更新 ──
function updateProg(km) {
  if (km === undefined) km = calcWalkedKm();
  const c    = stamped.size;
  const done = c + (arrivals['__goal__'] ? 1 : 0);
  const pct  = Math.round(done / (ST.length + 1) * 100); // 31チェックポイント
  document.getElementById('prog-bar').style.width = pct + '%';
  document.getElementById('prog-pct').textContent = pct + '%';
  document.getElementById('prog-s').textContent = c;
  document.getElementById('prog-km').textContent = km.toFixed(1);
}

// ── マイルストーン更新 ──
let mtt;
function updateMS(km) {
  if (km === undefined) km = calcWalkedKm();
  const newlyUnlocked = [];
  MS.forEach(m => {
    const el = document.getElementById('ms' + m.km);
    if (!el) return;
    const was = el.classList.contains('unlocked');
    const now = km >= m.km;
    if (!was && now) newlyUnlocked.push(m);
    el.className = 'ms ' + (now ? 'unlocked' : 'locked');
    el.querySelector('.ms-icon').textContent = now ? m.icon : '🔒';
    const lbl = el.querySelector('.ms-label');
    if (lbl) lbl.innerHTML = now ? m.label.replace('\n', '<br>') : '';
  });
  if (newlyUnlocked.length > 0 && !restoring) {
    setTimeout(() => { showMilestoneToasts(newlyUnlocked); launchConfetti(); }, 400);
  }
}

function showMilestoneToasts(milestones) {
  const container = document.getElementById('ms-toast-container');
  container.innerHTML = '';
  milestones.forEach(m => {
    const el = document.createElement('div');
    el.className = 'ms-toast';
    el.textContent = '🏆 ' + m.icon + ' ' + m.label.split('\n')[1] + ' 達成！';
    container.appendChild(el);
  });
  clearTimeout(mtt);
  mtt = setTimeout(() => { container.innerHTML = ''; }, 2500);
}

// ── コンフェッティ ──
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors = ['#e8b400','#b22222','#2d5a1b','#1a4a7a','#f5e6c8','#ffffff','#ff6b6b'];
  const pieces = Array.from({length: 150}, () => ({
    x: Math.random() * canvas.width, y: -10 - Math.random() * 150,
    r: 3 + Math.random() * 5, color: colors[Math.floor(Math.random() * colors.length)],
    vx: (Math.random() - 0.5) * 5, vy: 3 + Math.random() * 4,
    rot: Math.random() * 360, rotV: (Math.random() - 0.5) * 7,
    shape: Math.random() > 0.5 ? 'rect' : 'circle',
  }));
  let frame = 0;
  (function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      else { ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      p.x += p.vx; p.y += p.vy; p.rot += p.rotV; p.vy += 0.09;
    });
    if (++frame < 140) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

// ── トースト ──
let tt;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(tt);
  tt = setTimeout(() => el.classList.remove('show'), 1200);
}

// ── localStorage保存 ──
function saveStamps() {
  try { localStorage.setItem(STAMP_KEY, JSON.stringify([...stamped])); } catch(e) {}
}
function saveTimes() {
  try { localStorage.setItem(TIMES_KEY, JSON.stringify(arrivals)); } catch(e) {}
}

// ── 現在時刻 HH:MM ──
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

// ── 完歩証 ──
function openCertModal() {
  const input = prompt('お名前を入力してください（完歩証に記載されます）', certName);
  if (input !== null) certName = input.trim();
  updateCertDisp();
  document.getElementById('cert-modal').style.display = 'flex';
}
function closeCertModal() {
  document.getElementById('cert-modal').style.display = 'none';
}
function changeCertName() {
  const input = prompt('お名前を変更してください', certName);
  if (input !== null) { certName = input.trim(); updateCertDisp(); }
}
function updateCertDisp() {
  document.getElementById('cert-name-disp').textContent = (certName || '○○○○') + ' 殿';

  const startStIdx = route[0];
  const startTime  = arrivals[startStIdx] || '---';
  const finishTime = arrivals['__goal__'] || '---';
  let dur = '---';
  if (arrivals[startStIdx] && arrivals['__goal__']) {
    const [sh, sm] = arrivals[startStIdx].split(':').map(Number);
    const [dh, dm] = arrivals['__goal__'].split(':').map(Number);
    let diff = (dh * 60 + dm) - (sh * 60 + sm);
    if (diff < 0) diff += 1440;
    dur = Math.floor(diff / 60) + '時間' + String(diff % 60).padStart(2, '0') + '分';
  }

  const rows = [
    ['出発駅',  ST[startStIdx].n + '駅'],
    ['方向',    config.dir === 'outer' ? '外回り' : '内回り'],
    ['出発時刻', startTime],
    ['完歩時刻', finishTime],
    ['所要時間', dur],
  ];
  document.getElementById('cert-stats').innerHTML = rows.map(([l, v]) =>
    `<div class="cert-srow"><span class="cert-slbl">${l}</span><span class="cert-sval">${v}</span></div>`
  ).join('');

  // ラップタイム（主要6駅 + ゴール）
  const KEY_ST = new Set([0, 3, 7, 15, 19, 25]); // 渋谷・新宿・池袋・上野・東京・品川
  const lapsHtml = route
    .map((stIdx, pos) => ({ stIdx, pos }))
    .filter(({ stIdx }) => KEY_ST.has(stIdx))
    .map(({ stIdx, pos }) => {
      const t = arrivals[stIdx] || '--:--';
      return `<div class="cert-lap"><span class="cert-lap-n">No.${pos + 1}</span><span class="cert-lap-nm">${ST[stIdx].n}</span><span class="cert-lap-t">${t}</span></div>`;
    }).join('') +
    `<div class="cert-lap cert-lap-goal"><span class="cert-lap-n">No.31</span><span class="cert-lap-nm">${ST[startStIdx].n}（ゴール）</span><span class="cert-lap-t">${arrivals['__goal__'] || '--:--'}</span></div>`;
  document.getElementById('cert-laps').innerHTML = lapsHtml;

  const d = new Date();
  document.getElementById('cert-date-disp').textContent =
    d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 達成';
}

function saveCertImage() {
  updateCertDisp();
  if (typeof html2canvas === 'undefined') {
    alert('スクリーンショットで保存してください。');
    return;
  }
  const btn = document.querySelector('.cert-btn-save');
  if (btn) { btn.textContent = '⏳ 生成中...'; btn.disabled = true; }
  html2canvas(document.getElementById('cert-display'), {
    scale: 2, backgroundColor: '#f9f0dc', logging: false, useCORS: true,
  }).then(canvas => {
    if (btn) { btn.textContent = '📥 画像を保存'; btn.disabled = false; }
    showCertImage(canvas.toDataURL('image/png'));
  }).catch(() => {
    if (btn) { btn.textContent = '📥 画像を保存'; btn.disabled = false; }
    alert('画像生成に失敗しました。スクリーンショットで保存してください。');
  });
}
function showCertImage(dataUrl) {
  let ov = document.getElementById('cert-img-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'cert-img-overlay';
    ov.innerHTML = `
      <div id="cert-img-box">
        <p id="cert-img-hint">📱 画像を長押しして「写真に保存」を選んでください</p>
        <img id="cert-img-el" src="" alt="完歩証">
        <button id="cert-img-close" onclick="document.getElementById('cert-img-overlay').style.display='none'">✕ 閉じる</button>
      </div>`;
    document.body.appendChild(ov);
  }
  document.getElementById('cert-img-el').src = dataUrl;
  ov.style.display = 'flex';
}

// ── 復元 ──
function restoreUI() {
  restoring = true;
  stamped.forEach(stIdx => {
    const card = document.getElementById('st' + stIdx);
    if (!card) return;
    card.className = 'st-card visited collapsed';
    const btn = card.querySelector('.stamp-btn');
    btn.className = 'stamp-btn s';
    btn.innerHTML = '✔';
    const timeEl = document.getElementById('at' + stIdx);
    const t = arrivals[stIdx];
    if (timeEl) timeEl.textContent = t || '';
  });
  const km = calcWalkedKm();
  updateProg(km);
  updateMS(km);
  restoring = false;
  if (stamped.size === ST.length) {
    const goalCard = document.getElementById('st-goal');
    if (goalCard) goalCard.classList.add('visited');
    // ゴールスタンプ済みなら復元
    const goalBtn = document.getElementById('goal-stamp-btn');
    const goalTimeEl = document.getElementById('at__goal__');
    if (arrivals['__goal__'] && goalBtn) {
      goalBtn.className = 'stamp-btn s';
      goalBtn.innerHTML = '✔';
    }
    if (goalTimeEl) goalTimeEl.textContent = arrivals['__goal__'] || '';
    const certBtn = document.getElementById('cert-open-btn');
    if (arrivals['__goal__'] && certBtn) certBtn.style.display = 'inline-block';
  } else if (stamped.size > 0) {
    showTab('stations');
    setTimeout(scrollToNext, 500);
  }
}

// ── リセット ──
function resetAll() {
  if (!confirm('スタンプをすべてリセットしますか？')) return;
  stamped.clear();
  saveStamps();
  arrivals = {};
  saveTimes();
  const certBtn = document.getElementById('cert-open-btn');
  if (certBtn) certBtn.style.display = 'none';
  ST.forEach((_, stIdx) => {
    const card = document.getElementById('st' + stIdx);
    if (!card) return;
    card.className = 'st-card';
    const btn = card.querySelector('.stamp-btn');
    btn.className = 'stamp-btn u';
    btn.innerHTML = '到着<br>スタンプ';
    const timeEl = document.getElementById('at' + stIdx);
    if (timeEl) timeEl.textContent = '';
  });
  const goalCard = document.getElementById('st-goal');
  if (goalCard) goalCard.classList.remove('visited');
  const goalBtn = document.getElementById('goal-stamp-btn');
  if (goalBtn) { goalBtn.className = 'stamp-btn u'; goalBtn.innerHTML = '到着<br>スタンプ'; }
  const goalTimeEl = document.getElementById('at__goal__');
  if (goalTimeEl) goalTimeEl.textContent = '';
  filterOn = false;
  document.getElementById('filter-btn').classList.remove('on');
  applyFilter();
  updateProg(0);
  updateMS(0);
  toast('🔄 リセットしました');
  showTab('home');
}
