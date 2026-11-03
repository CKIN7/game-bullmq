/**
 * Arnés del Juego 3 — Cascada (fan-out de BullMQ).
 *
 * Verifica:
 *   - config: prioridades 1 / 3 / 5, INSERT IGNORE, UNIQUE (user_id, type,
 *     dedupe_key), preferencias notify_email / notify_inapp
 *   - config.js coincide exactamente con config.json
 *   - NO DERIVA: las prioridades del config siguen al README de api-movies y
 *     al documento de diseño de los juegos
 *   - cascada: evento -> notification-fanout -> canales -> notifications
 *   - preferencia: sin respetar user_settings el correo sale no deseado
 *   - dedupe_key: una clave por usuario traga la segunda notificacion
 *   - INSERT IGNORE absorbe el duplico; INSERT normal revienta el job
 *   - jobId: BullMQ ignora el add repetido (y el jobId es unico POR COLA)
 *   - los cuatro niveles: la partida optima alcanza el objetivo exacto
 *   - determinismo: misma semilla, misma partida
 *   - HTML: scripts, ids, vendor local, sin fetch, tema y window.CascadeGame
 *
 * Ejecutar: node juego-3-cascada/test-juego-3.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const Sim = require("./engine/cascade-sim.js");
const SCENARIOS = require("./engine/scenarios-juego-3.js");
const CONFIG = require("./config/cascade-config.json");
const CONFIG_JS = require("./config/cascade-config.js");

const ROOT = path.join(__dirname, "..");
const HTML_PATH = path.join(__dirname, "index.html");
const README_PATH = path.join(ROOT, "README.md");
const DESIGN_PATH = path.join(ROOT, "2026-11-02-juegos-aprendizaje-bullmq-repo-api-movies.md");
const VENDOR_PATH = path.join(__dirname, "vendor", "three", "three.min.js");

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

/** Juega un escenario con una configuracion de reglas y devuelve el resumen. */
function play(scenario, overrides, seed) {
  const rules = Object.assign({}, scenario.rules, overrides || {});
  const engine = new Sim.Engine({
    config: CONFIG,
    seed: seed == null ? 7 : seed,
    rules
  });
  engine.load(scenario);
  engine.runToIdle();
  engine.finalize();
  return engine;
}

/* ------------------------------------------------------------------ */
console.log("\n[1] Configuración del contrato de cascada");
/* ------------------------------------------------------------------ */

