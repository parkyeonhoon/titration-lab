// 중화 적정 계산 모듈
// 전하 균형식을 이분법으로 풀어 pH를 구한다. (25 °C, 활동도 보정 없음)

export const KW = 1.0e-14;

// 시료: 학생이 삼각 플라스크에 넣는 용액
// Ka 배열의 길이 = 산의 가수(n). 강산은 Ka를 매우 크게 두어 완전 이온화로 처리한다.
export const SAMPLES = {
  HCl:     { name: '염산',        formula: 'HCl',      kind: 'acid', Ka: [1e8],          strong: true },
  HNO3:    { name: '질산',        formula: 'HNO₃',     kind: 'acid', Ka: [1e8],          strong: true },
  H2SO4:   { name: '황산',        formula: 'H₂SO₄',    kind: 'acid', Ka: [1e8, 1.0e-2],  strong: true },
  CH3COOH: { name: '아세트산',    formula: 'CH₃COOH',  kind: 'acid', Ka: [1.8e-5],       strong: false },
  HCOOH:   { name: '폼산',        formula: 'HCOOH',    kind: 'acid', Ka: [1.8e-4],       strong: false },
  H2C2O4:  { name: '옥살산',      formula: 'H₂C₂O₄',   kind: 'acid', Ka: [5.6e-2, 1.5e-4], strong: false },
  NaOH_S:  { name: '수산화 나트륨 수용액', formula: 'NaOH', kind: 'base', strong: true, n: 1 },
  NH3:     { name: '암모니아수',  formula: 'NH₃',      kind: 'base', Kb: 1.8e-5,         strong: false, n: 1 },
};

// 표준 용액: 뷰렛에 넣는 용액 (모두 1가, 강산·강염기)
export const TITRANTS = {
  NaOH: { name: '수산화 나트륨', formula: 'NaOH', kind: 'base' },
  KOH:  { name: '수산화 칼륨',   formula: 'KOH',  kind: 'base' },
  HCl:  { name: '염산',          formula: 'HCl',  kind: 'acid' },
};

// 지시약: 변색 범위와 산성색·염기성색 (r, g, b, 진하기)
export const INDICATORS = {
  none: { name: '사용 안 함' },
  MO:   { name: '메틸 오렌지',   range: [3.1, 4.4],  colors: [[214, 45, 40, 0.75], [242, 190, 40, 0.6]],                 names: ['빨간색', '노란색'] },
  MR:   { name: '메틸 레드',     range: [4.4, 6.2],  colors: [[220, 40, 70, 0.7], [240, 205, 50, 0.6]],                  names: ['빨간색', '노란색'] },
  BTB:  { name: 'BTB',           range: [6.0, 7.6],  colors: [[232, 205, 40, 0.65], [80, 170, 90, 0.65], [40, 85, 205, 0.7]], names: ['노란색', '초록색', '파란색'] },
  PP:   { name: '페놀프탈레인',  range: [8.2, 10.0], colors: [[255, 255, 255, 0], [228, 40, 150, 0.62]],                 names: ['무색', '분홍색'] },
  TP:   { name: '티몰프탈레인',  range: [9.3, 10.5], colors: [[255, 255, 255, 0], [45, 75, 205, 0.62]],                  names: ['무색', '파란색'] },
};

export function protonCount(sampleKey) {
  const s = SAMPLES[sampleKey];
  return s.kind === 'acid' ? s.Ka.length : (s.n || 1);
}

// 산이 내놓은 음전하 (mol/L)
function acidAnionCharge(Ka, C, H) {
  if (Ka.length === 1) return C * Ka[0] / (Ka[0] + H);
  const [K1, K2] = Ka;
  const D = H * H + K1 * H + K1 * K2;
  return C * (K1 * H + 2 * K1 * K2) / D;
}

