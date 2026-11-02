# Juegos de aprendizaje para la infraestructura BullMQ

> **Tipo:** Propuesta · **Estado:** Pendiente de decisión · **Fecha:** 2026-11-02

Catálogo de formas de aprender la infraestructura de colas implementada en HU-13 (BullMQ + Redis)
mediante juegos interactivos en `public/`, reutilizando el motor real del proyecto como fuente de
verdad para no enseñar una semántica distinta a la del código.

---

## Contexto

HU-13 (`features/hu-13-bullmq-job-queue.md`) ya está implementada en sus cuatro fases. Lo que
existe hoy:

| Pieza | Ubicación | Qué define |
|--------|-----------|------------|
| Configuración de BullMQ | `config/bullmq.ts` | 7 colas con prioridad, `defaultJobOptions`, limiter, concurrencias, timeouts, cron, ventana de dedupe |
| Factory de colas | `queues/queueFactory.ts` | `createQueue()`, `allQueues`, `closeAllQueues()` |
| Productores | `queues/emailQueue.ts`, `queues/notificationQueue.ts`, `queues/recommendationQueue.ts` | `jobId` idempotente, guard de `:` en `jobId`, `withTimeout` best-effort, dedupe por ventana |
| Workers | `workers/baseWorker.ts` + 3 specialised | 1 worker por cola, concurrencia, limiter, `completed`/`failed`/`error`/`stalled`, graceful shutdown |
| Handlers | `jobs/*.ts` | Envío de email, fan-out con preferencias, recompute por lotes con `updateProgress` |
| Observabilidad | `api.ts:203-209` | Bull Board en `/admin/queues` (hoy sin protección en producción) |
| Proceso | `ecosystem.config.js` | 5 apps PM2 con `kill_timeout` 30 s / 60 s |

El problema: esa infraestructura tiene semántica no intuitiva y **el proyecto ya Cometió el error
más clásico de BullMQ**. En `fixes/bullmq-f1-corrections.md` se documenta que las prioridades
estaban invertidas (`critical: 10`, `marketing: 1`) porque **en BullMQ el número menor se procesa
primero** y el `0` significa "sin prioridad explícita", que se procesa *antes* que cualquier job
priorizado. El defecto no rompía nada hasta que existió un worker real consumiendo las colas. Hoy
`__tests__/unit/queueFactory.test.ts` protege ese orden.

Ese es exactamente el tipo de conocimiento que un juego puede transferir mejor que un documento:
la prioridad invertida es obvia cuando se ve una cinta transportadora sacando primero el correo de
marketing, e indescartable cuando solo se lee una tabla.

---

## Objetivo

- Que el equipo (y quien entre al repo) aprenda la semántica **real** de la infraestructura de
  colas mirando, no leyendo.
- Que el juego no pueda enseñar lo que el código no hace: los parámetros del simulador se derivan
  de `config/bullmq.ts` y un test falla si divergen.
- Que cada juego sea repetible: misma semilla, mismo resultado, y comparación A/B de dos
  configuraciones.

## Alcance

### Incluye

- Catálogo de 7 juegos, con mecánica, tecnología y concepto objetivo.
- Un motor de simulación compartido (scheduler, reintentos, limiter, dedupe, fan-out) reutilizable
  por todos los juegos.
- Procedimiento para derivar la configuración del simulador del código real.
- Plan de fases, criterios de aceptación y riesgos.

### No incluye

- Cambios en el runtime de la API, en los workers o en el contrato HTTP.
- Cualquier dependencia nueva en `dependencies` de producción. Three.js, si se usa, va en
  `devDependencies` y se sirve como vendor estático desde `public/vendor/`.
- Modos que escapen de la convención de `cross-cutting/frontend-lab-guideline.md`
  (`?demo=1` / `?lab=1`).

---

## Principios de diseño

1. **Fidelidad al código antes que a los valores.** Ningún número hardcodeado en un juego. Todo sale
   de `config/bullmq.ts` mediante un artefacto generado y verificado por test.
2. **Determinismo.** PRNG con semilla explícita. `?demo=1` parte siempre del mismo estado y nunca
   hace red, igual que exige la guía de laboratorios para el modo demo.
3. **Repetir y comparar.** Todo juego ofrece *Reiniciar* (misma semilla), *Avanzar paso a paso*,
   control de velocidad (1× / 2× / 4×) y *Comparar* (correr dos configuraciones en paralelo).
