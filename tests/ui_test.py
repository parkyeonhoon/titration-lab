import json, sys
from playwright.sync_api import sync_playwright
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx_block=lambda pg_: pg_.route('**/cdn.jsdelivr.net/**', lambda r: r.abort())
    pg=b.new_page(viewport={'width':1500,'height':1000})
    pass
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    # 가짜 AI 서버
    pg.add_init_script("window.__AI='http://ai.test/'")
    pg.route('**/config.js', lambda r: r.fulfill(body=open('/home/claude/titration-lab/config.js').read().replace('aiEndpoint: ""','aiEndpoint: "http://ai.test/"'), content_type='application/javascript'))
    sent=[]
    def ai(route):
        sent.append(json.loads(route.request.post_data))
        route.fulfill(status=200, headers={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}, body=json.dumps({'reply':'pH가 가장 크게 변한 구간은 어디였나요?'}))
    pg.route('http://ai.test/**', ai)
    ctx_block(pg); pg.goto('http://localhost:8765/index.html')
    pg.screenshot(path='/tmp/s0.png')
    pg.click('.mode[data-mode=practice]')
    for label in ['아세트산','0.1 M','25 mL','수산화 나트륨','0.1 M','페놀프탈레인','사용','이상적']:
        pass
    def pick(step_idx, text):
        pg.locator('.step').nth(step_idx).locator('.opt', has_text=text).first.click()
    pick(0,'아세트산'); pick(1,'0.1 M'); pick(2,'25 mL'); pick(3,'수산화 나트륨'); pick(4,'0.1 M'); pick(5,'페놀프탈레인'); pick(6,'사용'); pick(7,'이상적')
    pg.fill('#plan-reason','약산일 것 같아서 페놀프탈레인')
    pg.click('#btn-start')
    vols=[]
    for i in range(30):
        pg.click('[data-add="1"]')
        if i%2==1: pg.click('#btn-record')
    st=pg.evaluate('window.__lab.state.trial')
    print('added',round(st['added'],2),'rows',len(st['rows']), [ (r['added'],r['pH'],r['color']) for r in st['rows'][::3]])
    pg.click('#btn-endpoint')
    pg.screenshot(path='/tmp/s1.png', full_page=True)
    pg.click('.tab[data-tab=particle]'); pg.screenshot(path='/tmp/s2.png', full_page=True)
    pg.click('.tab[data-tab=ai]')
    pg.click('.chip-btn >> nth=2'); pg.wait_for_timeout(400)
    print('ai sent keys', list(sent[0]['state'].keys()), sent[0]['state']['단계'], sent[0]['messages'])
    pg.screenshot(path='/tmp/s3.png', full_page=True)
    pg.click('.tab[data-tab=result]')
    pg.fill('[name=vol]','25'); pg.fill('[name=conc]','0.1'); pg.select_option('[name=strength]','weak'); pg.fill('[name=why]','중화점 pH가 7보다 큼')
    pg.click('#result-form button'); print(pg.inner_text('#result-feedback'))
    # 탐구 모드: 상태에 정답이 새지 않는지
    pg2=b.new_page(viewport={'width':1300,'height':900}); pg2.on('pageerror', lambda e: errs.append(str(e)))
    pg2.route('**/config.js', lambda r: r.fulfill(body=open('/home/claude/titration-lab/config.js').read().replace('aiEndpoint: ""','aiEndpoint: "http://ai.test/"'), content_type='application/javascript'))
    pg2.route('http://ai.test/**', ai)
    ctx_block(pg2); pg2.goto('http://localhost:8765/index.html?mode=explore')
    def pick2(i,t): pg2.locator('.step').nth(i).locator('.opt', has_text=t).first.click()
    pick2(1,'10 mL'); pick2(2,'수산화 칼륨'); pick2(3,'0.1 M'); pick2(4,'BTB'); pick2(5,'사용 안 함'); pick2(6,'현실적')
    pg2.click('#btn-start'); pg2.click('[data-add="0.5"]'); pg2.click('#btn-record')
    pg2.click('.tab[data-tab=ai]'); pg2.fill('.ai-form textarea','이 산 강산이에요?'); pg2.keyboard.press('Enter'); pg2.wait_for_timeout(400)
    s=json.dumps(sent[-1]['state'],ensure_ascii=False)
    unk=pg2.evaluate('window.__lab.state.unknown'); print('unknown',unk)
    from chem_names import names
    leak=[n for n in names[unk['key']] if n in s] + ([str(unk['conc'])] if str(unk['conc']) in s else [])
    print('leak check', leak, '| state:', s[:300])
    pg2.screenshot(path='/tmp/s4.png', full_page=True)
    # 평가 모드
    pg3=b.new_page(viewport={'width':1300,'height':900}); pg3.on('pageerror', lambda e: errs.append(str(e)))
    ctx_block(pg3); pg3.goto('http://localhost:8765/index.html?mode=eval'); pg3.fill('[name=sid]','20301'); pg3.fill('[name=code]','A1'); pg3.click('#eval-form button')
    print('eval unknown', pg3.evaluate('window.__lab.state.unknown'), 'ai locked', pg3.is_visible('.ai-locked') or pg3.evaluate("!document.querySelector('.ai-locked').hidden"))
    pg3.screenshot(path='/tmp/s5.png')
    # 모바일
    pg4=b.new_page(viewport={'width':390,'height':844}); pg4.goto('http://localhost:8765/index.html?mode=practice'); pg4.screenshot(path='/tmp/s6.png', full_page=True)
    b.close()
print('ERRORS', errs)
