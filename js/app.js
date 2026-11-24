import {
  SAMPLES, TITRANTS, INDICATORS, solvePH, speciesAmounts, protonCount,
  indicatorRGBA, indicatorColorName, unknownFromSeed, gauss,
} from './chem.js';
import { initAI } from './ai.js';

const CFG = Object.assign({
  aiEndpoint: '', unknownPool: ['HCl', 'HNO3', 'CH3COOH', 'HCOOH'], unknownRange: [0.05, 0.2],
  evalFixed: {}, showReadingInPractice: true,
}, window.LAB_CONFIG || {});

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const BUR_CAP = 50;          // 뷰렛 용량 (mL)
const DROP = 0.05;           // 한 방울 (mL)

const MODE_NAMES = { practice: '연습 모드', explore: '탐구 모드', eval: '평가 모드' };

const state = {
  mode: null,
  student: { id: '', code: '' },
  seed: '',
  unknown: null,           // { key, conc } — 화면과 AI에 절대 보이지 않음
  choice: { sample: null, sampleConc: null, sampleVol: null, titrant: null, titrantConc: null, indicator: null, meter: null, noise: null },
  trial: null,
  trials: [],
  actions: [],
  results: [],
  chat: [],
  startedAt: new Date().toISOString(),
};

/* ---------- 공통 ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), 2600);
}
function logAction(type, detail = {}) {
  state.actions.push({ t: new Date().toISOString(), trial: state.trial ? state.trial.no : null, type, ...detail });
}
function isUnknownMode() { return state.mode === 'explore' || state.mode === 'eval'; }

/* ---------- 시작 화면 ---------- */
function setupStart() {
  const params = new URLSearchParams(location.search);
  $$('.mode').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.mode;
    if (m === 'eval') { $('#eval-form').hidden = false; $('#eval-form input').focus(); return; }
    beginMode(m);
  }));
  $('#eval-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    state.student.id = String(f.get('sid')).trim();
    state.student.code = String(f.get('code')).trim();
    beginMode('eval');
  });
  const pm = params.get('mode');
  if (pm === 'practice' || pm === 'explore') beginMode(pm);
  else if (pm === 'eval') { $('#eval-form').hidden = false; }
}

function beginMode(mode) {
  state.mode = mode;
  if (mode === 'explore') {
    state.seed = 'explore-' + Math.random().toString(36).slice(2, 10);
    state.unknown = unknownFromSeed(state.seed, CFG.unknownPool, CFG.unknownRange);
  } else if (mode === 'eval') {
    state.seed = `${state.student.code}|${state.student.id}`;
    state.unknown = unknownFromSeed(state.seed, CFG.unknownPool, CFG.unknownRange);
    if (CFG.evalFixed && CFG.evalFixed.noise) state.choice.noise = CFG.evalFixed.noise;
  }
  if (isUnknownMode()) state.choice.sample = 'UNKNOWN';
  $('#start').hidden = true;
  $('#mode-badge').textContent = MODE_NAMES[mode];
  $('#mode-badge').dataset.mode = mode;
  if (mode === 'eval') { const sb = $('#student-badge'); sb.hidden = false; sb.textContent = `학번 ${state.student.id}`; }
  $('#btn-download').disabled = false;
  logAction('mode', { mode });
  ai.setEnabled(mode !== 'eval');
  renderSteps(); renderAll();
}

/* ---------- 1. 실험 설계 ---------- */
function sampleKind() {
  if (isUnknownMode()) return 'acid';
  return state.choice.sample ? SAMPLES[state.choice.sample].kind : null;
}