4. **Cada concepto lleva su cita.** Cada regla del simulador muestra el archivo del repo que la
   define, para que el juego sea puerta de entrada al código y no sustituto.
5. **Sin build.** Todo vive en `public/` y se sirve con `express.static('public')`
   (`api.ts:104`). HTML + JS de módulos ES nativos + `<canvas>`; Three.js solo si el concepto lo
   pide.
6. **Modo laboratorio opcional.** `?demo=1` simula; `?lab=1` puede contrastar contra el backend
   real (Redis, Bull Board) siguiendo la guía de laboratorios.

---

## Catálogo de juegos

| # | Juego | Concepto BullMQ objetivo | Motor |
|---|-------|---------------------------|-------|
| 1 | **Despacho Prioritario** | Prioridad de cola, sentido invertido, `0` = sin prioridad, no competencia entre colas | 2D canvas |
| 2 | **Bala y Contra** (bullet hell) | `attempts`, backoff exponencial, `failed` como DLQ, `stalled` | **Three.js** |
| 3 | **Cascada** | Fan-out en dos etapas, `notify_email`, `INSERT IGNORE`, dedupe por `dedupe_key` | **Three.js** |
| 4 | **Apagón** | Fail-open del encolado, `withTimeout` 3 s, `201` conservado, recuperación por `/auth/resend` | 2D DOM |
| 5 | **El Turno** | Concurrencia, limiter **por cola** (no global), `worker.close()` vs kill, `kill_timeout` | 2D canvas / Three.js |
| 6 | **El Reloj** | `upsertJobScheduler` idempotente, TZ, lotes de 25, `updateProgress`, fallo parcial vs sistémico | **Three.js** |
| 7 | **Isla Idempotencia** (puzle) | `jobId` único, `:` prohibido, dedupe por ventana de 60 s, `removeOnComplete/Fail` | 2D DOM |

Los juegos 1, 4 y 7 son HTML/CSS/JS puro y no necesitan nada 3D. El 2, el 3 y el 6 sí, porque el
concepto es espacial o de flujo.

---

### Juego 1 — Despacho Prioritario

**Qué enseña.** En BullMQ la prioridad ordena jobs **dentro** de una cola, no entre colas. El
número menor se procesa antes. El `0` significa "sin prioridad explícita" y sale **antes** que
cualquier priorizado. El proyecto usa `1`, `3`, `5` y `10`, y ninguna cola usa `0`
(`config/bullmq.ts`, `fixes/bullmq-f1-corrections.md`).

**Mecánica.** Pantalla con las 7 colas como lanes y un extractor que toma siempre el job del lane de
menor número. El jugador ajusta el dial de prioridad de cada lane y tiene deadlines visibles
("el email de verificación sale antes de los 30 s o el usuario se va"). Al pulsar **Simular**, el
juego ejecuta la extracción con la semántica real (la del código, no la del jugador) y contrasta
el resultado.

**Niveles.**

1. *Inversión* — reproducir el estado previo al fix: el jugador learns que `critical: 10` sale
   después de `marketing: 1`.
2. *El cero traicionero* — un job sin prioridad explícita (`0`) adelanta a todos.
3. *Hambruna* — `recs-recompute-all` (10) con lote masivo puede retrasar `recs-recompute-user` (1).
4. *Independence* — dos colas con prioridad 1 no compiten entre sí; suben jobs a la vez.

**Por qué es el primero.** Es el bug que el proyecto ya cometió, y el más barato de construir: no
necesita más que un canvas y la lista de prioridades.

---

### Juego 2 — Bala y Contra (bullet hell)

**Qué enseña.** `attempts: 3` con `backoff: { type: 'exponential', delay: 2000 }`. Un job que
falla espera 2 s, luego 4 s, luego 8 s. Al tercer fallo queda en `failed` con
`removeOnFail: 50` — la "dead letter queue" de BullMQ no es un concepto aparte, es el conjunto
`failed`. Y el *stall check* devuelve a la cola el job cuyo worker murió.

