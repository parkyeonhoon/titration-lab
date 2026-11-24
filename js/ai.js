// AI 조교 채팅 패널
// 질문할 때마다 현재 실험 상태를 함께 보내고, 중계 서버(Cloudflare Worker)가 API 키를 붙여 AI에 전달한다.

const QUICK = [
  '다음에 무엇을 해야 할지 모르겠어요',
  '지금 고른 조건이 괜찮은지 봐 주세요',
  '제 적정 곡선을 어떻게 해석해야 하나요?',
  '종말점을 제대로 찾았는지 모르겠어요',
];

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function storageGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } }

export function initAI(root, { endpoint, getState, onExchange }) {
  const history = []; // {role, content}
  let enabled = true;
  let busy = false;

  root.innerHTML = `
    <div class="ai-locked" hidden>
      <p><b>평가 모드에서는 AI 조교를 사용할 수 없어요.</b></p>
      <p class="muted">앞선 차시에서 연습한 방법으로 혼자 실험하고 판단해 보세요.</p>
    </div>
    <div class="ai-main">
      <div class="ai-rule">AI 조교는 <b>정답이나 계산 결과를 알려 주지 않아요.</b> 지금 내 실험 상태를 보고 생각할 거리를 질문으로 돌려줘요.</div>
      <div class="ai-code" ${endpoint ? '' : 'hidden'}>
        <label>수업 코드 <input type="password" class="ai-class" placeholder="선생님이 알려 준 코드" autocomplete="off"></label>
      </div>
      <div class="ai-log" aria-live="polite"></div>
      <div class="ai-quick">${QUICK.map((q) => `<button type="button" class="chip-btn">${esc(q)}</button>`).join('')}</div>
      <form class="ai-form">
        <textarea rows="2" maxlength="600" placeholder="AI 조교에게 질문하기 (Enter로 보내기, Shift+Enter 줄바꿈)"></textarea>
        <button class="btn primary" type="submit">보내기</button>
      </form>
      <div class="ai-offline" ${endpoint ? 'hidden' : ''}>
        <p class="muted">AI 조교 서버가 아직 연결되지 않았어요(config.js의 <code>aiEndpoint</code>). 대신 아래 버튼으로 실험 상태와 조교 지시문을 복사해 다른 챗봇에 붙여 넣을 수 있어요.</p>
        <button type="button" class="btn ghost small ai-copy">실험 상태 복사</button>
      </div>
    </div>`;

  const log = root.querySelector('.ai-log');
  const form = root.querySelector('.ai-form');
  const ta = form.querySelector('textarea');
  const codeInput = root.querySelector('.ai-class');
  codeInput.value = storageGet('titration-class-code');
  codeInput.addEventListener('change', () => storageSet('titration-class-code', codeInput.value.trim()));

  function add(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.innerHTML = esc(text).replace(/\n/g, '<br>');
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }
  add('assistant', '안녕하세요! 실험하다가 막히면 물어보세요. 지금 어떤 조건을 골랐는지, 어떤 값을 기록했는지 저도 함께 보고 있어요.');

  async function send(q) {
    q = q.trim();
    if (!q || busy || !enabled) return;
    if (!endpoint) { add('assistant', 'AI 조교 서버가 연결되지 않았어요. 아래 “실험 상태 복사”를 이용하세요.'); return; }
    busy = true;
    add('user', q);
    history.push({ role: 'user', content: q });
    const wait = add('assistant pending', '생각하는 중…');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Class-Code': codeInput.value.trim() },
        body: JSON.stringify({ messages: history.slice(-12), state: getState() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.reply) throw new Error(data.error || `서버 오류 (${res.status})`);
      wait.remove();
      add('assistant', data.reply);
      history.push({ role: 'assistant', content: data.reply });
      onExchange && onExchange(q, data.reply);
    } catch (e) {
      wait.remove();
      history.pop();
      add('assistant error', `답을 받지 못했어요: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); const q = ta.value; ta.value = ''; send(q); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  root.querySelectorAll('.chip-btn').forEach((b) => b.addEventListener('click', () => send(b.textContent)));
  root.querySelector('.ai-copy').addEventListener('click', async () => {
    const text = `너는 고등학교 화학 중화 적정 실험의 AI 조교야. 정답이나 계산 결과(농도, 중화점 부피, 산의 정체)는 알려 주지 말고, 아래 실험 상태를 근거로 학생이 스스로 생각하도록 질문 1~2개로 안내해 줘. 한국어로 4문장 이내.\n\n[실험 상태]\n${JSON.stringify(getState(), null, 2)}\n\n[학생 질문]\n`;
    try { await navigator.clipboard.writeText(text); add('assistant', '실험 상태를 복사했어요. 챗봇에 붙여 넣고 마지막 줄에 질문을 적으세요.'); }
    catch { add('assistant error', '복사하지 못했어요. 브라우저의 클립보드 권한을 확인하세요.'); }
  });

  return {
    setEnabled(on) {
      enabled = on;
      root.querySelector('.ai-locked').hidden = on;
      root.querySelector('.ai-main').hidden = !on;
      const tab = document.getElementById('tab-ai');
      if (tab) tab.classList.toggle('disabled', !on);
    },
  };
}