function groups() {
  const g = [];
  const unk = isUnknownMode();
  g.push({ key: 'sample', title: '시료 (삼각 플라스크)', options: unk
    ? [{ v: 'UNKNOWN', label: '미지 산', sub: '정체·농도 비공개' }]
    : Object.entries(SAMPLES).map(([k, s]) => ({ v: k, label: s.name, sub: s.formula })) });
  if (!unk) g.push({ key: 'sampleConc', title: '시료 농도', options: [0.05, 0.1, 0.2].map((c) => ({ v: c, label: `${c} M` })) });
  g.push({ key: 'sampleVol', title: '시료 부피 (피펫)', options: [10, 20, 25].map((v) => ({ v, label: `${v} mL` })) });
  const kind = sampleKind();
  const tKeys = kind === 'base' ? ['HCl'] : kind === 'acid' ? ['NaOH', 'KOH'] : ['NaOH', 'KOH', 'HCl'];
  g.push({ key: 'titrant', title: '표준 용액 (뷰렛)', options: tKeys.map((k) => ({ v: k, label: TITRANTS[k].name, sub: TITRANTS[k].formula })) });
  g.push({ key: 'titrantConc', title: '표준 용액 농도', options: [0.05, 0.1, 0.2].map((c) => ({ v: c, label: `${c} M` })) });
  g.push({ key: 'indicator', title: '지시약', options: Object.entries(INDICATORS).map(([k, i]) => ({ v: k, label: i.name, sub: i.range ? `변색 pH ${i.range[0]}~${i.range[1]}` : '' })) });
  g.push({ key: 'meter', title: 'pH 미터', options: [{ v: 'on', label: '사용', sub: 'pH를 숫자로 측정' }, { v: 'off', label: '사용 안 함', sub: '색 변화로만 판단' }] });
  g.push({ key: 'noise', title: '측정 조건', options: [{ v: 'ideal', label: '이상적', sub: '측정 오차 없음' }, { v: 'real', label: '현실적', sub: '방울 크기·미터 오차 있음' }] });
  return g;
}

function isLocked(key) {
  if (state.trial && !state.trial.ended) return true;
  if (key === 'sample' && isUnknownMode()) return true;
  if (key === 'noise' && state.mode === 'eval' && CFG.evalFixed && CFG.evalFixed.noise) return true;
  return false;
}

function renderSteps() {
  const box = $('#steps');
  box.innerHTML = '';
  groups().forEach((grp, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'step';
    const done = state.choice[grp.key] !== null && state.choice[grp.key] !== undefined;
    wrap.innerHTML = `<div class="step-head"><span class="num ${done ? 'done' : ''}">${i + 1}</span><span>${grp.title}</span></div>`;
    const opts = document.createElement('div');
    opts.className = 'opts';
    grp.options.forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt' + (String(state.choice[grp.key]) === String(o.v) ? ' on' : '');
      b.innerHTML = `<span>${o.label}</span>${o.sub ? `<small>${o.sub}</small>` : ''}`;
      b.disabled = isLocked(grp.key);
      b.addEventListener('click', () => choose(grp.key, o.v));
      opts.appendChild(b);
    });
    wrap.appendChild(opts);
    box.appendChild(wrap);
  });
  renderRoute();
}

function choose(key, v) {
  state.choice[key] = v;
  if (key === 'sample') {
    const kind = SAMPLES[v] ? SAMPLES[v].kind : 'acid';
    const t = state.choice.titrant;
    if (t && TITRANTS[t].kind === kind) state.choice.titrant = null; // 산에는 염기, 염기에는 산
  }
  logAction('choose', { key, value: v });
  renderSteps();
}

function routeLabels(c = state.choice) {
  const out = [];
  if (c.sample) out.push(c.sample === 'UNKNOWN' ? '미지 산' : `${SAMPLES[c.sample].name} ${c.sampleConc ?? '?'} M`);
  if (c.sampleVol) out.push(`${c.sampleVol} mL`);
  if (c.titrant) out.push(`${TITRANTS[c.titrant].formula} ${c.titrantConc ?? '?'} M`);
  if (c.indicator) out.push(INDICATORS[c.indicator].name);
  if (c.meter) out.push(c.meter === 'on' ? 'pH 미터 사용' : 'pH 미터 없음');
  if (c.noise) out.push(c.noise === 'real' ? '현실적 측정' : '이상적 측정');
  return out;
}