**Mecánica.** Los jobs entran por la derecha hacia tu nave-worker. Un job *frágil* falla una o dos
veces y después pasa (un 500 temporal de Resend). Un job *envenenado* falla siempre (template
inválido, 400). El jugador decide en cada fallo: reintentar o mover a `failed`. Los reintentos
consumen un recurso compartido (la "energía de cola"), así que gastar los 3 intentos en un job
envenenado te deja sin margen para los frágiles.

**Extra.** Al mover un job a `failed` aparece el dilema real: se puede reencolar a mano con un
`jobId` nuevo (lo que hace el script de recompute) o abandonarlo.

**Tecnología.** Three.js: los jobs son proyectiles, el backoff se ve como una cuenta atrás
visible, y el conjunto `failed` se representa como un osario físico al que caen los jobs. Es el
juego con mayor retorno sensorial y el que mejor muestra por qué un backoff exponencial no es un
"sleep fijo".

---

### Juego 3 — Cascada

**Qué enseña.** El fan-out en dos etapas implementado en F3: `review.published` entra en
`notification-fanout` (prioridad 1); ese worker lee `user_settings.notify_email` y decide canales;
el aviso de email sale por `email-transactional` (prioridad 5) y la notificación persistida por
`notification-inapp` (prioridad 3). La persistencia es idempotente por `INSERT IGNORE` y la
restricción `UNIQUE (user_id, type, dedupe_key)`.

**Mecánica.** Una constelación: cada evento es una estrella que bifurcará hacia los canales
candidatos. El jugador activa o desactiva la regla "respetar preferencia del usuario" y observa
cómo cambia el árbol. Con la regla mal puesta, aparecen notificaciones duplicadas (dos nodos con
el mismo `dedupe_key`), que son penalizadas: el juego enseña que la deduplicación es lo que
impide el spam.

**Tecnología.** Three.js con estética de constelación; alternativa viable en 2D con layout
jerárquico por capas (evento → fan-out → canal), que es más legible y más barata.

---

### Juego 4 — Apagón

**Qué enseña.** El contrato fail-open. Si Redis no responde, el encolado se corta a los 3 s
(`withTimeout` en `utils/withTimeout.ts`, `emailEnqueueTimeoutMs = 3000`), el error se loguea y el
request **sigue devolviendo `201`**: el usuario queda registrado y la recuperación es
`POST /auth/resend`. El proyecto también documenta el error de compartir una instancia de `ioredis`
entre colas y workers: `MaxListenersExceededWarning` y un `error` no capturado
("Connection is closed") al cerrarlo (`config/bullmq.ts`, `fixes/register-atomicity.md`).

**Mecánica.** Simulación de `POST /auth/register` en una ciudad bajo apagón. El jugador elige
cuándo cortar Redis. Cuando ocurre, debe decidir la política de la API entre tres: **cuelgar**
(el request nunca responde), **fallar** (`500` al usuario) o **responder `201`** y perder solo el
correo. La partida se puntúa contra el contrato real del proyecto, no contra la intuición: la
respuesta correcta es `201` + log de error, y el juego enseña a soltar ese correo.

**Nivel avanzado.** El jugador configura la app y puede *cometer* los bugs: compartir el cliente
de `ioredis`, no poner `maxRetriesPerRequest: null`, o cerrar dos veces el worker. El juego
muestra el `MaxListenersExceededWarning` y el "Connection is closed" en un panel de log en vivo.

**Tecnología.** HTML/CSS/JS con una vista 2D de la ciudad y un panel de log estilo el que ya usan
las páginas de `public/`.

---

### Juego 5 — El Turno

**Qué enseña.** Concurrencia y límites. `emailWorkerConcurrency = 2`, `notificationWorkerConcurrency = 5`,
`recsWorkerConcurrency = 2`, y `recs-recompute-all` fuerza concurrencia 1. El `limiter` es opción
del **Worker**, no de la Queue: el límite se comparte entre instancias del mismo worker de email,
pero **cada cola tiene su propio limiter**. Con `max: 10` por segundo y tres colas de email, el
pico agregado es 30 req/s, y el plan gratuito de Resend son 2 req/s: por eso los defaults del
proyecto son conservadores. La deuda está documentada.

**Mecánica.** Vista de planta de una nave de producción. Cada estación es un slot de concurrencia.
Hay un cubo de tokens por cola que se llena y se vierte. Llegan peticiones mezcladas de las 7
colas. El jugador reparte workers entre colas (cuántos procesos PM2) y ajusta límites. Misión:
"procesar 30 emails de verificación y 30 de marketing sin un solo 429".

