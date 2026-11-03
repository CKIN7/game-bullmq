/**
 * Banco de preguntas del Juego 01 — El Puerto de Redis.
 *
 * Sin build: este archivo se carga con un <script> clásico y también se
 * puede requerir desde Node para validarlo en los tests.
 *
 * Cada pregunta vale +50 puntos si se acierta. La respuesta correcta es
 * el índice dentro de `options`.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PuertoQuiz = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  return [
    {
      title: "Marea tranquila",
      questions: [
        {
          id: "fifo",
          prompt: "factura-urgente tiene priority 1. ¿Por qué se procesó después de email-bienvenida y reporte-diario?",
          options: [
            "Porque priority 1 es menor que priority 0.",
            "Porque la LIST wait se drena completa antes de consultar prioritized.",
            "Porque los jobs con delay pasan siempre primero."
          ],
          answer: 1,
          why: "moveToActive-11.lua hace RPOPLPUSH sobre wait. Solo cuando wait queda vacía consulta el ZSET prioritized con ZPOPMIN. Por eso un priority 0 (sin prioridad) sale antes que un priority 1: la prioridad no salta la cola."
        },
        {
          id: "score-priority",
          prompt: "otp-alta es el primer job priorizado de la oleada. ¿Qué score recibe en el ZSET prioritized?",
          options: [
            "4294967296  (1 × 2³² + 0)",
            "4294967298  (1 × 2³² + 2)",
            "4294967297  (1 × 2³² + 1)"
          ],
          answer: 2,
          why: "getPriorityScore.lua calcula priority × 2³² + contador global. El contador empieza en 1 y desempata por FIFO dentro de la misma prioridad."
        }
      ]
    },
    {
      title: "Dos relojes",
      questions: [
        {
          id: "promotion",
          prompt: "sync-crm nace con delay 2000 ms. ¿Cuándo puede competir por un worker?",
          options: [
            "En cuanto se pulsa Zarpar, porque el delay se ignora.",
            "Solo cuando promoteDelayedJobs detecta que venció el delay y lo mueve a wait o prioritized.",
            "Antes que los jobs de wait, porque tiene priority 0."
          ],
          answer: 1,
          why: "Un job delayed no está ni en wait ni en prioritized. promoteDelayedJobs lo promueve al vencer; si tiene priority > 0 recibe un score NUEVO en el ZSET."
        },
        {
          id: "score-delayed",
          prompt: "sync-crm es el primer job delayed y nace en el tick 0. ¿Qué score recibe en el ZSET delayed?",
          options: [
            "2000000  (2000 × 1000 + 0)",
            "8192001  (2000 × 4096 + 1)",
            "8192000  (2000 × 4096 + 0)"
          ],
          answer: 2,
          why: "getDelayedScore.lua usa timestamp × 4096 + offset. El offset empieza en 0 dentro de cada bucket de timestamp y conserva el FIFO."
        },
        {
          id: "orden-zset",
          prompt: "En prioritized coinciden reauth-token (priority 1), alerta-stock (priority 5) y backup-nocturno (priority 10). ¿En qué orden salen con ZPOPMIN?",
          options: [
            "reauth-token (1) → alerta-stock (5) → backup-nocturno (10).",
            "backup-nocturno (10) → alerta-stock (5) → reauth-token (1).",
            "Da igual el número: desempata el orden de llegada."
          ],
          answer: 0,
          why: "El score es priority × 2³² + contador y ZPOPMIN saca el MENOR score: menor número = más prioridad. 1 va antes que 5, y 10 es la más lenta. El contador solo desempata jobs con la misma prioridad."
        }
      ]
    },
    {
      title: "La trampa del ZSET",
      questions: [
        {
          id: "trap",
          prompt: "pago-urgente tiene priority 1 y en wait hay seis jobs priority 0. ¿Qué ocurre?",
          options: [
            "pago-urgente se procesa primero por tener priority > 0.",
            "Los seis jobs de wait se procesan primero; pago-urgente se activa después.",
            "Se intercalan por orden de llegada entre wait y prioritized."
          ],
          answer: 1,
          why: "La LIST wait se vacía entera con RPOPLPUSH antes de tocar el ZSET. La prioridad solo ordena DENTRO de prioritized; no compite contra wait."
        },
        {
          id: "score-delayed-2",
          prompt: "archive-logs tiene delay 5000 ms y es el primer delayed de la oleada. ¿Qué score recibe?",
          options: [
            "20480000  (5000 × 4096 + 0)",
            "5000000  (5000 × 1000 + 0)",
            "20480001  (5000 × 4096 + 1)"
          ],
          answer: 0,
          why: "El score delayed es timestamp × 4096 + offset. Con el reloj a 0 y el primer offset del bucket, queda 5000 × 4096 = 20480000."
        }
      ]
    }
  ];
});