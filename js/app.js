import {
  SAMPLES, TITRANTS, INDICATORS, solvePH, speciesAmounts, protonCount,
  indicatorRGBA, indicatorColorName, unknownFromSeed, gauss,
} from './chem.js';
import { initAI } from './ai.js';

const CFG = Object.assign({
  aiEndpoint: '', requiredTrials: 3, videos: [],
  unknownPool: ['HCl', 'HNO3', 'CH3COOH', 'HCOOH'], unknownRange: [0.05, 0.2],
  evalFixed: {}, showReadingInPractice: true,
}, window.LAB_CONFIG || {});
const REQ = Math.max(1, Number(CFG.requiredTrials) || 3);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BUR_CAP = 50;
const DROP = 0.05;

const MODE_NAMES = { practice: '연습 모드', explore: '탐구 모드', eval: '평가 모드' };
const SCREEN_NAMES = { theory: '이론 학습', plan: '시약 선택', bench: '실험', result: '결과 정리' };

const state = {
  mode: null,
  screen: null,
  theoryDone: false,
  student: { id: '', code: '' },
  seed: '',
  unknown: null,           // { key, conc } — 화면과 AI에 절대 보이지 않음
  choice: { sample: null, sampleConc: null, sampleVol: null, titrant: null, titrantConc: null, indicator: null, meter: null, noise: null },
  trial: null,             // 지금 실험대에 있는 회차
  trials: [],              // 모든 시도 (status: running | done | abandoned)
  actions: [],
  results: [],
  chat: [],
  startedAt: new Date().toISOString(),
};

const doneTrials = () => state.trials.filter((t) => t.status === 'done');
const running = () => state.trial && state.trial.status === 'running';
const isUnknownMode = () => state.mode === 'explore' || state.mode === 'eval';

/* ---------- 공통 ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), 2800);
}
function logAction(type, detail = {}) {
  state.actions.push({ t: new Date().toISOString(), trial: state.trial ? state.trial.no : null, screen: state.screen, type, ...detail });
}

/* ---------- 화면 이동 ---------- */
function canGo(screen) {
  if (!state.mode) return false;
  if (screen === 'theory') return true;
  if (screen === 'plan') return state.theoryDone && !running() && doneTrials().length < REQ;
  if (screen === 'bench') return !!state.trial;
  if (screen === 'result') return doneTrials().length >= REQ;
  return false;
}
function go(screen) {
  if (!canGo(screen)) return;
  state.screen = screen;
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== screen; });
  logAction('screen', { to: screen });
  if (screen === 'plan') renderPlan();
  if (screen === 'bench') renderAll();
  if (screen === 'result') renderResult();
  renderStepper();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderStepper() {
  $$('.stp').forEach((b) => {
    const s = b.dataset.go;
    b.classList.toggle('active', s === state.screen);
    b.disabled = !canGo(s);
    const done = (s === 'theory' && state.theoryDone) || (s === 'result' && state.results.length) ||
      ((s === 'plan' || s === 'bench') && doneTrials().length >= REQ);
    b.classList.toggle('done', !!done);
  });
  const dots = $('#trial-dots');
  const n = doneTrials().length;
  dots.innerHTML = state.mode ? Array.from({ length: REQ }, (_, i) => `<i class="${i < n ? 'on' : running() && i === n ? 'now' : ''}"></i>`).join('') + `<span>${n}/${REQ}회차</span>` : '';
}

/* ---------- 시작 ---------- */
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
  else if (pm === 'eval') $('#eval-form').hidden = false;
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
  const aiOn = mode !== 'eval';
  ai.setEnabled(aiOn);
  $('#btn-ai').disabled = !aiOn;
  $('#btn-ai').title = aiOn ? '' : '평가 모드에서는 AI 조교를 쓸 수 없어요';
  logAction('mode', { mode });
  go('theory');
}