**Cierre de turno.** Suena SIGTERM. El jugador decide **drenar** (`worker.close()` sin `force`,
espera al job en curso) o **matar** (el job en vuelo se pierde y vuelve por el stall check). Si
mata, ve el job reaparecer en la cola tras el stall check, con su retraso.

**Tecnología.** 2D canvas en vista lateral, o isométrico en Three.js si se quiere el flujo de
tokens más legible en 3D.

---

### Juego 6 — El Reloj

**Qué enseña.** El cron reproducible de F4. `upsertJobScheduler('recs-recompute-nightly', { pattern:
'0 3 * * *', tz })` se registra **desde el worker**, no desde la API: sobrevive reinicios porque
vive en Redis, y no se duplica aunque la API corra en cluster. El recompute masivo trabaja en
lotes de 25 (`recsRecomputeBatchSize`), reporta `updateProgress({ processed, total })` y libera el
event loop entre lotes.

**Mecánica.** Una torre de reloj en 3D. A las 3:00 suena la campana y cae una lluvia de usuarios
en grupos de 25. Una barra de progreso sube mientras las tarjetas de usuario se procesan. El
jugador puede inyectar fallos (DB caída).

**La decisión clave.** Al terminar el lote, el juego pregunta: *¿reintentas?*. Y la respuesta
depende del estado, exactamente como en `jobs/recomputeRecommendationsJob.ts:104`: si **ningún**
usuario salió bien y todos fallaron, hay que lanzar el error para que BullMQ reintente (fallo
sistémico); si al menos uno salió bien, no se repite trabajo ya hecho. Reintentar cuando no
debía → el juego muestra el progreso duplicándose y penaliza el trabajo repetido.

**Extras.** La notificación `recs.ready` se emite una vez por usuario y día
(`jobId: recs-ready-<fecha>-<userId>`), así que un segundo recompute del mismo día no genera
avisos duplicados. El reloj tiene TZ configurable, como el código.

**Tecnología.** Three.js: torre, campana, lluvia y reloj son el concepto.

---

### Juego 7 — Isla Idempotencia (puzle)

**Qué enseña.** El `jobId` es la clave de idempotencia: BullMQ ignora un `add` con un `jobId` que
ya existe. Reglas del proyecto:

- El `jobId` **no puede contener `:`**. El bug real: los notifiers armaban `<template>:<token>` y
  BullMQ lanzaba `Custom Id cannot contain :`. Como el encolado es best-effort, el error se
  silenciaba y **ningún email se encolaba**. Hoy los tres productores validan y lanzan un error
  explícito (`assertValidJobId`).
- El **nombre** del job sí puede llevar `:` (`critical:verification`); solo el `jobId` no.
- El dedupe de recs usa una ventana de 60 s: el `jobId` incluye el minuto actual
  (`recs-user-<userId>-<minuto>`). Un `jobId` fijo bloquearía al usuario para siempre si el job
  quedara retenido en `failed`.

**Mecánica.** Tablero de asignación de sellos. El jugador reparte `jobId`s entre eventos que
llegan (registro, reset de contraseña, review publicada, recompute). Cada regla incumplida tiene
consecuencia visible: sello con `:` → el "guard de BullMQ" rechaza con el mensaje real; sello
repetido → el segundo evento se descarta y se marca "notificación perdida"; `jobId` fijo en recs →
el usuario queda bloqueado y el juego lo señala como "para siempre" con un candado.

**Tecnología.** HTML/CSS/JS puro, tipo puzle de tablero con pistas que son fragmentos reales del
repo.

---

## Matriz de cobertura

