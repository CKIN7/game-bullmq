/**
 * Niveles del Juego 1 — Despacho Prioritario.
 *
 * Cuatro niveles sobre el mismo motor:
 *   1. Inversión          — el número MENOR gana (bug real de api-movies).
 *   2. El cero traicionero — priority 0 entra en wait y se drena antes.
 *   3. Hambruna            — la prioridad no interrumpe un job ya activo.
 *   4. Independencia       — dos colas p1 con workers distintos no compiten.
 *
 * Las prioridades (1, 3, 5, 10) y las colas salen del README de api-movies
 * (sección "Async jobs (BullMQ)"); no se inventan valores.
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
      hint: "Ajusta los diales y pulsa Simular.",
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
      hint: "Haz clic en los jobs para predecir el orden y pulsa Simular.",
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
    },
    {
      id: "hambruna",
      number: 3,
      name: "Hambruna",
      kicker: "Nivel 3 · El lote que no suelta el worker",
      mode: "predict",
      queueName: "email-despacho",
      preStep: true,
      mission: "El lote ya ocupa el worker. Predice cuándo sale el job del usuario.",
      intro: [
        "recs-recompute-all (p10) es un lote masivo. Llegó primero, cuando la cola estaba vacía, y el único worker ya lo está ejecutando.",
        "Ahora llega recs-recompute-user (p1): el job que el usuario está esperando. La prioridad solo elige entre jobs EN ESPERA; no puede interrumpir uno activo.",
        "Después entra un segundo lote (p10). Predice el orden completo de activación."
      ],
      jobs: [
        {
          id: "recs-recompute-all-1",
          name: "Recompute all · lote 1",
          type: "recs-batch",
          queue: "recs-recompute-all",
          priority: 10,
          work: 9000,
          editable: false,
          preActivate: true,
          note: "Lote masivo en curso: ocupa el worker durante 9 s."
        },
        {
          id: "recs-recompute-user",
          name: "Recompute user",
          type: "recs-single",
          queue: "recs-recompute-user",
          priority: 1,
          work: 1200,
          editable: false,
          enqueueAfterStart: true,
          note: "Prioridad 1, pero llega cuando el lote ya está activo."
        },
        {
          id: "recs-recompute-all-2",
          name: "Recompute all · lote 2",
          type: "recs-batch",
          queue: "recs-recompute-all",
          priority: 10,
          work: 6000,
          editable: false,
          enqueueAfterStart: true,
          note: "Segundo lote: espera en el ZSET con p10."
        }
      ],
      allowedPriorities: [],
      goal: {
        type: "predict",
        order: ["recs-recompute-all-1", "recs-recompute-user", "recs-recompute-all-2"],
        hint: "El primer lote ya está activo: no se puede adelantar."
      },
      hint: "Haz clic en los jobs para predecir el orden y pulsa Simular.",
      queueNote: "Los tres jobs comparten la cola de prueba <code>bull:email-despacho</code>, pero conservan su cola de origen en api-movies. El lote 1 ya está <b>activo</b> cuando arranca la simulación.",
      lesson: "La prioridad decide qué job sale del ZSET, no qué job se interrumpe. recs-recompute-all-1 ya estaba activo y el worker es uno solo: el usuario espera ~9 s aunque su prioridad sea 1. Cuando el lote termina, el p1 sale antes que el segundo lote p10, que seguía esperando. Un job largo puede provocar hambruna si acapara el worker.",
      observe: [
        "El lote 1 aparece como active ANTES de que lleguen los otros dos jobs.",
        "recompute-user (p1) espera: la prioridad no expropia un job activo.",
        "Al liberarse el worker, el p1 sale antes que el lote 2 (p10).",
        "La barra del Gantt enseña la espera real del job del usuario."
      ],
      source: {
        label: "api-movies README → Async jobs (BullMQ)",
        url: "README.md"
      }
    },
    {
      id: "independencia",
      number: 4,
      name: "Independencia",
      kicker: "Nivel 4 · Dos colas, dos workers",
      mode: "predict",
      queueName: "email-despacho",
      concurrency: 2,
      mission: "Predice qué dos jobs suben a la vez y cuál tiene que esperar.",
      intro: [
        "email-critical y notification-fanout tienen prioridad 1 en api-movies, pero son colas distintas con workers distintos: no compiten entre sí.",
        "El simulador les da dos slots de worker (concurrency 2) para mostrar que ambos suben en el mismo tick. El aviso in-app (p3) espera a que uno se libere.",
        "Predice el orden. Los dos jobs con p1 pueden ir en cualquier orden; lo importante es quién espera."
      ],
      jobs: [
        {
          id: "email-critical-verify",
          name: "Verificación de cuenta",
          type: "email-critical",
          queue: "email-critical",
          priority: 1,
          work: 900,
          editable: false,
          note: "Cola email-critical: worker de email, p1."
        },
        {
          id: "notification-fanout-review",
          name: "Fan-out de reseña",
          type: "notification-fanout",
          queue: "notification-fanout",
          priority: 1,
          work: 900,
          editable: false,
          note: "Cola notification-fanout: otro worker, también p1."
        },
        {
          id: "notification-inapp-welcome",
          name: "Aviso in-app de bienvenida",
          type: "notification-inapp",
          queue: "notification-inapp",
          priority: 3,
          work: 700,
          editable: false,
          note: "p3: espera a que se libere uno de los dos slots."
        }
      ],
      allowedPriorities: [],
      goal: {
        type: "predict",
        order: [
          "email-critical-verify",
          "notification-fanout-review",
          "notification-inapp-welcome"
        ],
        tied: ["email-critical-verify", "notification-fanout-review"],
        hint: "Los dos p1 arrancan juntos: su orden no importa. El p3 espera."
      },
      hint: "Haz clic en los jobs para predecir el orden y pulsa Simular.",
      queueNote: "Para aislar la regla, los tres jobs entran en la cola de prueba <code>bull:email-despacho</code>. Aquí hay <b>dos slots de worker</b> (concurrency 2), que representan los workers independientes de email y notificaciones en api-movies.",
      lesson: "Dos colas con la misma prioridad no compiten: cada una tiene su worker. Con dos slots, email-critical-verify y notification-fanout-review se activan en el mismo tick y avanzan en paralelo; el aviso in-app (p3) espera a que uno termine. La prioridad no crea una fila global entre colas.",
      observe: [
        "Los dos jobs p1 aparecen activos al mismo tiempo.",
        "El orden entre ambos es indiferente: ninguno adelanta al otro.",
        "El p3 no compite: espera a que se libere un slot de worker.",
        "En el Gantt las dos barras p1 se solapan desde el mismo tick."
      ],
      source: {
        label: "api-movies README → Async jobs (BullMQ)",
        url: "README.md"
      }
    }
  ];

  return LEVELS;
});
