/**
 * Arnés de prueba del motor de simulación BullMQ.
 * Extrae el <script> de la página HTML y lo ejecuta en Node con un DOM mínimo,
 * de modo que la semántica se valida sin depender de la interacción del navegador.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, 'bullmq-juegos-propuesta.html');
const html = fs.readFileSync(HTML, 'utf8');

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('No se encontró el <script>'); process.exit(1); }
const code = m[1];

/* ---------- DOM stub ---------- */
const INPUT_DEFAULTS = {
  jobName: 'enviar-email', jobDelay: '0', jobPrio: '0', jobWork: '1200',
  jobFail: false, jobBlock: false,
  pConc: '2', pLock: '30000', pStall: '1', pAtt: '1', pSpeed: '4'
};

const els = {};
function makeEl(id) {
  return {
    id,
    value: INPUT_DEFAULTS[id] !== undefined ? String(INPUT_DEFAULTS[id]) : '',
    checked: INPUT_DEFAULTS[id] === true,
    textContent: '', innerHTML: '', className: '', style: {},
    addEventListener() {}, scrollTop: 0, scrollHeight: 0
  };
}
const IDS = ['jobName','jobDelay','jobPrio','jobWork','jobFail','jobBlock',
  'pConc','pLock','pStall','pAtt','pSpeed',
  'btnRun','btnStep','btnReset','btnReplay','btnAdd',
  'laneWait','lanePrio','laneDelayed','laneActive','laneDone',
  'mClock','mDone','mFail','mWait','evtLog'];

IDS.forEach(id => { els[id] = makeEl(id); });

const documentStub = {
  getElementById: id => els[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}
};

let storage = {};
const localStorageStub = {
  getItem: k => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: k => { delete storage[k]; }
};

const sandbox = {
  document: documentStub,
  localStorage: localStorageStub,
  window: {},
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  Math, JSON, Date, parseInt, isNaN, String, Number, Object, Array
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const sim = sandbox.window.__bullmqSim;
const S = sim.state;

/* ---------- Helpers ---------- */
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  ->  ' + detail : '')); }
}
function reset() {
  sim.reset(false);
  els.pConc.value = '2'; els.pLock.value = '30000'; els.pStall.value = '1'; els.pAtt.value = '1';
}
function run(ticks) { for (let i = 0; i < ticks; i++) sim.step(); }
function orderOfProcessing() {
  return S.events.filter(e => e.text.indexOf('→active') >= 0)
                 .map(e => (e.text.match(/id=(\d+)/) || [])[1]);
}
function logContains(sub) {
  return S.events.some(e => e.text.indexOf(sub) >= 0);
}

/* ---------- 1. FIFO se drena antes que el set priorizado ---------- */
console.log('\n[1] La lista wait se drena COMPLETA antes que el set priorizado');
reset();
sim.add('sin-prio-1', 0, 0, 100);
sim.add('sin-prio-2', 0, 0, 100);
sim.add('prio-1', 0, 1, 100);   // prioritario, añadido en medio
sim.add('sin-prio-3', 0, 0, 100);
run(4);
{
  const order = orderOfProcessing();
  check('el job prioritario se activa el último de los 4', order[3] === '3', 'orden=' + order.join(','));
  check('los tres sin prioridad van primero, en FIFO',
    order.slice(0,3).join(',') === '1,2,4', 'orden=' + order.join(','));
  check('el log registra RPOPLPUSH desde wait antes que ZPOPMIN',
    S.events.findIndex(e => e.text.indexOf('RPOPLPUSH') >= 0) < S.events.findIndex(e => e.text.indexOf('ZPOPMIN') >= 0));
}

/* ---------- 2. Score de prioridad ---------- */
console.log('\n[2] Score del set priorizado = priority × 2^32 + contador');
reset();
sim.add('p1', 0, 1, 100);
sim.add('p5', 0, 5, 100);
sim.add('p1b', 0, 1, 100);
{
  const prio = S.prio.slice().sort((a,b) => a.score - b.score);
  // el contador es un INCR global: el primer job priorizado recibe offset 1
  check('priority 1 -> score 1×2^32 + 1', prio[0].score === 4294967296 + 1, 'score=' + prio[0].score);
  check('priority 5 -> score 5×2^32 + 2', prio[2].score === 5 * 4294967296 + 2, 'score=' + prio[2].score);
  check('dos jobs con la misma prioridad mantienen orden FIFO por contador',
    prio[0].score < prio[1].score, prio[0].score + ' vs ' + prio[1].score);
  check('el offset del contador es global: los 2 jobs de prioridad 1 difieren en 2 (el p5 consumió el 2)',
    prio[1].score - prio[0].score === 2, prio[0].score + ' vs ' + prio[1].score);
  check('dentro de la misma prioridad manda el orden de inserción (FIFO)',
    S.jobs[prio[0].id].name === 'p1' && S.jobs[prio[1].id].name === 'p1b',
    S.jobs[prio[0].id].name + ' vs ' + S.jobs[prio[1].id].name);
}