| Mecánica implementada | Dónde vive | Juego |
|------------------------|-----------|-------|
| Prioridad de cola y su sentido invertido | `config/bullmq.ts` | 1, 5 |
| `0` = sin prioridad explícita | `fixes/bullmq-f1-corrections.md` | 1 |
| Un worker por cola | `workers/*.ts` | 5 |
| Concurrencia | `config/bullmq.ts` | 5 |
| Limiter por cola, no global | `workers/emailWorker.ts` | 5 |
| `attempts` + backoff exponencial | `config/bullmq.ts` | 2 |
| `failed` como DLQ, `removeOnFail` | `config/bullmq.ts` | 2 |
| `stalled` y devolución a la cola | `workers/baseWorker.ts` | 2, 5 |
| `jobId` idempotente | `queues/*.ts` | 3, 7 |
| `:` prohibido en `jobId` | `queues/emailQueue.ts:49` | 7 |
| Dedupe por ventana de 60 s | `queues/recommendationQueue.ts:43` | 6, 7 |
| `INSERT IGNORE` + `dedupe_key` | F3, migración de notificaciones | 3 |
| Fan-out en dos etapas | `jobs/notificationFanoutJob.ts` | 3 |
| Preferencia `notify_email` | `workers/notificationWorker.ts` | 3 |
| Fail-open del encolado | `utils/withTimeout.ts` | 4 |
| `201` conservado + `/auth/resend` | `fixes/register-atomicity.md` | 4 |
| No compartir `ioredis` | `config/bullmq.ts` | 4 |
| `maxRetriesPerRequest: null` | `config/bullmq.ts` | 4 |
| Graceful shutdown y `kill_timeout` | `workers/baseWorker.ts`, `ecosystem.config.js` | 5 |
| Cron idempotente y TZ | `workers/recommendationWorker.ts:132` | 6 |
| Lotes de 25 y `updateProgress` | `jobs/recomputeRecommendationsJob.ts` | 6 |
| Fallo parcial vs sistémico | `jobs/recomputeRecommendationsJob.ts:104` | 6 |
| `removeOnComplete: 100` | `config/bullmq.ts` | 7 |

---

## Arquitectura común

```text
source/
├── public/games/
│   ├── index.html              # hub: los 7 juegos, progreso y rutas de aprendizaje
│   ├── engine/
│   │   ├── simulator.js        # núcleo: scheduler, retries, limiter, dedupe, fan-out
│   │   ├── config.js           # carga bullmq-config.json (única fuente de números)
│   │   ├── rng.js              # PRNG con semilla (nada de Math.random)
│   │   ├── scenario.js         # escenarios precargados y editables
│   │   └── ui.js               # panel, log, toasts, línea de tiempo (reutiliza el estilo de public/)
│   ├── games/
│   │   ├── dispatch.html|js    # 1
│   │   ├── bullet-hell.html|js # 2
│   │   ├── cascade.html|js     # 3
│   │   ├── blackout.html|js    # 4
│   │   ├── shift.html|js       # 5
│   │   ├── clocktower.html|js  # 6
│   │   └── idempotency.html|js # 7
│   └── vendor/three/           # three.module.js local (sin CDN)
├── scripts/
│   └── exportBullmqGameConfig.ts   # genera bullmq-config.json desde config/bullmq.ts
└── __tests__/unit/
    └── bullmqGameConfig.test.ts    # falla si el JSON diverge del código
```

### El punto crítico: el juego no puede mentir

El riesgo real de esta iniciativa no es el alcance, es **la deriva**: alguien toca
`config/bullmq.ts` y el juego sigue enseñando los números viejos. Ya pasó con las prioridades.

La mitigación es una sola regla dura: **ningún número de BullMQ se escribe a mano en un juego**.

1. `scripts/exportBullmqGameConfig.ts` lee `config/bullmq.ts` y genera
   `public/games/bullmq-config.json` con: nombres de cola, prioridades por cola,
   `defaultJobOptions` (attempts, backoff, removeOn*), limiter, concurrencias, timeouts de
   encolado, `recsRecomputeBatchSize`, patrón y TZ del cron, ventana de dedupe y los `jobId`
   canónicos que usa el proyecto.
2. El JSON se **commitea**, para que el modo demo funcione sin red ni build.
3. `__tests__/unit/bullmqGameConfig.test.ts` regenera el JSON en memoria y falla si no coincide
   con el commiteado. El mismo patrón que ya protege el orden de prioridades en
   `queueFactory.test.ts`.

Con esto, el juego 1 no "explica" la prioridad: la **muestra**, y si el código cambia, el test
falla antes de que alguien aprenda algo falso.

### Modos

Siguiendo `cross-cutting/frontend-lab-guideline.md`:

