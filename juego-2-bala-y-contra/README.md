# Juego 2 — Bala y Contra

Bullet-hell didáctico sobre **reintentos y backoff** en BullMQ, derivado de
`api-movies`. Los jobs entran como proyectiles hacia una nave-worker. Cuando un
job falla, el jugador decide entre reintentarlo (gasta energía y espera el
backoff) o mandarlo a `failed`, que es la dead-letter queue real de BullMQ.

Se abre directamente en el navegador: no hay build ni dependencias.

```text
juego-2-bala-y-contra/
├── index.html                  # juego completo (Canvas 2D + DOM)
├── config/
│   ├── retry-config.json       # contrato canónico de reintentos
│   └── retry-config.js         # espejo para el navegador
├── engine/
│   ├── retry-sim.js            # motor determinista de intentos/backoff
│   └── scenarios-juego-2.js    # dos escenarios jugables
└── test-juego-2.js             # arnés de verificación
```

## Qué enseña

| Concepto | Valor real usado |
|---|---|
| `attempts` | `3` |
| `backoff` | `{ type: "exponential", delay: 2000 }` |
| Esperas | `2000 × 2^(intento-1)` → 2 s, 4 s, 8 s |
| Con `attempts: 3` | solo se usan 2 s y 4 s; el hueco de 8 s no llega a usarse |
| `failed` | la DLQ de BullMQ (el conjunto de jobs agotados, no una cola aparte) |
| `removeOnFail` | `50` (se conservan los últimos 50 jobs fallidos) |
| `stalled` | si el worker muere, el stall check devuelve el job a la cola **sin** consumir intento |

Fuente de los valores: `2026-11-02-juegos-aprendizaje-bullmq-repo-api-movies.md`
(sección «Juego 2 — Bala y Contra»), que a su vez cita `config/bullmq.ts` de
`api-movies` y la guía de reintentos de BullMQ
(<https://docs.bullmq.io/guide/retrying-failing-jobs>).

## Cómo se juega

1. Un job llega a la nave y consume un intento.
2. Si falla, se muestra el error real y dos salidas:
   - **Reintentar**: gasta 1 de energía y programa el backoff exponencial.
   - **Mandar a failed**: lo mete en la DLQ sin gastar más intentos.
3. La pista está en el código de error:
   - `429`, `500`, `503` → probablemente transitorio (job **frágil**).
   - `400` → permanente (job **envenenado**): reintentarlo solo quema energía.
4. La energía es compartida. Gastarla en un veneno deja sin margen a los frágiles.
5. El escenario 2 añade un **stall**: la nave muere en pleno intento y el job
   reaparece sin perder el contador de intentos.

## Escenarios

| # | Nombre | Energía | Objetivo | Particularidad |
|---|---|---|---|---|
| 1 | Primer contacto | 4 | 260 pts | 2 frágiles + 1 venenoso |
| 2 | Stall check | 5 | 360 pts | 3 frágiles + 1 venenoso + 1 stall |

Puntuación: `completed` +100 · abandonar un veneno +60 · abandonar un frágil −40 ·
veneno que agota `attempts` +20 · frágil que agota `attempts` −60.

Ruta óptima del escenario 1: frágil de 1 fallo (1 reintento), frágil de 2 fallos
(2 reintentos) y veneno abandonado → 260 pts con 1 de energía.

## Verificación

```powershell
node juego-2-bala-y-contra/test-juego-2.js
```

El arnés comprueba config, escalera de backoff, frágiles/venenosos, energía,
DLQ, `removeOnFail`, stall, los dos escenarios y el contrato del HTML (ids,
scripts, canvas, modal, tema y `window.BalaGame`).

Para inspeccionarlo con las mismas herramientas que usa el juego, `window.BalaGame`
expone `state`, `engine`, `scenarios`, `config`, `setScenario`, `start`, `reset`,
`pause`, `retry`, `abandon`, `step(ms)`, `draw` y `render`.

## Nota de alcance

Esta primera versión usa Canvas 2D y un motor determinista (sin `Math.random`
ni timers). El documento de diseño propone Three.js para la capa visual; queda
como mejora posterior, igual que nuevos escenarios.
