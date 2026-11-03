/**
 * Arnés del Juego 2 — Bala y Contra (BullMQ retries).
 *
 * Verifica:
 *   - config: attempts 3, backoff exponencial 2000 ms, removeOnFail 50
 *   - backoff: 2 s, 4 s, 8 s
 *   - frágil de 1 y 2 fallos completa en el intento correcto
 *   - venenoso agota attempts y termina en failed
 *   - reintentar cuesta energía; sin energía no hay reintento
 *   - abandonar un veneno suma; abandonar un frágil resta
 *   - removeOnFail conserva solo los últimos 50
 *   - stall check devuelve el job sin consumir intento
 *   - los dos escenarios se pueden jugar de forma determinista
 *   - HTML: scripts, ids, canvas, modal, sin fetch y con tema claro/oscuro
 *
 * Ejecutar: node juego-2-bala-y-contra/test-juego-2.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const Sim = require("./engine/retry-sim.js");
const SCENARIOS = require("./engine/scenarios-juego-2.js");
const CONFIG = require("./config/retry-config.json");
const CONFIG_JS = require("./config/retry-config.js");

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

/** Juega un escenario con una estrategia fija y devuelve el motor. */
function playScenario(scenario, options) {
  options = options || {};
  const sim = new Sim.Engine({
    attempts: CONFIG.jobOptions.attempts,
    backoffDelay: CONFIG.jobOptions.backoff.delay,
    removeOnFail: CONFIG.jobOptions.removeOnFail,
    energy: scenario.energy
  });
  scenario.jobs.forEach((job) => sim.addJob(job));

  let stalled = false;
  let guard = 0;
  while (!sim.isDone() && guard++ < 200) {
    const nextId = sim.pending[0];
    if (!nextId) {
      const next = sim.delayed[0];
      if (!next) break;
      sim.advance(next.readyAt - sim.time);
      continue;
    }

    sim.start(nextId);

    if (!stalled && scenario.stallOn === nextId) {
      stalled = true;
      sim.stall();
      continue;
    }

    const result = sim.runActive();
    if (result.status === "retryable") {
      const strategy = options.strategy || function (job) {
        return job.kind === "poisoned" ? "abandon" : "retry";
      };
      const action = strategy(result.job, result);
      if (action === "retry") sim.retry(nextId);
      else sim.abandon(nextId);
    }
  }
  return sim;
}

/* ------------------------------------------------------------------ */
console.log("\n[1] Configuración derivada del contrato de reintentos");
/* ------------------------------------------------------------------ */

