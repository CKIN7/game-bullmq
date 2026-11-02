/**
 * Guion determinista del Juego 01 — El Puerto de Redis.
 *
 * Cada job declara exactamente lo que declara un `queue.add()`:
 *   priority: 0 → LIST wait ; priority > 0 → ZSET prioritized
 *   delay > 0   → ZSET delayed (tenga la prioridad que tenga)
 *
 * `work` es el tiempo virtual del processor en ms (1 tick = 100 ms).
 * Las oleadas están pensadas para que el orden real contradiga la intuición:
 * la prioridad no adelanta a los jobs que ya están en `wait`.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PuertoWaves = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  return [
    {
      name: "Marea tranquila",
      jobs: [
        { id: "1", name: "email-bienvenida", priority: 0, delay: 0, work: 1400 },
        { id: "2", name: "reporte-diario", priority: 0, delay: 0, work: 900 },
        { id: "3", name: "otp-alta", priority: 1, delay: 0, work: 700 },
        { id: "4", name: "webhook-limpieza", priority: 0, delay: 4000, work: 1200 },
        { id: "5", name: "factura-urgente", priority: 1, delay: 0, work: 600 }
      ],
      lesson: "factura-urgente (priority 1) se procesó DESPUÉS de email-bienvenida y reporte-diario (priority 0). No es un bug: moveToActive-11.lua drena la LIST wait completa con RPOPLPUSH antes de tocar el ZSET con ZPOPMIN. La prioridad no salta la cola."
    },
    {
      name: "Dos relojes",
      jobs: [
        { id: "1", name: "pago-recurrente", priority: 0, delay: 0, work: 1100 },
        { id: "2", name: "pdf-factura", priority: 0, delay: 0, work: 800 },
        { id: "3", name: "alerta-stock", priority: 5, delay: 0, work: 600 },
        { id: "4", name: "sync-crm", priority: 0, delay: 2000, work: 900 },
        { id: "5", name: "reauth-token", priority: 1, delay: 0, work: 500 },
        { id: "6", name: "backup-nocturno", priority: 10, delay: 0, work: 700 },
        { id: "7", name: "purga-cache", priority: 0, delay: 0, work: 400 }
      ],
      lesson: "sync-crm nació delayed: no está ni en wait ni en prioritized hasta que promoteDelayedJobs lo mueve. Si el job promovido tiene priority > 0, recibe un score NUEVO en el ZSET: el contador de delayed no se conserva."
    },
    {
      name: "La trampa del ZSET",
      jobs: [
        { id: "1", name: "conciliar-banco", priority: 0, delay: 0, work: 900 },
        { id: "2", name: "generar-nomina", priority: 0, delay: 0, work: 800 },
        { id: "3", name: "enviar-recibos", priority: 0, delay: 0, work: 700 },
        { id: "4", name: "limpiar-tmp", priority: 0, delay: 0, work: 500 },
        { id: "5", name: "refrescar-cache", priority: 0, delay: 0, work: 600 },
        { id: "6", name: "indexar-busqueda", priority: 0, delay: 0, work: 1000 },
        { id: "7", name: "pago-urgente", priority: 1, delay: 0, work: 400 },
        { id: "8", name: "archive-logs", priority: 0, delay: 5000, work: 600 }
      ],
      lesson: "pago-urgente (priority 1) tuvo que esperar a los seis jobs de wait. El ZSET prioritized ni se consulta hasta que la LIST está vacía. La prioridad solo ordena DENTRO del ZSET; no compite contra wait."
    }
  ];
});
