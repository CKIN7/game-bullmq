/**
 * Arnés del Juego 1 — Despacho Prioritario (api-movies).
 *
 * Verifica lo que el juego debe enseñar y lo que el navegador necesita:
 *   - config: 7 colas reales del README y paridad JSON ↔ .js
 *   - motor: priority 0 → LIST wait ; priority > 0 → ZSET prioritized
 *   - motor: wait se drena ENTERA antes que prioritized
 *   - motor: dentro del ZSET gana el MENOR score (menor número = más prioridad)
 *   - niveles: Inversión (diales) reproduce el bug y su arreglo
 *   - niveles: El cero traicionero hace salir primero al priority 0
 *   - niveles: Hambruna demuestra que la prioridad no expropia un job activo
 *   - niveles: Independencia demuestra que dos colas p1 no compiten
 *   - HTML: ids, scripts, tema claro/oscuro y glosario citado
 *   - visual: mapa de componentes, cuatro gráficas, pasos add→completed y checklist
 *
 * Ejecutar: node juego-1-api/test-juego-1-api.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const Sim = require("./engine/bullmq-sim.js");
const LEVELS = require("./engine/levels-juego-1.js");
const CONFIG = require("./config/bullmq-config.json");
const CONFIG_JS = require("./config/bullmq-config.js");

const HTML_PATH = path.join(__dirname, "index.html");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  ->  " + err.message);
  }
}

function runLevel(level, priorities) {
  const engine = new Sim.Engine({
    queueName: level.queueName,
    concurrency: level.concurrency || 1
  });
  const add = (job) => {
    const priority = priorities ? priorities[job.id] : job.priority;
    engine.addJob({
      id: job.id,
      name: job.name,
      type: job.type,
      priority: priority,
      work: job.work
    });
  };
  const early = [];
  const late = [];
  level.jobs.forEach((job) => {
    (job.enqueueAfterStart ? late : early).push(job);
  });
  early.forEach(add);
  if (level.preStep) engine.step();
  late.forEach(add);
  engine.runToIdle();
  return engine;
}

/** Misma tolerancia de empates que usa la UI para el nivel 4. */
function sameOrderWithTies(a, b, tied) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (tied && tied.length && tied.indexOf(b[i]) >= 0) {
      if (tied.indexOf(a[i]) < 0) return false;
    } else if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
console.log("\n[1] Configuración derivada del README de api-movies");
/* ------------------------------------------------------------------ */

