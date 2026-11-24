// AI 조교 중계 서버 (Cloudflare Worker)
// 학생 브라우저 → 이 Worker → AI API. API 키는 Worker의 비밀 변수에만 있고 학생에게 보이지 않는다.
//
// Worker 설정(Settings → Variables and Secrets)에 넣을 값
//   API_KEY        (Secret, 필수)  Anthropic 또는 OpenAI API 키
//   PROVIDER       (Text, 선택)    "anthropic"(기본) 또는 "openai"
//   MODEL          (Text, 선택)    사용할 모델 이름. 비우면 아래 기본값
//   ALLOWED_ORIGIN (Text, 권장)    실험실 주소. 예: https://내아이디.github.io  (여러 개면 쉼표로 구분)
//   CLASS_CODE     (Secret, 권장)  수업 코드. 설정하면 코드를 아는 학생만 AI 조교를 쓸 수 있음

const DEFAULT_MODEL = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-4o-mini',
};
const MAX_TOKENS = 500;

const SYSTEM_PROMPT = `너는 고등학교 '화학 반응의 세계' 수업에서 중화 적정 가상 실험을 돕는 AI 조교야.
학생은 버튼으로 실험 조건(시료, 시료 부피, 표준 용액과 농도, 지시약, pH 미터 사용 여부, 측정 조건)을 골라 실험 경로를 정하고, 뷰렛으로 표준 용액을 넣으며 데이터를 기록한다.
매 질문마다 [현재 실험 상태]가 함께 온다. 이것은 학생이 화면에서 보고 있는 정보와 같다.

## 지켜야 할 원칙
1. 정답을 주지 않는다. 시료의 농도, 중화점 부피, 이온화 상수 값, 미지 산의 정체(강산인지 약산인지 포함)를 직접 말하거나 학생 데이터로 계산해 주지 않는다.
2. 대신 학생의 실제 데이터와 선택을 짚으며 생각할 거리를 질문 1~2개로 돌려준다. 예: "기록한 값 중 pH가 가장 크게 변한 구간은 어디였나요?"
3. 일반적인 개념(중화점과 종말점의 차이, nMV = n′M′V′의 의미, 지시약 변색 범위, 적정 곡선의 일반적 모양)은 설명해도 된다. 단, 학생의 숫자를 넣어 결과를 내지 않는다. 예시가 필요하면 학생 실험과 다른 숫자를 쓴다.
4. 단계에 맞춰 돕는다.
   - 실험 설계 중: 왜 그 조건을 골랐는지, 다른 선택과 비교하면 무엇이 달라질지 묻는다.
   - 적정 진행 중: 어디서 더 조금씩 넣어야 할지, 어떤 값을 더 기록하면 좋을지 스스로 판단하게 묻는다.
   - 종말점 표시 후: 곡선 모양, 지시약 색 변화, 계산 과정(처음 눈금과 나중 눈금, 가수)을 점검하게 묻는다.
   - 결과 제출 후: 오차 원인과 다른 조건으로 다시 하면 어떻게 될지 생각하게 묻는다.
5. 학생이 실수한 것이 보이면(예: 처음 눈금을 빼지 않음, 데이터가 너무 성김, 변색 범위가 맞지 않는 지시약) 고쳐 주지 말고 그 부분을 다시 보도록 질문으로 짚는다.
6. 학생이 계속 답만 요구하면, 정답은 줄 수 없다고 짧게 말하고 더 작은 단계의 질문으로 나눠 준다.
7. 실험·화학과 관계없는 요청은 정중히 실험으로 돌아오게 한다.
8. 한국어 존댓말, 4문장 이내로 짧게. 목록이나 표, 마크다운 기호는 쓰지 않는다.
9. 실험 상태에 없는 내용은 지어내지 않는다. 모르는 값은 학생에게 확인을 요청한다.`;

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const any = allowed.includes('*');
  const ok = any || allowed.includes(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': any ? '*' : ok ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Class-Code',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}

// 역할이 번갈아 오도록 정리 (같은 역할이 이어지면 합침)
function cleanMessages(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  const out = [];
  for (const m of list) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n' + m.content;
    else out.push({ ...m });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function callAnthropic(env, system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.MODEL || DEFAULT_MODEL.anthropic, max_tokens: MAX_TOKENS, system, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function callOpenAI(env, system, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.MODEL || DEFAULT_MODEL.openai, max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return (data.choices?.[0]?.message?.content || '').trim();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });
    if (request.method !== 'POST') return json({ error: 'POST 요청만 받아요.' }, 405, cors.headers);
    if (!cors.ok) return json({ error: '허용되지 않은 주소에서 온 요청이에요.' }, 403, cors.headers);
    if (!env.API_KEY) return json({ error: '서버에 API 키가 설정되지 않았어요.' }, 500, cors.headers);
    if (env.CLASS_CODE && request.headers.get('X-Class-Code') !== env.CLASS_CODE) {
      return json({ error: '수업 코드가 맞지 않아요. 선생님께 확인하세요.' }, 401, cors.headers);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: '요청 형식이 잘못됐어요.' }, 400, cors.headers); }
    const messages = cleanMessages(body.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: '질문이 비어 있어요.' }, 400, cors.headers);

    const stateText = JSON.stringify(body.state ?? {}, null, 1).slice(0, 12000);
    const system = `${SYSTEM_PROMPT}\n\n[현재 실험 상태]\n${stateText}`;
    const provider = (env.PROVIDER || 'anthropic').toLowerCase();

    try {
      const reply = provider === 'openai' ? await callOpenAI(env, system, messages) : await callAnthropic(env, system, messages);
      if (!reply) throw new Error('빈 응답');
      return json({ reply }, 200, cors.headers);
    } catch (e) {
      console.log('AI error', String(e));
      return json({ error: 'AI 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.' }, 502, cors.headers);
    }
  },
};
