# Diseño — Juego 3: Cascada

> **Estado:** implementado (esqueleto funcional jugable) · **Rama:** `feat/juego-3-cascada`
> **Fuente de verdad del contrato:** `README.md` de api-movies + `2026-11-02-juegos-aprendizaje-bullmq-repo-api-movies.md` (sección «Juego 3 — Cascada»)

## 1. Qué enseña

El fan-out en dos etapas que usa `api-movies`:

```text
review.published
      │
      ▼
notification-fanout            (prioridad 1, worker notificationWorker)
      │  lee user_settings.notify_email / notify_inapp
      ├──► email-transactional   (prioridad 5, worker emailWorker)      ──► correo enviado
      └──► notification-inapp    (prioridad 3, worker notificationWorker) ──► INSERT IGNORE en notifications
                                   UNIQUE (user_id, type, dedupe_key)
```

Las cuatro ideas que el juego hace visibles:

1. **La cascada es de dos etapas.** El fan-out no envía nada: reparte. Cada canal es
   su propia cola, con su propia prioridad, y se ejecutan en paralelo (no compiten
   entre sí, como en el Juego 1).
2. **La preferencia se respeta antes de encolar.** Si `notify_email` está apagado,
   el fan-out no debe crear el job de correo. Si lo crea, el correo sale.
3. **La fila la protege el `dedupe_key`.** `INSERT IGNORE` + `UNIQUE (user_id, type,
   dedupe_key)` evita la fila duplicada, pero solo si la clave distingue una review
   de otra. Una clave por usuario se come notificaciones legítimas.
4. **El correo lo protege el `jobId`, no el `INSERT IGNORE`.** El `INSERT IGNORE` no
   evita un correo duplicado: para eso está el `jobId` idempotente de BullMQ. Y un
   `jobId` demasiado fijo bloquea el evento legítimo.

> El punto 4 es el corazón del juego: el error intuitivo es creer que "INSERT
> IGNORE ya evita duplicados". La constelación muestra que la fila y el correo son
> dos caminos distintos con dos protecciones distintas.

## 2. Mecánica

El jugador **configura cuatro reglas** y pulsa *Simular*. La constelación crece
mientras el motor procesa la cascada real.

| Regla | Opciones | Consecuencia de equivocarse |
|-------|----------|------------------------------|
| **Respetar `user_settings.notify_*`** | sí / no | correo no pedido (`emailUnwanted`) |
| **`jobId` del job de canal** | por evento / distinto por emisión / fijo | spam de correo, o notificación perdida por bloqueo |
| **`dedupe_key` de la fila** | review+película+usuario / por usuario / fijo | colisión: la fila de otra review se traga |
| **`INSERT IGNORE`** | sí / no | sin IGNORE el job revienta contra `UNIQUE` |

Controles: *Simular / Pausa*, *Paso* (un tick), *Reiniciar* (misma semilla, conserva
tus reglas), velocidad 1× / 2× / 4×, *Comparar* (A/B contra una configuración
"ingenua"), *Ayuda*, tema claro/oscuro.

### Puntuación

Todos los valores viven en `config/cascade-config.json` (`scoring`), no en el código.

| Concepto | Puntos |
|----------|--------|
| Notificación in-app entregada | +60 |
| Correo enviado a quien lo quiere | +30 |
| Duplicado absorbido por `INSERT IGNORE` | +40 |
| Re-emisión absorbida por `jobId` | +40 |
| Correo duplicado (spam) | −60 |
| Correo no deseado | −50 |
| Notificación perdida | −80 |
| Nivel limpio (sin spam ni pérdidas) | +50 |

El objetivo de cada nivel es **exactamente** la puntuación de la partida óptima: el
arnés lo verifica (`la partida óptima alcanza el objetivo exacto de cada nivel`).

## 3. Niveles

| # | Nombre | Qué aísla | Objetivo | Partida óptima |
|---|--------|-----------|----------|----------------|
| 1 | **La supernova** | La estructura de la cascada | 140 | 140 |
| 2 | **El silencio** | `notify_email` apagado | 110 | 110 |
| 3 | **Las gemelas** | `dedupe_key` demasiado grueso | 230 | 230 |
| 4 | **El eco** | `jobId` inestable o demasiado fijo | 270 | 270 |