function choiceComplete() {
  const need = ['sample', 'sampleVol', 'titrant', 'titrantConc', 'indicator', 'meter', 'noise'];
  if (!isUnknownMode()) need.push('sampleConc');
  return need.every((k) => state.choice[k] !== null && state.choice[k] !== undefined);
}

function renderRoute() {
  const labels = routeLabels();
  $('#route-chips').innerHTML = labels.length
    ? labels.map((l, i) => `<span class="chip">${l}</span>${i < labels.length - 1 ? '<span class="arrow">→</span>' : ''}`).join('')
    : '<span class="muted">아직 고른 조건이 없어요</span>';
  const running = state.trial && !state.trial.ended;
  $('#btn-start').disabled = !state.mode || !choiceComplete() || running;
  $('#btn-start').hidden = running;
  $('#btn-new').hidden = !running;
  $('#plan-reason').disabled = running;
}

/* ---------- 2. 실험대 ---------- */
function trueSample() {
  if (isUnknownMode()) return { key: state.unknown.key, conc: state.unknown.conc };
  return { key: state.choice.sample, conc: state.choice.sampleConc };
}
function chemParams(addedOverride) {
  const tr = state.trial;
  const s = trueSample();
  return { sample: s.key, Cs: s.conc, Vs: tr.c.sampleVol, titrant: tr.c.titrant, Ct: tr.c.titrantConc, Vt: addedOverride ?? tr.added };
}

function startTrial() {
  if (!choiceComplete()) return;
  const real = state.choice.noise === 'real';
  const initial = real ? round(Math.random() * 1.2, 2) : 0;
  state.trial = {
    no: state.trials.length + 1,
    c: { ...state.choice },
    route: routeLabels(),
    reason: $('#plan-reason').value.trim(),
    startedAt: new Date().toISOString(),
    added: 0, initialReading: initial, reading: initial,
    rows: [], endpoint: null, ended: false, refills: 0,
  };
  state.trials.push(state.trial);
  logAction('start', { route: state.trial.route, reason: state.trial.reason });
  toast(real ? '뷰렛의 처음 눈금을 먼저 읽어 두세요.' : '실험을 시작해요. 처음 눈금은 0.00 mL예요.');
  renderSteps(); renderAll();
}

function newTrial() {
  if (state.trial && !state.trial.ended) {
    if (!state.trial.endpoint && state.trial.added > 0 && !confirm('지금 실험을 끝내고 새 실험을 할까요? 기록은 남아요.')) return;
    state.trial.ended = true;
    logAction('end_trial');
  }
  renderSteps(); renderAll();
  toast('조건을 다시 고르고 실험 시작을 누르세요.');
}

function currentPH() {
  if (!state.trial) return null;
  return solvePH(chemParams());
}
function meterPH() {
  const pH = currentPH();
  if (pH === null) return null;
  const noisy = state.trial.c.noise === 'real' ? pH + gauss() * 0.015 : pH;
  return round(noisy, 2);
}

function addVolume(dv, { silent = false } = {}) {
  const tr = state.trial;
  if (!tr || tr.ended) { toast('실험 시작을 먼저 누르세요.'); return 0; }
  if (tr.endpoint) { toast('종말점을 표시했어요. 새 실험을 하려면 “조건 바꿔 새 실험”을 누르세요.'); return 0; }
  let actual = dv;
  if (tr.c.noise === 'real') actual = Math.max(0, dv * (1 + gauss() * 0.04));
  const room = BUR_CAP - tr.reading;
  if (room <= 0.0001) { toast('뷰렛이 비었어요. “뷰렛 다시 채우기”를 누르세요.'); return 0; }
  if (actual > room) actual = room;
  tr.added += actual; tr.reading += actual;
  if (!silent) logAction('add', { requested: dv });
  animateDrop();
  renderBench();
  return actual;
}