{
  check("hay 7 colas", () => assert.strictEqual(CONFIG.queues.length, 7));

  const expected = {
    "email-critical": 1,
    "email-transactional": 5,
    "email-marketing": 10,
    "notification-fanout": 1,
    "notification-inapp": 3,
    "recs-recompute-user": 1,
    "recs-recompute-all": 10
  };

  Object.keys(expected).forEach((name) => {
    check(`cola ${name} con prioridad ${expected[name]}`, () => {
      const queue = CONFIG.queues.find((q) => q.name === name);
      assert.ok(queue, "no existe la cola " + name);
      assert.strictEqual(queue.priority, expected[name]);
    });
  });

  check("cada cola declara su worker", () => {
    CONFIG.queues.forEach((q) => {
      assert.ok(typeof q.worker === "string" && q.worker.length > 0, "falta worker en " + q.name);
    });
  });

  check("solo se usan las prioridades reales {1,3,5,10}", () => {
    const priorities = [...new Set(CONFIG.queues.map((q) => q.priority))].sort((a, b) => a - b);
    assert.deepStrictEqual(priorities, [1, 3, 5, 10]);
  });

  check("la regla documenta priority 0 → wait y priority > 0 → prioritized", () => {
    assert.ok(CONFIG.priorityRule.list.includes("0"));
    assert.ok(CONFIG.priorityRule.zset.includes("prioritized"));
    assert.strictEqual(CONFIG.priorityRule.waitDrainsFirst, true);
  });

  check("bullmq-config.js coincide exactamente con bullmq-config.json", () => {
    assert.deepStrictEqual(CONFIG_JS, CONFIG);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[2] Motor: zona de entrada y drenado de wait");
/* ------------------------------------------------------------------ */

{
  check("priority 0 va a la LIST wait", () => {
    assert.strictEqual(Sim.zoneFor({ priority: 0 }), "wait");
    const engine = new Sim.Engine();
    engine.addJob({ id: "z", priority: 0, work: 100 });
    assert.deepStrictEqual(engine.wait, ["z"]);
    assert.strictEqual(engine.prioritized.length, 0);
  });

  check("priority > 0 va al ZSET prioritized", () => {
    assert.strictEqual(Sim.zoneFor({ priority: 3 }), "prioritized");
    const engine = new Sim.Engine();
    engine.addJob({ id: "p", priority: 3, work: 100 });
    assert.strictEqual(engine.wait.length, 0);
    assert.strictEqual(engine.prioritized.length, 1);
  });

  check("wait se drena ENTERA antes que prioritized", () => {
    const engine = new Sim.Engine({ concurrency: 1 });
    engine.addJob({ id: "prio", priority: 1, work: 100 });
    engine.addJob({ id: "zero", priority: 0, work: 100 });
    engine.runToIdle();
    assert.strictEqual(engine.processingOrder.join(","), "zero,prio");
  });

  check("dentro del ZSET gana el MENOR score: p1 → p5 → p10", () => {
    const engine = new Sim.Engine({ concurrency: 1 });
    engine.addJob({ id: "p10", priority: 10, work: 100 });
    engine.addJob({ id: "p1", priority: 1, work: 100 });
    engine.addJob({ id: "p5", priority: 5, work: 100 });
    engine.runToIdle();
    assert.strictEqual(engine.processingOrder.join(","), "p1,p5,p10");
  });

  check("el score priorizado es priority × 2^32 + contador", () => {
    const engine = new Sim.Engine();
    engine.addJob({ id: "a", priority: 1, work: 100 });
    engine.addJob({ id: "b", priority: 5, work: 100 });
    assert.strictEqual(engine.jobs.a.score, Sim.PRIORITY_MULT + 1);
    assert.strictEqual(engine.jobs.b.score, 5 * Sim.PRIORITY_MULT + 2);
  });

  check("las activaciones de wait usan RPOPLPUSH y las del ZSET ZPOPMIN", () => {
    const engine = new Sim.Engine({ concurrency: 1 });
    engine.addJob({ id: "zero", priority: 0, work: 100 });
    engine.addJob({ id: "prio", priority: 1, work: 100 });
    engine.runToIdle();
    const cmds = engine.events.filter((e) => e.kind === "move").map((e) => e.cmd.split(" ")[0]);
    assert.deepStrictEqual(cmds, ["RPOPLPUSH", "ZPOPMIN"]);
  });

  check("determinismo: mismo guion, mismo orden", () => {
    const a = runLevel(LEVELS[0]);
    const b = runLevel(LEVELS[0]);
    assert.deepStrictEqual(a.processingOrder, b.processingOrder);
    assert.strictEqual(a.clock, b.clock);
  });

  check("priority 0 y priority > 0 nunca comparten zona", () => {
    assert.notStrictEqual(Sim.zoneFor({ priority: 0 }), Sim.zoneFor({ priority: 1 }));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[3] Niveles: estructura y coherencia con la config");
/* ------------------------------------------------------------------ */

{
  check("se entregan exactamente 4 niveles", () => {
    assert.strictEqual(LEVELS.length, 4);
  });

  check("los ids de nivel son inversion, cero, hambruna e independencia", () => {
    assert.deepStrictEqual(
      LEVELS.map((l) => l.id),
      ["inversion", "cero", "hambruna", "independencia"]
    );
    assert.deepStrictEqual(LEVELS.map((l) => l.number), [1, 2, 3, 4]);
  });

  check("los modos son tune (1) y predict (2, 3 y 4)", () => {
    assert.deepStrictEqual(
      LEVELS.map((l) => l.mode),
      ["tune", "predict", "predict", "predict"]
    );
  });

  check("las prioridades editables son las reales {1,3,5,10}", () => {
    assert.deepStrictEqual(
      LEVELS[0].allowedPriorities.slice().sort((a, b) => a - b),
      [1, 3, 5, 10]
    );
  });

  check("cada job apunta a una cola de la config", () => {
    const names = CONFIG.queues.map((q) => q.name);
    LEVELS.forEach((level) => {
      level.jobs.forEach((job) => {
        assert.ok(names.indexOf(job.queue) >= 0, "cola desconocida: " + job.queue);
      });
    });
  });

  check("cada job priorizado usa una prioridad real (> 0)", () => {
    const real = new Set(CONFIG.queues.map((q) => q.priority));
    LEVELS.forEach((level) => {
      level.jobs.forEach((job) => {
        if (job.priority > 0) {
          assert.ok(real.has(job.priority), "prioridad inventada: " + job.priority + " en " + job.id);
        }
      });
    });
  });

  check("cada nivel trae misión, lección y fuente", () => {
    LEVELS.forEach((level) => {
      assert.ok(typeof level.name === "string" && level.name.length > 0);
      assert.ok(Array.isArray(level.intro) && level.intro.length > 0);
      assert.ok(typeof level.mission === "string" && level.mission.length > 0);
      assert.ok(typeof level.lesson === "string" && level.lesson.length > 0);
      assert.ok(level.source && level.source.label && level.source.url);
    });
  });

  check("el objetivo de cada nivel referencia ids reales", () => {
    LEVELS.forEach((level) => {
      const ids = level.jobs.map((j) => j.id);
      assert.strictEqual(level.goal.order.length, ids.length);
      level.goal.order.forEach((id) => {
        assert.ok(ids.indexOf(id) >= 0, "objetivo con id desconocido: " + id);
      });
      (level.goal.tied || []).forEach((id) => {
        assert.ok(ids.indexOf(id) >= 0, "empatado desconocido: " + id);
        assert.ok(level.goal.order.indexOf(id) >= 0, "empatado fuera del objetivo: " + id);
      });
    });
  });

  check("cada nivel trae su pista y su checklist", () => {
    LEVELS.forEach((level) => {
      assert.ok(typeof level.hint === "string" && level.hint.length > 10, "falta hint en " + level.id);
      assert.ok(Array.isArray(level.observe) && level.observe.length >= 3, "falta observe en " + level.id);
    });
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[4] Nivel 1 «Inversión»: el bug y su arreglo");
/* ------------------------------------------------------------------ */

{
  const level = LEVELS[0];

  check("el recibo está fijado en prioridad 5 y no es editable", () => {
    const receipt = level.jobs.find((j) => j.id === "transactional-receipt");
    assert.strictEqual(receipt.priority, 5);
    assert.strictEqual(receipt.editable, false);
  });

  check("verificación y newsletter sí son editables", () => {
    assert.strictEqual(level.jobs.find((j) => j.id === "critical-verification").editable, true);
    assert.strictEqual(level.jobs.find((j) => j.id === "marketing-newsletter").editable, true);
  });

  check("con los valores por defecto (bug) el newsletter sale PRIMERO", () => {
    const engine = runLevel(level);
    assert.deepStrictEqual(
      engine.processingOrder,
      ["marketing-newsletter", "transactional-receipt", "critical-verification"]
    );
  });

  check("el arreglo (1, 5, 10) produce el orden objetivo", () => {
    const fixed = {
      "critical-verification": 1,
      "transactional-receipt": 5,
      "marketing-newsletter": 10
    };
    const engine = runLevel(level, fixed);
    assert.deepStrictEqual(engine.processingOrder, level.goal.order);
  });

  check("los diales permitidos incluyen 1 y 10 para poder arreglarlo", () => {
    assert.ok(level.allowedPriorities.indexOf(1) >= 0);
    assert.ok(level.allowedPriorities.indexOf(10) >= 0);
  });

  check("la lección explica que el número menor gana", () => {
    assert.ok(level.lesson.includes("MENOR") || level.lesson.includes("menor"));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[5] Nivel 2 «El cero traicionero»: priority 0 sale antes");
/* ------------------------------------------------------------------ */

{
  const level = LEVELS[1];

  check("system-note (aviso de sistema) tiene priority 0", () => {
    const note = level.jobs.find((j) => j.id === "system-note");
    assert.strictEqual(note.priority, 0);
  });

  check("el motor confirma el orden correcto declarado", () => {
    const engine = runLevel(level);
    assert.deepStrictEqual(engine.processingOrder, level.correctOrder);
    assert.deepStrictEqual(engine.processingOrder, level.goal.order);
  });

  check("el priority 0 (system-note) se activa primero", () => {
    const engine = runLevel(level);
    assert.strictEqual(engine.processingOrder[0], "system-note");
  });

  check("sin el priority 0, el ZSET ordena por score (p1 antes que p5)", () => {
    const withoutZero = {
      verification: 1,
      "system-note": 1,
      receipt: 5
    };
    const engine = runLevel(level, withoutZero);
    // al darle prioridad 1 al aviso, compite en el ZSET y su orden de llegada lo deja detrás
    assert.strictEqual(engine.processingOrder[0], "verification");
    assert.strictEqual(engine.processingOrder[1], "system-note");
    assert.strictEqual(engine.processingOrder[2], "receipt");
  });

  check("la lección menciona wait y RPOPLPUSH", () => {
    assert.ok(level.lesson.includes("wait"));
    assert.ok(level.lesson.includes("RPOPLPUSH"));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[6] Nivel 3 «Hambruna»: la prioridad no expropia el job activo");
/* ------------------------------------------------------------------ */

{
  const level = LEVELS[2];

  check("el primer lote está marcado para activarse antes de que lleguen los demás", () => {
    const first = level.jobs.find((j) => j.preActivate);
    assert.ok(first, "falta un job preActivate");
    assert.strictEqual(first.id, "recs-recompute-all-1");
    assert.strictEqual(level.preStep, true);
    assert.strictEqual(
      level.jobs.filter((j) => j.enqueueAfterStart).length,
      2
    );
  });

  check("el motor confirma el orden declarado (lote → usuario → lote 2)", () => {
    const engine = runLevel(level);
    assert.deepStrictEqual(engine.processingOrder, level.goal.order);
  });

  check("el lote 1 se activa en el tick 1, antes que los otros dos", () => {
    const engine = runLevel(level);
    const active = engine.events.filter((e) => e.kind === "active");
    assert.strictEqual(active[0].jobId, "recs-recompute-all-1");
    assert.strictEqual(active[0].tick, 1);
  });

  check("recompute-user (p1) espera ~9 s porque el worker está ocupado", () => {
    const engine = runLevel(level);
    const active = engine.events.filter((e) => e.kind === "active");
    const batch = active.find((e) => e.jobId === "recs-recompute-all-1");
    const user = active.find((e) => e.jobId === "recs-recompute-user");
    assert.ok(user.tick - batch.tick >= 80, "el usuario no esperó al lote");
  });

  check("cuando el lote termina, el p1 sale antes que el segundo lote p10", () => {
    const engine = runLevel(level);
    const order = engine.processingOrder;
    assert.ok(order.indexOf("recs-recompute-user") < order.indexOf("recs-recompute-all-2"));
  });

  check("la lección explica la hambruna y el job activo", () => {
    assert.ok(/activo/i.test(level.lesson));
    assert.ok(/hambruna/i.test(level.lesson));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[7] Nivel 4 «Independencia»: dos colas p1 no compiten");
/* ------------------------------------------------------------------ */

{
  const level = LEVELS[3];

  check("el nivel declara concurrency 2 (dos workers independientes)", () => {
    assert.strictEqual(level.concurrency, 2);
  });

  check("los dos jobs p1 vienen de colas distintas", () => {
    const tied = level.goal.tied || [];
    assert.strictEqual(tied.length, 2);
    const jobs = tied.map((id) => level.jobs.find((j) => j.id === id));
    jobs.forEach((job) => assert.strictEqual(job.priority, 1));
    assert.notStrictEqual(jobs[0].queue, jobs[1].queue);
  });

  check("los dos p1 se activan en el MISMO tick", () => {
    const engine = runLevel(level);
    const active = engine.events.filter((e) => e.kind === "active");
    const a = active.find((e) => e.jobId === "email-critical-verify");
    const b = active.find((e) => e.jobId === "notification-fanout-review");
    assert.ok(a && b, "faltan activaciones p1");
    assert.strictEqual(a.tick, b.tick);
  });

  check("el p3 espera a que se libere un slot de worker", () => {
    const engine = runLevel(level);
    const active = engine.events.filter((e) => e.kind === "active");
    const p1 = active.find((e) => e.jobId === "email-critical-verify");
    const p3 = active.find((e) => e.jobId === "notification-inapp-welcome");
    assert.ok(p3.tick > p1.tick, "el p3 no esperó");
  });

  check("el orden real deja el p3 al final y tolera el empate p1", () => {
    const engine = runLevel(level);
    const tied = level.goal.tied;
    assert.strictEqual(engine.processingOrder[2], "notification-inapp-welcome");
    assert.ok(tied.indexOf(engine.processingOrder[0]) >= 0);
    assert.ok(tied.indexOf(engine.processingOrder[1]) >= 0);
    assert.ok(sameOrderWithTies(engine.processingOrder, level.goal.order, tied));
    const swapped = [engine.processingOrder[1], engine.processingOrder[0], engine.processingOrder[2]];
    assert.ok(sameOrderWithTies(swapped, engine.processingOrder, tied), "el empate se rechazó");
  });

  check("la lección explica que las colas no compiten entre sí", () => {
    assert.ok(/no compiten/i.test(level.lesson));
    assert.ok(/worker/i.test(level.lesson));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[8] HTML: estructura, scripts y controles");
/* ------------------------------------------------------------------ */

{
  const html = fs.readFileSync(HTML_PATH, "utf8");

  const requiredIds = [
    "board", "overlay", "toast",
    "btnSim", "btnStep", "btnReset", "btnTheme", "btnGlossary", "btnGlossaryClose",
    "speed", "hint",
    "hudLevel", "hudQueued", "hudDone", "hudClock",
    "missionTitle", "missionBadge", "missionText", "missionGoal",
    "tunePanel", "dials", "predictPanel", "predList", "predCount", "btnClearPred",
    "rule-zero", "rule-prio", "rule-wait",
    "scoreBody", "scoreStatus", "evtLog", "traceTick",
    "glossary",
    "lvl-inversion", "lvl-cero", "lvl-hambruna", "lvl-independencia"
  ];

  requiredIds.forEach((id) => {
    check(`el HTML incluye #${id}`, () => {
      assert.ok(html.includes('id="' + id + '"'), "falta id=" + id);
    });
  });

  check("el HTML carga config, motor y niveles sin build", () => {
    assert.ok(html.includes('<script src="config/bullmq-config.js"></script>'));
    assert.ok(html.includes('<script src="engine/bullmq-sim.js"></script>'));
    assert.ok(html.includes('<script src="engine/levels-juego-1.js"></script>'));
  });

  check("el juego es autocontenido: no usa fetch", () => {
    assert.ok(!html.includes("fetch("), "el juego no debe depender de fetch");
  });

  check("el canvas declara dimensiones y se dibuja con la paleta", () => {
    assert.ok(/id="board"\s+width="960"\s+height="600"/.test(html), "canvas sin tamaño");
    assert.ok(html.includes("C.bgTop") && html.includes("C.panelLine"), "el canvas no usa la paleta");
  });

  check("las tres zonas de UI existen como paneles laterales", () => {
    assert.ok(html.includes("Regla de entrada"));
    assert.ok(html.includes("Score inspector"));
    assert.ok(html.includes("Traza de eventos"));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[9] HTML: tema claro/oscuro");
/* ------------------------------------------------------------------ */

{
  const html = fs.readFileSync(HTML_PATH, "utf8");

  check("existe el botón de tema con aria-pressed", () => {
    assert.ok(html.includes('id="btnTheme"'), "falta #btnTheme");
    assert.ok(/id="btnTheme"[^>]*aria-pressed/.test(html), "el botón no expone aria-pressed");
  });

  check("el botón está cableado a toggleTheme", () => {
    assert.ok(html.includes('$("btnTheme").addEventListener("click", toggleTheme)'));
  });

  check('existe el bloque CSS [data-theme="dark"]', () => {
    assert.ok(html.includes('[data-theme="dark"]'), "falta el tema oscuro");
    assert.ok(/\[data-theme="dark"\]\s*\{[\s\S]*--bg:#0d1117/.test(html), "el tema oscuro no redefine --bg");
    assert.ok(/\[data-theme="dark"\]\s*\{[\s\S]*--ink:#e8ecf3/.test(html), "el tema oscuro no redefine --ink");
  });

  check("el tema se persiste y respeta al sistema", () => {
    assert.ok(html.includes('localStorage.getItem("despacho-theme")'), "no lee el tema guardado");
    assert.ok(html.includes('localStorage.setItem("despacho-theme", t)'), "no persiste el tema");
    assert.ok(html.includes("prefers-color-scheme: dark"), "no respeta el sistema");
  });

  check("las paletas claro y oscuro definen las mismas claves", () => {
    const themes = html.match(/var THEMES = \{[\s\S]*?\n  \};/);
    assert.ok(themes, "no se encontró THEMES");
    const colorBlocks = themes[0].match(/colors: \{[\s\S]*?\n      \}/g) || [];
    assert.strictEqual(colorBlocks.length, 2, "se esperaban dos paletas de canvas");
    const keys = (s) => [...s.matchAll(/([a-zA-Z0-9]+):\s*"/g)].map((m) => m[1]).sort();
    const light = keys(colorBlocks[0]);
    const dark = keys(colorBlocks[1]);
    assert.ok(light.length > 20, "la paleta clara parece incompleta");
    assert.deepStrictEqual(light, dark, "las paletas no cubren las mismas claves");
  });

  check("el canvas no usa colores literales", () => {
    const jsStart = html.lastIndexOf("<script>");
    const js = html.slice(jsStart, html.indexOf("</script>", jsStart));
    const flat = js.match(/ctx\.(fillStyle|strokeStyle|shadowColor)\s*=\s*"#/g) || [];
    assert.strictEqual(flat.length, 0, "quedan colores literales en el canvas");
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[10] HTML: glosario y didáctica citada");
/* ------------------------------------------------------------------ */

{
  const html = fs.readFileSync(HTML_PATH, "utf8");

  check("el glosario define los términos clave", () => {
    ["wait", "prio", "zero", "fifo", "score", "events"].forEach((term) => {
      assert.ok(html.includes('id="glossary-' + term + '"'), "falta glossary-" + term);
    });
  });

  check("las filas de regla enlazan con el glosario", () => {
    ["zero", "prio", "fifo"].forEach((term) => {
      assert.ok(html.includes('data-term="' + term + '"'), "falta data-term=" + term);
    });
  });

  check("el HTML cita la fuente real de BullMQ", () => {
    assert.ok(html.includes("moveToActive-11.lua"));
    assert.ok(html.includes("includes/getPriorityScore.lua"));
  });

  check("el aula enseña que menor número = más prioridad", () => {
    assert.ok(html.includes("menor número = más prioridad"));
  });

  check("el HTML no usa el texto ambiguo '232' fuera de los colores hex", () => {
    // Se ignoran los literales de color (#232b36, etc.) para no dar falsos positivos.
    const prose = html.replace(/#[0-9a-fA-F]{3,8}/g, "");
    assert.ok(!prose.includes("× 232"), "queda × 232");
    assert.ok(!prose.includes("232"), "queda el texto 232");
    assert.ok(prose.includes("2³²"), "debería usar el exponente 2³²");
  });

  check("el HTML expone el juego para depuración", () => {
    assert.ok(html.includes("window.DespachoGame"));
  });
}

console.log("\n[11] Capa visual: mapa, gráficas, pasos y checklist");

/* ------------------------------------------------------------------ */

{
  const html = fs.readFileSync(HTML_PATH, "utf8");

  const visualIds = [
    "archMap", "archNow",
    "arch-producer", "arch-router", "arch-wait", "arch-prioritized",
    "arch-move", "arch-worker", "arch-completed", "arch-failed", "arch-events",
    "arch-e-producer-router", "arch-e-router-wait", "arch-e-router-prio",
    "arch-e-wait-move", "arch-e-prio-move", "arch-e-move-worker",
    "arch-e-worker-completed", "arch-e-worker-failed", "arch-e-worker-events",
    "chartPriority", "chartScore", "chartGantt", "chartDepth",
    "stepPanel", "stepNow", "step-add", "step-zone", "step-move",
    "step-active", "step-complete",
    "observeList", "observeBadge"
  ];

  visualIds.forEach((id) => {
    check(`el HTML incluye #${id}`, () => {
      assert.ok(html.includes('id="' + id + '"'), "falta id=" + id);
    });
  });

  check("el mapa enlaza nodos con el glosario", () => {
    ["wait", "prio", "fifo", "events"].forEach((term) => {
      assert.ok(html.includes('data-term="' + term + '"'), "falta data-term=" + term);
    });
  });

  check("la capa visual usa el motor vendorizado BullMQSim", () => {
    assert.ok(html.includes("var Sim = window.BullMQSim;"));
    assert.ok(!html.includes("window.DispatchSim"), "queda la referencia al motor recortado");
  });

  check("la traza usa engine.tick (no engine.ticks)", () => {
    assert.ok(html.includes("engine ? engine.tick : 0"));
    assert.ok(!html.includes("engine.ticks"));
  });

  check("cada nivel trae su checklist «¿Qué observar?»", () => {
    LEVELS.forEach((level) => {
      assert.ok(Array.isArray(level.observe) && level.observe.length >= 3, "checklist incompleta en " + level.id);
      level.observe.forEach((item) => assert.ok(item.length > 10, "ítem demasiado corto en " + level.id));
    });
  });

  check("el HTML renderiza la checklist y el estado de pasos", () => {
    assert.ok(html.includes("function renderObserve()"));
    assert.ok(html.includes("function renderSteps()"));
    assert.ok(html.includes("function drawCharts()"));
    assert.ok(html.includes("function renderArchMap()"));
    assert.ok(html.includes("function flowForEvent(e)"));
  });

  check("las cuatro gráficas se dibujan con la paleta del tema", () => {
    ["drawPriorityChart", "drawScoreChart", "drawGanttChart", "drawDepthChart"].forEach((fn) => {
      assert.ok(html.includes("function " + fn + "()"), "falta " + fn);
    });
    assert.ok(html.includes("drawCharts()"), "drawCharts no está cableado");
  });

  check("el score se conserva tras completar los jobs", () => {
    const engine = runLevel(LEVELS[0]);
    engine.processingOrder.forEach((id) => {
      assert.ok(engine.jobs[id].score != null, "se perdió el score de " + id);
    });
    const seq = engine.jobs["marketing-newsletter"].score % Sim.PRIORITY_MULT;
    assert.strictEqual(seq, 3);
  });

  check("el juego expone el mapa y las gráficas para depuración", () => {
    assert.ok(/window\.DespachoGame\s*=\s*\{[\s\S]*flowForEvent[\s\S]*drawCharts[\s\S]*renderArchMap/.test(html));
  });
}

console.log("\n----------------------------------------");
console.log("  " + passed + " pasaron, " + failed + " fallaron");
console.log("----------------------------------------");
process.exit(failed > 0 ? 1 : 0);