{
  check("attempts es 3", () => {
    assert.strictEqual(CONFIG.jobOptions.attempts, 3);
  });

  check("el backoff es exponencial con delay 2000", () => {
    assert.strictEqual(CONFIG.jobOptions.backoff.type, "exponential");
    assert.strictEqual(CONFIG.jobOptions.backoff.delay, 2000);
  });

  check("removeOnFail conserva 50", () => {
    assert.strictEqual(CONFIG.jobOptions.removeOnFail, 50);
  });

  check("retry-config.js coincide exactamente con retry-config.json", () => {
    assert.deepStrictEqual(CONFIG_JS, CONFIG);
  });

  check("la config cita la fuente del juego y la doc de BullMQ", () => {
    assert.ok(CONFIG.source.section.includes("Juego 2"));
    assert.ok(CONFIG.source.bullmqDocs.includes("bullmq.io"));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[2] Backoff exponencial: 2 s, 4 s, 8 s");
/* ------------------------------------------------------------------ */

{
  check("backoffDelay(1) = 2000, (2) = 4000, (3) = 8000", () => {
    assert.strictEqual(Sim.backoffDelay(1, 2000), 2000);
    assert.strictEqual(Sim.backoffDelay(2, 2000), 4000);
    assert.strictEqual(Sim.backoffDelay(3, 2000), 8000);
  });

  check("la escalera del motor coincide con la config", () => {
    const sim = new Sim.Engine();
    assert.deepStrictEqual(sim.ladder(), [2000, 4000, 8000]);
  });

  check("con attempts=3 solo se usan los delays de los fallos 1 y 2", () => {
    const sim = new Sim.Engine({ attempts: 3, backoffDelay: 2000 });
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 2 });
    const delays = [];
    for (let i = 0; i < 2; i++) {
      sim.start("f");
      const res = sim.runActive();
      assert.strictEqual(res.status, "retryable");
      delays.push(res.delay);
      sim.retry("f");
      sim.advance(res.delay);
    }
    assert.deepStrictEqual(delays, [2000, 4000]);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[3] Frágiles y venenosos");
/* ------------------------------------------------------------------ */

{
  check("frágil de 1 fallo: falla el intento 1 y completa en el 2", () => {
    const sim = new Sim.Engine();
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 1 });
    sim.start("f");
    const first = sim.runActive();
    assert.strictEqual(first.status, "retryable");
    assert.strictEqual(first.delay, 2000);
    sim.retry("f");
    sim.advance(2000);
    sim.start("f");
    const second = sim.runActive();
    assert.strictEqual(second.status, "completed");
    assert.strictEqual(sim.jobs.f.attemptsMade, 2);
    assert.deepStrictEqual(sim.completed, ["f"]);
  });

  check("frágil de 2 fallos: completa en el intento 3", () => {
    const sim = new Sim.Engine();
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      sim.start("f");
      const res = sim.runActive();
      statuses.push(res.status);
      if (res.status === "retryable") {
        sim.retry("f");
        sim.advance(res.delay);
      }
    }
    assert.deepStrictEqual(statuses, ["retryable", "retryable", "completed"]);
    assert.strictEqual(sim.jobs.f.attemptsMade, 3);
  });

  check("venenoso: falla siempre y a los 3 intentos va a failed", () => {
    const sim = new Sim.Engine();
    sim.addJob({ id: "p", kind: "poisoned" });
    let last = null;
    for (let i = 0; i < 3; i++) {
      sim.start("p");
      last = sim.runActive();
      if (last.status === "retryable") {
        sim.retry("p");
        sim.advance(last.delay);
      }
    }
    assert.strictEqual(last.status, "failed");
    assert.strictEqual(last.terminal, true);
    assert.deepStrictEqual(sim.failed, ["p"]);
    assert.strictEqual(sim.jobs.p.attemptsMade, 3);
    assert.strictEqual(sim.active, null, "el fallo terminal debe liberar el worker");
    assert.strictEqual(sim.pendingCount(), 0);
    assert.strictEqual(sim.isDone(), true);
  });

  check("el veneno nunca completa aunque se reintente", () => {
    const sim = playScenario(SCENARIOS[0], {
      strategy: () => "retry"
    });
    assert.strictEqual(sim.completed.indexOf("poisoned-template"), -1);
    assert.ok(sim.failed.indexOf("poisoned-template") >= 0);
    assert.strictEqual(sim.score < SCENARIOS[0].target, true);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[4] Energía, decisiones y DLQ");
/* ------------------------------------------------------------------ */

{
  check("reintentar cuesta 1 de energía", () => {
    const sim = new Sim.Engine({ energy: 2 });
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 1 });
    sim.start("f");
    sim.runActive();
    const res = sim.retry("f");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sim.energy, 1);
    assert.strictEqual(sim.stats.energySpent, 1);
  });

  check("sin energía el reintento se rechaza", () => {
    const sim = new Sim.Engine({ energy: 0 });
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 1 });
    sim.start("f");
    sim.runActive();
    const res = sim.retry("f");
    assert.strictEqual(res.ok, false);
    assert.ok(res.reason.includes("energía"));
    assert.strictEqual(sim.jobs.f.state, "decision");
  });

  check("abandonar un veneno suma +60", () => {
    const sim = new Sim.Engine();
    sim.addJob({ id: "p", kind: "poisoned" });
    sim.start("p");
    sim.runActive();
    sim.abandon("p");
    assert.strictEqual(sim.score, 60);
    assert.deepStrictEqual(sim.failed, ["p"]);
  });

  check("abandonar un frágil resta -40", () => {
    const sim = new Sim.Engine();
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 1 });
    sim.start("f");
    sim.runActive();
    sim.abandon("f");
    assert.strictEqual(sim.score, -40);
  });

  check("removeOnFail conserva solo los últimos 50", () => {
    const sim = new Sim.Engine({ removeOnFail: 50 });
    for (let i = 0; i < 60; i++) {
      sim.addJob({ id: "p" + i, kind: "poisoned" });
      sim.start("p" + i);
      sim.runActive();
      sim.abandon("p" + i);
    }
    assert.strictEqual(sim.failed.length, 50);
    assert.strictEqual(sim.failed[0], "p10");
    assert.strictEqual(sim.failed[49], "p59");
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[5] Stall check");
/* ------------------------------------------------------------------ */

{
  check("stall devuelve el job a la cola sin consumir intento", () => {
    const sim = new Sim.Engine({ energy: 2 });
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 1 });
    sim.start("f");
    const before = sim.jobs.f.attemptsMade;
    const job = sim.stall();
    assert.strictEqual(job.id, "f");
    assert.strictEqual(sim.jobs.f.attemptsMade, before);
    assert.strictEqual(sim.jobs.f.attemptsMade, 0);
    assert.strictEqual(sim.jobs.f.stalled, 1);
    assert.strictEqual(sim.energy, 2);
    assert.strictEqual(sim.delayed.length, 0);
    assert.strictEqual(sim.pending[0], "f");
  });

  check("tras el stall el job se puede volver a tomar y fallar normalmente", () => {
    const sim = new Sim.Engine();
    sim.addJob({ id: "f", kind: "fragile", failuresBeforeSuccess: 1 });
    sim.start("f");
    sim.stall();
    assert.ok(sim.start("f"));
    const res = sim.runActive();
    assert.strictEqual(res.status, "retryable");
    assert.strictEqual(sim.jobs.f.attemptsMade, 1);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[6] Escenarios jugables");
/* ------------------------------------------------------------------ */

{
  check("hay dos escenarios y sus jobs son válidos", () => {
    assert.strictEqual(SCENARIOS.length, 2);
    SCENARIOS.forEach((scenario) => {
      assert.ok(scenario.energy > 0);
      assert.ok(scenario.target > 0);
      scenario.jobs.forEach((job) => {
        assert.ok(job.id && job.name && job.error);
        assert.ok(job.kind === "fragile" || job.kind === "poisoned");
      });
    });
  });

  check("el escenario 1 se gana leyendo los errores", () => {
    const sim = playScenario(SCENARIOS[0]);
    assert.strictEqual(sim.score, 260);
    assert.strictEqual(sim.completed.length, 2);
    assert.strictEqual(sim.failed.length, 1);
    assert.strictEqual(sim.energy, 1);
    assert.strictEqual(sim.score >= SCENARIOS[0].target, true);
  });

  check("reintentar el veneno en el escenario 1 baja del objetivo", () => {
    const sim = playScenario(SCENARIOS[0], {
      strategy: () => "retry"
    });
    assert.strictEqual(sim.score < SCENARIOS[0].target, true);
  });

  check("el escenario 2 incluye el stall y se gana con la misma lectura", () => {
    const sim = playScenario(SCENARIOS[1]);
    assert.strictEqual(sim.stats.stalled, 1);
    assert.strictEqual(sim.jobs["fragile-receipt"].stalled, 1);
    assert.strictEqual(sim.score, 360);
    assert.strictEqual(sim.energy, 1);
    assert.strictEqual(sim.score >= SCENARIOS[1].target, true);
  });

  check("el determinismo produce el mismo resultado dos veces", () => {
    const a = playScenario(SCENARIOS[1]);
    const b = playScenario(SCENARIOS[1]);
    assert.deepStrictEqual(a.summary(), b.summary());
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[7] HTML: scripts, canvas, modal y tema");
/* ------------------------------------------------------------------ */

{
  const html = fs.readFileSync(HTML_PATH, "utf8");

  const requiredIds = [
    "board", "overlay", "toast",
    "btnStart", "btnReset", "btnPause", "btnTheme", "btnHelp", "btnHelpClose",
    "hudScore", "hudEnergy", "hudCompleted", "hudFailed", "hudAttempts", "hudTime",
    "scenarioTitle", "scenarioKicker", "scenarioBrief", "scenarioGoal",
    "decisionModal", "decisionTitle", "decisionError", "decisionMeta",
    "btnRetry", "btnAbandon",
    "eventLog", "ladder", "failedTray",
    "observeList", "observeBadge", "help"
  ];

  requiredIds.forEach((id) => {
    check(`el HTML incluye #${id}`, () => {
      assert.ok(html.includes('id="' + id + '"'), "falta id=" + id);
    });
  });

  check("el HTML carga config, motor y escenarios sin build", () => {
    assert.ok(html.includes('<script src="config/retry-config.js"></script>'));
    assert.ok(html.includes('<script src="engine/retry-sim.js"></script>'));
    assert.ok(html.includes('<script src="engine/scenarios-juego-2.js"></script>'));
  });

  check("el juego es autocontenido: no usa fetch", () => {
    assert.ok(!html.includes("fetch("), "el juego no debe depender de fetch");
  });

  check("el canvas declara dimensiones", () => {
    assert.ok(/id="board"\s+width="960"\s+height="560"/.test(html), "canvas sin tamaño");
  });

  check("el canvas se dibuja con una paleta, no con colores literales", () => {
    const jsStart = html.lastIndexOf("<script>");
    const js = html.slice(jsStart, html.indexOf("</script>", jsStart));
    const flat = js.match(/ctx\.(fillStyle|strokeStyle|shadowColor)\s*=\s*"#/g) || [];
    assert.strictEqual(flat.length, 0, "quedan colores literales en el canvas");
    assert.ok(html.includes("var PAL ="), "no hay paleta de canvas");
  });

  check("el tema se persiste y respeta al sistema", () => {
    assert.ok(html.includes('localStorage.getItem("bala-theme")'), "no lee el tema guardado");
    assert.ok(html.includes('localStorage.setItem("bala-theme", t)'), "no persiste el tema");
    assert.ok(html.includes("prefers-color-scheme: dark"), "no respeta el sistema");
  });

  check("el HTML expone el juego para depuración", () => {
    assert.ok(html.includes("window.BalaGame"));
  });

  check("el modal ofrece reintentar y mandar a failed", () => {
    assert.ok(html.includes("data-action=\"retry\""));
    assert.ok(html.includes("data-action=\"abandon\""));
  });
}

console.log("\n----------------------------------------");
console.log("  " + passed + " pasaron, " + failed + " fallaron");
console.log("----------------------------------------");
process.exit(failed > 0 ? 1 : 0);