// 혼합 용액의 pH
// p = { sample, Cs(M), Vs(mL), titrant, Ct(M), Vt(mL) }
export function solvePH(p) {
  const s = SAMPLES[p.sample];
  const t = TITRANTS[p.titrant];
  const V = p.Vs + p.Vt;
  const cs = p.Cs * p.Vs / V;
  const ct = p.Ct * p.Vt / V;

  const f = (H) => {
    let pos = H, neg = KW / H;
    if (t.kind === 'base') pos += ct; else neg += ct;
    if (s.kind === 'acid') neg += acidAnionCharge(s.Ka, cs, H);
    else if (s.strong) pos += cs;
    else { const KaBH = KW / s.Kb; pos += cs * H / (H + KaBH); }
    return pos - neg; // H가 커질수록 증가하는 함수
  };

  let lo = -1.5, hi = 15.5; // log10 H 기준이 아니라 pH 기준
  // pH가 클수록 H가 작아져 f가 감소
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const val = f(Math.pow(10, -mid));
    if (val > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// 입자 수준 보기: 플라스크 속 각 입자의 양 (mmol)
export function speciesAmounts(p, pH) {
  const s = SAMPLES[p.sample];
  const t = TITRANTS[p.titrant];
  const V = p.Vs + p.Vt;
  const H = Math.pow(10, -pH);
  const OH = KW / H;
  const nS = p.Cs * p.Vs;   // mmol
  const nT = p.Ct * p.Vt;   // mmol
  const out = [];
  if (s.kind === 'acid') {
    if (s.Ka.length === 1) {
      const a = s.Ka[0] / (s.Ka[0] + H);
      out.push({ label: s.formula.replace(/^H/, 'H') + ' (이온화 안 됨)', key: 'HA', mmol: nS * (1 - a) });
      out.push({ label: anionLabel(p.sample, 1), key: 'A', mmol: nS * a });
    } else {
      const [K1, K2] = s.Ka;
      const D = H * H + K1 * H + K1 * K2;
      out.push({ label: s.formula + ' (이온화 안 됨)', key: 'H2A', mmol: nS * H * H / D });
      out.push({ label: anionLabel(p.sample, 1), key: 'HA', mmol: nS * K1 * H / D });
      out.push({ label: anionLabel(p.sample, 2), key: 'A', mmol: nS * K1 * K2 / D });
    }
  } else if (s.strong) {
    out.push({ label: 'Na⁺ (시료)', key: 'Ms', mmol: nS });
  } else {
    const KaBH = KW / s.Kb;
    const f = H / (H + KaBH);
    out.push({ label: 'NH₃', key: 'B', mmol: nS * (1 - f) });
    out.push({ label: 'NH₄⁺', key: 'BH', mmol: nS * f });
  }
  if (t.kind === 'base') out.push({ label: (p.titrant === 'KOH' ? 'K⁺' : 'Na⁺') + ' (표준 용액)', key: 'M', mmol: nT });
  else out.push({ label: 'Cl⁻ (표준 용액)', key: 'X', mmol: nT });
  out.push({ label: 'H₃O⁺', key: 'H', mmol: H * V });
  out.push({ label: 'OH⁻', key: 'OH', mmol: OH * V });
  return out;
}

function anionLabel(key, step) {
  const map = {
    HCl: ['Cl⁻'], HNO3: ['NO₃⁻'], H2SO4: ['HSO₄⁻', 'SO₄²⁻'],
    CH3COOH: ['CH₃COO⁻'], HCOOH: ['HCOO⁻'], H2C2O4: ['HC₂O₄⁻', 'C₂O₄²⁻'],
  };
  return (map[key] || ['A⁻'])[step - 1];
}

// 중화점 부피 (mL): n·M·V = n'·M'·V'
export function equivalenceVolume(sampleKey, Cs, Vs, Ct) {
  return protonCount(sampleKey) * Cs * Vs / Ct;
}

// 지시약 색 (rgba 문자열)과 색 이름
function mix(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }

export function indicatorRGBA(indKey, pH) {
  const ind = INDICATORS[indKey];
  if (!ind || !ind.range) return null;
  const [lo, hi] = ind.range;
  const t = Math.min(1, Math.max(0, (pH - lo) / (hi - lo)));
  let c;
  if (ind.colors.length === 3) c = t < 0.5 ? mix(ind.colors[0], ind.colors[1], t * 2) : mix(ind.colors[1], ind.colors[2], (t - 0.5) * 2);
  else c = mix(ind.colors[0], ind.colors[1], t);
  return c;
}

export function indicatorColorName(indKey, pH) {
  const ind = INDICATORS[indKey];
  if (!ind || !ind.range) return '무색 (지시약 없음)';
  const [lo, hi] = ind.range;
  const t = (pH - lo) / (hi - lo);
  const n = ind.names;
  if (n.length === 3) {
    if (t <= 0.15) return n[0];
    if (t >= 0.85) return n[2];
    if (t > 0.35 && t < 0.65) return n[1];
    return t < 0.5 ? `${n[0]}과 ${n[1]} 사이` : `${n[1]}과 ${n[2]} 사이`;
  }
  if (t <= 0.1) return n[0];
  if (t >= 0.9) return n[1];
  return n[0] === '무색' ? `연한 ${n[1]}` : `${n[0]}과 ${n[1]} 사이`;
}

// 시드 기반 난수 (미지 시료·평가용)
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
export function makeRng(seedStr) {
  let a = xmur3(String(seedStr))();
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 미지 시료: 시드가 같으면 항상 같은 산과 농도
export function unknownFromSeed(seedStr, pool, range = [0.05, 0.2]) {
  const rng = makeRng(seedStr);
  const key = pool[Math.floor(rng() * pool.length)];
  const steps = Math.round((range[1] - range[0]) / 0.005);
  const conc = Math.round((range[0] + Math.floor(rng() * (steps + 1)) * 0.005) * 1000) / 1000;
  return { key, conc };
}

export function gauss(rng = Math.random) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