/* ---------- 3. Score y promoción del delayed ---------- */
console.log('\n[3] Delayed: score = timestamp × 4096 + offset, promoción al vencer');
reset();
sim.add('d1', 2000, 0, 100);
sim.add('d2', 2000, 0, 100);
{
  const d = S.delayed.slice().sort((a,b) => a.score - b.score);
  check('ambos delayed comparten timestamp', d[0].at === d[1].at);
  check('scores consecutivos dentro del bucket', d[1].score - d[0].score === 1,
    d[0].score + ' vs ' + d[1].score);
  check('score = timestamp × 4096', d[0].score === 2000 * 4096, 'score=' + d[0].score);
}
run(20);
{
  const order = orderOfProcessing();
  check('ambos delayed se activan tras vencer el delay', order.length === 2, 'orden=' + order.join(','));
  check('se promotes a wait con LPUSH (prev=delayed)', logContains('promoteDelayed'));
}

/* ---------- 4. Retries con backoff ---------- */
console.log('\n[4] Retry con backoff exponencial y fallo definitivo');
reset();
els.pAtt.value = '3';
sim.add('falla', 0, 0, 100, true);
run(3);
check('el job que falla no se marca completado', S.done.length === 0);
check('vuelve a delayed para el reintento', S.delayed.length === 1 || S.active.length === 1,
  'delayed=' + S.delayed.length + ' active=' + S.active.length);
run(120);
{
  check('tras agotar los intentos queda failed', S.failed.length === 1,
    'failed=' + S.failed.length + ' done=' + S.done.length);
  check('se registran 3 intentos (atm=3)', /atm=3/.test(S.events.map(e=>e.text).join('|')), 'eventos=' + S.events.length);
  check('el motivo de fallo se registra', logContains('error simulado'));
}

/* ---------- 5. Stalled: lock caduca cuando el processor bloquea el event loop ---------- */
console.log('\n[5] Stalled: lock sin renovar -> vuelve a wait; superado maxStalledCount -> failed');
reset();
els.pLock.value = '1000';
els.pStall.value = '1';
sim.add('bloquea', 0, 0, 20000, false, true);  // processor que bloquea el event loop
run(15);   // el lock caduca ~1s despues de activarse: primer stall
{
  check('el lock caduca y se emite stalled', logContains('stalled'), 'eventos=' + S.events.length);
  check('el contador stc sube a 1 en el primer stall', S.jobs['1'].stalled === 1, 'stc=' + S.jobs['1'].stalled);
  check('el job no se pierde: vuelve a wait', S.wait.includes('1') || S.active.some(a=>a.id==='1') || S.failed.includes('1'),
    'wait=' + S.wait + ' active=' + S.active.map(a=>a.id) + ' failed=' + S.failed);
  check('con stc=1 y maxStalledCount=1 NO se falla todavia', !S.failed.includes('1'), 'failed=' + S.failed.join(','));
}
run(200);
{
  check('superado maxStalledCount el job falla permanentemente', S.failed.includes('1'),
    'failed=' + S.failed.join(',') + ' stc=' + S.jobs['1'].stalled);
  check('el motivo es "job stalled more than allowable limit"', logContains('job stalled more than allowable limit'));
  check('el contador stc supera maxStalledCount', S.jobs['1'].stalled > 1, 'stc=' + S.jobs['1'].stalled);
}

/* ---------- 6. attemptsMade se incrementa al finalizar, no al activar ---------- */
console.log('\n[6] attemptsMade (atm) vs attemptsStarted (ats)');
reset();
sim.add('ok', 0, 0, 100);
run(4);
{
  const j = S.jobs['1'];
  check('atm=1 tras completarse', j.attemptsMade === 1, 'atm=' + j.attemptsMade);
  check('ats=1 (arrancó una vez)', j.attemptsStarted === 1, 'ats=' + j.attemptsStarted);
}

/* ---------- 7. Job sin prioridad va a LIST, con prioridad va a ZSET ---------- */
console.log('\n[7] priority 0 -> LIST wait ; priority > 0 -> ZSET prioritized');
reset();
sim.add('a', 0, 0, 100);
sim.add('b', 0, 1, 100);
check('el job sin prioridad está en la lista wait', S.wait.includes('1'));
check('el job con priority 1 NO está en la lista wait', !S.wait.includes('2'));
check('el job con priority 1 está en el set priorizado', S.prio.some(p => p.id === '2'));

console.log('\n----------------------------------------');
console.log('  ' + passed + ' pasaron, ' + failed + ' fallaron');
console.log('----------------------------------------');
process.exit(failed > 0 ? 1 : 0);
