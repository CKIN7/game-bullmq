/**
 * Motor determinista de despacho prioritario de BullMQ.
 *
 * Modela UNA cola (no varias) para aislar el concepto del Juego 1:
 *
 *   priority === 0  -> LIST  wait         (FIFO; se drena ENTERA primero)
 *   priority >  0   -> ZSET  prioritized  (score = priority * 2^32 + counter)
 *
 * moveToActive hace RPOPLPUSH sobre wait antes de tocar el ZSET. Por eso un
 * job con priority 0 sale antes que cualquier job priorizado, aunque su
 * "número" parezca el más bajo.
 *
 * Sin Math.random y sin relojes reales: mismo guion -> mismo orden.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DispatchSim = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PRIORITY_MULT = 0x100000000; // 2^32
  var MAX_PRIORITY = 2097151;      // 2^21 - 1
  var TICK_MS = 100;

  function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sortPrioritized(list) {
    list.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      return a.order - b.order;
    });
    return list;
  }

  /**
   * @param {{queueName?: string, concurrency?: number}} [options]
   */
  function Engine(options) {
    options = options || {};
    this.queue = options.queueName || "movie-jobs";
    this.concurrency = Math.max(1, toInt(options.concurrency, 1));
    this.reset();
  }

  Engine.prototype.reset = function () {
    this.clock = 0;              // ms virtuales
    this.ticks = 0;
    this.counter = 0;            // contador global de prioridad (INCR)
    this.jobs = {};              // id -> job
    this.ids = [];               // ids en orden de creación
    this.wait = [];              // LIST: ids, FIFO (push / shift)
    this.prioritized = [];       // ZSET: { id, priority, score, order }
    this.active = [];            // { id, from, workLeft, total }
    this.completed = [];         // ids
    this.failed = [];            // ids
    this.processingOrder = [];   // ids en el orden en que se activaron
    this.events = [];            // traza didáctica
  };

  Engine.prototype._key = function (name) {
    return "bull:" + this.queue + ":" + name;
  };

  Engine.prototype._log = function (kind, jobId, cmd, note) {
    this.events.push({
      kind: kind,
      jobId: jobId,
      cmd: cmd,
      note: note,
      tick: this.ticks,
      clock: this.clock
    });
  };

  /**
   * Encola un job. Si priority > 0 va al ZSET; si es 0 va a la LIST wait.
   * @param {{id: string, name?: string, type?: string, priority?: number, work?: number}} spec
   */
  Engine.prototype.addJob = function (spec) {
    var id = String(spec.id);
    if (this.jobs[id]) return this.jobs[id];

    var priority = clamp(toInt(spec.priority, 0), 0, MAX_PRIORITY);
    var job = {
      id: id,
      name: spec.name || id,
      type: spec.type || "job",
      priority: priority,
      work: Math.max(TICK_MS, toInt(spec.work, 600)),
      state: priority > 0 ? "prioritized" : "wait",
      score: null,
      order: this.ids.length + 1
    };

    this.jobs[id] = job;
    this.ids.push(id);
    this.counter += 1;

    if (priority > 0) {
      job.score = priority * PRIORITY_MULT + (this.counter % PRIORITY_MULT);
      this.prioritized.push({
        id: id,
        priority: priority,
        score: job.score,
        order: job.order
      });
      sortPrioritized(this.prioritized);
      this._log(
        "add",
        id,
        "ZADD " + this._key("prioritized") + " " + job.score + " " + id,
        "addPrioritizedJob -> prioritized (priority " + priority + ")"
      );
    } else {
      this.wait.push(id);
      this._log(
        "add",
        id,
        "LPUSH " + this._key("wait") + " " + id,
        "addStandardJob -> wait (priority 0: sin prioridad)"
      );
    }

    return job;
  };

  /** Siguiente job: primero la LIST wait completa, después el ZSET. */
  Engine.prototype._next = function () {
    if (this.wait.length) {
      return { id: this.wait.shift(), from: "wait" };
    }
    if (this.prioritized.length) {
      var top = this.prioritized.shift();
      return { id: top.id, from: "prioritized" };
    }
    return null;
  };

  /** Avanza un tick virtual de 100 ms. */
  Engine.prototype.step = function () {
    this.ticks += 1;
    this.clock += TICK_MS;

    // 1. Completar los jobs que terminan este tick.
    var stillActive = [];
    for (var i = 0; i < this.active.length; i++) {
      var entry = this.active[i];
      entry.workLeft -= TICK_MS;

      if (entry.workLeft <= 0) {
        var job = this.jobs[entry.id];
        job.state = "completed";
        this.completed.push(entry.id);
        this._log(
          "complete",
          entry.id,
          "XADD " + this._key("events") + " * event=completed jobId=" + entry.id,
          "completed id=" + entry.id
        );
      } else {
        stillActive.push(entry);
      }
    }
    this.active = stillActive;

    // 2. Despachar hasta concurrency. wait se drena antes que prioritized.
    while (this.active.length < this.concurrency) {
      var next = this._next();
      if (!next) break;

      var nextJob = this.jobs[next.id];
      nextJob.state = "active";
      this.active.push({
        id: next.id,
        from: next.from,
        workLeft: nextJob.work,
        total: nextJob.work
      });
      this.processingOrder.push(next.id);

      if (next.from === "wait") {
        this._log(
          "move",
          next.id,
          "RPOPLPUSH " + this._key("wait") + " " + this._key("active"),
          "moveToActive -> RPOPLPUSH desde wait"
        );
      } else {
        this._log(
          "move",
          next.id,
          "ZPOPMIN " + this._key("prioritized"),
          "moveToActive -> ZPOPMIN del prioritized"
        );
      }
    }

    return this;
  };

  Engine.prototype.isIdle = function () {
    return this.wait.length === 0 &&
      this.prioritized.length === 0 &&
      this.active.length === 0;
  };

  /** Ejecuta hasta vaciar la cola (con un tope de seguridad). */
  Engine.prototype.runToIdle = function (maxTicks) {
    var guard = 0;
    var limit = maxTicks || 1000;
    while (!this.isIdle() && guard < limit) {
      this.step();
      guard += 1;
    }
    return this;
  };

  Engine.prototype.sortedPrioritized = function () {
    return sortPrioritized(this.prioritized.slice());
  };

  /** La cola de un job: LIST wait para priority 0; ZSET en el resto. */
  function zoneFor(spec) {
    var priority = clamp(toInt(spec && spec.priority, 0), 0, MAX_PRIORITY);
    return priority > 0 ? "prioritized" : "wait";
  }

  /** Texto didáctico del score, sin números mágicos. */
  function explainScore(priority, counter) {
    return priority + " x 2^32 + " + (counter % PRIORITY_MULT) +
      " = " + (priority * PRIORITY_MULT + (counter % PRIORITY_MULT));
  }

  return {
    Engine: Engine,
    PRIORITY_MULT: PRIORITY_MULT,
    MAX_PRIORITY: MAX_PRIORITY,
    TICK_MS: TICK_MS,
    zoneFor: zoneFor,
    explainScore: explainScore
  };
});