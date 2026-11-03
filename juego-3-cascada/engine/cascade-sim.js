/**
 * Núcleo del Juego 3 — Cascada.
 *
 * Modela el fan-out en dos etapas que usa api-movies:
 *   - Etapa 1: el evento de dominio (review.published) entra en la cola
 *     `notification-fanout` (prioridad 1).
 *   - Etapa 2: el worker de fan-out lee `user_settings.notify_email` /
 *     `notify_inapp` y encola un job por canal:
 *       · email  -> `email-transactional`  (prioridad 5)
 *       · in-app -> `notification-inapp`   (prioridad 3)
 *   - La fila in-app se persiste en `notifications` con INSERT IGNORE y la
 *     restriccion UNIQUE (user_id, type, dedupe_key): si la fila ya existe,
 *     el INSERT IGNORE no inserta nada y el trabajo termina bien.
 *
 * Reglas que el jugador manipula (el motor no decide por el):
 *   - respectPreference: respetar `user_settings.notify_*`
 *   - jobIdStrategy:    porEvento | porEmision | fijo
 *   - dedupeScope:      porEvento | porUsuario | fijo
 *   - insertIgnore:     INSERT IGNORE | INSERT normal
 *
 * El motor es AGNOSTICO del render: no toca el DOM, no usa Math.random y no
 * usa timers. El reloj avanza con `step()` / `advance(ms)` y las decisiones
 * se aplican con `setRule()`. Dos ejecuciones con la misma semilla producen
 * exactamente los mismos eventos.
 *
 * Uso en navegador:  const sim = new CascadeSim.Engine({ config: CascadeConfig });
 * Uso en Node:       const { Engine } = require('./engine/cascade-sim.js');
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CascadeSim = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Reglas por defecto: la configuracion que el proyecto usa de verdad
   * (respeta la preferencia, jobId por evento, dedupe_key por evento e
   * INSERT IGNORE). El jugador parte de aqui y puede empeorarlo.
   */
  var DEFAULT_RULES = {
    respectPreference: true,
    jobIdStrategy: "porEvento",
    dedupeScope: "porEvento",
    insertIgnore: true
  };

  /** Capas de la constelacion (posicion X en la escena 3D). */
  var LAYER_X = {
    event: -10,
    fanout: -3.5,
    channel: 3.5,
    sink: 10
  };

  /** PRNG determinista (mulberry32). Nada de Math.random. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function Engine(options) {
    options = options || {};
    if (!options.config) {
      throw new Error("CascadeSim: falta `config` (usa config/cascade-config.json)");
    }

    this.config = options.config;
    this.tickMs = this.config.timing.tickMs;
    this.seed = options.seed != null ? options.seed : 1;

    this.rules = Object.assign({}, DEFAULT_RULES, options.rules || {});
    this.scenario = null;
    this.reset();
  }

  /* ------------------------------------------------------------------ */
  /* Ciclo de vida                                                      */
  /* ------------------------------------------------------------------ */

  /** Carga un escenario y deja el motor en su estado inicial. */
  Engine.prototype.load = function (scenario) {
    this.scenario = scenario;
    this.reset();
    return this;
  };

  /** Vuelve al estado inicial con la MISMA semilla y las reglas actuales. */
  Engine.prototype.reset = function () {
    this.rng = mulberry32(this.seed);
    this.time = 0;
    this.tick = 0;
    this.score = 0;
    this.seq = 0;

    this.domainEvents = [];   // eventos de dominio por llegar
    this.emitted = [];        // eventos ya emitidos
    this.emissionSeq = 0;     // contador global de emisiones (jobId "porEmision")
    this.jobs = {};           // clave "cola|jobId" -> job
    this.jobOrder = [];       // claves en orden de creacion
    this.queues = {};         // nombre -> { name, priority, pending, active }
    this.rows = [];           // filas de `notifications`
    this.rowIndex = {};       // clave UNIQUE -> fila
    this.sentEmails = {};     // "user|tipo|entidad" -> true
    this.log = [];            // bitacora para el panel de la UI
    this.observed = {};       // banderas para la lista de observaciones
    this.stats = {
      fanouts: 0,
      branchJobs: 0,
      delivered: 0,
      emails: 0,
      duplicateEmails: 0,
      unwantedEmails: 0,
      ignored: 0,
      jobIdDedup: 0,
      lost: 0,
      failed: 0
    };

    this.graph = { nodes: [], links: [] };
    this.nodeIndex = {};
    this.linkIndex = {};

    var self = this;
    this.config.queues.forEach(function (queue) {
      self.queues[queue.name] = {
        name: queue.name,
        priority: queue.priority,
        worker: queue.worker,
        pending: [],
        active: null
      };
    });

    if (this.scenario) {
      var events = this.scenario.events || [];
      this.domainEvents = events.map(function (event, index) {
        return {
          id: event.id || ("evt-" + (index + 1)),
          type: event.type || self.config.event.name,
          entityId: event.entityId || "entidad",
          actorId: event.actorId || "actor",
          at: event.at != null ? event.at : 0,
          emission: event.emission != null ? event.emission : 1,
          recipients: (event.recipients || []).map(function (recipient) {
            return {
              userId: recipient.userId,
              // Mismos nombres que las columnas de user_settings.
              notify_email: !!recipient.notify_email,
              notify_inapp: !!recipient.notify_inapp
            };
          })
        };
      });
      this.domainEvents.sort(function (a, b) {
        return a.at - b.at;
      });
    }

    return this;
  };

  /* ------------------------------------------------------------------ */
  /* Bitacora y grafo                                                    */
  /* ------------------------------------------------------------------ */

  Engine.prototype._log = function (kind, text, extra) {
    var entry = Object.assign(
      { t: this.time, tick: this.tick, kind: kind, text: text || "" },
      extra || {}
    );
    this.log.push(entry);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    return entry;
  };

  Engine.prototype._node = function (id, layer, kind, label, sub, state) {
    if (this.nodeIndex[id]) return this.nodeIndex[id];
    var node = {
      id: id,
      layer: layer,
      kind: kind,
      label: label,
      sub: sub || "",
      state: state || "pending",
      x: LAYER_X[layer],
      y: 0,
      // El jitter se sortea una sola vez al crear el nodo: la constelacion
      // es estable aunque el layout se recalcule en cada tick.
      jitter: (this.rng() - 0.5) * 0.6,
      born: this.time
    };
    this.graph.nodes.push(node);
    this.nodeIndex[id] = node;
    return node;
  };

  Engine.prototype._link = function (from, to, kind, state) {
    var id = from + "->" + to;
    if (this.linkIndex[id]) return this.linkIndex[id];
    var link = { id: id, from: from, to: to, kind: kind, state: state || "pending" };
    this.graph.links.push(link);
    this.linkIndex[id] = link;
    return link;
  };

  /**
   * Distribuye las estrellas de una capa en Y sin solaparse. El jitter sale
   * del PRNG con semilla: misma semilla, misma constelacion.
   */
  Engine.prototype._layout = function () {
    var counts = {};
    var self = this;
    this.graph.nodes.forEach(function (node) {
      counts[node.layer] = (counts[node.layer] || 0) + 1;
    });
    var seen = {};
    this.graph.nodes.forEach(function (node) {
      seen[node.layer] = (seen[node.layer] || 0) + 1;
      var total = counts[node.layer];
      var spread = 8.5;
      var step = total > 1 ? spread / (total - 1) : 0;
      var base = total > 1 ? -spread / 2 : 0;
      var jitter = node.jitter != null ? node.jitter : 0;
      node.y = base + step * (seen[node.layer] - 1) + jitter;
    });
  };

  /* ------------------------------------------------------------------ */
  /* Reglas                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Cambia una regla en caliente. Solo afecta a los jobs que todavia no se
   * han procesado: por eso el juego pide Reiniciar para comparar de verdad.
   */
  Engine.prototype.setRule = function (key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_RULES, key)) {
      return { ok: false, reason: "regla desconocida: " + key };
    }
    var previous = this.rules[key];
    this.rules[key] = value;
    this._log("rule", "regla " + key + ": " + previous + " -> " + value, { rule: key });
    return { ok: true, key: key, value: value, previous: previous };
  };

  Engine.prototype.resetRules = function () {
    this.rules = Object.assign({}, DEFAULT_RULES);
    this._log("rule", "reglas restauradas al contrato del proyecto");
    return this.rules;
  };

  Engine.prototype.rulesSnapshot = function () {
    return Object.assign({}, this.rules);
  };

  /* ------------------------------------------------------------------ */
  /* Encolado                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * `queue.add(job)`. BullMQ ignora el alta si el jobId ya existe EN ESA
   * COLA (la unicidad del jobId es por cola, no global).
   */
  Engine.prototype._addJob = function (queueName, jobId, jobName, payload, work) {
    var queue = this.queues[queueName];
    if (!queue) throw new Error("CascadeSim: cola desconocida " + queueName);

    var key = queueName + "|" + jobId;
    if (this.jobs[key]) {
      // El bonus se cobra UNA vez por evento absorbido, no una por canal:
      // lo cuenta quienAbsorbe (see _branch / _emitFanout).
      this.stats.jobIdDedup++;
      this._log(
        "dedup",
        "BullMQ ignora el add: jobId ya usado en " + queueName + " (" + jobId + ")",
        { jobId: jobId, queue: queueName }
      );
      return { ok: false, ignored: true, jobId: jobId, queue: queueName, existing: this.jobs[key] };
    }

    var job = {
      id: jobId,
      key: key,
      queue: queueName,
      name: jobName,
      payload: payload,
      work: work,
      remaining: work,
      state: "queued",
      born: this.time
    };
    this.jobs[key] = job;
    this.jobOrder.push(key);
    queue.pending.push(key);
    this._log("add", "encolado en " + queueName + " · " + jobId, {
      jobId: jobId,
      queue: queueName
    });
    return { ok: true, job: job };
  };

  /* ------------------------------------------------------------------ */
  /* Reloj                                                              */
  /* ------------------------------------------------------------------ */

  /** Avanza un tick. Devuelve true mientras quede trabajo pendiente. */
  Engine.prototype.step = function () {
    this.time += this.tickMs;
    this.tick++;

    this._emitDomainEvents();
    this._dispatch();
    this._work();
    this._layout();

    return this.pendingCount() > 0 || this.domainEvents.length > 0;
  };

  Engine.prototype.advance = function (ms) {
    var ticks = Math.max(0, Math.round((ms || 0) / this.tickMs));
    for (var i = 0; i < ticks; i++) {
      if (!this.step()) break;
    }
    return this;
  };

  /** Ejecuta hasta que no queda nada por hacer. */
  Engine.prototype.runToIdle = function (maxTicks) {
    var limit = maxTicks || 2000;
    var ticks = 0;
    while (ticks < limit) {
      if (!this.step()) break;
      ticks++;
    }
    this._layout();
    return { ticks: ticks, idle: this.pendingCount() === 0 };
  };

  Engine.prototype.pendingCount = function () {
    var total = this.domainEvents.length;
    var names = Object.keys(this.queues);
    for (var i = 0; i < names.length; i++) {
      var queue = this.queues[names[i]];
      total += queue.pending.length + (queue.active ? 1 : 0);
    }
    return total;
  };

  Engine.prototype.isDone = function () {
    return this.pendingCount() === 0;
  };

  /* ------------------------------------------------------------------ */
  /* Etapa 0: eventos de dominio                                        */
  /* ------------------------------------------------------------------ */

  Engine.prototype._emitDomainEvents = function () {
    while (this.domainEvents.length && this.domainEvents[0].at <= this.time) {
      var event = this.domainEvents.shift();
      event.seq = ++this.emissionSeq;
      this.emitted.push(event);
      this._emitFanout(event);
    }
  };

  /** El evento entra en `notification-fanout` (prioridad 1). */
  Engine.prototype._emitFanout = function (event) {
    var template = this.config.event.jobIdTemplate;
    var jobId = template
      .replace("<movieId>", event.entityId)
      .replace("<reviewerId>", event.actorId);
    if (event.emission > 1) jobId += "-" + event.emission;

    var eventNode = this._node(
      "evt:" + event.id + ":" + event.emission,
      "event",
      "event",
      event.type,
      event.entityId + (event.emission > 1 ? " · emision " + event.emission : ""),
      "ok"
    );

    var fanoutNode = this._node(
      "fanout:" + jobId,
      "fanout",
      "fanout",
      this.config.event.queue,
      "prioridad " + this.queues[this.config.event.queue].priority,
      "pending"
    );

    var added = this._addJob(
      this.config.event.queue,
      jobId,
      this.config.event.jobName,
      { eventId: event.id, emission: event.emission },
      this.config.timing.fanoutCost
    );

    if (!added.ok) {
      fanoutNode.state = "warn";
      fanoutNode.sub = "jobId ya usado";
      this._link(eventNode.id, fanoutNode.id, "blocked", "warn");
      // El evento ni siquiera entra al fan-out: queda absorbido entero.
      this.score += this.config.scoring.jobIdDeduplicated;
      this.observed.jobIdDedup = true;
      return;
    }

    this._link(eventNode.id, fanoutNode.id, "enqueue", "pending");
    this.observed.fanout = true;
  };

  /** Identificador del nodo de canal (estable por canal + usuario + entidad). */
  Engine.prototype._channelNodeId = function (payload) {
    return (
      "chan:" + payload.channel + ":" + payload.userId + ":" +
      payload.entityId + ":" + payload.emission
    );
  };

  /* ------------------------------------------------------------------ */
  /* Despacho: una instancia de worker por cola                         */
  /* ------------------------------------------------------------------ */

  Engine.prototype._dispatch = function () {
    var self = this;
    var names = Object.keys(this.queues).sort(function (a, b) {
      // Menor prioridad numerica = sale antes (dentro de su propia cola).
      return self.queues[a].priority - self.queues[b].priority;
    });

    names.forEach(function (name) {
      var queue = self.queues[name];
      if (queue.active || !queue.pending.length) return;
      var key = queue.pending.shift();
      var job = self.jobs[key];
      job.state = "active";
      job.started = self.time;
      queue.active = key;
      self._log("active", "worker toma " + name + " · " + job.id, {
        jobId: job.id,
        queue: name
      });
    });
  };

  Engine.prototype._work = function () {
    var self = this;
    var names = Object.keys(this.queues);
    names.forEach(function (name) {
      var queue = self.queues[name];
      if (!queue.active) return;
      var job = self.jobs[queue.active];
      job.remaining -= self.tickMs;

      if (job.remaining > 0) return;

      queue.active = null;
      job.state = "completed";
      self._log("complete", "job completado en " + name + " · " + job.id, {
        jobId: job.id,
        queue: name
      });
      self._finish(job);
    });
  };

  /* ------------------------------------------------------------------ */
  /* Etapa 1: el fan-out reparte entre canales                           */
  /* ------------------------------------------------------------------ */

  Engine.prototype._finish = function (job) {
    if (job.queue === this.config.event.queue) this._finishFanout(job);
    else if (job.payload && job.payload.channel === "inapp") this._finishInapp(job);
    else if (job.payload && job.payload.channel === "email") this._finishEmail(job);
  };

  Engine.prototype._finishFanout = function (job) {
    var event = this._findEvent(job.payload);
    if (!event) return;

    this.stats.fanouts++;
    var fanoutNode = this.nodeIndex["fanout:" + job.id];
    if (fanoutNode) fanoutNode.state = "ok";

    var self = this;
    event.recipients.forEach(function (recipient) {
      self._branch(recipient, event, job);
    });
  };

  Engine.prototype._findEvent = function (payload) {
    for (var i = 0; i < this.emitted.length; i++) {
      if (this.emitted[i].id === payload.eventId &&
          this.emitted[i].emission === payload.emission) {
        return this.emitted[i];
      }
    }
    return null;
  };

  /** Decide los canales de un destinatario y encola un job por canal. */
  Engine.prototype._branch = function (recipient, event, fanoutJob) {
    var self = this;
    var allowed = this.rules.respectPreference;

    var channels = this.config.channels.filter(function (channel) {
      if (!allowed) return true;
      return recipient[channel.preference];
    });

    if (!channels.length) {
      this._log(
        "silence",
        recipient.userId + " tiene los canales apagados · no se encola nada",
        { userId: recipient.userId }
      );
      this.observed.respected = true;
      return;
    }

    channels.forEach(function (channel) {
      var jobId = self._channelJobId(channel, recipient, event);
      var added = self._addJob(
        channel.queue,
        jobId,
        "notification:" + channel.id,
        {
          eventId: event.id,
          emission: event.emission,
          userId: recipient.userId,
          channel: channel.id,
          entityId: event.entityId,
          type: self.config.persistence.type
        },
        channel.id === "email" ? self.config.timing.emailCost : self.config.timing.channelCost
      );

      if (!added.ok) {
        var existingJob = added.existing;
        var sameEntity = existingJob &&
          existingJob.payload &&
          existingJob.payload.entityId === event.entityId;

        var nodeId = self._channelNodeId({
          channel: channel.id,
          userId: recipient.userId,
          entityId: event.entityId,
          emission: event.emission
        });

        if (sameEntity) {
          // Misma review re-emitida: el jobId estable la absorbe. Es el
          // comportamiento correcto y NO es una perdida.
          if (!event.dedupScored) {
            event.dedupScored = true;
            self.score += self.config.scoring.jobIdDeduplicated;
            self.observed.jobIdDedup = true;
          }
          var absorbed = self._node(
            nodeId, "channel", "channel", channel.id,
            recipient.userId + " · duplicado absorbido", "warn"
          );
          self._link("fanout:" + fanoutJob.id, absorbed.id, "dedup", "warn");
          return;
        }

        // Otra review con el mismo jobId (jobId fijo): la notificacion
        // legitima se queda sin procesar. Se penaliza UNA vez por
        // destinatario, no una por canal: es la misma notificacion.
        if (!event.lostScored) event.lostScored = {};
        if (!event.lostScored[recipient.userId]) {
          event.lostScored[recipient.userId] = true;
          self.stats.lost++;
          self.score += self.config.scoring.notificationLost;
        }
        self.observed.lost = true;
        var blocked = self._node(
          nodeId, "channel", "channel", channel.id,
          recipient.userId + " · bloqueado por jobId", "danger"
        );
        blocked.state = "danger";
        self._link("fanout:" + fanoutJob.id, blocked.id, "blocked", "danger");
        return;
      }

      self.stats.branchJobs++;
      self.observed.branch = true;
      var node = self._node(
        self._channelNodeId({
          channel: channel.id,
          userId: recipient.userId,
          entityId: event.entityId,
          emission: event.emission
        }),
        "channel",
        "channel",
        channel.id,
        recipient.userId + " · " + channel.queue,
        "pending"
      );
      self._link("fanout:" + fanoutJob.id, node.id, "branch", "pending");

      if (!allowed && channel.id === "email" && !recipient.notify_email) {
        self._log(
          "warn",
          "aviso: se encoló email a " + recipient.userId + " aunque notify_email está apagado",
          { userId: recipient.userId }
        );
      }
    });
  };

  /**
   * jobId del job de canal. La unicidad del jobId es POR COLA: el mismo
   * jobId puede vivir a la vez en email-transactional y en notification-inapp.
   */
  Engine.prototype._channelJobId = function (channel, recipient, event) {
    var template = this.config.jobIdTemplates[this.rules.jobIdStrategy];
    var jobId = template
      .replace("<movieId>", event.entityId)
      .replace("<userId>", recipient.userId);
    if (this.rules.jobIdStrategy === "porEmision") {
      jobId = jobId.replace("<n>", String(event.seq));
    }
    return jobId;
  };

  /* ------------------------------------------------------------------ */
  /* Etapa 2a: persistencia in-app (INSERT IGNORE + dedupe_key)          */
  /* ------------------------------------------------------------------ */

  Engine.prototype._finishInapp = function (job) {
    var payload = job.payload;
    var dedupeKey = this._dedupeKey(payload);
    var unique = payload.userId + "|" + payload.type + "|" + dedupeKey;

    var sink = this._node(
      "row:" + payload.userId + ":" + payload.entityId + ":" + payload.emission,
      "sink",
      "row",
      "notifications",
      dedupeKey,
      "pending"
    );

    var existing = this.rowIndex[unique];
    if (!existing) {
      var row = {
        userId: payload.userId,
        type: payload.type,
        dedupeKey: dedupeKey,
        entityId: payload.entityId
      };
      this.rows.push(row);
      this.rowIndex[unique] = row;
      this.stats.delivered++;
      this.score += this.config.scoring.notificationDelivered;
      this.observed.delivered = true;
      sink.state = "ok";
      this._link(this._channelNodeId(payload), sink.id, "persist", "ok");
      this._log(
        "persist",
        "INSERT IGNORE en notifications · " + payload.userId + " · dedupe_key " + dedupeKey,
        { userId: payload.userId, dedupeKey: dedupeKey }
      );
      return;
    }

    // La fila ya existe: aqui decide el INSERT IGNORE.
    var sameEntity = existing.entityId === payload.entityId;

    if (!this.rules.insertIgnore) {
      // INSERT normal contra la restriccion UNIQUE: el job revienta.
      this.stats.failed++;
      this.stats.lost++;
      this.score += this.config.scoring.notificationLost;
      this.observed.failedInsert = true;
      this.observed.lost = true;
      sink.state = "danger";
      sink.sub = "duplicate key · job fallido";
      this._link(this._channelNodeId(payload), sink.id, "failed", "danger");
      this._log(
        "failed",
        "INSERT contra UNIQUE (user_id, type, dedupe_key) viola la restriccion · el job falla",
        { userId: payload.userId, dedupeKey: dedupeKey }
      );
      return;
    }

    if (sameEntity) {
      // Duplicado real (el mismo evento llego dos veces): el INSERT IGNORE
      // no inserta nada y el trabajo termina bien. Esto es lo correcto.
      this.stats.ignored++;
      this.score += this.config.scoring.duplicateIgnored;
      this.observed.duplicateIgnored = true;
      sink.state = "warn";
      sink.sub = "duplicado ignorado";
      this._link(this._channelNodeId(payload), sink.id, "ignored", "warn");
      this._log(
        "ignored",
        "INSERT IGNORE: la fila ya existia (misma review) · no se inserta nada",
        { userId: payload.userId, dedupeKey: dedupeKey }
      );
      return;
    }

    // Colision: el dedupe_key no distingue dos entidades distintas, asi que
    // el INSERT IGNORE se come la notificacion que si debia entregarse.
    this.stats.lost++;
    this.score += this.config.scoring.notificationLost;
    this.observed.dedupeCollision = true;
    this.observed.lost = true;
    sink.state = "danger";
    sink.sub = "colision · notificacion tragada";
    this._link(this._channelNodeId(payload), sink.id, "swallowed", "danger");
    this._log(
      "collision",
      "colision de dedupe_key: " + dedupeKey + " ya identifica a otra review · la notificacion se pierde",
      { userId: payload.userId, dedupeKey: dedupeKey }
    );
  };

  Engine.prototype._dedupeKey = function (payload) {
    var template = this.config.persistence.dedupeKeyTemplates[this.rules.dedupeScope];
    return template
      .replace("<movieId>", payload.entityId)
      .replace("<userId>", payload.userId);
  };

  /* ------------------------------------------------------------------ */
  /* Etapa 2b: correo (no lo protege el INSERT IGNORE)                   */
  /* ------------------------------------------------------------------ */

  Engine.prototype._finishEmail = function (job) {
    var payload = job.payload;
    var sink = this._node(
      "mail:" + payload.userId + ":" + payload.entityId + ":" + payload.emission,
      "sink",
      "mail",
      "email-transactional",
      payload.userId,
      "pending"
    );

    var unique = payload.userId + "|" + payload.type + "|" + payload.entityId;
    if (this.sentEmails[unique]) {
      // El INSERT IGNORE protege la fila, pero el correo ya salio.
      this.stats.duplicateEmails++;
      this.score += this.config.scoring.emailDuplicate;
      this.observed.duplicateEmail = true;
      sink.state = "danger";
      sink.sub = "correo duplicado";
      this._link(this._channelNodeId(payload), sink.id, "spam", "danger");
      this._log(
        "spam",
        "correo duplicado a " + payload.userId + " · el INSERT IGNORE no protege el email",
        { userId: payload.userId }
      );
      return;
    }

    this.sentEmails[unique] = true;

    var recipient = this._findRecipient(payload);
    if (recipient && !recipient.notify_email) {
      this.stats.unwantedEmails++;
      this.score += this.config.scoring.emailUnwanted;
      this.observed.unwantedEmail = true;
      sink.state = "danger";
      sink.sub = "no lo pidio";
      this._link(this._channelNodeId(payload), sink.id, "unwanted", "danger");
      this._log(
        "unwanted",
        "correo a " + payload.userId + ", que tiene notify_email apagado",
        { userId: payload.userId }
      );
      return;
    }

    this.stats.emails++;
    this.score += this.config.scoring.emailDelivered;
    sink.state = "ok";
    this._link(this._channelNodeId(payload), sink.id, "send", "ok");
    this._log("sent", "correo enviado a " + payload.userId, { userId: payload.userId });
  };

  Engine.prototype._findRecipient = function (payload) {
    for (var i = 0; i < this.emitted.length; i++) {
      var event = this.emitted[i];
      for (var j = 0; j < event.recipients.length; j++) {
        if (event.recipients[j].userId === payload.userId) return event.recipients[j];
      }
    }
    return null;
  };

  /* ------------------------------------------------------------------ */
  /* Cierre                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Bonus de nivel: se concede solo si no hubo spam, ni correos no deseados
   * ni notificaciones perdidas.
   */
  Engine.prototype.finalize = function () {
    var clean =
      this.stats.duplicateEmails === 0 &&
      this.stats.unwantedEmails === 0 &&
      this.stats.lost === 0;
    if (clean) {
      this.score += this.config.scoring.levelBonus;
      this.observed.clean = true;
      this._log("bonus", "nivel limpio: +" + this.config.scoring.levelBonus + " puntos");
    }
    this._layout();
    return this;
  };

  Engine.prototype.summary = function () {
    return {
      time: this.time,
      tick: this.tick,
      score: this.score,
      stats: Object.assign({}, this.stats),
      rows: this.rows.length,
      emails: Object.keys(this.sentEmails).length,
      observed: Object.assign({}, this.observed),
      rules: this.rulesSnapshot(),
      done: this.isDone()
    };
  };

  return {
    Engine: Engine,
    DEFAULT_RULES: DEFAULT_RULES,
    LAYER_X: LAYER_X,
    mulberry32: mulberry32
  };
});