Contrapruebas medidas con el arnés (mismo escenario, una regla cambiada):

| Nivel | Regla que se rompe | Resultado |
|-------|--------------------|-----------|
| 2 | sin respetar la preferencia | 110 → **10** (correo no deseado) |
| 3 | `dedupe_key` por usuario | 230 → **40** (colisión: 1 notificación perdida) |
| 3 | `dedupe_key` por usuario + `INSERT` normal | 230 → **40** (el job revienta contra `UNIQUE`) |
| 4 | `jobId` por emisión | 270 → **160** (1 correo duplicado) |
| 4 | `jobId` fijo | 270 → **50** (la review de `movie-77` queda bloqueada: notificación perdida) |

Cada nivel tiene una lista de **observaciones** que se marcan solas cuando el motor
produce el fenómeno correspondiente (`observed.<flag>`): el jugador ve *qué* tiene que
mirar, no solo un número.

## 4. Arquitectura

```text
juego-3-cascada/
├── index.html                  # juego completo (Three.js + DOM)
├── DISEÑO.md                   # este documento
├── README.md                   # cómo se juega y cómo se verifica
├── config/
│   ├── cascade-config.json     # contrato canónico (fuente de verdad)
│   └── cascade-config.js       # espejo para el navegador (sin fetch)
├── engine/
│   ├── cascade-sim.js          # motor determinista de la cascada
│   ├── scenarios-juego-3.js    # los cuatro niveles
│   └── constellation.js        # renderizador Three.js de la constelación
├── vendor/three/
│   ├── three.min.js            # Three.js r149 local (sin CDN)
│   └── LICENSE
└── test-juego-3.js             # arnés de verificación (51 checks)
```

### Motor (`engine/cascade-sim.js`)

Agnóstico del render: no toca el DOM, no usa `Math.random` ni timers. El reloj
avanza con `step()` / `advance(ms)` y las decisiones se aplican con `setRule()`.

- **Reloj virtual**: `tickMs = 100`. Cada cola tiene **un worker** (como en el API) y
  los jobs se despachan por cola; las colas corren en paralelo.
- **Colas**: las tres del config, con su prioridad real. La prioridad ordena *dentro*
  de la cola, no entre colas.
- **`_addJob`**: si el `jobId` ya existe **en esa cola**, BullMQ ignora el `add`. La
  unicidad del `jobId` es por cola: el mismo `jobId` puede vivir a la vez en
  `email-transactional` y en `notification-inapp`.
- **Tabla `notifications`**: se simula el índice `UNIQUE (user_id, type, dedupe_key)`.
  - Fila nueva → se inserta (`notificationDelivered`).
  - Fila existente, **misma** entidad → `INSERT IGNORE` la ignora (`duplicateIgnored`);
    sin IGNORE el job falla contra la restricción (`failedInsert`).
  - Fila existente, **otra** entidad → colisión: el `INSERT IGNORE` se come una
    notificación que debía entregarse (`dedupeCollision` → notificación perdida).
- **Correo**: se lleva su propio registro de envíos. Un segundo correo con el mismo
  `(user_id, type, entidad)` es spam, aunque la fila in-app esté a salvo. Si el
  destinatario tiene `notify_email` apagado, es correo no deseado.

### Config (`config/cascade-config.json`)

Única fuente de números. El motor **exige** configuración (`new Engine({})` falla):
no hay ni un valor de BullMQ escrito a mano en el código.

```json
{
  "queues": [
    { "name": "notification-fanout", "priority": 1, ... },
    { "name": "notification-inapp", "priority": 3, ... },
    { "name": "email-transactional", "priority": 5, ... }
  ],
  "persistence": {
    "uniqueConstraint": "UNIQUE (user_id, type, dedupe_key)",
    "insert": "INSERT IGNORE"
  }
}
```

`cascade-config.js` es el espejo que se carga en el navegador (para que funcione
desde `file://` sin `fetch`); el arnés comprueba que ambos son idénticos.

### Renderizador (`engine/constellation.js`)

Three.js **vendorizado localmente** (r149, `build/three.min.js`, 594 KB, sin CDN y
sin build). Se eligió la build clásica UMD a propósito: el juego abre con doble
clic desde `file://`, donde los módulos ES están bloqueados por CORS.