let pourTimer = null, pourTotal = 0;
function startPour() {
  if (!state.trial || state.trial.ended || state.trial.endpoint) { addVolume(0); return; }
  pourTotal = 0;
  $('#stopcock').classList.add('open');
  pourTimer = setInterval(() => {
    const a = addVolume(DROP, { silent: true });
    if (!a) stopPour(); else pourTotal += DROP;
  }, 50); // 1 mL/s
}
function stopPour() {
  if (!pourTimer) return;
  clearInterval(pourTimer); pourTimer = null;
  $('#stopcock').classList.remove('open');
  if (pourTotal > 0) logAction('pour', { requested: round(pourTotal) });
}

function animateDrop() {
  const d = $('#drop');
  d.classList.remove('fall'); void d.getBBox(); d.classList.add('fall');
}

function recordRow() {
  const tr = state.trial;
  if (!tr || tr.ended) { toast('실험 중일 때 기록할 수 있어요.'); return; }
  const pH = tr.c.meter === 'on' ? meterPH() : null;
  const row = { added: round(tr.added), reading: round(tr.reading), pH, color: indicatorColorName(tr.c.indicator, currentPH()) };
  tr.rows.push(row);
  logAction('record', row);
  renderData();
  toast(`${tr.rows.length}번째 값을 기록했어요.`);
}

function markEndpoint() {
  const tr = state.trial;
  if (!tr || tr.ended) { toast('실험 중일 때 표시할 수 있어요.'); return; }
  if (tr.endpoint) return;
  if (tr.added <= 0) { toast('아직 표준 용액을 넣지 않았어요.'); return; }
  tr.endpoint = { added: round(tr.added), reading: round(tr.reading), color: indicatorColorName(tr.c.indicator, currentPH()), pH: tr.c.meter === 'on' ? meterPH() : null };
  logAction('endpoint', tr.endpoint);
  renderAll();
  toast('종말점을 표시했어요. 결과 계산 탭에서 농도를 구해 보세요.');
}

function refill() {
  const tr = state.trial;
  if (!tr || tr.ended || tr.endpoint) return;
  tr.refills += 1;
  tr.reading = tr.c.noise === 'real' ? round(Math.random() * 1.2, 2) : 0;
  logAction('refill', { newReading: tr.reading });
  renderBench();
  toast('뷰렛을 다시 채웠어요. 새 처음 눈금을 읽어 두세요.');
}

/* ---------- 그리기 ---------- */
const BUR_TOP = 30, BUR_PX = 5.2; // 0 mL → y=30, 50 mL → y=290

function drawBuretteTicks() {
  const g = $('#bur-ticks');
  let s = '';
  for (let v = 0; v <= 50; v += 1) {
    const y = BUR_TOP + v * BUR_PX;
    const len = v % 5 === 0 ? 8 : 4;
    s += `<line x1="146" x2="${146 + len}" y1="${y}" y2="${y}" class="tick"/>`;
    if (v % 10 === 0) s += `<text x="140" y="${y + 3}" class="tick-label">${v}</text>`;
  }
  g.innerHTML = s;
}

function liquidRGB() {
  const tr = state.trial;
  if (!tr) return null;
  return indicatorRGBA(tr.c.indicator, currentPH());
}

function renderBench() {
  const tr = state.trial;
  const running = tr && !tr.ended;
  // 뷰렛 액체
  const reading = tr ? tr.reading : 0;
  const y = BUR_TOP + Math.min(BUR_CAP, reading) * BUR_PX;
  const bl = $('#bur-liquid');
  bl.setAttribute('y', y); bl.setAttribute('height', Math.max(0, 306 - y));
  // 플라스크
  const vol = tr ? tr.c.sampleVol + tr.added : 0;
  const h = tr ? Math.min(100, 10 + vol * 0.6) : 0;
  ['#flask-liquid', '#flask-tint'].forEach((id) => { const r = $(id); r.setAttribute('y', 458 - h); r.setAttribute('height', h); });
  const c = tr ? liquidRGB() : null;
  $('#flask-tint').setAttribute('fill', c ? `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(2)})` : 'transparent');
  // pH 미터
  const meterOn = tr && tr.c.meter === 'on';
  $('#meter').toggleAttribute('hidden', !meterOn);
  const mp = meterOn ? meterPH() : null;
  $('#meter-value').textContent = mp !== null ? mp.toFixed(2) : '--';
  $('#ph-read').textContent = !tr ? '-' : meterOn ? mp.toFixed(2) : '사용 안 함';
  $('#color-name').textContent = tr ? indicatorColorName(tr.c.indicator, currentPH()) : '-';
  // 확대 눈금
  renderZoom(reading);
  // 버튼 상태
  const canAdd = running && !tr.endpoint;
  $$('#controls [data-add], #btn-pour, #btn-endpoint, #btn-refill').forEach((b) => { b.disabled = !canAdd; });
  $('#btn-record').disabled = !running;
  $('#trial-no').textContent = tr ? `· ${tr.no}회차` : '';
  $('#bench-status').textContent = !state.mode ? '활동을 먼저 고르세요'
    : !tr || tr.ended ? '실험 설계를 끝내고 실험 시작을 누르세요'
    : tr.endpoint ? `종말점 표시 완료 (넣은 부피 ${tr.endpoint.added.toFixed(2)} mL)`
    : '표준 용액을 조금씩 넣으며 관찰하세요';
}

