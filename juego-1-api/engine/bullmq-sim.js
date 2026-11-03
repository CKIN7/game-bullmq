/**
 * BullMQSim — motor de simulación determinista de BullMQ v5 sobre Redis.
 *
 * Copia vendorizada del motor del Juego 01 (engine/bullmq-sim.js) para que
 * juego-1-api/ siga siendo autocontenido. Conviene mantener ambos en sincronía.
 *
 * No reproduce la API de Node; reproduce las ESTRUCTURAS y los scripts:
 *   - bull:<q>:wait          LIST  → LPUSH al añadir, RPOPLPUSH al activar
 *   - bull:<q>:prioritized   ZSET  → score = priority × 2^32 + contador global
 *   - bull:<q>:delayed       ZSET  → score = timestamp × 4096 + offset del bucket
 *   - bull:<q>:active        LIST  → lock SET NX PX lockDuration
 *   - bull:<q>:events        STREAM→ XADD de cada transición
 *
 * Regla central de moveToActive-11.lua: primero se drena la lista `wait`
 * COMPLETA (RPOPLPUSH) y solo cuando está vacía se consulta el ZSET con
 * ZPOPMIN. Por eso un job con priority > 0 añadido después de varios jobs
 * sin prioridad se procesa el último.
 *
 * El motor es agnóstico del render: no toca DOM ni Math.random. Dos
 * ejecuciones con el mismo guion producen exactamente los mismos eventos.
 *
 * Uso en navegador:  const q = new BullMQSim.Engine({ concurrency: 2 });
 * Uso en Node:       const { Engine } = require('./engine/bullmq-sim.js');
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BullMQSim = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PRIORITY_MULT = 4294967296; // 2^32
  var DELAY_MULT = 4096;          // 2^12
  var DEFAULT_TICK = 100;         // un tick = 100 ms virtuales
  var MAX_EVENTS = 600;

  function toInt(value, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) ? fallback : n;
  }

  /**
   * Zona de entrada según addStandardJob / addPrioritizedJob / addDelayedJob.
   *   delay > 0            → delayed (aunque tenga priority)
   *   priority > 0         → prioritized
   *   priority === 0       → wait  ("sin prioridad"; sale antes que prioritized
   *                                 porque wait se drena entero primero)
   */
  function zoneFor(spec) {
    spec = spec || {};
    if (toInt(spec.delay, 0) > 0) return 'delayed';
    if (toInt(spec.priority, 0) > 0) return 'prioritized';
    return 'wait';
  }

  function Engine(options) {
    options = options || {};
    this.tickMs = toInt(options.tickMs, DEFAULT_TICK) || DEFAULT_TICK;
    this.concurrency = Math.max(1, toInt(options.concurrency, 2));
    this.lockDuration = Math.max(0, toInt(options.lockDuration, 30000));
    this.maxStalledCount = Math.max(0, toInt(options.maxStalledCount, 1));
    this.attempts = Math.max(1, toInt(options.attempts, 1));
    this.queue = options.queueName || 'q';
    this.listeners = {};
    this.reset();
  }

  /** Nombre completo de la key de Redis, p. ej. bull:puerto:wait. */
  Engine.prototype._key = function (name) {
    return 'bull:' + this.queue + ':' + name;
  };

  /** Deja el store como una instancia de Redis recién arrancada. */
  Engine.prototype.reset = function () {
    this.clock = 0;
    this.tick = 0;

    this.jobs = {};          // id -> job
    this.order = [];         // ids en orden de creación
    this.wait = [];          // LIST: orden de salida (FIFO)
    this.prioritized = [];   // ZSET: { id, score, priority, seq }
    this.delayed = [];       // ZSET: { id, score, at }
    this.active = [];        // LIST: { id, worker, workLeft, total }
    this.completed = [];     // ids
    this.failed = [];        // ids
    this.events = [];        // stream de eventos
    this.processingOrder = []; // ids en el orden en que se activaron

    this.counters = {
      job: 0,
      priority: 0,
      bucket: {}             // timestamp -> offset dentro del bucket
    };
    return this;
  };

  /* ------------------------------------------------------------------ */
  /* Eventos                                                             */
  /* ------------------------------------------------------------------ */

  Engine.prototype.on = function (name, fn) {
    if (typeof fn !== 'function') return this;
    (this.listeners[name] || (this.listeners[name] = [])).push(fn);
    return this;
  };

  Engine.prototype.emit = function (name, payload) {
    var list = this.listeners[name];
    if (!list) return this;
    for (var i = 0; i < list.length; i++) {
      list[i](payload);
    }
    return this;
  };

  Engine.prototype._log = function (kind, jobId, cmd, text) {
    var event = {
      t: this.clock,
      tick: this.tick,
      kind: kind,
      jobId: jobId || null,
      cmd: cmd || '',
      text: text || ''
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.emit('event', event);
    return event;
  };

  /* ------------------------------------------------------------------ */
  /* Altas                                                               */
  /* ------------------------------------------------------------------ */

  Engine.prototype.addJob = function (spec) {
    spec = spec || {};
    var id = spec.id != null ? String(spec.id) : String(++this.counters.job);
    if (this.jobs[id]) {
      throw new Error('BullMQSim: job duplicado "' + id + '"');
    }

    var priority = Math.max(0, toInt(spec.priority, 0));
    var delay = Math.max(0, toInt(spec.delay, 0));
    var work = Math.max(0, toInt(spec.work, 1000));

    var job = {
      id: id,
      name: spec.name || ('job-' + id),
      priority: priority,
      delay: delay,
      work: work,
      attempts: Math.max(1, toInt(spec.attempts, this.attempts)),
      willFail: !!spec.willFail,
      blockLoop: !!spec.blockLoop,
      state: 'waiting',
      score: null,
      at: null,
      enqueuedAt: this.clock,
      attemptsMade: 0,
      attemptsStarted: 0,
      stalled: 0,
      lockExpiresAt: null,
      lockRenewAt: null
    };

    this.jobs[id] = job;
    this.order.push(id);

    if (delay > 0) {
      // getDelayedScore: timestamp × 4096 + offset del bucket (FIFO dentro del mismo ms)
      var ts = this.clock + delay;
      var offset = this.counters.bucket[ts] || 0;
      this.counters.bucket[ts] = offset + 1;
      var delayedScore = ts * DELAY_MULT + offset;
      job.score = delayedScore;
      job.at = ts;
      job.state = 'delayed';
      this.delayed.push({ id: id, score: delayedScore, at: ts });
      this._log(
        'add',
        id,
        'ZADD ' + this._key('delayed') + ' ' + delayedScore + ' ' + id,
        'delayed id=' + id + ' score=' + delayedScore +
          ' (ts ' + ts + ' × 4096 + ' + offset + ')'
      );
    } else if (priority > 0) {
      // addPrioritizedJob: score = priority × 2^32 + contador global (INCR)
      var counter = ++this.counters.priority;
      var priorityScore = priority * PRIORITY_MULT + (counter % PRIORITY_MULT);
      job.score = priorityScore;
      job.state = 'prioritized';
      this.prioritized.push({
        id: id,
        score: priorityScore,
        priority: priority,
        seq: counter
      });
      this._log(
        'add',
        id,
        'ZADD ' + this._key('prioritized') + ' ' + priorityScore + ' ' + id,
        'prioritized id=' + id + ' score=' + priorityScore +
          ' (p' + priority + ' × 2³² + ' + counter + ')'
      );
    } else {
      // addStandardJob: LPUSH wait; el worker hace RPOPLPUSH desde el otro extremo
      this.wait.push(id);
      job.state = 'waiting';
      this._log(
        'add',
        id,
        'LPUSH ' + this._key('wait') + ' ' + id,
        'waiting id=' + id + ' (priority 0 → LIST)'
      );
    }

    this.emit('add', job);
    return job;
  };

  /* ------------------------------------------------------------------ */
  /* Lecturas ordenadas                                                  */
  /* ------------------------------------------------------------------ */

  Engine.prototype.sortedPrioritized = function () {
    return this.prioritized.slice().sort(function (a, b) {
      return a.score - b.score || a.seq - b.seq;
    });
  };

  Engine.prototype.sortedDelayed = function () {
    return this.delayed.slice().sort(function (a, b) {
      return a.score - b.score;
    });
  };

  Engine.prototype.isIdle = function () {
    return this.wait.length === 0 &&
      this.prioritized.length === 0 &&
      this.delayed.length === 0 &&
      this.active.length === 0;
  };

  Engine.prototype.pendingCount = function () {
    return this.wait.length + this.prioritized.length +
      this.delayed.length + this.active.length;
  };

  /* ------------------------------------------------------------------ */
  /* Transiciones                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * promoteDelayedJobs:
   *   ZRANGEBYSCORE delayed 0 (timestamp+1)*0x1000-1
   * Los que vencen pasan a wait (LPUSH) o a prioritized (ZADD con un
   * contador NUEVO, no conservan el score de delayed).
   */
  Engine.prototype._promoteDelayed = function () {
    var limit = (this.clock + 1) * DELAY_MULT - 1;
    var ready = this.sortedDelayed().filter(function (entry) {
      return entry.score <= limit;
    });
    if (!ready.length) return 0;

    var readyIds = {};
    for (var i = 0; i < ready.length; i++) readyIds[ready[i].id] = true;
    this.delayed = this.delayed.filter(function (entry) {
      return !readyIds[entry.id];
    });

    for (var j = 0; j < ready.length; j++) {
      var entry = ready[j];
      var job = this.jobs[entry.id];

      if (job.priority > 0) {
        var counter = ++this.counters.priority;
        var score = job.priority * PRIORITY_MULT + (counter % PRIORITY_MULT);
        job.score = score;
        job.state = 'prioritized';
        this.prioritized.push({
          id: job.id,
          score: score,
          priority: job.priority,
          seq: counter
        });
        this._log(
          'promote',
          job.id,
          'ZADD ' + this._key('prioritized') + ' ' + score + ' ' + job.id,
          'promoteDelayed id=' + job.id + ' → prioritized score=' + score
        );
      } else {
        job.state = 'waiting';
        this.wait.push(job.id);
        this._log(
          'promote',
          job.id,
          'LPUSH ' + this._key('wait') + ' ' + job.id,
          'promoteDelayed id=' + job.id + ' → wait (prev=delayed)'
        );
      }
      this.emit('promote', job);
    }
    return ready.length;
  };

  /** moveToActive: RPOPLPUSH wait primero; ZPOPMIN prioritized solo si wait está vacía. */
  Engine.prototype._nextJob = function () {
    if (this.wait.length > 0) {
      var waitId = this.wait.shift();
      this._log(
        'move',
        waitId,
        'RPOPLPUSH ' + this._key('wait') + ' ' + this._key('active'),
        'wait → active id=' + waitId + '  (FIFO gana)'
      );
      return waitId;
    }

    if (this.prioritized.length > 0) {
      var head = this.sortedPrioritized()[0];
      this.prioritized = this.prioritized.filter(function (entry) {
        return entry.id !== head.id;
      });
      this._log(
        'move',
        head.id,
        'ZPOPMIN ' + this._key('prioritized'),
        'prioritized → active id=' + head.id + '  score=' + head.score
      );
      return head.id;
    }

    return null;
  };

  Engine.prototype._finish = function (entry) {
    var job = this.jobs[entry.id];
    job.attemptsMade++; // HINCRBY attemptsMade 1 en moveToFinished

    var maxAttempts = job.attempts;
    if (job.willFail && job.attemptsMade < maxAttempts) {
      // moveToDelayed con backoff exponencial (mínimo 1 s)
      var backoff = Math.min(1000 * Math.pow(2, job.attemptsMade - 1), 8000);
      var ts = this.clock + backoff;
      var offset = this.counters.bucket[ts] || 0;
      this.counters.bucket[ts] = offset + 1;
      var score = ts * DELAY_MULT + offset;
      job.score = score;
      job.at = ts;
      job.state = 'delayed';
      this.delayed.push({ id: job.id, score: score, at: ts });
      this._log(
        'fail',
        job.id,
        'ZADD ' + this._key('delayed') + ' ' + score + ' ' + job.id,
        'failed id=' + job.id + ' → retry en ' + backoff + 'ms (atm=' +
          job.attemptsMade + '/' + maxAttempts + ')'
      );
      this.emit('retry', job);
      return;
    }

    if (job.willFail) {
      job.state = 'failed';
      this.failed.push(job.id);
      this._log(
        'fail',
        job.id,
        'XADD ' + this._key('events') + ' * event=failed jobId=' + job.id,
        'failed id=' + job.id + '  (atm=' + job.attemptsMade + ')'
      );
      this.emit('fail', job);
      return;
    }

    job.state = 'completed';
    this.completed.push(job.id);
    this._log(
      'complete',
      job.id,
      'XADD ' + this._key('events') + ' * event=completed jobId=' + job.id,
      'completed id=' + job.id + '  (atm=' + job.attemptsMade + ')'
    );
    this.emit('complete', job);
  };

  /**
   * checkStalledJobs: un job con blockLoop no renueva el lock, este expira
   * y moveStalledJobsToWait-9.lua lo devuelve a wait (o lo falla si stc >
   * maxStalledCount). En el juego 01 no se usa; queda para los siguientes.
   */
  Engine.prototype._checkStalled = function () {
    if (this.lockDuration <= 0 || this.active.length === 0) return 0;
    var clock = this.clock;
    var active = this.active;
    var jobs = this.jobs;
    var expired = active.filter(function (entry) {
      var job = jobs[entry.id];
      return job.blockLoop && clock > job.lockExpiresAt;
    });
    if (!expired.length) return 0;

    var expiredIds = {};
    for (var i = 0; i < expired.length; i++) expiredIds[expired[i].id] = true;
    this.active = active.filter(function (entry) {
      return !expiredIds[entry.id];
    });

    for (var j = 0; j < expired.length; j++) {
      var entry = expired[j];
      var job = jobs[entry.id];
      job.stalled++;
      if (job.stalled > this.maxStalledCount) {
        job.state = 'failed';
        this.failed.push(job.id);
        this._log(
          'fail',
          job.id,
          'XADD ' + this._key('events') + ' * event=failed jobId=' + job.id,
          'stalled id=' + job.id + ' stc=' + job.stalled +
            ' > maxStalledCount=' + this.maxStalledCount +
            ' → FAILED (job stalled more than allowable limit)'
        );
        this.emit('fail', job);
      } else {
        job.state = 'waiting';
        this.wait.unshift(job.id);
        this._log(
          'stall',
          job.id,
          'XADD ' + this._key('events') + ' * event=stalled jobId=' + job.id,
          'stalled id=' + job.id + ' stc=' + job.stalled + ' → devuelto a wait'
        );
        this.emit('stall', job);
      }
    }
    return expired.length;
  };

  /* ------------------------------------------------------------------ */
  /* Reloj                                                               */
  /* ------------------------------------------------------------------ */

  Engine.prototype.step = function () {
    if (this.isIdle()) return false;

    this.clock += this.tickMs;
    this.tick++;

    this._promoteDelayed();

    // Avanzar el trabajo en curso.
    var stillActive = [];
    for (var i = 0; i < this.active.length; i++) {
      var entry = this.active[i];
      var job = this.jobs[entry.id];
      entry.workLeft -= this.tickMs;

      if (entry.workLeft <= 0) {
        this._finish(entry);
        continue;
      }

      // Renovación del lock a lockDuration/2 (salvo que el processor bloquee).
      if (!job.blockLoop && this.lockDuration > 0 && this.clock >= job.lockRenewAt) {
        job.lockRenewAt = this.clock + this.lockDuration / 2;
        job.lockExpiresAt = this.clock + this.lockDuration;
        this._log(
          'lock',
          job.id,
          'PEXPIRE ' + this._key(job.id + ':lock') + ' ' + this.lockDuration,
          'renueva lock id=' + job.id + '  PX ' + this.lockDuration
        );
        this.emit('lock', job);
      }

      stillActive.push(entry);
    }
    this.active = stillActive;

    this._checkStalled();

    // Despachar hasta concurrency.
    var activeCount = this.active.length;
    while (activeCount < this.concurrency) {
      var nextId = this._nextJob();
      if (!nextId) break;

      var nextJob = this.jobs[nextId];
      nextJob.state = 'active';
      nextJob.attemptsStarted++; // HINCRBY attemptsStarted 1
      nextJob.lockRenewAt = this.clock + this.lockDuration / 2;
      nextJob.lockExpiresAt = this.clock + this.lockDuration;

      this.active.push({
        id: nextId,
        worker: activeCount,
        workLeft: nextJob.work,
        total: nextJob.work
      });
      this.processingOrder.push(nextId);

      this._log(
        'active',
        nextId,
        'SET ' + this._key(nextId + ':lock') + ' PX ' + this.lockDuration + ' NX',
        'activo id=' + nextId + '  (ats=' + nextJob.attemptsStarted + ')'
      );
      this.emit('active', nextJob);
      activeCount++;
    }

    this.emit('tick', this);
    return true;
  };

  /** Ejecuta hasta drenar la cola. Devuelve cuántos ticks consumió. */
  Engine.prototype.runToIdle = function (maxTicks) {
    var limit = maxTicks || 100000;
    var ticks = 0;
    while (!this.isIdle() && ticks < limit) {
      this.step();
      ticks++;
    }
    return { ticks: ticks, idle: this.isIdle() };
  };

  /** Vista serializable para pintar el estado sin exponer referencias internas. */
  Engine.prototype.snapshot = function () {
    return {
      clock: this.clock,
      tick: this.tick,
      wait: this.wait.slice(),
      prioritized: this.sortedPrioritized(),
      delayed: this.sortedDelayed(),
      active: this.active.map(function (entry) {
        return {
          id: entry.id,
          worker: entry.worker,
          workLeft: entry.workLeft,
          total: entry.total
        };
      }),
      completed: this.completed.slice(),
      failed: this.failed.slice(),
      processingOrder: this.processingOrder.slice(),
      jobs: this.jobs,
      idle: this.isIdle(),
      counters: {
        priority: this.counters.priority,
        bucket: Object.assign({}, this.counters.bucket)
      }
    };
  };

  return {
    Engine: Engine,
    zoneFor: zoneFor,
    PRIORITY_MULT: PRIORITY_MULT,
    DELAY_MULT: DELAY_MULT,
    TICK_MS: DEFAULT_TICK
  };
});
