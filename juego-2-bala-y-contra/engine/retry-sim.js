/**
 * Núcleo del Juego 2 — Bala y Contra.
 *
 * Modela el contrato de reintentos de BullMQ que usa api-movies:
 *   - attempts: 3
 *   - backoff exponencial con delay base 2000 ms  ->  2 s, 4 s, 8 s
 *   - al tercer fallo el job pasa al conjunto failed (la DLQ de BullMQ)
 *   - removeOnFail: 50 conserva solo los últimos 50 jobs fallidos
 *   - stall check: si el worker muere, el job vuelve a la cola sin gastar intento
 *
 * Es determinista: no usa Math.random ni timers. La UI avanza el reloj con
 * `advance(ms)` y decide con `retry(id)` / `abandon(id)`.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RetrySim = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    attempts: 3,
    backoffDelay: 2000,
    removeOnFail: 50,
    energy: 6
  };

  /** delay × 2^(intento-1): 2 s, 4 s, 8 s. */
  function backoffDelay(attempt, baseDelay) {
    var n = Math.max(1, Math.floor(attempt || 1));
    return Math.max(0, baseDelay || DEFAULTS.backoffDelay) * Math.pow(2, n - 1);
  }

  function RetrySim(options) {
    options = options || {};
    this.attempts = Math.max(1, options.attempts || DEFAULTS.attempts);
    this.baseDelay = Math.max(0, options.backoffDelay != null ? options.backoffDelay : DEFAULTS.backoffDelay);
    this.removeOnFail = Math.max(1, options.removeOnFail || DEFAULTS.removeOnFail);
    this.energy = options.energy != null ? options.energy : DEFAULTS.energy;

    this.jobs = {};
    this.order = [];
    this.pending = [];
    this.active = null;
    this.decision = null;
    this.delayed = [];
    this.completed = [];
    this.failed = [];

    this.time = 0;
    this.score = 0;
    this.stats = {
      attempts: 0,
      retries: 0,
      energySpent: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      stalled: 0
    };
    this.events = [];
  }

  RetrySim.prototype._log = function (kind, jobId, text) {
    this.events.push({ t: this.time, kind: kind, jobId: jobId || null, text: text || "" });
  };

  RetrySim.prototype.addJob = function (spec) {
    spec = spec || {};
    var id = String(spec.id != null ? spec.id : "job-" + (this.order.length + 1));
    if (this.jobs[id]) throw new Error("RetrySim: job duplicado \"" + id + "\"");

    var kind = spec.kind === "poisoned" ? "poisoned" : "fragile";
    var failures = kind === "poisoned"
      ? Infinity
      : Math.max(0, Math.floor(spec.failuresBeforeSuccess != null ? spec.failuresBeforeSuccess : 1));

    var job = {
      id: id,
      name: spec.name || id,
      kind: kind,
      error: spec.error || (kind === "poisoned"
        ? "400 · template inválido"
        : "500 · timeout temporal"),
      failuresBeforeSuccess: failures,
      attempts: Math.max(1, spec.attempts || this.attempts),
      attemptsMade: 0,
      stalled: 0,
      state: "queued",
      readyAt: 0,
      lastDelay: 0
    };

    this.jobs[id] = job;
    this.order.push(id);
    this.pending.push(id);
    this._log("add", id, "encolado · " + kind + " · attempts " + job.attempts);
    return job;
  };

  /** Toma un job de la cola (el que llega a la nave). */
  RetrySim.prototype.start = function (id) {
    if (this.active) return null;
    var job = this.jobs[id];
    if (!job || job.state !== "queued") return null;
    var at = this.pending.indexOf(id);
    if (at >= 0) this.pending.splice(at, 1);
    this.active = id;
    job.state = "active";
    this._log("active", id, "el worker toma el job");
    return job;
  };

  /** Resuelve el intento del job activo. */
  RetrySim.prototype.runActive = function () {
    if (!this.active) return null;
    var job = this.jobs[this.active];
    job.attemptsMade++;
    this.stats.attempts++;

    var ok = job.kind !== "poisoned" && job.attemptsMade > job.failuresBeforeSuccess;

    if (ok) {
      job.state = "completed";
      this.active = null;
      this.completed.push(job.id);
      this.stats.completed++;
      this.score += 100;
      this._log("completed", job.id, "intento " + job.attemptsMade + " OK · completed");
      return { status: "completed", job: job, attempt: job.attemptsMade };
    }

    this._log(
      "failed",
      job.id,
      "intento " + job.attemptsMade + "/" + job.attempts + " · " + job.error
    );

    if (job.attemptsMade >= job.attempts) {
      // El intento terminal también libera el slot del worker: si no, el
      // motor se queda con un job activo fantasma y nunca termina.
      this.active = null;
      this._toFailed(job, "agotó sus " + job.attempts + " intentos");
      this.score += job.kind === "poisoned" ? 20 : -60;
      return {
        status: "failed",
        terminal: true,
        job: job,
        attempt: job.attemptsMade,
        error: job.error
      };
    }

    job.state = "decision";
    this.active = null;
    this.decision = job.id;
    return {
      status: "retryable",
      job: job,
      attempt: job.attemptsMade,
      delay: backoffDelay(job.attemptsMade, this.baseDelay),
      error: job.error
    };
  };

  /**
   * El jugador decide reintentar: cuesta 1 de energía y programa el backoff
   * exponencial. Devuelve { ok, reason, delay }.
   */
  RetrySim.prototype.retry = function (id) {
    var job = this.jobs[id];
    if (!job || job.state !== "decision" || this.decision !== id) {
      return { ok: false, reason: "no hay una decisión pendiente para " + id };
    }
    if (this.energy <= 0) {
      return { ok: false, reason: "sin energía de cola" };
    }

    this.energy--;
    this.stats.energySpent++;
    this.stats.retries++;

    var delay = backoffDelay(job.attemptsMade, this.baseDelay);
    job.lastDelay = delay;
    job.readyAt = this.time + delay;
    job.state = "delayed";
    this.decision = null;
    this.delayed.push({ id: job.id, readyAt: job.readyAt, delay: delay });
    this.delayed.sort(function (a, b) { return a.readyAt - b.readyAt; });
    this._log("backoff", job.id, "reintento programado en " + delay + " ms");
    return { ok: true, delay: delay, energy: this.energy };
  };

  /** El jugador manda el job a failed (la DLQ) sin gastar más intentos. */
  RetrySim.prototype.abandon = function (id) {
    var job = this.jobs[id];
    if (!job || job.state !== "decision" || this.decision !== id) return false;
    this.decision = null;
    this._toFailed(job, "movido a failed por el jugador");
    this.stats.abandoned++;
    // Acertar con un veneno suma; abandonar un frágil recuperable resta.
    this.score += job.kind === "poisoned" ? 60 : -40;
    return true;
  };

  /** Avanza el reloj y devuelve los ids que salieron del backoff. */
  RetrySim.prototype.advance = function (ms) {
    this.time += Math.max(0, ms || 0);
    var ready = [];
    var keep = [];
    for (var i = 0; i < this.delayed.length; i++) {
      var entry = this.delayed[i];
      if (entry.readyAt <= this.time) ready.push(entry);
      else keep.push(entry);
    }
    this.delayed = keep;

    var ids = [];
    for (var k = 0; k < ready.length; k++) {
      var job = this.jobs[ready[k].id];
      if (!job || job.state !== "delayed") continue;
      job.state = "queued";
      this.pending.push(job.id);
      ids.push(job.id);
      this._log("retry", job.id, "vuelve a la cola tras " + ready[k].delay + " ms");
    }
    return ids;
  };

  /**
   * El worker muere con un job activo. El stall check lo devuelve a la cola
   * SIN consumir un intento (attemptsMade no cambia).
   */
  RetrySim.prototype.stall = function () {
    if (!this.active) return null;
    var job = this.jobs[this.active];
    job.state = "queued";
    job.stalled++;
    this.pending.unshift(job.id);
    this.active = null;
    this.stats.stalled++;
    this._log("stalled", job.id, "worker muerto · stall check lo devuelve a la cola (intento intacto)");
    return job;
  };

  RetrySim.prototype._toFailed = function (job, reason) {
    job.state = "failed";
    this.failed.push(job.id);
    this.stats.failed++;
    while (this.failed.length > this.removeOnFail) this.failed.shift();
    this._log("dead", job.id, "failed · " + reason);
  };

  RetrySim.prototype.pendingCount = function () {
    return this.pending.length + (this.active ? 1 : 0) + this.delayed.length +
      (this.decision ? 1 : 0);
  };

  RetrySim.prototype.isDone = function () {
    return this.pendingCount() === 0 && !this.decision;
  };

  RetrySim.prototype.ladder = function () {
    var out = [];
    for (var i = 1; i <= this.attempts; i++) out.push(backoffDelay(i, this.baseDelay));
    return out;
  };

  RetrySim.prototype.summary = function () {
    return {
      time: this.time,
      energy: this.energy,
      score: this.score,
      completed: this.completed.slice(),
      failed: this.failed.slice(),
      pending: this.pendingCount(),
      done: this.isDone(),
      stats: Object.assign({}, this.stats)
    };
  };

  return {
    Engine: RetrySim,
    backoffDelay: backoffDelay,
    DEFAULTS: DEFAULTS
  };
});
