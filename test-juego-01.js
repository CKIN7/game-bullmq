/**
 * Arnés del motor BullMQSim y del guion del Juego 01.
 *
 * Verifica la semántica que el juego necesita enseñar:
 *   - priority 0 → LIST wait ; priority > 0 → ZSET prioritized
 *   - wait se drena ENTERA antes que prioritized
 *   - score priorizado = priority × 2^32 + contador
 *   - delayed = timestamp × 4096 + offset ; al promover, score nuevo si tiene prioridad
 *   - determinismo: dos corridas del mismo guion producen el mismo orden y eventos
 *
 * Ejecutar: node test-juego-01.js
 */
"use strict";

const assert = require("assert");
const {
  Engine,
  zoneFor,
  PRIORITY_MULT,
  DELAY_MULT
} = require("./engine/bullmq-sim.js");
const WAVES = require("./engine/waves-juego-01.js");

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

function runWave(wave) {
  const queue = new Engine({ queueName: "puerto", concurrency: 2, attempts: 1 });
  wave.jobs.forEach((job) => queue.addJob(job));
  queue.runToIdle();
  return queue;
}

function activationCommands(queue) {
  return queue.events
    .filter((event) => event.kind === "move")
    .map((event) => event.cmd.split(" ")[0]);
}

/* ------------------------------------------------------------------ */
console.log("\n[1] Regla de entrada: delay > 0 → delayed; priority > 0 → prioritized; resto → wait");
/* ------------------------------------------------------------------ */

WAVES.forEach((wave, waveIndex) => {
  wave.jobs.forEach((job) => {
    const expected = job.delay > 0 ? "delayed" : job.priority > 0 ? "prioritized" : "wait";
    check(
      `oleada ${waveIndex + 1} · ${job.name} → ${expected}`,
      () => assert.strictEqual(zoneFor(job), expected)
    );
  });
});

/* ------------------------------------------------------------------ */
console.log("\n[2] Oleada 1: wait se drena antes que prioritized");
/* ------------------------------------------------------------------ */

