/**
 * Niveles del Juego 1 — Despacho Prioritario.
 *
 * Núcleo de esta entrega: Inversión (nivel 1) y El cero traicionero (nivel 2).
 * Las prioridades disponibles (1, 3, 5, 10) y las colas salen del README de
 * api-movies (sección "Async jobs (BullMQ)"); no se inventan valores.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DispatchLevels = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LEVELS = [
    {
      id: "inversion",
      number: 1,
      name: "Inversión",
      kicker: "Nivel 1 · El bug clásico",
      mode: "tune",
      queueName: "email-despacho",
      mission: "Consigue el orden: verificación → recibo → newsletter.",
      intro: [
        "En BullMQ el número MENOR se procesa antes. La infraestructura de api-movies tenía las prioridades invertidas: critical: 10 y marketing: 1, así que el newsletter salía antes que la verificación de cuenta.",
        "Ajusta los diales de verificación y newsletter. El recibo está fijado en 5. Pulsa Simular y comprueba el orden real."
      ],
      jobs: [
        {
          id: "critical-verification",
          name: "Verificación de cuenta",
          type: "email-critical",
          queue: "email-critical",
          priority: 10,
          work: 900,
          editable: true,
          note: "El usuario no puede entrar hasta verificar su email."
        },
        {
          id: "transactional-receipt",
          name: "Recibo de compra",
          type: "email-transactional",
          queue: "email-transactional",
          priority: 5,
          work: 900,
          editable: false,
          note: "Fijado en la prioridad real de la cola: 5."
        },
        {
          id: "marketing-newsletter",
          name: "Newsletter semanal",
          type: "email-marketing",
          queue: "email-marketing",
          priority: 1,
          work: 900,
          editable: true,
          note: "Puede esperar: es marketing."
        }
      ],
      allowedPriorities: [1, 3, 5, 10],
      goal: {
        type: "order",
        order: ["critical-verification", "transactional-receipt", "marketing-newsletter"]
      },
      lesson: "El bug no era el motor: era el sentido. Con critical: 10 y marketing: 1, el newsletter (1) salía antes que la verificación (10). La semántica real ordena por el MENOR número: verificación 1, recibo 5, newsletter 10.",
      observe: [
        "El número MENOR gana: 1 se procesa antes que 5, y 5 antes que 10.",
        "Con el bug inicial (crítico 10, marketing 1) el newsletter sale primero.",
        "El recibo está fijado en 5: solo puedes mover verificación y newsletter.",
        "La gráfica de Gantt confirma el mismo orden que la traza de eventos."
      ],
      source: {
        label: "api-movies README → Async jobs (BullMQ)",
        url: "README.md"
      }
    },
    {
      id: "cero",
      number: 2,
      name: "El cero traicionero",
      kicker: "Nivel 2 · Sin prioridad explícita",
      mode: "predict",
      queueName: "email-despacho",
      mission: "Predice el orden de salida y pulsa Simular.",
      intro: [
        "Un job con priority 0 no significa «el más lento»: significa SIN prioridad explícita.",
        "BullMQ lo manda a la LIST wait. moveToActive drena wait ENTERA con RPOPLPUSH antes de mirar el ZSET prioritized con ZPOPMIN.",
        "Haz clic en los jobs en el orden en que crees que saldrán. Después simula y compara."
      ],
      jobs: [
        {
          id: "verification",
          name: "Verificación de cuenta",
          type: "email-critical",
          queue: "email-critical",
          priority: 1,
          work: 800,
          editable: false,
          note: "Prioridad 1: la más alta del ZSET."
        },
        {
          id: "system-note",
          name: "Aviso de sistema",
          type: "notification-inapp",
          queue: "notification-inapp",
          priority: 0,
          work: 700,
          editable: false,
          note: "Lo dejaron en 0: sin prioridad explícita."
        },
        {
          id: "receipt",
          name: "Recibo de compra",
          type: "email-transactional",
          queue: "email-transactional",
          priority: 5,
          work: 900,
          editable: false,
          note: "Prioridad 5: detrás de la verificación."
        }
      ],
      allowedPriorities: [],
      correctOrder: ["system-note", "verification", "receipt"],
      goal: {
        type: "predict",
        order: ["system-note", "verification", "receipt"]
      },
      lesson: "system-note tiene priority 0, así que entró en wait. moveToActive hace RPOPLPUSH sobre wait antes de tocar el ZSET: sale primero aunque su número parezca el más bajo. Después, dentro de prioritized, el menor score gana: 1 (verificación) antes que 5 (recibo).",
      observe: [
        "priority 0 no significa «el más lento»: significa sin prioridad explícita.",
        "El job con priority 0 entra en la LIST wait, no en el ZSET prioritized.",
        "moveToActive drena wait ENTERA antes de consultar prioritized.",
        "Por eso el aviso de sistema sale primero; después gana el menor score del ZSET."
      ],
      source: {
        label: "BullMQ moveToActive-11.lua",
        url: "https://github.com/taskforcesh/bullmq/blob/master/src/commands/moveToActive-11.lua"
      }
    }
  ];

  return LEVELS;
});