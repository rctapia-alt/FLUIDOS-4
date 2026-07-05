/* =========================================================================
   MOBILE-PERF.JS — Optimización de rendimiento para la vista móvil
   ---------------------------------------------------------------------
   POR QUÉ EXISTE ESTE ARCHIVO
   El simulador ya usa pestañas en celular (mobile-tabs.js): solo un panel
   se VE a la vez (Parámetros / Visor 3D / Datos / Gráficas). Pero "verse"
   y "estar en pausa" son cosas distintas — antes de este archivo, aunque
   el usuario estuviera mirando la pestaña de Parámetros, por detrás
   seguían ocurriendo, 60 veces por segundo:
     1. El render 3D completo (WebGL) del panel Visor 3D oculto.
     2. El redibujado de las 3 gráficas de Chart.js del panel oculto.
     3. La reescritura del HUD de lecturas sobre el visor oculto.
   Eso es exactamente lo que se siente como "lentitud": el hilo principal
   y la GPU del teléfono siguen ocupados en tres paneles que nadie está
   viendo. Este archivo no cambia ningún cálculo de ingeniería ni ninguna
   fórmula — solo evita hacer trabajo de dibujo para lo que está oculto,
   y en su lugar sigue acumulando los datos para que, al volver a esa
   pestaña, todo aparezca ya actualizado sin saltos ni huecos.

   Se carga como el ÚLTIMO <script> del documento (después de scene3d.js,
   charts.js, ui.js, main.js y mobile-tabs.js) precisamente para poder
   "envolver" sus funciones públicas sin tener que modificar esos
   archivos.
   ========================================================================= */
(function () {

  // Solo tiene sentido en celular: en escritorio los 3 paneles están
  // siempre visibles a la vez, así que no hay nada que pausar.
  function isMobile() {
    return window.matchMedia("(max-width: 980px)").matches;
  }

  function viewerVisible() {
    if (!isMobile()) return true;
    const el = document.querySelector(".panel-viewer");
    return !!el && el.classList.contains("mobile-active");
  }

  function chartsVisible() {
    if (!isMobile()) return true;
    const panel = document.querySelector(".panel-data");
    const section = document.getElementById("dataSectionCharts");
    return !!panel && panel.classList.contains("mobile-active") &&
           !!section && section.classList.contains("mobile-section-active");
  }

  // -------------------------------------------------------------------
  // 1) PAUSAR EL RENDER 3D (no los cálculos) mientras el Visor 3D está
  //    oculto — es, con diferencia, el mayor ahorro: en una GPU de
  //    celular, saltarse la llamada renderer.render() de un frame pesa
  //    mucho más que todo lo demás junto.
  //    Scene3D.setRenderPaused() ya existe (ar.js la usa al entrar/salir
  //    de AR); aquí solo se reutiliza para el mismo propósito en el
  //    cambio de pestañas móvil.
  // -------------------------------------------------------------------
  function syncRenderPause() {
    if (typeof Scene3D === "undefined" || typeof Scene3D.setRenderPaused !== "function") return;
    const visible = viewerVisible();
    Scene3D.setRenderPaused(!visible);
    // Al VOLVER a hacer visible el visor (o en el arranque), el canvas pudo
    // haber quedado con tamaño 0 mientras su panel estuvo en display:none:
    // se fuerza un recálculo de tamaño para que no aparezca negro/cortado.
    if (visible && typeof Scene3D.resize === "function") {
      requestAnimationFrame(() => { try { Scene3D.resize(); } catch (e) {} });
    }
  }

  // -------------------------------------------------------------------
  // 2) EVITAR REDIBUJOS DE CHART.JS mientras la pestaña "Gráficas" no
  //    está activa. Los datos de la simulación se siguen acumulando con
  //    total normalidad (no se pierde ni un punto); lo único que se
  //    salta es la llamada chart.update("none") — el redibujo del
  //    canvas — que nadie puede ver de todos modos. Al volver a la
  //    pestaña, mobile-tabs.js ya fuerza un chart.resize() (que redibuja
  //    con los datos más recientes), así que no queda nada desactualizado.
  // -------------------------------------------------------------------
  function wrapChartsPushStreamPoint() {
    if (typeof Charts === "undefined" || typeof Charts.pushStreamPoint !== "function") return;
    const original = Charts.pushStreamPoint;
    Charts.pushStreamPoint = function (chart, t, series, xLabel, yLabel) {
      if (chartsVisible() || !chart || typeof chart.update !== "function") {
        return original(chart, t, series, xLabel, yLabel);
      }
      // Silencia SOLO esta llamada al update interno del push (sigue
      // empujando/recortando los arreglos de datos como siempre).
      const realUpdate = chart.update;
      chart.update = function () {};
      try {
        return original(chart, t, series, xLabel, yLabel);
      } finally {
        chart.update = realUpdate;
      }
    };
  }

  // -------------------------------------------------------------------
  // 3) EVITAR REESCRITURAS DE innerHTML del HUD del visor 3D mientras el
  //    Visor 3D está oculto (se reconstruye desde cero en cada frame
  //    mientras la simulación corre). Como se recalcula con datos
  //    frescos cada frame, al volver a la pestaña simplemente vuelve a
  //    pintarse con el valor actual — no necesita "ponerse al día".
  // -------------------------------------------------------------------
  function wrapSetViewerHud() {
    if (typeof UI === "undefined" || typeof UI.setViewerHud !== "function") return;
    const original = UI.setViewerHud;
    UI.setViewerHud = function (rows) {
      if (!viewerVisible()) return;
      return original(rows);
    };
  }

  // -------------------------------------------------------------------
  // Enganche a los cambios de pestaña: mobile-tabs.js construye la barra
  // (#mobileTabbar) y registra su propio listener de click ANTES de que
  // este archivo se ejecute (se carga después en index.html), así que
  // cuando el nuestro se dispara las clases ".mobile-active" /
  // ".mobile-section-active" ya están actualizadas — solo hace falta
  // leerlas y sincronizar el render 3D.
  // -------------------------------------------------------------------
  function attachTabbarSync() {
    const bar = document.getElementById("mobileTabbar");
    if (bar) bar.addEventListener("click", () => syncRenderPause());
    // Cambiar de orientación o cruzar el umbral escritorio/móvil también
    // debe re-sincronizar (mobile-tabs.js ya hace algo análogo para el
    // tamaño de sus paneles).
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncRenderPause, 150);
    });
  }

  function init() {
    wrapChartsPushStreamPoint();
    wrapSetViewerHud();
    attachTabbarSync();
    syncRenderPause(); // estado inicial correcto (por defecto la pestaña activa es "Visor 3D")
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
