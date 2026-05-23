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
  // 全駅制覇で最終区間（最後の駅→出発駅）を加算
  if (stamped.size === route.length) {
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
      ...(isStart ? ['start', 'goal'] : []),
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
      <button class="stamp-btn u" onclick="tap(${stIdx})">到着<br>スタンプ</button>
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

  // ルート順で最初の未訪問駅を探す
  let nextRoutePos = -1;
  for (let i = 0; i < route.length; i++) {
    if (!stamped.has(route[i])) { nextRoutePos = i; break; }
  }

  if (nextRoutePos === -1) {
    container.innerHTML = '<div class="map-complete">🎉 全駅制覇！<br>山手線一周達成！</div>';
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

  const remaining = route.filter((si, pos) => pos > nextRoutePos && !stamped.has(si));
  if (remaining.length === 0) return;

  const title = document.createElement('div');
  title.className = 'map-section-title';
  title.textContent = '残りの駅 ' + remaining.length + '駅';
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
  btn.innerHTML = on
    ? '✔' + (arrivals[stIdx] ? '<br><span class="stamp-time">' + arrivals[stIdx] + '</span>' : '')
    : '到着<br>スタンプ';

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

  // 全駅制覇チェック
  if (on && stamped.size === ST.length) {
    const certBtn = document.getElementById('cert-open-btn');
    if (certBtn) certBtn.style.display = 'inline-block';
    setTimeout(() => {
      launchConfetti();
      toast('🎉 山手線一周完全制覇！おめでとう！');
      setTimeout(openCertModal, 2000);
    }, 400);
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
  const c = stamped.size;
  const pct = Math.round(c / ST.length * 100);
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
  updateCertDisp();
  document.getElementById('cert-modal').style.display = 'flex';
}
function closeCertModal() {
  document.getElementById('cert-modal').style.display = 'none';
}
function updateCertDisp() {
  const sei = (document.getElementById('cert-sei').value || '').trim();
  const mei = (document.getElementById('cert-mei').value || '').trim();
  const name = (sei + (sei && mei ? ' ' : '') + mei) || '○○ ○○';
  document.getElementById('cert-name-disp').textContent = name + ' 殿';

  const startStIdx  = route[0];
  const goalStIdx   = route[route.length - 1];
  const startTime   = arrivals[startStIdx] || '---';
  const finishTime  = arrivals[goalStIdx]  || '---';
  let dur = '---';
  if (arrivals[startStIdx] && arrivals[goalStIdx]) {
    const [sh, sm] = arrivals[startStIdx].split(':').map(Number);
    const [dh, dm] = arrivals[goalStIdx].split(':').map(Number);
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

  const d = new Date();
  document.getElementById('cert-date-disp').textContent =
    d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 達成';
}

function saveCertImage() {
  updateCertDisp();
  if (typeof html2canvas === 'undefined') {
    alert('画像保存機能が読み込まれていません。スクリーンショットで保存してください。');
    return;
  }
  html2canvas(document.getElementById('cert-display'), {
    scale: 2, backgroundColor: '#f9f0dc', logging: false, useCORS: true,
  }).then(canvas => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      // iOS: ページ内に画像表示して長押し保存を促す
      let img = document.getElementById('cert-inline-img');
      if (!img) {
        img = document.createElement('img');
        img.id = 'cert-inline-img';
        img.style.cssText = 'width:100%;display:block;margin:8px 0;border-radius:4px;border:1px solid var(--gold);';
        document.getElementById('cert-save-hint').before(img);
      }
      img.src = canvas.toDataURL('image/png');
      document.getElementById('cert-save-hint').style.display = 'block';
    } else {
      const link = document.createElement('a');
      link.download = '山手線完歩証.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    }
  });
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
    const t = arrivals[stIdx];
    btn.innerHTML = '✔' + (t ? '<br><span class="stamp-time">' + t + '</span>' : '');
  });
  const km = calcWalkedKm();
  updateProg(km);
  updateMS(km);
  restoring = false;
  if (stamped.size === ST.length) {
    const certBtn = document.getElementById('cert-open-btn');
    if (certBtn) certBtn.style.display = 'inline-block';
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
  });
  filterOn = false;
  document.getElementById('filter-btn').classList.remove('on');
  applyFilter();
  updateProg(0);
  updateMS(0);
  toast('🔄 リセットしました');
  showTab('home');
}