| Modo | Activación | Backend | Datos | Contenido |
|------|------------|---------|-------|-----------|
| Demo | `?demo=1` | Ninguno | Mock determinista | Toda la mécanique, sin red |
| Laboratorio | `?lab=1` | Real | Reales + acciones | Reparto real de colas, Bull Board, logs reales |
| Producto | sin parámetros | — | — | El hub de juegos (solo navegación y tutorial) |

El modo demo es el que se usa para aprender y para CI; el laboratorio sirve para contrastar
"en el simulador" contra "en el sistema real" y es opcional.

---

## Fases

| Fase | Contenido | Entregable verificable |
|------|-----------|-------------------------|
| **F0** | Kernel del simulador + config derivada + test de no-deriva + **Juego 1** completo | Vertical slice: un juego jugable de punta a punta y el test que lo ata al código |
| **F1** | Juegos **2** y **4** (reintentos/DLQ y fail-open) | Dos juegos en HTML/canvas, sin 3D |
| **F2** | Juegos **6**, **3** y **7** (cron, fan-out, idempotencia) | Primer uso de Three.js con vendor local |
| **F3** | Juego **5** + modo `?lab=1` contra backend real + Bull Board embebido | Comparación simulador ↔ sistema real |

**F0 primero y sola.** La tentación de hacer siete juegos a la vez es real; el riesgo es tener
siete simulaciones distintas y ninguna fidedigna. Un kernel único con un juego que ya demuestra
el patrón de "config derivada + test" es la forma de descubrir los problemas del motor antes de
que se propaguen.

---

## Criterios de aceptación (de la iniciativa)

- [ ] Ningún juego contiene un valor de BullMQ hardcodeado: todo sale de `bullmq-config.json`.
- [ ] `npm test` incluye `bullmqGameConfig.test.ts` y falla si el JSON commiteado diverge de
      `config/bullmq.ts`.
- [ ] Todo juego tiene *Reiniciar* (misma semilla), *Avanzar paso a paso*, control de velocidad y
      *Comparar*.
- [ ] El modo demo no hace red ni toca Redis/MySQL, y produce el mismo estado en cada carga.
- [ ] Cada juego muestra la cita del archivo del repo que define la regla que enseña.
- [ ] El hub enlaza a los 7 juegos y a la doc de HU-13.
- [ ] La página sigue el sistema de diseño de `public/` (mismas variables CSS, modo claro/oscuro).
- [ ] Si se usa Three.js, se sirve desde `public/vendor/` (sin CDN) y no añade dependencia de
      producción.

---

## Riesgos

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| El juego enseña una semántica que el código no tiene | Alto (enseña al revés, como el fix de prioridades) | Config derivada + test de no-deriva; cada regla cita su archivo |
| Tres.js añade complejidad y peso sin build | Medio | Three.js solo donde aporta (2, 3, 6); vendor local; los demás juegos son DOM/canvas |
| Alcance excesivo: siete juegos | Medio | F0 con un juego completo; el kernel se valida antes de replicar |
| Los juegos se desactualizan al tocar el código | Alto | El test de no-deriva es bloqueante; si el JSON no se regenera, CI falla |
| Confundir el juego con la documentación oficial | Bajo | Cada juego enlaza a `hu-13-bullmq-job-queue.md` y al archivo del código |

---

## Deuda que esta iniciativa no cierra

- `/admin/queues` sigue sin protección en producción (ya anotado en el fix de F1). El modo
  `?lab=1` de los juegos no lo cambia.
- El limiter sigue siendo por cola y no global: el juego 5 lo enseña como **deuda conocida**, no
  como comportamiento deseado.
- El simulador es un modelo del sistema, no el sistema. Sirve para aprender y para contrastar
  hipótesis; no sustituye a una prueba de integración contra Redis real.

---

## Referencias

- [HU-13: BullMQ Job Queue System](../features/hu-13-bullmq-job-queue.md)
- [Correcciones de la infraestructura BullMQ (F1)](../fixes/bullmq-f1-corrections.md)
- [Registro atómico](../fixes/register-atomicity.md)
- [Demo y laboratorio frontend por feature](../cross-cutting/frontend-lab-guideline.md)
- [Otros casos de uso para BullMQ](2026-10-24-bullmq-use-cases.md)
- Código: `source/config/bullmq.ts`, `source/queues/`, `source/workers/`, `source/jobs/`,
  `source/utils/withTimeout.ts`, `source/ecosystem.config.js`