{
  const queue = runWave(WAVES[0]);
  console.log("      orden de activación: " + queue.processingOrder.join(" → "));

  check("los 5 jobs terminan", () => assert.strictEqual(queue.completed.length, 5));
  check("la prioridad 1 se activa DESPUÉS de los dos priority 0", () => {
    assert.strictEqual(queue.processingOrder.join(","), "1,2,3,5,4");
  });
  check("el primer job prioritario se activa en 3ª posición, no en 1ª", () => {
    assert.strictEqual(queue.processingOrder[2], "3");
  });
  check("las dos primeras activaciones salen de la LIST (RPOPLPUSH)", () => {
    const commands = activationCommands(queue);
    assert.deepStrictEqual(commands.slice(0, 2), ["RPOPLPUSH", "RPOPLPUSH"]);
  });
  check("la tercera activación ya es ZPOPMIN del ZSET", () => {
    assert.strictEqual(activationCommands(queue)[2], "ZPOPMIN");
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[3] Scores: priority × 2^32 + contador y delayed × 4096 + offset");
/* ------------------------------------------------------------------ */

{
  const queue = runWave(WAVES[0]);
  check("otp-alta (p1, primer prioritario) → 1×2^32 + 1", () => {
    assert.strictEqual(queue.jobs["3"].score, PRIORITY_MULT + 1);
  });
  check("factura-urgente (p1, segundo prioritario) → 1×2^32 + 2", () => {
    assert.strictEqual(queue.jobs["5"].score, PRIORITY_MULT + 2);
  });
  check("webhook-limpieza (delay 4000) → 4000×4096 + 0", () => {
    assert.strictEqual(queue.jobs["4"].score, 4000 * DELAY_MULT);
  });
  check("los scores priorizados están ordenados", () => {
    const scores = queue.sortedPrioritized().map((entry) => entry.score);
    assert.deepStrictEqual(scores, scores.slice().sort((a, b) => a - b));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[4] Oleada 2: delayed se promueve y conserva su hueco temporal");
/* ------------------------------------------------------------------ */

{
  const queue = runWave(WAVES[1]);
  console.log("      orden de activación: " + queue.processingOrder.join(" → "));

  check("los 7 jobs terminan", () => assert.strictEqual(queue.completed.length, 7));
  check("orden esperado: 1,2,7,5,3,6,4", () => {
    assert.strictEqual(queue.processingOrder.join(","), "1,2,7,5,3,6,4");
  });
  check("sync-crm se promueve desde delayed", () => {
    assert.ok(queue.events.some((event) => event.kind === "promote" && event.jobId === "4"));
  });
  check("sync-crm se activa después de los jobs de wait y prioritized", () => {
    assert.strictEqual(queue.processingOrder[queue.processingOrder.length - 1], "4");
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[5] Oleada 3: la trampa — priority 1 no adelanta a wait");
/* ------------------------------------------------------------------ */

{
  const queue = runWave(WAVES[2]);
  console.log("      orden de activación: " + queue.processingOrder.join(" → "));

  check("los 8 jobs terminan", () => assert.strictEqual(queue.completed.length, 8));
  check("pago-urgente (p1) se activa después de los seis de wait", () => {
    const index = queue.processingOrder.indexOf("7");
    assert.ok(index >= 6, "índice=" + index + " orden=" + queue.processingOrder.join(","));
  });
  check("orden esperado: 1,2,3,4,5,6,7,8", () => {
    assert.strictEqual(queue.processingOrder.join(","), "1,2,3,4,5,6,7,8");
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[6] Delayed con priority > 0 recibe un score NUEVO al promover");
/* ------------------------------------------------------------------ */

{
  const queue = new Engine({ queueName: "puerto", concurrency: 1, attempts: 1 });
  queue.addJob({ id: "a", name: "primero", priority: 1, delay: 0, work: 100 });
  queue.addJob({ id: "b", name: "diferido", priority: 5, delay: 1000, work: 100 });

  check("antes de promover, b está en delayed con score 1000×4096", () => {
    assert.strictEqual(queue.jobs["b"].score, 1000 * DELAY_MULT);
    assert.strictEqual(queue.delayed.length, 1);
  });

  queue.runToIdle();
  check("al promover, b pasa a prioritized con score 5×2^32 + 2", () => {
    assert.strictEqual(queue.jobs["b"].score, 5 * PRIORITY_MULT + 2);
  });
  check("el orden es a → b", () => {
    assert.strictEqual(queue.processingOrder.join(","), "a,b");
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[7] Determinismo del guion");
/* ------------------------------------------------------------------ */

{
  const first = runWave(WAVES[2]);
  const second = runWave(WAVES[2]);
  check("mismo processingOrder en dos corridas", () => {
    assert.deepStrictEqual(first.processingOrder, second.processingOrder);
  });
  check("mismos comandos y textos de evento", () => {
    const a = first.events.map((event) => event.cmd + "|" + event.text);
    const b = second.events.map((event) => event.cmd + "|" + event.text);
    assert.deepStrictEqual(a, b);
  });
  check("el reloj virtual termina en el mismo instante", () => {
    assert.strictEqual(first.clock, second.clock);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[8] Casos límite del motor");
/* ------------------------------------------------------------------ */

{
  const empty = new Engine();
  const result = empty.runToIdle();
  check("una cola vacía no avanza el reloj", () => {
    assert.strictEqual(result.ticks, 0);
    assert.strictEqual(empty.clock, 0);
    assert.strictEqual(empty.isIdle(), true);
  });

  check("priority 0 y delay 0 van a wait", () => {
    const queue = new Engine();
    queue.addJob({ id: "x", priority: 0, delay: 0, work: 100 });
    assert.deepStrictEqual(queue.wait, ["x"]);
    assert.strictEqual(queue.prioritized.length, 0);
    assert.strictEqual(queue.delayed.length, 0);
  });

  check("priority > 0 va a prioritized, no a wait", () => {
    const queue = new Engine();
    queue.addJob({ id: "x", priority: 3, delay: 0, work: 100 });
    assert.deepStrictEqual(queue.wait, []);
    assert.strictEqual(queue.prioritized.length, 1);
  });

  check("delay > 0 va a delayed aunque tenga priority", () => {
    const queue = new Engine();
    queue.addJob({ id: "x", priority: 9, delay: 500, work: 100 });
    assert.strictEqual(queue.delayed.length, 1);
    assert.strictEqual(queue.prioritized.length, 0);
    assert.strictEqual(queue.wait.length, 0);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[9] Banco de preguntas del aula (content/quiz-juego-01.js)");
/* ------------------------------------------------------------------ */

{
  const QUIZ = require("./content/quiz-juego-01.js");
  const QUIZ_POINTS = 50;

  check("hay un paquete de preguntas por oleada", () => {
    assert.strictEqual(QUIZ.length, WAVES.length);
  });

  QUIZ.forEach((pack, waveIndex) => {
    check(`oleada ${waveIndex + 1} · el paquete tiene título y preguntas`, () => {
      assert.ok(typeof pack.title === "string" && pack.title.trim().length > 0);
      assert.ok(Array.isArray(pack.questions) && pack.questions.length >= 2);
    });

    pack.questions.forEach((q, qi) => {
      check(`oleada ${waveIndex + 1} · pregunta ${qi + 1} bien formada`, () => {
        assert.ok(typeof q.prompt === "string" && q.prompt.trim().length > 0);
        assert.ok(Array.isArray(q.options) && q.options.length >= 2);
        assert.ok(q.options.every((opt) => typeof opt === "string" && opt.trim().length > 0));
        assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
        assert.ok(typeof q.why === "string" && q.why.trim().length > 0);
      });
    });

    check(`oleada ${waveIndex + 1} · las respuestas correctas no caen siempre en la opción 0`, () => {
      assert.ok(pack.questions.some((q) => q.answer !== 0));
    });
  });

  check("cada paquete declara cuántos puntos vale el reto", () => {
    assert.strictEqual(QUIZ_POINTS, 50);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[10] Mapa de componentes (juego-01-el-puerto-de-redis.html)");
/* ------------------------------------------------------------------ */

{
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(
    path.join(__dirname, "juego-01-el-puerto-de-redis.html"),
    "utf8"
  );

  const requiredIds = [
    "archMap", "archNow",
    "arch-wait", "arch-prioritized", "arch-delayed",
    "arch-move", "arch-worker", "arch-completed", "arch-failed", "arch-events",
    "arch-e-router-wait", "arch-e-router-prio", "arch-e-router-delayed",
    "arch-e-wait-move", "arch-e-prio-move", "arch-e-delayed-move",
    "arch-e-move-worker", "arch-e-worker-completed", "arch-e-worker-events",
    "rule-wait", "rule-prio", "rule-delay"
  ];

  requiredIds.forEach((id) => {
    check(`el mapa incluye #${id}`, () => {
      assert.ok(html.includes('id="' + id + '"'), "falta id=" + id);
    });
  });

  check("el mapa dibuja los comandos Redis en las aristas", () => {
    ["LPUSH", "ZPOPMIN", "RPOPLPUSH", "promote", "XADD"].forEach((cmd) => {
      assert.ok(html.includes(">" + cmd + "<"), "falta la etiqueta " + cmd);
    });
  });

  check("los nodos del mapa enlazan con el glosario", () => {
    ["wait", "prio", "delayed", "fifo", "lock", "events"].forEach((term) => {
      assert.ok(html.includes('id="glossary-' + term + '"'), "falta glossary-" + term);
      assert.ok(html.includes('data-term="' + term + '"'), "falta data-term=" + term);
    });
  });

  check("el canvas anima el flujo entre componentes", () => {
    assert.ok(html.includes("function captureEngineFlow"));
    assert.ok(html.includes("function drawFlow"));
    assert.ok(html.includes("G.lastFocusEvent"));
  });
}

console.log("\n----------------------------------------");
console.log("  " + passed + " pasaron, " + failed + " fallaron");
console.log("----------------------------------------");
process.exit(failed > 0 ? 1 : 0);
