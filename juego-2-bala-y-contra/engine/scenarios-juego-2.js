/**
 * Escenarios deterministas del Juego 2.
 *
 * `kind: "fragile"`  -> falla `failuresBeforeSuccess` veces y después pasa.
 * `kind: "poisoned"` -> falla siempre: reintentarlo solo gasta energía.
 *
 * Los errores imitan respuestas reales: 429/500/503 son transitorios (frágil),
 * 400 es permanente (veneno). El jugador decide con esa pista.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RetryScenarios = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCENARIOS = [
    {
      id: "primer-contacto",
      number: 1,
      name: "Primer contacto",
      kicker: "Nivel 1 · 500 transitorio vs 400 permanente",
      energy: 4,
      target: 260,
      hint: "Lee el código de error: 500/429 se reintenta; 400 no.",
      briefing: [
        "Cada job que llega a la nave es un intento del worker. Si falla, decide: reintentar (cuesta energía y espera un backoff) o mandarlo a failed.",
        "Un 500 o un 429 puede ser temporal: merece un reintento. Un 400 es permanente: reintentarlo quema energía que necesitas para los jobs recuperables.",
        "Objetivo: 260 puntos. Completa los dos jobs frágiles y manda el venenoso a failed."
      ],
      jobs: [
        {
          id: "fragile-verify",
          name: "Email de verificación",
          kind: "fragile",
          failuresBeforeSuccess: 1,
          error: "429 · rate limit de Resend"
        },
        {
          id: "poisoned-template",
          name: "Email de bienvenida",
          kind: "poisoned",
          error: "400 · template inválido"
        },
        {
          id: "fragile-receipt",
          name: "Recibo de compra",
          kind: "fragile",
          failuresBeforeSuccess: 2,
          error: "500 · timeout de Resend"
        }
      ],
      observe: [
        "El job frágil de 1 fallo completa en el intento 2 (backoff de 2 s).",
        "El frágil de 2 fallos completa en el intento 3 (2 s y luego 4 s).",
        "El venenoso nunca completa: cada reintento gasta energía sin cambiar el resultado.",
        "Con attempts=3, el tercer fallo del venenoso va directo a failed; el backoff de 8 s no llega a usarse."
      ]
    },
    {
      id: "stall-check",
      number: 2,
      name: "Stall check",
      kicker: "Nivel 2 · el worker muere en pleno vuelo",
      energy: 5,
      target: 360,
      stallOn: "fragile-receipt",
      hint: "Si el worker muere, el job vuelve a la cola: no pierde el intento.",
      briefing: [
        "Ahora hay un job más y un imprevisto: el worker que atiende el recibo muere en pleno intento.",
        "El stall check detecta el lock vencido y devuelve el job a la cola sin consumir un intento. Verás la nave reaparecer.",
        "Objetivo: 360 puntos. Tres frágiles completados y el venenoso en failed."
      ],
      jobs: [
        {
          id: "fragile-verify",
          name: "Email de verificación",
          kind: "fragile",
          failuresBeforeSuccess: 1,
          error: "429 · rate limit de Resend"
        },
        {
          id: "poisoned-template",
          name: "Email de bienvenida",
          kind: "poisoned",
          error: "400 · template inválido"
        },
        {
          id: "fragile-receipt",
          name: "Recibo de compra",
          kind: "fragile",
          failuresBeforeSuccess: 2,
          error: "500 · timeout de Resend"
        },
        {
          id: "fragile-reset",
          name: "Reset de contraseña",
          kind: "fragile",
          failuresBeforeSuccess: 1,
          error: "503 · servicio no disponible"
        }
      ],
      observe: [
        "El recibo vuelve a la cola tras el stall: su contador de intentos no sube.",
        "El stall check es distinto de un fallo: no programa backoff ni gasta energía.",
        "El frágil de 2 fallos sigue necesitando sus 3 intentos después del stall.",
        "El venenoso se descarta con el 400; los frágiles se recuperan."
      ]
    }
  ];

  return SCENARIOS;
});