/* ---------- ① 이론 학습 ---------- */
function setupTheory() {
  $('#ind-table-body').innerHTML = Object.values(INDICATORS).filter((i) => i.range).map((i) => {
    const sw = (c) => `<i class="sw" style="background:rgba(${c[0]},${c[1]},${c[2]},${Math.max(c[3], 0.08)})"></i>`;
    return `<tr><td>${i.name}</td><td>${i.range[0]} ~ ${i.range[1]}</td><td>${sw(i.colors[0])}${i.names[0]} → ${sw(i.colors[i.colors.length - 1])}${i.names[i.names.length - 1]}</td></tr>`;
  }).join('');
  drawTheoryCurve();
  const vbox = $('#videos');
  vbox.innerHTML = (CFG.videos || []).map((v, i) => `
    <div class="video" data-i="${i}">
      <button class="thumb" type="button" aria-label="${esc(v.title)} 재생">
        <img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy">
        <span class="play">▶</span>
      </button>
      <div class="vmeta"><b>${esc(v.title)}</b><span class="muted small">${esc(v.source || '')}</span>
      <a class="small" href="https://www.youtube.com/watch?v=${esc(v.id)}${v.start ? `&t=${v.start}s` : ''}" target="_blank" rel="noopener">유튜브에서 보기 ↗</a></div>
    </div>`).join('') || '<p class="muted">선생님이 영상을 아직 넣지 않았어요.</p>';
  $$('.video .thumb').forEach((b) => b.addEventListener('click', () => {
    const box = b.closest('.video');
    const v = CFG.videos[Number(box.dataset.i)];
    const f = document.createElement('iframe');
    f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?autoplay=1&rel=0${v.start ? `&start=${v.start}` : ''}`;
    f.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
    f.allowFullscreen = true; f.title = v.title;
    b.replaceWith(f);
    logAction('video', { title: v.title });
  }));
  $('#theory-check').addEventListener('change', (e) => { $('#btn-to-plan').disabled = !e.target.checked; });
  $('#btn-to-plan').addEventListener('click', () => {
    state.theoryDone = true;
    logAction('theory_done');
    go('plan');
  });
}

function drawTheoryCurve() {
  const svg = $('#theory-curve');
  const W = 420, H = 260, L = 38, R = 12, T = 12, B = 32;
  const X = (v) => L + (v / 50) * (W - L - R);
  const Y = (p) => T + (1 - p / 14) * (H - T - B);
  const pts = (key) => Array.from({ length: 251 }, (_, i) => i * 0.2).map((v) => `${X(v).toFixed(1)},${Y(solvePH({ sample: key, Cs: 0.1, Vs: 25, titrant: 'NaOH', Ct: 0.1, Vt: v })).toFixed(1)}`).join(' ');
  let s = '';
  for (let p = 0; p <= 14; p += 2) s += `<line x1="${L}" x2="${W - R}" y1="${Y(p)}" y2="${Y(p)}" class="grid"/><text x="${L - 6}" y="${Y(p) + 4}" class="ax" text-anchor="end">${p}</text>`;
  for (let v = 0; v <= 50; v += 10) s += `<text x="${X(v)}" y="${H - B + 16}" class="ax" text-anchor="middle">${v}</text>`;
  s += `<text x="${(W + L) / 2}" y="${H - 2}" class="ax" text-anchor="middle">넣은 NaOH 부피 (mL)</text>`;
  s += `<line x1="${X(25)}" x2="${X(25)}" y1="${T}" y2="${H - B}" class="eq"/><text x="${X(25) + 4}" y="${T + 12}" class="ax">중화점</text>`;
  s += `<polyline points="${pts('HCl')}" class="ln strong"/><polyline points="${pts('CH3COOH')}" class="ln weak"/>`;
  s += `<circle cx="${X(12.5)}" cy="${Y(solvePH({ sample: 'CH3COOH', Cs: 0.1, Vs: 25, titrant: 'NaOH', Ct: 0.1, Vt: 12.5 }))}" r="4" class="half"/><text x="${X(12.5)}" y="${Y(3.3)}" class="ax" text-anchor="middle">반당량점 (pH = pKa)</text>`;
  s += `<text x="${X(5)}" y="${Y(0.25)}" class="lab strong-t">HCl (강산)</text><text x="${X(2)}" y="${Y(6.2)}" class="lab weak-t">CH₃COOH (약산)</text>`;
  svg.innerHTML = s;
}

/* ---------- ② 시약 선택 ---------- */
function sampleKind() {
  if (isUnknownMode()) return 'acid';
  return state.choice.sample ? SAMPLES[state.choice.sample].kind : null;
}

function shelves() {
  const unk = isUnknownMode();
  const kind = sampleKind();
  const tKeys = kind === 'base' ? ['HCl'] : kind === 'acid' ? ['NaOH', 'KOH'] : ['NaOH', 'KOH', 'HCl'];
  const sh = [
    { title: '삼각 플라스크에 넣을 시료', icon: '🧪', groups: [
      { key: 'sample', title: '시료', options: unk ? [{ v: 'UNKNOWN', label: '미지 산', sub: '정체·농도 비공개' }]
        : Object.entries(SAMPLES).map(([k, s]) => ({ v: k, label: s.name, sub: s.formula, tag: s.kind === 'acid' ? '산' : '염기' })) },
      ...(unk ? [] : [{ key: 'sampleConc', title: '시료 농도', options: [0.05, 0.1, 0.2].map((c) => ({ v: c, label: `${c} M` })) }]),
      { key: 'sampleVol', title: '피펫으로 취할 부피', options: [10, 20, 25].map((v) => ({ v, label: `${v} mL` })) },
    ] },
    { title: '뷰렛에 넣을 표준 용액', icon: '⚗', groups: [
      { key: 'titrant', title: '표준 용액', options: tKeys.map((k) => ({ v: k, label: TITRANTS[k].name, sub: TITRANTS[k].formula })) },
      { key: 'titrantConc', title: '표준 용액 농도', options: [0.05, 0.1, 0.2].map((c) => ({ v: c, label: `${c} M` })) },
    ] },
    { title: '지시약', icon: '💧', groups: [
      { key: 'indicator', title: '지시약 (2~3방울)', options: Object.entries(INDICATORS).map(([k, i]) => ({ v: k, label: i.name, sub: i.range ? `pH ${i.range[0]}~${i.range[1]}` : '', swatch: i.colors ? i.colors : null })) },
    ] },
    { title: '측정 도구와 조건', icon: '📟', groups: [
      { key: 'meter', title: 'pH 미터', options: [{ v: 'on', label: '사용', sub: 'pH를 숫자로 측정' }, { v: 'off', label: '사용 안 함', sub: '색 변화로만 판단' }] },
      { key: 'noise', title: '측정 조건', options: [{ v: 'ideal', label: '이상적', sub: '측정 오차 없음' }, { v: 'real', label: '현실적', sub: '방울 크기·미터 오차' }] },
    ] },
  ];
  return sh;
}

function isLocked(key) {
  if (key === 'sample' && isUnknownMode()) return true;
  if (key === 'noise' && state.mode === 'eval' && CFG.evalFixed && CFG.evalFixed.noise) return true;
  return false;
}

function renderPlan() {
  const no = doneTrials().length + 1;
  $('#plan-title').textContent = `${no}회차 실험 설계 (${no}/${REQ})`;
  $('#plan-sub').textContent = no === 1 ? '시약장에서 실험에 쓸 시약과 도구를 고르세요.'
    : '지난 회차 조건이 그대로 골라져 있어요. 같은 조건으로 반복하거나, 바꿔서 비교해 보세요.';
  const last = doneTrials().slice(-1)[0];
  const ps = $('#prev-summary');
  ps.hidden = !last;
  if (last) ps.innerHTML = `<b>지난 ${last.no}회차</b><br>${last.route.map(esc).join(' → ')}<br><span class="muted">종말점 눈금 ${last.endpoint.reading.toFixed(2)} mL (처음 ${last.initialReading.toFixed(2)} mL)</span>`;
  const box = $('#shelves');
  box.innerHTML = '';
  shelves().forEach((shelf) => {
    const sh = document.createElement('div');
    sh.className = 'shelf';
    sh.innerHTML = `<div class="shelf-title"><span aria-hidden="true">${shelf.icon}</span>${shelf.title}</div>`;
    shelf.groups.forEach((grp) => {
      const done = state.choice[grp.key] !== null && state.choice[grp.key] !== undefined;
      const g = document.createElement('div');
      g.className = 'grp';
      g.innerHTML = `<div class="grp-title">${done ? '<span class="ok">✓</span>' : '<span class="todo">○</span>'}${grp.title}</div>`;
      const row = document.createElement('div');
      row.className = 'bottles';
      grp.options.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bottle' + (String(state.choice[grp.key]) === String(o.v) ? ' on' : '');
        const sw = o.swatch ? `<span class="swatches">${o.swatch.map((c) => `<i style="background:rgba(${c[0]},${c[1]},${c[2]},${Math.max(c[3], 0.12)})"></i>`).join('')}</span>` : '';
        b.innerHTML = `${o.tag ? `<em class="tag">${o.tag}</em>` : ''}<span class="b-label">${o.label}</span>${o.sub ? `<small>${o.sub}</small>` : ''}${sw}`;
        b.disabled = isLocked(grp.key);
        b.addEventListener('click', () => choose(grp.key, o.v));
        row.appendChild(b);
      });
      g.appendChild(row);
      sh.appendChild(g);
    });
    box.appendChild(sh);
  });
  renderRoute();
}

function choose(key, v) {
  state.choice[key] = v;
  if (key === 'sample') {
    const kind = SAMPLES[v] ? SAMPLES[v].kind : 'acid';
    const t = state.choice.titrant;
    if (t && TITRANTS[t].kind === kind) state.choice.titrant = null;
  }
  logAction('choose', { key, value: v });
  renderPlan();
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
    ? labels.map((l, i) => `<span class="chip">${esc(l)}</span>${i < labels.length - 1 ? '<span class="arrow">→</span>' : ''}`).join('')
    : '<span class="muted">아직 고른 조건이 없어요</span>';
  $('#btn-start').disabled = !choiceComplete();
}

/* ---------- ③ 실험 ---------- */
function trueSample() {
  if (isUnknownMode()) return { key: state.unknown.key, conc: state.unknown.conc };
  return { key: state.trial.c.sample, conc: state.trial.c.sampleConc };
}
function chemParams(tr = state.trial, added) {
  const s = isUnknownMode() ? state.unknown : { key: tr.c.sample, conc: tr.c.sampleConc };
  return { sample: s.key, Cs: s.conc, Vs: tr.c.sampleVol, titrant: tr.c.titrant, Ct: tr.c.titrantConc, Vt: added ?? tr.added };
}

function makeTrial(c, reason) {
  const real = c.noise === 'real';
  const initial = real ? round(Math.random() * 1.2, 2) : 0;
  return {
    no: doneTrials().length + 1, status: 'running',
    c: { ...c }, route: routeLabels(c), reason,
    startedAt: new Date().toISOString(),
    added: 0, initialReading: initial, reading: initial,
    rows: [], endpoint: null, refills: 0,
  };
}

function startTrial() {
  if (!choiceComplete()) return;
  const reason = $('#plan-reason').value.trim();
  if (!reason) { toast('조건을 고른 이유를 한 줄이라도 적어 주세요.'); $('#plan-reason').focus(); return; }
  state.trial = makeTrial(state.choice, reason);
  state.trials.push(state.trial);
  $('#plan-reason').value = '';
  logAction('start', { route: state.trial.route, reason });
  go('bench');
  toast(state.trial.c.noise === 'real' ? `${state.trial.no}회차 시작! 뷰렛의 처음 눈금을 먼저 읽어 두세요.` : `${state.trial.no}회차 시작! 처음 눈금은 0.00 mL예요.`);
}

function restartTrial() {
  const tr = state.trial;
  if (!running()) return;
  if (tr.added > 0 && !confirm('이번 회차를 처음부터 다시 할까요? 지금까지 넣은 용액과 기록은 회차로 인정되지 않아요.')) return;
  tr.status = 'abandoned';
  logAction('restart_trial');
  state.trial = makeTrial(tr.c, tr.reason);
  state.trials.push(state.trial);
  renderAll();
  toast('같은 조건으로 다시 시작했어요.');
}

function currentPH(tr = state.trial) { return tr ? solvePH(chemParams(tr)) : null; }
function meterPH() {
  const pH = currentPH();
  if (pH === null) return null;
  return round(state.trial.c.noise === 'real' ? pH + gauss() * 0.015 : pH, 2);
}

function addVolume(dv, { silent = false } = {}) {
  const tr = state.trial;
  if (!running()) { toast(tr && tr.status === 'done' ? '이 회차는 끝났어요. 다음 단계로 넘어가세요.' : '실험을 먼저 시작하세요.'); return 0; }
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
  if (!running()) { addVolume(0); return; }
  pourTotal = 0;
  $('#stopcock').classList.add('open');
  pourTimer = setInterval(() => { const a = addVolume(DROP, { silent: true }); if (!a) stopPour(); else pourTotal += DROP; }, 50);
}
function stopPour() {
  if (!pourTimer) return;
  clearInterval(pourTimer); pourTimer = null;
  $('#stopcock').classList.remove('open');
  if (pourTotal > 0) logAction('pour', { requested: round(pourTotal) });
}
function animateDrop() { const d = $('#drop'); d.classList.remove('fall'); void d.getBBox(); d.classList.add('fall'); }

function recordRow() {
  const tr = state.trial;
  if (!running()) { toast('실험 중일 때 기록할 수 있어요.'); return; }
  const row = { added: round(tr.added), reading: round(tr.reading), pH: tr.c.meter === 'on' ? meterPH() : null, color: indicatorColorName(tr.c.indicator, currentPH()) };
  tr.rows.push(row);
  logAction('record', row);
  renderData();
  toast(`${tr.rows.length}번째 값을 기록했어요.`);
}

function markEndpoint() {
  const tr = state.trial;
  if (!running()) return;
  if (tr.added <= 0) { toast('아직 표준 용액을 넣지 않았어요.'); return; }
  if (!confirm('여기를 종말점으로 표시할까요? 표시하면 이번 회차는 끝나요.')) return;
  tr.endpoint = { added: round(tr.added), reading: round(tr.reading), color: indicatorColorName(tr.c.indicator, currentPH()), pH: tr.c.meter === 'on' ? meterPH() : null };
  tr.status = 'done';
  tr.endedAt = new Date().toISOString();
  logAction('endpoint', tr.endpoint);
  renderAll(); renderStepper();
  toast(`${tr.no}회차를 마쳤어요.`);
}

function refill() {
  const tr = state.trial;
  if (!running()) return;
  tr.refills += 1;
  tr.reading = tr.c.noise === 'real' ? round(Math.random() * 1.2, 2) : 0;
  logAction('refill', { newReading: tr.reading });
  renderBench();
  toast('뷰렛을 다시 채웠어요. 새 처음 눈금을 읽어 두세요.');
}

/* ---------- 그리기 ---------- */
const BUR_TOP = 30, BUR_PX = 5.2;
function drawBuretteTicks() {
  let s = '';
  for (let v = 0; v <= 50; v += 1) {
    const y = BUR_TOP + v * BUR_PX;
    s += `<line x1="146" x2="${146 + (v % 5 === 0 ? 8 : 4)}" y1="${y}" y2="${y}" class="tick"/>`;
    if (v % 10 === 0) s += `<text x="140" y="${y + 3}" class="tick-label">${v}</text>`;
  }
  $('#bur-ticks').innerHTML = s;
}

function renderBench() {
  const tr = state.trial;
  const run = running();
  const reading = tr ? tr.reading : 0;
  const y = BUR_TOP + Math.min(BUR_CAP, reading) * BUR_PX;
  const bl = $('#bur-liquid'); bl.setAttribute('y', y); bl.setAttribute('height', Math.max(0, 306 - y));
  const vol = tr ? tr.c.sampleVol + tr.added : 0;
  const h = tr ? Math.min(100, 10 + vol * 0.6) : 0;
  ['#flask-liquid', '#flask-tint'].forEach((id) => { const r = $(id); r.setAttribute('y', 458 - h); r.setAttribute('height', h); });
  const c = tr ? indicatorRGBA(tr.c.indicator, currentPH()) : null;
  $('#flask-tint').setAttribute('fill', c ? `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(2)})` : 'transparent');
  const meterOn = tr && tr.c.meter === 'on';
  $('#meter').toggleAttribute('hidden', !meterOn);
  const mp = meterOn ? (run ? meterPH() : tr.endpoint?.pH ?? round(currentPH(), 2)) : null;
  $('#meter-value').textContent = mp !== null && mp !== undefined ? mp.toFixed(2) : '--';
  $('#ph-read').textContent = !tr ? '-' : meterOn ? mp.toFixed(2) : '사용 안 함';
  $('#color-name').textContent = tr ? indicatorColorName(tr.c.indicator, currentPH()) : '-';
  renderZoom(reading);
  $$('#controls [data-add], #btn-pour, #btn-endpoint, #btn-refill, #btn-record, #btn-restart').forEach((b) => { b.disabled = !run; });
  $('#trial-no').textContent = tr ? `· ${tr.no}회차 / ${REQ}` : '';
  $('#bench-chips').innerHTML = tr ? tr.route.map((l) => `<span class="chip">${esc(l)}</span>`).join('') : '';
  $('#bench-status').textContent = !tr ? '' : run ? '표준 용액을 조금씩 넣으며 관찰하세요' : `종말점 표시 완료 (종말점 눈금 ${tr.endpoint.reading.toFixed(2)} mL)`;
  // 다음 단계 안내
  const nb = $('#next-box');
  const n = doneTrials().length;
  nb.hidden = !(tr && tr.status === 'done');
  if (!nb.hidden) {
    if (n < REQ) { $('#next-msg').textContent = `${tr.no}회차 끝! ${REQ - n}회차가 더 남았어요.`; $('#btn-next').textContent = `${n + 1}회차 시약 선택하기 →`; $('#btn-next').dataset.to = 'plan'; }
    else { $('#next-msg').textContent = `${REQ}회차를 모두 마쳤어요.`; $('#btn-next').textContent = '결과 정리하기 →'; $('#btn-next').dataset.to = 'result'; }
  }
}

function renderZoom(r) {
  const cy = 85, px = 50;
  let s = '<rect x="45" y="0" width="60" height="170" fill="#f8fafc"/>';
  if (state.trial) s += '<path d="M45 80 Q75 90 105 80 L105 170 L45 170 Z" fill="#dbe9fb"/>';
  const start = Math.ceil((r - 1.75) * 10) / 10, end = r + 1.75;
  for (let v = Math.max(0, start); v <= Math.min(50, end) + 1e-9; v = round(v + 0.1, 1)) {
    const y = cy + (v - r) * px;
    const major = Math.abs(v - Math.round(v)) < 1e-6;
    const half = Math.abs(v * 2 - Math.round(v * 2)) < 1e-6;
    s += `<line x1="45" x2="${45 + (major ? 26 : half ? 18 : 11)}" y1="${y}" y2="${y}" stroke="#334155" stroke-width="${major ? 1.4 : 0.9}"/>`;
    if (major) s += `<text x="112" y="${y + 4}" font-size="12" fill="#334155">${Math.round(v)}</text>`;
  }
  s += '<rect x="45" y="0" width="60" height="170" fill="none" stroke="#94a3b8"/>';
  $('#zoom').innerHTML = s;
  const showNum = state.mode === 'practice' && CFG.showReadingInPractice;
  $('#zoom-read').textContent = !state.trial ? '' : showNum ? `현재 눈금 ${r.toFixed(2)} mL` : '메니스커스 아래쪽을 직접 읽으세요';
}

function renderData() {
  const tr = state.trial;
  const rows = tr ? tr.rows : [];
  $('#data-table tbody').innerHTML = rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.added.toFixed(2)}</td><td>${r.reading.toFixed(2)}</td><td>${r.pH !== null ? r.pH.toFixed(2) : '-'}</td><td>${r.color}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">“현재 값 기록”을 누르면 여기에 쌓여요</td></tr>';
  drawCurve(); renderHistory();
}

function drawCurve() {
  const cv = $('#curve');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, L = 52, R = 18, T = 18, B = 44;
  ctx.clearRect(0, 0, W, H);
  const tr = state.trial;
  const meterOn = tr && tr.c.meter === 'on';
  const pr = (t) => t.rows.filter((r) => r.pH !== null);
  const prev = doneTrials().filter((t) => t !== tr && t.c.meter === 'on' && pr(t).length > 1);
  const rows = tr ? pr(tr) : [];
  const allX = [tr ? tr.added : 0, ...rows.map((r) => r.added), ...prev.flatMap((t) => pr(t).map((r) => r.added))];
  const xmax = Math.max(10, Math.ceil((Math.max(...allX) * 1.15) / 5) * 5);
  const X = (v) => L + (v / xmax) * (W - L - R);
  const Y = (p) => T + (1 - p / 14) * (H - T - B);
  ctx.font = '13px Pretendard Variable, system-ui, sans-serif';
  ctx.strokeStyle = '#e2e8f0'; ctx.fillStyle = '#64748b'; ctx.lineWidth = 1;
  for (let p = 0; p <= 14; p += 2) { ctx.beginPath(); ctx.moveTo(L, Y(p)); ctx.lineTo(W - R, Y(p)); ctx.stroke(); ctx.fillText(String(p), L - 24, Y(p) + 4); }
  const step = xmax <= 20 ? 2 : xmax <= 50 ? 5 : 10;
  for (let v = 0; v <= xmax; v += step) { ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), H - B); ctx.stroke(); ctx.fillText(String(v), X(v) - 6, H - B + 18); }
  ctx.fillStyle = '#334155';
  ctx.fillText('넣은 표준 용액의 부피 (mL)', W / 2 - 80, H - 8);
  ctx.save(); ctx.translate(16, H / 2 + 10); ctx.rotate(-Math.PI / 2); ctx.fillText('pH', 0, 0); ctx.restore();
  const line = (rs, color, w, dots) => {
    const s = [...rs].sort((a, b) => a.added - b.added);
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    s.forEach((r, i) => { const x = X(r.added), y = Y(r.pH); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    if (dots) { ctx.fillStyle = color; s.forEach((r) => { ctx.beginPath(); ctx.arc(X(r.added), Y(r.pH), 3.5, 0, Math.PI * 2); ctx.fill(); }); }
  };
  prev.forEach((t) => { line(pr(t), 'rgba(100,116,139,0.45)', 1.5, false); const last = [...pr(t)].sort((a, b) => b.added - a.added)[0]; ctx.fillStyle = '#94a3b8'; ctx.fillText(`${t.no}회차`, X(last.added) + 4, Y(last.pH)); });
  const note = $('#curve-note');
  if (!tr) { note.textContent = '실험을 시작하면 기록한 값으로 적정 곡선이 그려져요.'; return; }
  if (!meterOn) { note.textContent = 'pH 미터를 쓰지 않는 회차라 곡선 대신 색 변화로 종말점을 찾아요. 기록한 색은 아래 표에서 확인하세요.' + (prev.length ? ' (회색 선은 지난 회차 곡선이에요)' : ''); return; }
  note.textContent = (rows.length < 2 ? '“현재 값 기록”을 눌러 점을 찍어 보세요. 점이 많을수록 곡선이 또렷해져요.' : `기록한 점 ${rows.length}개`) + (prev.length ? ' · 회색 선은 지난 회차 곡선이에요' : '');
  const ind = INDICATORS[tr.c.indicator];
  if (ind && ind.range) {
    ctx.fillStyle = 'rgba(99,102,241,0.08)';
    ctx.fillRect(L, Y(ind.range[1]), W - L - R, Y(ind.range[0]) - Y(ind.range[1]));
    ctx.fillStyle = '#6366f1'; ctx.fillText(`${ind.name} 변색 범위`, W - R - 130, Y(ind.range[1]) - 4);
  }
  if (rows.length) line(rows, '#2563eb', 2, true);
  if (tr.endpoint) {
    ctx.strokeStyle = '#dc2626'; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(X(tr.endpoint.added), T); ctx.lineTo(X(tr.endpoint.added), H - B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#dc2626'; ctx.fillText('종말점', X(tr.endpoint.added) + 4, T + 14);
  }
}

function renderHistory() {
  const box = $('#trial-history');
  if (!state.trials.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h3>회차 기록</h3>' + state.trials.map((t) => `
    <div class="hist ${t === state.trial ? 'now' : ''} ${t.status}">
      <b>${t.no}회차</b>${t.status === 'abandoned' ? ' <span class="pill">다시 함</span>' : t.status === 'running' ? ' <span class="pill run">진행 중</span>' : ''} ${t.route.map(esc).join(' → ')}<br>
      <span class="muted">기록 ${t.rows.length}개 · ${t.endpoint ? `처음 눈금 ${t.initialReading.toFixed(2)} mL → 종말점 눈금 ${t.endpoint.reading.toFixed(2)} mL${t.refills ? ` (다시 채움 ${t.refills}회)` : ''}` : '종말점 미표시'}</span>
    </div>`).join('');
}

function renderParticles() {
  const box = $('#particles');
  const tr = state.trial;
  if (isUnknownMode()) { box.innerHTML = '<p class="muted">미지 시료를 분석하는 중이라 입자 보기를 쓸 수 없어요. 연습 모드에서 강산과 약산의 입자 변화를 비교해 보세요.</p>'; return; }
  if (!tr) { box.innerHTML = '<p class="muted">실험을 시작하면 입자의 양이 나타나요.</p>'; return; }
  const sp = speciesAmounts(chemParams(), currentPH());
  const max = Math.max(...sp.map((s) => s.mmol), 1e-9);
  box.innerHTML = sp.map((s) => {
    const w = s.mmol < max * 0.005 ? 0.5 : Math.max(0.5, (s.mmol / max) * 100);
    return `<div class="bar-row"><span class="bar-label">${s.label}</span><span class="bar"><i style="width:${w}%"></i></span><span class="bar-val">${s.mmol < 0.001 ? s.mmol.toExponential(1) : s.mmol.toFixed(3)} mmol</span></div>`;
  }).join('') + `<p class="note">넣은 부피 ${tr.added.toFixed(2)} mL 기준. H₃O⁺와 OH⁻처럼 아주 적은 입자는 막대가 거의 보이지 않아요.</p>`;
}

function renderAll() {
  renderBench(); renderData();
  if (!$('[data-body="particle"]').hidden) renderParticles();
}

/* ---------- ④ 결과 정리 ---------- */
function renderResult() {
  const ts = doneTrials().slice(0, REQ);
  $('#result-rows').innerHTML = ts.map((t, i) => `<tr>
    <td>${t.no}</td><td class="cond">${t.route.map(esc).join(' → ')}</td>
    <td>${t.initialReading.toFixed(2)}</td><td>${t.endpoint.reading.toFixed(2)}</td>
    <td><input name="vol${i}" type="number" step="0.01" min="0" required></td>
    <td><input name="conc${i}" type="number" step="0.0001" min="0" required class="conc-in"></td></tr>`).join('');
  $$('.conc-in').forEach((inp) => inp.addEventListener('input', updateAvg));
  updateAvg();
}
function updateAvg() {
  const v = $$('.conc-in').map((i) => parseFloat(i.value)).filter((x) => !Number.isNaN(x));
  $('#avg-conc').textContent = v.length === REQ ? `${round(v.reduce((a, b) => a + b, 0) / v.length, 4)} M` : '-';
}

function setupResult() {
  $('#result-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const ts = doneTrials().slice(0, REQ);
    const per = ts.map((t, i) => ({ trial: t.no, volume: Number(f.get(`vol${i}`)), conc: Number(f.get(`conc${i}`)) }));
    const avg = round(per.reduce((a, p) => a + p.conc, 0) / per.length, 4);
    const res = { t: new Date().toISOString(), perTrial: per, average: avg, n: Number(f.get('n')), strength: f.get('strength'), why: String(f.get('why')), best: String(f.get('best')), error: String(f.get('error')) };
    state.results.push(res);
    logAction('submit_result', { average: avg, strength: res.strength });
    renderStepper();
    const fb = $('#result-feedback');
    if (state.mode === 'eval') { fb.innerHTML = '<div class="card ok">제출했어요. 위쪽 <b>기록 내려받기</b>를 눌러 파일을 선생님께 내세요.</div>'; return; }
    const lines = ts.map((t, i) => {
      const s = isUnknownMode() ? state.unknown : { key: t.c.sample, conc: t.c.sampleConc };
      const err = Math.abs(per[i].conc - s.conc) / s.conc * 100;
      return `<li>${t.no}회차: 실제 ${s.conc} M, 내 값 ${per[i].conc} M → 오차 ${err.toFixed(1)}%</li>`;
    }).join('');
    let extra = '';
    if (isUnknownMode()) {
      const S = SAMPLES[state.unknown.key];
      const err = Math.abs(avg - state.unknown.conc) / state.unknown.conc * 100;
      const ok = res.strength === (S.strong ? 'strong' : 'weak');
      extra = `<div><b>미지 산의 정체</b> ${S.name} (${S.formula}) · ${S.strong ? '강산' : '약산'} · ${state.unknown.conc} M</div>
        <div><b>평균 농도</b> ${avg} M → 오차 ${err.toFixed(1)}% · <b>세기 판단</b> ${ok ? '맞았어요' : '다시 생각해 보세요'}</div>`;
      logAction('reveal');
    }
    fb.innerHTML = `<div class="card">${extra}<ul>${lines}</ul><p class="muted">오차가 크다면 처음 눈금을 뺐는지, 가수 n과 시료 부피를 맞게 넣었는지 확인해 보세요.</p></div>`;
  });
}

/* ---------- AI 조교에 넘기는 상태 ---------- */
// 학생이 화면에서 볼 수 있는 정보만 넘긴다. 미지 시료의 정체와 농도는 절대 넣지 않는다.
function aiState() {
  const tr = state.trial;
  const n = doneTrials().length;
  let stage = SCREEN_NAMES[state.screen] || '';
  if (state.screen === 'bench' && tr) stage = tr.status === 'done' ? `${tr.no}회차 종말점 표시 후` : tr.rows.length ? `${tr.no}회차 적정 진행 중` : `${tr.no}회차 적정 시작 직후`;
  if (state.screen === 'plan') stage = `${n + 1}회차 시약 선택 중`;
  if (state.screen === 'result') stage = state.results.length ? '결과 제출 후' : '결과 정리 중 (회차별 농도 계산)';
  const c = state.screen === 'plan' || !tr ? state.choice : tr.c;
  const cond = {
    시료: c.sample === 'UNKNOWN' ? '미지 산 (정체·농도는 학생도 AI도 모름)' : c.sample ? `${SAMPLES[c.sample].name} (${SAMPLES[c.sample].formula}) ${c.sampleConc ?? '?'} M` : '미선택',
    시료부피_mL: c.sampleVol ?? '미선택', 표준용액: c.titrant ? `${TITRANTS[c.titrant].name} ${c.titrantConc ?? '?'} M` : '미선택',
    지시약: c.indicator ? INDICATORS[c.indicator].name : '미선택',
    pH미터: c.meter === 'on' ? '사용' : c.meter === 'off' ? '사용 안 함' : '미선택',
    측정조건: c.noise === 'real' ? '현실적(오차 있음)' : c.noise === 'ideal' ? '이상적' : '미선택',
  };
  const cur = tr && state.screen === 'bench' ? {
    회차: tr.no, 상태: tr.status === 'done' ? '종말점 표시 완료' : '진행 중',
    넣은부피_mL: round(tr.added), 뷰렛눈금_mL: round(tr.reading), 처음눈금_mL: tr.initialReading,
    현재pH: tr.c.meter === 'on' ? round(currentPH(), 2) : '측정 안 함', 플라스크색: indicatorColorName(tr.c.indicator, currentPH()),
    종말점: tr.endpoint, 기록한데이터: tr.rows.slice(-40), 조건을고른이유: tr.reason || '(적지 않음)',
  } : null;
  return {
    모드: MODE_NAMES[state.mode] || '', 단계: stage, 완료회차: `${n}/${REQ}`,
    고른조건: cond, 현재실험: cur,
    완료한회차: doneTrials().map((t) => ({ 회차: t.no, 경로: t.route.join(' → '), 기록수: t.rows.length, 처음눈금_mL: t.initialReading, 종말점눈금_mL: t.endpoint.reading, 종말점색: t.endpoint.color, 종말점pH: t.endpoint.pH })),
    제출한결과: state.results.slice(-1)[0] || null,
    최근조작: state.actions.slice(-12).map((a) => ({ 종류: a.type, ...(a.key ? { 항목: a.key, 값: a.value } : {}), ...(a.requested ? { mL: a.requested } : {}) })),
  };
}

/* ---------- 기록 내려받기 ---------- */
function download() {
  const rec = {
    app: '중화 적정 가상 실험실', version: 2, mode: state.mode, student: state.student.id || null,
    seed: state.mode === 'eval' ? state.seed : null, startedAt: state.startedAt, savedAt: new Date().toISOString(),
    requiredTrials: REQ,
    trials: state.trials.map((t) => ({ no: t.no, status: t.status, route: t.route, conditions: { ...t.c, sampleConc: t.c.sample === 'UNKNOWN' ? null : t.c.sampleConc }, reason: t.reason, initialReading: t.initialReading, refills: t.refills, rows: t.rows, endpoint: t.endpoint, startedAt: t.startedAt, endedAt: t.endedAt || null })),
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
  onExchange: (q, a) => { const t = new Date().toISOString(); state.chat.push({ t, screen: state.screen, role: 'user', content: q }, { t, role: 'assistant', content: a }); logAction('ai_question'); },
});

function setup() {
  drawBuretteTicks();
  setupStart(); setupTheory(); setupResult();
  $$('.stp').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  $('#btn-start').addEventListener('click', startTrial);
  $('#btn-restart').addEventListener('click', restartTrial);
  $('#btn-next').addEventListener('click', (e) => go(e.currentTarget.dataset.to));
  $$('#controls [data-add]').forEach((b) => b.addEventListener('click', () => addVolume(Number(b.dataset.add))));
  const pour = $('#btn-pour');
  pour.addEventListener('pointerdown', (e) => { e.preventDefault(); startPour(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => pour.addEventListener(ev, stopPour));
  $('#btn-record').addEventListener('click', recordRow);
  $('#btn-endpoint').addEventListener('click', markEndpoint);
  $('#btn-refill').addEventListener('click', refill);
  $('#btn-download').addEventListener('click', download);
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== t.dataset.tab; });
    if (t.dataset.tab === 'particle') renderParticles();
    if (t.dataset.tab === 'data') drawCurve();
  }));
  const drawer = $('#ai-drawer');
  $('#btn-ai').addEventListener('click', () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) logAction('ai_open'); });
  $('#ai-close').addEventListener('click', () => { drawer.hidden = true; });
  window.addEventListener('beforeunload', (e) => { if (state.actions.length > 5) { e.preventDefault(); e.returnValue = ''; } });
  renderStepper();
}
setup();

window.__lab = { state, aiState };