function renderZoom(reading) {
  const svg = $('#zoom');
  const r = reading;
  const cy = 85, px = 50; // 1 mL = 50 px
  const col = state.trial ? '#dbe9fb' : '#eef2f7';
  let s = `<rect x="45" y="0" width="60" height="170" fill="#f8fafc"/>`;
  if (state.trial) s += `<path d="M45 80 Q75 90 105 80 L105 170 L45 170 Z" fill="${col}"/>`;
  const start = Math.ceil((r - 1.75) * 10) / 10, end = r + 1.75;
  for (let v = Math.max(0, start); v <= Math.min(50, end) + 1e-9; v = round(v + 0.1, 1)) {
    const y = cy + (v - r) * px;
    const major = Math.abs(v - Math.round(v)) < 1e-6;
    const half = Math.abs(v * 2 - Math.round(v * 2)) < 1e-6;
    const len = major ? 26 : half ? 18 : 11;
    s += `<line x1="45" x2="${45 + len}" y1="${y}" y2="${y}" stroke="#334155" stroke-width="${major ? 1.4 : 0.9}"/>`;
    if (major) s += `<text x="112" y="${y + 4}" font-size="12" fill="#334155">${Math.round(v)}</text>`;
  }
  s += `<rect x="45" y="0" width="60" height="170" fill="none" stroke="#94a3b8"/>`;
  svg.innerHTML = s;
  const showNum = state.mode === 'practice' && CFG.showReadingInPractice;
  $('#zoom-read').textContent = !state.trial ? '' : showNum ? `현재 눈금 ${r.toFixed(2)} mL` : '메니스커스 아래쪽을 직접 읽으세요';
}

function renderData() {
  const tr = state.trial;
  const tb = $('#data-table tbody');
  const rows = tr ? tr.rows : [];
  tb.innerHTML = rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.added.toFixed(2)}</td><td>${r.reading.toFixed(2)}</td><td>${r.pH !== null ? r.pH.toFixed(2) : '-'}</td><td>${r.color}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">“현재 값 기록”을 누르면 여기에 쌓여요</td></tr>';
  drawCurve();
  renderHistory();
}

