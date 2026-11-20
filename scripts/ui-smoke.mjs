// Run with Vite on 1430 and an isolated headless Chrome on CDP port 9334.
// The desktop bridge is a fixture: these checks never access real hardware.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base = process.env.FLASHSTUDIO_UI_URL ?? 'http://127.0.0.1:1430';
const port = process.env.FLASHSTUDIO_CDP_PORT ?? '9334';
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(base)).ok) break; } catch { /* Wait for the local test server. */ }
  if (i === 59) throw new Error('Local FlashStudio test server did not start');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find(p => p.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let serial = 0;
const requests = new Map();
const errors = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) { const r = requests.get(message.id); if (r) { requests.delete(message.id); clearTimeout(r.timer); message.error ? r.reject(message.error) : r.resolve(message.result); } }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000); requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async expression => { for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await delay(100); } throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`); };
const click = async text => assert.ok(await evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)});if(!e||e.disabled)return false;e.click();return true})()`), `enabled button ${text}`);
const input = async (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
const select = async (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
const screenshot = async name => { const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(`/tmp/flashstudio-${name}.png`, Buffer.from(r.data, 'base64')); };
function installFixture() {
  window.isTauri = true;
  let callbacks = 1;
  const handlers = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__fixture = { job: null, firmware: null, starts: [], reject: false, cancelCount: 0, authorization: 0, denyAuthorization: false, usbRulesInstalled: false };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { const id = callbacks++; handlers.set(id, callback); return id; },
    unregisterCallback(id) { handlers.delete(id); },
    async invoke(command, args = {}) {
      const f = window.__fixture;
      if (command === 'plugin:event|listen') return 1;
      if (command === 'plugin:event|unlisten') return null;
      if (command === 'get_job') return f.job ? structuredClone(f.job) : null;
      if (command === 'check_engine') return { version: '0.12.0-7', platform: 'linux-x64', canAuthorizeUsb: true, usbRulesInstalled: f.usbRulesInstalled };
      if (command === 'authorize_usb') { f.authorization++; if (f.denyAuthorization) throw 'USB 授权未完成（已取消）'; f.usbRulesInstalled = true; return 'USB 权限已配置，请重新插拔探针后再检测连接。'; }
      if (command === 'import_firmware') { f.firmware = { id: 'image-1', name: args.name, format: args.name.endsWith('.hex') ? 'ihex' : 'bin', size: args.bytes.length, sha256: 'a'.repeat(64) }; return f.firmware; }
      if (command === 'start_operation') {
        if (f.reject) throw 'OpenOCD test launch failure';
        if (f.job?.status === 'running') throw '已有任务正在执行';
        f.starts.push(structuredClone(args.request));
        f.job = { id: `job-${f.starts.length}`, operation: args.request.operation, status: 'running', startedAt: Date.now(), finishedAt: null, request: args.request, firmware: f.firmware,
          logs: [{ sequence: 0, time: Date.now(), text: 'Info : fixture process started' }], nextSequence: 1, message: 'OpenOCD 正在执行', plan: { executable: 'openocd', args: ['-f', args.request.config.target], timeoutSecs: 120 } };
        return structuredClone(f.job);
      }
      if (command === 'cancel_operation') { f.cancelCount++; f.job.status = 'cancelled'; f.job.finishedAt = Date.now(); f.job.message = '操作已取消'; return; }
      throw `Unknown fixture command: ${command}`;
    },
  };
}
const finish = async (status, message) => evaluate(`Object.assign(window.__fixture.job,{status:${JSON.stringify(status)},finishedAt:Date.now(),message:${JSON.stringify(message)}})`);
const file = async (name) => evaluate(`(()=>{const input=document.querySelector('input[type=file]');const files=new DataTransfer();files.items.add(new File([new Uint8Array([1,2,3,4])],${JSON.stringify(name)}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
let fixtureId;
try {
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base }); await delay(500);
  await until(`document.querySelector('.brand')?.textContent==='FlashStudio'`);
  await evaluate(`localStorage.clear(); localStorage.setItem('flashstudio.records','[{"id":"obsolete"}]'); localStorage.setItem('flashstudio.config', JSON.stringify({executable:'/bad/old/openocd',scriptsDir:'/bad/scripts'}))`); await cdp('Page.reload'); await delay(500);
  await until(`document.body.innerText.includes('浏览器预览')`);
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='开始烧录').disabled`), true);
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='检测连接').disabled`), true);
  await screenshot('preview');
  fixtureId = (await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFixture.toString()})();` })).identifier;
  await cdp('Page.reload'); await delay(500);
  await until(`document.body.innerText.includes('内置引擎就绪') && !document.querySelector('.probe-button').disabled`);
  assert.equal(await evaluate(`document.querySelectorAll('nav button').length`), 3);
  assert.equal(await evaluate(`document.querySelector('nav [aria-current=page]')?.textContent`), '固件烧录');
  assert.equal(await evaluate(`document.body.innerText.includes('操作记录') || document.body.innerText.includes('引擎设置')`), false);
  assert.equal(await evaluate(`localStorage.getItem('flashstudio.records')`), null);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('flashstudio.config')).executable`), undefined);
  assert.equal(await evaluate(`!!document.querySelector('.advanced-panel') || !!document.querySelector('.log-content')`), false);
  assert.equal(await evaluate(`document.querySelector('.execution-row').getBoundingClientRect().bottom < innerHeight - 28`), true);
  await screenshot('sidebar-workspace');
  await file('application.bin');
  await until(`document.querySelector('.firmware-drop strong').textContent==='application.bin'`);
  await input('[aria-label="BIN 起始地址"]', '0x100000000');
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='开始烧录').disabled`), true);
  await input('[aria-label="BIN 起始地址"]', '0x08004000');
  await select('[aria-label="烧录探针"]', 'jlink'); await select('[aria-label="目标芯片"]', 'target/stm32g4x.cfg');
  await click('开始烧录');
  await until(`document.body.innerText.includes('固件烧录进行中')`);
  assert.equal(await evaluate(`document.querySelector('input[type=file]').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('.connection-card fieldset').disabled`), true);
  assert.equal(await evaluate(`[...document.querySelectorAll('nav button')].every(button => button.disabled)`), true);
  const sent = await evaluate('window.__fixture.starts[0]');
  assert.equal(sent.address, '0x08004000'); assert.equal(sent.config.adapter, 'jlink'); assert.equal(sent.config.target, 'target/stm32g4x.cfg'); assert.equal(sent.verifyAfterWrite, true);
  await click('取消操作'); await click('继续等待'); assert.equal(await evaluate('window.__fixture.cancelCount'), 0);
  await finish('success', '烧录与校验完成'); await until(`document.body.innerText.includes('固件烧录 · 成功')`);
  await screenshot('desktop-success');
  await click('固件校验'); await file('application.hex');
  assert.equal(await evaluate(`document.querySelector('nav [aria-current=page]')?.textContent`), '固件校验');
  assert.equal(await evaluate(`document.querySelector('h1')?.textContent`), '固件校验');
  await until(`document.querySelector('.firmware-drop strong').textContent==='application.hex'`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="BIN 起始地址"]').disabled`), true);
  await click('开始校验'); await finish('failed', 'verify mismatch');
  await until(`document.body.innerText.includes('固件校验 · 失败')`);
  await click('Flash 擦除');
  await input('[aria-label="Flash Bank 编号"]', '-1');
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='擦除 Flash').disabled`), true);
  await input('[aria-label="Flash Bank 编号"]', '1');
  const count = await evaluate('window.__fixture.starts.length');
  await click('擦除 Flash'); await until(`document.querySelector('dialog')?.open`);
  assert.equal(await evaluate('window.__fixture.starts.length'), count);
  assert.ok(await evaluate(`document.querySelector('dialog').innerText.includes('Bank 1')`));
  await screenshot('erase-confirmation');
  await click('返回检查');
  await click('擦除 Flash'); await click('确认擦除');
  await until(`window.__fixture.starts.length===${count + 1}`);
  assert.equal(await evaluate('window.__fixture.starts.at(-1).eraseConfirmed'), true);
  assert.equal(await evaluate('window.__fixture.starts.at(-1).bank'), 1);
  await click('取消操作'); await click('确认取消');
  await until(`document.body.innerText.includes('Flash 擦除 · 已取消')`);
  await click('高级设置');
  await evaluate('window.__fixture.denyAuthorization=true');
  await click('授权访问探针');
  await until(`document.querySelector('[role=alert]')?.textContent.includes('已取消')`);
  assert.equal(await evaluate(`document.querySelector('.connection-fields').disabled`), false);
  await evaluate('window.__fixture.denyAuthorization=false');
  await click('授权访问探针');
  await until(`document.body.innerText.includes('USB 权限已配置')`);
  assert.equal(await evaluate('window.__fixture.authorization'), 2);
  await click('高级设置');
  await evaluate(`document.querySelector('[aria-label="切换深色主题"]').click()`);
  await delay(200); await screenshot('sidebar-dark');
  await click('固件烧录');
  await evaluate('window.__fixture.reject=true'); await click('开始烧录');
  await until(`document.querySelector('[role=alert]')?.textContent.includes('OpenOCD test launch failure')`);
  assert.equal(await evaluate('document.querySelector(".connection-card fieldset").disabled'), false);
  assert.equal(await evaluate(`localStorage.getItem('flashstudio.records')`), null);
  await cdp('Page.reload'); await delay(500); await until(`document.querySelector('.brand')?.textContent==='FlashStudio'`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="目标芯片"]').value`), 'target/stm32g4x.cfg');
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
  assert.equal(await evaluate(`document.querySelector('.firmware-drop strong').textContent`), '选择或拖入固件文件');
  assert.equal(await evaluate(`localStorage.getItem('flashstudio.records')`), null);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 650, deviceScaleFactor: 1, mobile: false });

  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate('document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth'), true);
  assert.equal(await evaluate(`document.querySelector('nav button').getBoundingClientRect().width > 100 && document.querySelector('.sidebar').getBoundingClientRect().right <= document.querySelector('main').getBoundingClientRect().left`), true);
  assert.equal(await evaluate(`document.querySelector('.execution-row').getBoundingClientRect().bottom <= innerHeight - 28`), true);
  await screenshot('minimum-window');
  assert.deepEqual(errors, []);
  console.log('PASS: sidebar navigation, browser guard, file import, address validation, busy lock, flash/verify/erase, confirmation, cancellation, engine detection, failure recovery, no history or engine paths, USB authorization and rejection, persistence, theme, 800px layout.');
} finally {
  if (fixtureId) await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: fixtureId });
  socket.close();
}
