# Juego 3 — Cascada

Juego didáctico sobre el **fan-out en dos etapas** de `api-movies`: un evento
`review.published` entra en `notification-fanout` (prioridad 1), ese worker lee
`user_settings.notify_email` / `notify_inapp` y reparte en canales
(`email-transactional`, prioridad 5; `notification-inapp`, prioridad 3), y la rama
in-app persiste en `notifications` con `INSERT IGNORE` y la restricción
`UNIQUE (user_id, type, dedupe_key)`.

La constelación de Three.js muestra la cascada real mientras el jugador decide
cuatro reglas: respetar la preferencia, el `jobId` del canal, el `dedupe_key` de la
fila y el `INSERT IGNORE`.

Se abre directamente en el navegador: no hay build ni dependencias (Three.js va
vendorizado en `vendor/three/`, sin CDN).

```text
juego-3-cascada/
├── index.html                  # juego completo (Three.js + DOM)
├── DISEÑO.md                   # documento de diseño del juego
├── config/
│   ├── cascade-config.json     # contrato canónico de la cascada
│   └── cascade-config.js       # espejo para el navegador (sin fetch)
├── engine/
│   ├── cascade-sim.js          # motor determinista (fan-out, dedupe, jobId)
│   ├── scenarios-juego-3.js    # los cuatro niveles
│   └── constellation.js        # renderizador de la constelación
├── vendor/three/three.min.js   # Three.js r149 local
└── test-juego-3.js             # arnés de verificación
```

## Qué enseña

| Concepto | Valor real usado |
|---|---|
| Prioridades | fan-out `1`, in-app `3`, email transaccional `5` |
| Preferencia | `user_settings.notify_email` / `notify_inapp` |
| Persistencia | `INSERT IGNORE` sobre `notifications` |
| Idempotencia de fila | `UNIQUE (user_id, type, dedupe_key)` |
| Idempotencia de cola | `jobId` por cola: BullMQ ignora un `add` con un `jobId` ya usado |

La idea central: **el `INSERT IGNORE` protege la fila, el `jobId` protege el
correo**. Son dos caminos distintos y confundirlos cuesta puntos.

## Cómo se juega

1. Eliges nivel y ajustas las cuatro reglas del panel **Reglas de la cascada**.
2. Pulsas **Simular** (o **Paso** para avanzar un tick a la vez).
3. Las estrellas muestran: evento → fan-out → canal → destino. Verde = entregado,
   ámbar = ignorado, rojo = spam o notificación perdida.
4. Al terminar aparece el resultado con los puntos frente al objetivo.
5. **Comparar** contrasta tu configuración con una "ingenua" (sin preferencia,
   `jobId` por emisión, `dedupe_key` por usuario, `INSERT` normal).

## Niveles

| # | Nombre | Qué aísla | Objetivo |
|---|--------|-----------|----------|
| 1 | La supernova | La estructura de la cascada | 140 |
| 2 | El silencio | La preferencia del usuario | 110 |
| 3 | Las gemelas | El `dedupe_key` | 230 |
| 4 | El eco | El `jobId` idempotente | 270 |

El objetivo de cada nivel es exactamente la puntuación de la partida óptima: el
arnés lo comprueba.

## Verificación

```powershell
node juego-3-cascada/test-juego-3.js
```

El arnés comprueba el config y su espejo, la **no-deriva** contra el `README.md` de
`api-movies` (las prioridades del config tienen que seguir a las del README), la
cascada de dos etapas, la preferencia, el `dedupe_key`, el `INSERT IGNORE`, el
`jobId` idempotente, los cuatro objetivos exactos, el determinismo y el contrato
del HTML (scripts, ids, vendor local, sin `fetch`, tema y `window.CascadeGame`).

Para inspeccionarlo con las mismas herramientas que usa el juego,
`window.CascadeGame` expone `state`, `config`, `scenarios`, `engine()`, `view()`,
`loadScenario`, `reset`, `step`, `start`, `setRule` y `compare`.

## Nota de alcance

El motor es determinista (sin `Math.random` ni timers): misma semilla, misma
partida. La persistencia simulada modela la unicidad lógica de `UNIQUE`, no la
concurrencia real de MySQL. El modo `?lab=1` contra el backend real y el hub de
juegos quedan para fases posteriores.