function drawCurve() {
  const cv = $('#curve');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const L = 52, R = 18, T = 18, B = 44;
  ctx.clearRect(0, 0, W, H);
  const tr = state.trial;
  const meterOn = tr && tr.c.meter === 'on';
  const rows = tr ? tr.rows.filter((r) => r.pH !== null) : [];
  const xmax = Math.max(10, Math.ceil((Math.max(0, ...rows.map((r) => r.added), tr ? tr.added : 0) * 1.15) / 5) * 5);
  const X = (v) => L + (v / xmax) * (W - L - R);
  const Y = (p) => T + (1 - p / 14) * (H - T - B);
  // 축과 격자
  ctx.font = '13px Pretendard Variable, system-ui, sans-serif';
  ctx.strokeStyle = '#e2e8f0'; ctx.fillStyle = '#64748b'; ctx.lineWidth = 1;
  for (let p = 0; p <= 14; p += 2) { ctx.beginPath(); ctx.moveTo(L, Y(p)); ctx.lineTo(W - R, Y(p)); ctx.stroke(); ctx.fillText(String(p), L - 24, Y(p) + 4); }
  const step = xmax <= 20 ? 2 : xmax <= 50 ? 5 : 10;
  for (let v = 0; v <= xmax; v += step) { ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), H - B); ctx.stroke(); ctx.fillText(String(v), X(v) - 6, H - B + 18); }
  ctx.fillStyle = '#334155';
  ctx.fillText('넣은 표준 용액의 부피 (mL)', W / 2 - 80, H - 8);
  ctx.save(); ctx.translate(16, H / 2 + 10); ctx.rotate(-Math.PI / 2); ctx.fillText('pH', 0, 0); ctx.restore();
  const note = $('#curve-note');
  if (!tr) { note.textContent = '실험을 시작하면 기록한 값으로 적정 곡선이 그려져요.'; return; }
  if (!meterOn) { note.textContent = 'pH 미터를 쓰지 않는 실험이라 곡선 대신 색 변화로 종말점을 찾아요. 기록한 색은 아래 표에서 확인하세요.'; return; }
  note.textContent = rows.length < 2 ? '“현재 값 기록”을 눌러 점을 찍어 보세요. 점이 많을수록 곡선이 또렷해져요.' : `기록한 점 ${rows.length}개`;
  // 지시약 변색 범위 띠
  const ind = INDICATORS[tr.c.indicator];
  if (ind && ind.range) {
    ctx.fillStyle = 'rgba(99,102,241,0.08)';
    ctx.fillRect(L, Y(ind.range[1]), W - L - R, Y(ind.range[0]) - Y(ind.range[1]));
    ctx.fillStyle = '#6366f1'; ctx.fillText(`${ind.name} 변색 범위`, W - R - 130, Y(ind.range[1]) - 4);
  }
  const sorted = [...rows].sort((a, b) => a.added - b.added);
  ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.beginPath();
  sorted.forEach((r, i) => { const x = X(r.added), y = Y(r.pH); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = '#1d4ed8';
  sorted.forEach((r) => { ctx.beginPath(); ctx.arc(X(r.added), Y(r.pH), 3.5, 0, Math.PI * 2); ctx.fill(); });
  if (tr.endpoint) {
    ctx.strokeStyle = '#dc2626'; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(X(tr.endpoint.added), T); ctx.lineTo(X(tr.endpoint.added), H - B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#dc2626'; ctx.fillText('종말점', X(tr.endpoint.added) + 4, T + 14);
  }
}

function renderHistory() {
  const done = state.trials.filter((t) => t !== state.trial || t.ended);
  const box = $('#trial-history');
  if (!state.trials.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h3>실험 기록</h3>' + state.trials.map((t) => `
    <div class="hist${t === state.trial && !t.ended ? ' now' : ''}">
      <b>${t.no}회차</b> ${t.route.join(' → ')}<br>
      <span class="muted">기록 ${t.rows.length}개 · ${t.endpoint ? `종말점 눈금 ${t.endpoint.reading.toFixed(2)} mL (처음 눈금 ${t.initialReading.toFixed(2)} mL${t.refills ? `, 다시 채움 ${t.refills}회` : ''})` : '종말점 미표시'}</span>
    </div>`).join('');
  void done;
}

function renderParticles() {
  const box = $('#particles');
  const tr = state.trial;
  if (isUnknownMode()) { box.innerHTML = '<p class="muted">미지 시료를 분석하는 중이라 입자 보기를 쓸 수 없어요. 연습 모드에서 강산과 약산의 입자 변화를 비교해 보세요.</p>'; return; }
  if (!tr) { box.innerHTML = '<p class="muted">실험을 시작하면 입자의 양이 나타나요.</p>'; return; }
  const p = chemParams();
  const sp = speciesAmounts(p, currentPH());
  const max = Math.max(...sp.map((s) => s.mmol), 1e-9);
  box.innerHTML = sp.map((s) => {
    const w = Math.max(0.5, (s.mmol / max) * 100);
    const tiny = s.mmol < max * 0.005;
    return `<div class="bar-row"><span class="bar-label">${s.label}</span><span class="bar"><i style="width:${tiny ? 0.5 : w}%"></i></span><span class="bar-val">${s.mmol < 0.001 ? s.mmol.toExponential(1) : s.mmol.toFixed(3)} mmol</span></div>`;
  }).join('') + `<p class="note">넣은 부피 ${tr.added.toFixed(2)} mL 기준. H₃O⁺와 OH⁻처럼 아주 적은 입자는 막대가 거의 보이지 않아요.</p>`;
}

/* ---------- 결과 계산 ---------- */
function setupResult() {
  $('#result-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const withEnd = state.trials.filter((t) => t.endpoint);
    if (!withEnd.length) { toast('종말점을 표시한 실험이 있어야 제출할 수 있어요.'); return; }
    const f = new FormData(e.target);
    const res = {
      t: new Date().toISOString(),
      volume: Number(f.get('vol')), n: Number(f.get('n')), conc: Number(f.get('conc')),
      strength: f.get('strength'), why: String(f.get('why')), error: String(f.get('error')),
      trialsWithEndpoint: withEnd.map((t) => t.no),
    };
    state.results.push(res);
    logAction('submit_result', { volume: res.volume, conc: res.conc, strength: res.strength });
    const fb = $('#result-feedback');
    if (state.mode === 'eval') {
      fb.innerHTML = '<div class="card ok">제출했어요. 위 <b>기록 내려받기</b>를 눌러 파일을 선생님께 내세요.</div>';
      return;
    }
    const s = trueSample();
    const S = SAMPLES[s.key];
    const err = Math.abs(res.conc - s.conc) / s.conc * 100;
    const strengthOk = res.strength === (S.strong ? 'strong' : 'weak');
    fb.innerHTML = `<div class="card">
      <div><b>실제 시료</b> ${isUnknownMode() ? `${S.name} (${S.formula})` : S.name} · ${s.conc} M · ${protonCount(s.key)}가 · ${S.kind === 'acid' ? (S.strong ? '강산' : '약산') : (S.strong ? '강염기' : '약염기')}</div>
      <div><b>내 농도</b> ${res.conc} M → 오차 ${err.toFixed(1)}%</div>
      ${S.kind === 'acid' ? `<div><b>세기 판단</b> ${strengthOk ? '맞았어요' : '다시 생각해 보세요'}</div>` : ''}
      <p class="muted">오차가 크다면 종말점에서 넣은 부피, 처음 눈금, 가수 n을 다시 확인해 보세요.</p></div>`;
    if (state.mode === 'explore') logAction('reveal', {});
  });
}

/* ---------- 탭 ---------- */
function setupTabs() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== t.dataset.tab; });
    if (t.dataset.tab === 'particle') renderParticles();
    if (t.dataset.tab === 'data') drawCurve();
  }));
}

function renderAll() {
  renderBench(); renderData(); renderRoute();
  if (!$('[data-body="particle"]').hidden) renderParticles();
}

/* ---------- AI 조교에 넘기는 실험 상태 ---------- */
// 학생이 화면에서 볼 수 있는 정보만 넘긴다. 미지 시료의 정체와 농도는 절대 넣지 않는다.
function aiState() {
  const tr = state.trial;
  const stage = !tr || tr.ended ? (state.trials.length ? '새 실험 설계 중' : '실험 설계 중')
    : tr.endpoint ? (state.results.length ? '결과 제출 후' : '종말점 표시 후, 계산·해석 단계')
    : tr.rows.length ? '적정 진행 중 (데이터 기록 중)' : '적정 시작 직후';
  const c = tr && !tr.ended ? tr.c : state.choice;
  const conditions = {
    시료: c.sample === 'UNKNOWN' ? '미지 산 (정체·농도는 학생도 AI도 모름)' : c.sample ? `${SAMPLES[c.sample].name} (${SAMPLES[c.sample].formula}) ${c.sampleConc ?? '?'} M` : '미선택',
    시료부피_mL: c.sampleVol, 표준용액: c.titrant ? `${TITRANTS[c.titrant].name} ${c.titrantConc ?? '?'} M` : '미선택',
    지시약: c.indicator ? INDICATORS[c.indicator].name : '미선택',
    pH미터: c.meter === 'on' ? '사용' : c.meter === 'off' ? '사용 안 함' : '미선택',
    측정조건: c.noise === 'real' ? '현실적(오차 있음)' : c.noise === 'ideal' ? '이상적' : '미선택',
  };
  const cur = tr && !tr.ended ? {
    넣은부피_mL: round(tr.added), 뷰렛눈금_mL: round(tr.reading), 처음눈금_mL: tr.initialReading,
    현재pH: tr.c.meter === 'on' ? meterPH() : '측정 안 함', 플라스크색: indicatorColorName(tr.c.indicator, currentPH()),
    종말점: tr.endpoint, 기록한데이터: tr.rows.slice(-40), 조건을고른이유: tr.reason || '(적지 않음)',
  } : null;
  return {
    모드: MODE_NAMES[state.mode] || '', 단계: stage, 현재조건: conditions, 현재실험: cur,
    이전실험: state.trials.filter((t) => t !== tr || t.ended).slice(-5).map((t) => ({ 회차: t.no, 경로: t.route.join(' → '), 기록수: t.rows.length, 종말점: t.endpoint })),
    제출한결과: state.results.slice(-1)[0] || null,
    최근조작: state.actions.slice(-12).map((a) => ({ 종류: a.type, ...(a.key ? { 항목: a.key, 값: a.value } : {}), ...(a.requested ? { mL: a.requested } : {}) })),
  };
}

/* ---------- 기록 내려받기 ---------- */
function download() {
  const rec = {
    app: '중화 적정 가상 실험실', version: 1, mode: state.mode, student: state.student.id || null,
    seed: state.mode === 'eval' ? state.seed : null, startedAt: state.startedAt, savedAt: new Date().toISOString(),
    trials: state.trials.map((t) => ({ no: t.no, route: t.route, conditions: { ...t.c, sampleConc: t.c.sample === 'UNKNOWN' ? null : t.c.sampleConc }, reason: t.reason, initialReading: t.initialReading, refills: t.refills, rows: t.rows, endpoint: t.endpoint })),
    results: state.results, aiChat: state.chat, actions: state.actions,
  };
  const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.student.id || '적정'}_기록_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  logAction('download');
}

/* ---------- 연결 ---------- */
const ai = initAI($('#ai-panel'), {
  endpoint: CFG.aiEndpoint,
  getState: aiState,
  onExchange: (q, a) => { state.chat.push({ t: new Date().toISOString(), role: 'user', content: q }, { t: new Date().toISOString(), role: 'assistant', content: a }); logAction('ai_question'); },
});

function setup() {
  drawBuretteTicks();
  setupStart(); setupTabs(); setupResult();
  $('#btn-start').addEventListener('click', startTrial);
  $('#btn-new').addEventListener('click', newTrial);
  $$('#controls [data-add]').forEach((b) => b.addEventListener('click', () => addVolume(Number(b.dataset.add))));
  const pour = $('#btn-pour');
  pour.addEventListener('pointerdown', (e) => { e.preventDefault(); startPour(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => pour.addEventListener(ev, stopPour));
  $('#btn-record').addEventListener('click', recordRow);
  $('#btn-endpoint').addEventListener('click', markEndpoint);
  $('#btn-refill').addEventListener('click', refill);
  $('#btn-download').addEventListener('click', download);
  window.addEventListener('beforeunload', (e) => { if (state.actions.length > 3) { e.preventDefault(); e.returnValue = ''; } });
  renderSteps(); renderAll();
}
setup();

// 테스트용 (브라우저 콘솔)
window.__lab = { state, aiState };