- Nodos = `THREE.Sprite` con textura de halo generada en canvas (sin assets
  externos) + etiqueta de texto con `CanvasTexture`.
- Enlaces = `THREE.Line` sobre curvas `QuadraticBezierCurve3` entre capas:
  evento (x −10) → fan-out (−3,5) → canal (3,5) → destino (10).
- Color por estado: entregado (verde), ignorado (ámbar), spam o pérdida (rojo).
- Fondo: campo de estrellas con LCG sembrado (sin `Math.random`).
- El renderizador **lee** el grafo del motor; no decide nada.

## 5. El juego no puede mentir (no-deriva)

El riesgo real de esta iniciativa es la deriva: que alguien toque el API y el juego
siga enseñando los números viejos (ya pasó con las prioridades invertidas).

Triple defensa, toda en `test-juego-3.js`:

1. **El config se compara con el README del API.** El arnés parsea la tabla de colas
   de `README.md` (`notification-fanout` 1, `notification-inapp` 3,
   `email-transactional` 5) y falla si el `cascade-config.json` diverge.
2. **El documento de diseño se cita.** El arnés comprueba que el documento de los
   juegos sigue describiendo el Juego 3 con las tres colas, `INSERT IGNORE` y
   `dedupe_key`.
3. **Los `jobId` canónicos no pueden llevar `:`.** El arnés falla si algún template
   contiene `:` (la regla de BullMQ que ya rompió los correos del proyecto).

Cuando el API cambie, hay que regenerar `cascade-config.json` y su espejo: el arnés
falla antes de que alguien aprenda algo falso.

## 6. Verificación

```powershell
node juego-3-cascada/test-juego-3.js
```

51 comprobaciones: config y su espejo, no-deriva contra el README, la cascada de dos
etapas, la preferencia, el `dedupe_key`, el `INSERT IGNORE`, el `jobId` idempotente
(incluido que la unicidad es por cola), los cuatro objetivos exactos, determinismo
(misma semilla → misma partida) y el contrato del HTML (scripts, ids, vendor local,
sin `fetch`, tema, `window.CascadeGame`).

Comprobado además en navegador: nivel 1 con las reglas correctas → 140/140; nivel 4
con `jobId` por emisión → 160/270 con 1 spam; consola sin errores ni advertencias.

## 7. Decisiones de diseño

| Decisión | Alternativa descartada | Por qué |
|----------|------------------------|---------|
| Three.js vendorizado (UMD r149) | build ESM de Three | El ESM no carga desde `file://` (CORS); el juego debe abrirse con doble clic como los juegos 1 y 2 |
| Cuatro reglas manipulables | Narrativa fija con una solución | El jugador aprende probando y viendo el precio de cada decisión en la constelación |
| El motor no renderiza | Todo en el DOM | El motor se puede verificar en Node y es determinista; el 3D solo lee su grafo |
| Puntuación por resultado | Puntuación por pasos | El jugador puede tener muchas rutas correctas; lo que se premia es el efecto final |
| `INSERT IGNORE` y `jobId` como reglas separadas | Una sola "idempotencia" | Es justo el punto: cada protege una capa distinta, y esa confusión es la que hay que desmontar |

## 8. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Que el motor enseñe una semántica que el código no tiene | Config derivada + test de no-deriva contra el README; cada regla cita su archivo |
| Que el 3D distraiga del concepto | Las cuatro reglas están en un panel DOM legible; el 3D muestra el efecto, no lo explica |
| Que el jugador adivine sin entender | La bitácora y el panel de observaciones explican *por qué* cada regla produce ese resultado |
| El vendor de Three.js pesa 594 KB | Es un archivo estático sin CDN ni build; el juego sigue siendo autocontenido |

## 9. Deuda que este juego no cierra

- El simulador es un **modelo** del sistema, no el sistema: no sustituye a una prueba
  de integración contra Redis real.
- No se cubre el modo `?lab=1` (contraste contra el backend real) ni el hub de juegos:
  quedan para fases posteriores.
- La persistencia simulada no modela la concurrencia real de MySQL (dos inserts
  simultáneos contra el mismo `UNIQUE`), solo la unicidad lógica.
- `notifications` no tiene purga de filas (deuda ya anotada en el README del API).