{
  check("notification-fanout tiene prioridad 1", () => {
    const fanout = CONFIG.queues.find((q) => q.name === "notification-fanout");
    assert.ok(fanout);
    assert.strictEqual(fanout.priority, 1);
  });

  check("notification-inapp tiene prioridad 3", () => {
    const inapp = CONFIG.queues.find((q) => q.name === "notification-inapp");
    assert.ok(inapp);
    assert.strictEqual(inapp.priority, 3);
  });

  check("email-transactional tiene prioridad 5", () => {
    const email = CONFIG.queues.find((q) => q.name === "email-transactional");
    assert.ok(email);
    assert.strictEqual(email.priority, 5);
  });

  check("la persistencia usa INSERT IGNORE", () => {
    assert.strictEqual(CONFIG.persistence.insert, "INSERT IGNORE");
  });

  check("la restricción es UNIQUE (user_id, type, dedupe_key)", () => {
    assert.ok(CONFIG.persistence.uniqueConstraint.includes("user_id"));
    assert.ok(CONFIG.persistence.uniqueConstraint.includes("type"));
    assert.ok(CONFIG.persistence.uniqueConstraint.includes("dedupe_key"));
  });

  check("las preferencias son las columnas de user_settings", () => {
    assert.strictEqual(CONFIG.preferences.table, "user_settings");
    assert.deepStrictEqual(CONFIG.preferences.columns, ["notify_email", "notify_inapp"]);
  });

  check("los canales apuntan a las colas reales", () => {
    const email = CONFIG.channels.find((c) => c.id === "email");
    const inapp = CONFIG.channels.find((c) => c.id === "inapp");
    assert.strictEqual(email.queue, "email-transactional");
    assert.strictEqual(email.preference, "notify_email");
    assert.strictEqual(inapp.queue, "notification-inapp");
    assert.strictEqual(inapp.preference, "notify_inapp");
    assert.strictEqual(inapp.persists, true);
  });

  check("ningún jobId canónico contiene ':'", () => {
    const templates = Object.assign(
      {},
      CONFIG.jobIdTemplates,
      CONFIG.persistence.dedupeKeyTemplates,
      { event: CONFIG.event.jobIdTemplate }
    );
    Object.keys(templates).forEach((key) => {
      assert.ok(
        !templates[key].includes(":"),
        "el template " + key + " contiene ':' y BullMQ lo rechaza"
      );
    });
  });

  check("cascade-config.js coincide exactamente con cascade-config.json", () => {
    assert.deepStrictEqual(CONFIG_JS, CONFIG);
  });

  check("la config cita el README y el documento de diseño", () => {
    assert.strictEqual(CONFIG.source.repo, "api-movies");
    assert.ok(CONFIG.source.file.includes("README"));
    assert.ok(CONFIG.source.gameSection.includes("Juego 3"));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[2] No-deriva: el config sigue al README de api-movies");
/* ------------------------------------------------------------------ */

{
  const readme = fs.readFileSync(README_PATH, "utf8");

  const readmePriorities = {};
  readme.split(/\r?\n/).forEach((line) => {
    if (!/^\|\s*`/.test(line)) return;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length);
    if (cells.length !== 3) return;
    const names = [];
    const namePattern = /`([^`]+)`/g;
    let match;
    while ((match = namePattern.exec(cells[0])) !== null) names.push(match[1]);
    const priorities = cells[1].split("/").map((p) => parseInt(p.trim(), 10));
    if (!names.length || priorities.length !== names.length) return;
    if (priorities.some((p) => Number.isNaN(p))) return;
    names.forEach((name, index) => { readmePriorities[name] = priorities[index]; });
  });

  check("el README declara las prioridades de las tres colas del juego", () => {
    ["notification-fanout", "notification-inapp", "email-transactional"].forEach((name) => {
      assert.ok(
        readmePriorities[name] !== undefined,
        "el README no declara la cola " + name
      );
    });
  });

  check("las prioridades del config son las del README", () => {
    CONFIG.queues.forEach((queue) => {
      assert.strictEqual(
        queue.priority,
        readmePriorities[queue.name],
        "la cola " + queue.name + " diverge del README"
      );
    });
  });

  check("el README documenta dedupe_key, notify_* y la restricción unique", () => {
    assert.ok(readme.includes("dedupe_key"));
    assert.ok(readme.includes("notify_"));
    assert.ok(/unique/i.test(readme));
  });

  check("el documento de diseño describe el Juego 3 — Cascada", () => {
    const design = fs.readFileSync(DESIGN_PATH, "utf8");
    assert.ok(design.includes("Juego 3 — Cascada"));
    assert.ok(design.includes("notification-fanout"));
    assert.ok(design.includes("email-transactional"));
    assert.ok(design.includes("notification-inapp"));
    assert.ok(design.includes("INSERT IGNORE"));
    assert.ok(design.includes("dedupe_key"));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[3] La cascada de dos etapas");
/* ------------------------------------------------------------------ */

{
  const level1 = SCENARIOS.find((s) => s.id === "la-supernova");

  check("el evento entra en notification-fanout", () => {
    const engine = play(level1);
    assert.strictEqual(engine.stats.fanouts, 1);
    assert.ok(engine.log.some((e) => e.kind === "add" && e.text.includes("notification-fanout")));
  });

  check("el fan-out abre una rama por canal permitido", () => {
    const engine = play(level1);
    assert.strictEqual(engine.stats.branchJobs, 2);
    assert.ok(engine.log.some((e) => e.text.includes("email-transactional")));
    assert.ok(engine.log.some((e) => e.text.includes("notification-inapp")));
  });

  check("la rama in-app persiste una fila con su dedupe_key", () => {
    const engine = play(level1);
    assert.strictEqual(engine.rows.length, 1);
    assert.strictEqual(engine.rows[0].userId, "user-9");
    assert.strictEqual(engine.rows[0].type, "review.published");
    assert.ok(engine.rows[0].dedupeKey.includes("movie-42"));
  });

  check("la rama email envía el aviso", () => {
    const engine = play(level1);
    assert.strictEqual(engine.stats.emails, 1);
  });

  check("el grafo tiene nodos y enlaces sin referencias colgantes", () => {
    const engine = play(level1);
    const ids = new Set(engine.graph.nodes.map((n) => n.id));
    assert.ok(engine.graph.nodes.length >= 5);
    engine.graph.links.forEach((link) => {
      assert.ok(ids.has(link.from), "enlace con origen inexistente: " + link.from);
      assert.ok(ids.has(link.to), "enlace con destino inexistente: " + link.to);
    });
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[4] Preferencia del usuario");
/* ------------------------------------------------------------------ */

{
  const level2 = SCENARIOS.find((s) => s.id === "el-silencio");

  check("respetando la preferencia no se encola el canal de email", () => {
    const engine = play(level2);
    assert.strictEqual(engine.stats.emails, 0);
    assert.strictEqual(engine.stats.unwantedEmails, 0);
    assert.strictEqual(engine.stats.delivered, 1);
  });

  check("sin respetar la preferencia el correo no deseado se penaliza", () => {
    const engine = play(level2, { respectPreference: false });
    assert.strictEqual(engine.stats.unwantedEmails, 1);
    assert.ok(engine.score < play(level2).score);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[5] dedupe_key e INSERT IGNORE");
/* ------------------------------------------------------------------ */

{
  const level3 = SCENARIOS.find((s) => s.id === "las-gemelas");
  const level4 = SCENARIOS.find((s) => s.id === "el-eco");

  check("con dedupe_key por evento llegan las dos notificaciones", () => {
    const engine = play(level3);
    assert.strictEqual(engine.stats.delivered, 2);
    assert.strictEqual(engine.stats.lost, 0);
  });

  check("un dedupe_key por usuario hace colisión y pierde una notificación", () => {
    const engine = play(level3, { dedupeScope: "porUsuario" });
    assert.strictEqual(engine.stats.delivered, 1);
    assert.strictEqual(engine.stats.lost, 1);
    assert.ok(engine.observed.dedupeCollision);
  });

  check("con INSERT normal el duplicato revienta el job contra UNIQUE", () => {
    const engine = play(level3, { dedupeScope: "porUsuario", insertIgnore: false });
    assert.strictEqual(engine.stats.failed, 1);
    assert.ok(engine.observed.failedInsert);
  });

  check("con INSERT IGNORE el duplico se ignora y el trabajo termina bien", () => {
    // Misma review re-emitida con un jobId distinto: la fila ya existe.
    const engine = play(level4, { jobIdStrategy: "porEmision", insertIgnore: true });
    assert.strictEqual(engine.stats.failed, 0);
    assert.strictEqual(engine.stats.ignored, 1);
    assert.ok(engine.observed.duplicateIgnored);
  });

  check("con INSERT normal el mismo duplico revienta el job contra UNIQUE", () => {
    const engine = play(level4, { jobIdStrategy: "porEmision", insertIgnore: false });
    assert.strictEqual(engine.stats.failed, 1);
    assert.ok(engine.observed.failedInsert);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[6] jobId idempotente");
/* ------------------------------------------------------------------ */

{
  const level4 = SCENARIOS.find((s) => s.id === "el-eco");

  check("un jobId estable absorbe la re-emisión (BullMQ ignora el add)", () => {
    const engine = play(level4);
    assert.strictEqual(engine.stats.duplicateEmails, 0);
    assert.strictEqual(engine.stats.lost, 0);
    assert.ok(engine.observed.jobIdDedup);
  });

  check("un jobId distinto por emisión duplica el correo", () => {
    const engine = play(level4, { jobIdStrategy: "porEmision" });
    assert.strictEqual(engine.stats.duplicateEmails, 1);
    assert.ok(engine.observed.duplicateEmail);
  });

  check("la fila sigue protegida por el INSERT IGNORE aunque el correo se duplique", () => {
    const engine = play(level4, { jobIdStrategy: "porEmision" });
    assert.strictEqual(engine.stats.ignored, 1);
    assert.strictEqual(engine.rows.length, 2);
  });

  check("un jobId fijo bloquea el evento legítimo y pierde la notificación", () => {
    const engine = play(level4, { jobIdStrategy: "fijo" });
    assert.strictEqual(engine.stats.lost, 1);
    assert.ok(engine.observed.lost);
  });

  check("la unicidad del jobId es por cola, no global", () => {
    const engine = play(SCENARIOS[0]);
    const jobIds = engine.jobOrder.map((key) => key.split("|")[0] + "|" + key.split("|")[1]);
    const inapp = jobIds.find((key) => key.startsWith("notification-inapp|"));
    const email = jobIds.find((key) => key.startsWith("email-transactional|"));
    assert.ok(inapp && email);
    assert.strictEqual(
      inapp.split("|")[1],
      email.split("|")[1],
      "el mismo jobId debe poder vivir en dos colas distintas"
    );
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[7] Niveles, objetivos y determinismo");
/* ------------------------------------------------------------------ */

{
  check("hay cuatro niveles con id, numero y briefing", () => {
    assert.strictEqual(SCENARIOS.length, 4);
    SCENARIOS.forEach((scenario) => {
      assert.ok(scenario.id);
      assert.ok(scenario.number);
      assert.ok(scenario.briefing.length >= 3);
      assert.ok(scenario.observe.length >= 3);
      scenario.observe.forEach((item) => {
        assert.ok(item.flag, "cada observación declara el flag del motor");
      });
    });
  });

  check("la partida óptima alcanza el objetivo exacto de cada nivel", () => {
    SCENARIOS.forEach((scenario) => {
      const engine = play(scenario);
      assert.strictEqual(
        engine.score,
        scenario.target,
        "nivel " + scenario.number + ": " + engine.score + " != " + scenario.target
      );
    });
  });

  check("las reglas por defecto son las del contrato del proyecto", () => {
    assert.deepStrictEqual(Sim.DEFAULT_RULES, {
      respectPreference: true,
      jobIdStrategy: "porEvento",
      dedupeScope: "porEvento",
      insertIgnore: true
    });
  });

  check("misma semilla produce la misma partida", () => {
    const level = SCENARIOS[3];
    const a = play(level, {}, 7);
    const b = play(level, {}, 7);
    assert.deepStrictEqual(a.summary(), b.summary());
    assert.deepStrictEqual(
      a.log.map((e) => e.t + "|" + e.kind + "|" + e.text),
      b.log.map((e) => e.t + "|" + e.kind + "|" + e.text)
    );
  });

  check("semillas distintas no cambian la partida (los niveles son deterministas)", () => {
    const level = SCENARIOS[3];
    const a = play(level, {}, 7);
    const b = play(level, {}, 99);
    assert.strictEqual(a.score, b.score);
    assert.strictEqual(a.rows.length, b.rows.length);
  });

  check("setRule cambia la configuración y queda registrado", () => {
    const engine = new Sim.Engine({ config: CONFIG, seed: 7 });
    engine.load(SCENARIOS[0]);
    const result = engine.setRule("respectPreference", false);
    assert.ok(result.ok);
    assert.strictEqual(engine.rules.respectPreference, false);
    assert.ok(engine.log.some((e) => e.kind === "rule"));
  });

  check("el motor exige configuración (no lleva números hardcodeados)", () => {
    assert.throws(() => new Sim.Engine({ seed: 1 }), /config/);
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[8] Contrato del HTML");
/* ------------------------------------------------------------------ */

{
  const html = fs.readFileSync(HTML_PATH, "utf8");

  check("carga Three.js desde el vendor local", () => {
    assert.ok(html.includes('src="vendor/three/three.min.js"'));
    assert.ok(fs.existsSync(VENDOR_PATH));
    assert.ok(fs.statSync(VENDOR_PATH).size > 100 * 1024);
  });

  check("el vendor no viene de un CDN", () => {
    assert.ok(!/https?:\/\/[^"']*three[^"']*\.js/.test(html));
  });

  check("carga config, motor, escenarios y renderizador", () => {
    assert.ok(html.includes('src="config/cascade-config.js"'));
    assert.ok(html.includes('src="engine/cascade-sim.js"'));
    assert.ok(html.includes('src="engine/scenarios-juego-3.js"'));
    assert.ok(html.includes('src="engine/constellation.js"'));
  });

  check("no hace fetch ni red", () => {
    assert.ok(!/fetch\s*\(/.test(html));
    assert.ok(!/XMLHttpRequest/.test(html));
  });

  check("expone window.CascadeGame con la API de inspección", () => {
    assert.ok(html.includes("window.CascadeGame"));
    ["loadScenario", "reset", "step", "start", "setRule", "compare"].forEach((name) => {
      assert.ok(html.includes(name + ":"), "falta CascadeGame." + name);
    });
  });

  check("tiene los controles de reproducción y comparación", () => {
    ["btn-play", "btn-step", "btn-reset", "btn-compare", "btn-help"].forEach((id) => {
      assert.ok(html.includes('id="' + id + '"'), "falta #" + id);
    });
    assert.ok(html.includes('data-speed="1"'));
    assert.ok(html.includes('data-speed="2"'));
    assert.ok(html.includes('data-speed="4"'));
  });

  check("tiene los cuatro controles de regla", () => {
    ["rule-preference", "rule-jobid", "rule-dedupe", "rule-insert"].forEach((id) => {
      assert.ok(html.includes('id="' + id + '"'), "falta #" + id);
    });
  });

  check("tiene los paneles de misión, observaciones y bitácora", () => {
    ["mission-name", "mission-brief", "mission-goal", "observe-list", "event-log", "stage"].forEach((id) => {
      assert.ok(html.includes('id="' + id + '"'), "falta #" + id);
    });
  });

  check("soporta tema claro y oscuro", () => {
    assert.ok(html.includes('data-theme="dark"'));
    assert.ok(html.includes('data-theme="light"'));
    assert.ok(html.includes('id="btn-theme"'));
  });

  check("cada regla cita el archivo del repo que la define", () => {
    ["workers/notificationWorker.ts", "queues/notificationQueue.ts", "jobs/notificationFanoutJob.ts"]
      .forEach((ref) => {
        assert.ok(html.includes(ref), "falta la cita " + ref);
      });
  });
}

/* ------------------------------------------------------------------ */
console.log("\n[9] Renderizador de constelación");
/* ------------------------------------------------------------------ */

{
  const renderer = fs.readFileSync(path.join(__dirname, "engine", "constellation.js"), "utf8");

  check("el renderizador expone una Vista", () => {
    const view = require("./engine/constellation.js");
    assert.ok(view.View);
  });

  check("usa Three.js para nodos, enlaces y fondo estrellado", () => {
    assert.ok(renderer.includes("THREE.Sprite"));
    assert.ok(renderer.includes("THREE.Line"));
    assert.ok(renderer.includes("THREE.Points"));
  });

  check("el renderizador no usa Math.random", () => {
    assert.ok(!/Math\.random\s*\(/.test(renderer));
  });
}

/* ------------------------------------------------------------------ */
console.log("\n" + (failed === 0 ? "TODO OK" : "HAY FALLOS") + ": " + passed + " pasan, " + failed + " fallan\n");
/* ------------------------------------------------------------------ */

process.exit(failed === 0 ? 0 : 1);
