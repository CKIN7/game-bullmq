/**
 * Escenarios deterministas del Juego 3 — Cascada.
 *
 * Cada nivel aísla una de las cuatro reglas que el jugador manipula:
 *   N1 la estructura de la cascada de dos etapas
 *   N2 la preferencia del usuario (user_settings.notify_*)
 *   N3 el dedupe_key (UNIQUE user_id + type + dedupe_key) y el INSERT IGNORE
 *   N4 el jobId idempotente (BullMQ ignora un add con un jobId ya usado)
 *
 * `observe` lista lo que el jugador debe ver pasar. Cada item trae el flag
 * del motor que lo dispara, para que la lista se marque sola y no dependa de
 * que el jugador la lea.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CascadeScenarios = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCENARIOS = [
    {
      id: "la-supernova",
      number: 1,
      name: "La supernova",
      kicker: "Nivel 1 · un evento, dos canales",
      target: 140,
      rules: {
        respectPreference: true,
        jobIdStrategy: "porEvento",
        dedupeScope: "porEvento",
        insertIgnore: true
      },
      hint: "El evento entra en notification-fanout; de ahí salen dos ramas.",
      briefing: [
        "Un usuario publica una review. El evento review.published entra en la cola notification-fanout (prioridad 1).",
        "El worker de fan-out lee user_settings y decide los canales: email-transactional (prioridad 5) y notification-inapp (prioridad 3).",
        "La rama in-app termina en un INSERT IGNORE sobre notifications, con la restricción UNIQUE (user_id, type, dedupe_key).",
        "Objetivo: 140 puntos. Ejecuta la cascada completa sin perder nada."
      ],
      events: [
        {
          id: "evt-1",
          type: "review.published",
          entityId: "movie-42",
          actorId: "user-7",
          at: 0,
          recipients: [{ userId: "user-9", notify_email: true, notify_inapp: true }]
        }
      ],
      observe: [
        { id: "o1", text: "El evento review.published entra en notification-fanout.", flag: "fanout" },
        { id: "o2", text: "El fan-out abre dos ramas: email-transactional y notification-inapp.", flag: "branch" },
        { id: "o3", text: "La fila queda en notifications con su dedupe_key.", flag: "delivered" }
      ]
    },
    {
      id: "el-silencio",
      number: 2,
      name: "El silencio",
      kicker: "Nivel 2 · el usuario apagó un canal",
      target: 110,
      rules: {
        respectPreference: true,
        jobIdStrategy: "porEvento",
        dedupeScope: "porEvento",
        insertIgnore: true
      },
      hint: "user-9 tiene notify_email apagado. El fan-out debe respetarlo.",
      briefing: [
        "Mismo evento, pero user-9 tiene notify_email apagado en user_settings: no quiere correos.",
        "El fan-out tiene que leer la preferencia ANTES de encolar el canal de email.",
        "El aviso in-app sí sale, porque notify_inapp está encendido.",
        "Objetivo: 110 puntos. Un correo no solicitado se penaliza."
      ],
      events: [
        {
          id: "evt-1",
          type: "review.published",
          entityId: "movie-42",
          actorId: "user-7",
          at: 0,
          recipients: [{ userId: "user-9", notify_email: false, notify_inapp: true }]
        }
      ],
      observe: [
        { id: "o1", text: "El fan-out lee notify_email antes de encolar el canal.", flag: "respected" },
        { id: "o2", text: "Solo sale la rama in-app.", flag: "branch" },
        { id: "o3", text: "La notificación in-app se entrega igual.", flag: "delivered" }
      ]
    },
    {
      id: "las-gemelas",
      number: 3,
      name: "Las gemelas",
      kicker: "Nivel 3 · dos reviews del mismo usuario",
      target: 230,
      rules: {
        respectPreference: true,
        jobIdStrategy: "porEvento",
        dedupeScope: "porEvento",
        insertIgnore: true
      },
      hint: "El dedupe_key tiene que distinguir una review de otra.",
      briefing: [
        "user-7 publica dos reviews: movie-42 y movie-77. Las dos son para user-9.",
        "Si el dedupe_key solo lleva el user_id, la segunda review choca con la primera y el INSERT IGNORE se come una notificación que sí debía entregarse.",
        "Con INSERT normal (sin IGNORE) el duplicado no se traga: revienta el job contra la restricción UNIQUE.",
        "Objetivo: 230 puntos. Las dos notificaciones tienen que llegar."
      ],
      events: [
        {
          id: "evt-1",
          type: "review.published",
          entityId: "movie-42",
          actorId: "user-7",
          at: 0,
          recipients: [{ userId: "user-9", notify_email: true, notify_inapp: true }]
        },
        {
          id: "evt-2",
          type: "review.published",
          entityId: "movie-77",
          actorId: "user-7",
          at: 800,
          recipients: [{ userId: "user-9", notify_email: true, notify_inapp: true }]
        }
      ],
      observe: [
        { id: "o1", text: "Las dos reviews generan dos ramas in-app distintas.", flag: "delivered" },
        { id: "o2", text: "Un dedupe_key por usuario hace colisión y pierde una notificación.", flag: "dedupeCollision" },
        { id: "o3", text: "Con INSERT normal el duplicado revienta el job.", flag: "failedInsert" }
      ]
    },
    {
      id: "el-eco",
      number: 4,
      name: "El eco",
      kicker: "Nivel 4 · el mismo evento, dos veces",
      target: 270,
      rules: {
        respectPreference: true,
        jobIdStrategy: "porEvento",
        dedupeScope: "porEvento",
        insertIgnore: true
      },
      hint: "El INSERT IGNORE protege la fila. El jobId es lo que protege el correo.",
      briefing: [
        "El API vuelve a emitir la review de movie-42 (emisión 2) y además llega la review de movie-77.",
        "La fila in-app está a salvo por el INSERT IGNORE, pero el correo no: si cada emisión genera un jobId distinto, user-9 recibe dos correos de la misma review.",
        "Un jobId fijo tampoco es la solución: bloquearía la review de movie-77 y perderías esa notificación.",
        "Objetivo: 270 puntos. Ni spam, ni notificaciones perdidas."
      ],
      events: [
        {
          id: "evt-1",
          type: "review.published",
          entityId: "movie-42",
          actorId: "user-7",
          at: 0,
          emission: 1,
          recipients: [{ userId: "user-9", notify_email: true, notify_inapp: true }]
        },
        {
          id: "evt-1",
          type: "review.published",
          entityId: "movie-42",
          actorId: "user-7",
          at: 600,
          emission: 2,
          recipients: [{ userId: "user-9", notify_email: true, notify_inapp: true }]
        },
        {
          id: "evt-2",
          type: "review.published",
          entityId: "movie-77",
          actorId: "user-7",
          at: 1500,
          emission: 1,
          recipients: [{ userId: "user-9", notify_email: true, notify_inapp: true }]
        }
      ],
      observe: [
        { id: "o1", text: "BullMQ ignora el segundo add con el mismo jobId.", flag: "jobIdDedup" },
        { id: "o2", text: "Con un jobId distinto por emisión, el INSERT IGNORE absorbe la fila duplicada.", flag: "duplicateIgnored" },
        { id: "o3", text: "Sin jobId estable, el correo sale dos veces.", flag: "duplicateEmail" },
        { id: "o4", text: "Con jobId fijo, la review de movie-77 se pierde.", flag: "lost" }
      ]
    }
  ];

  return SCENARIOS;
});
