/* =========================================================================
   MAIN.JS — Orquestador de CENTRIX
   Conecta engine.js (matemática) · scene3d.js (visor) · charts.js (gráficas)
   · ui.js (DOM) para los tres equipos: decanter, bowl, pump.
   ========================================================================= */

(function () {

  const ACCENT = { heavy: "#E8A33D", light: "#4FC3D9", green: "#3DCB7A", solids: "#9C6B3E" };
  // Decantador: la pared del tazón dibujado (radio de escena 1.3) representa
  // r_pared = 0.30 m. Con la fórmula correcta de zona neutra
  // (r_i² = (ρ_A r_A² − ρ_B r_B²)/(ρ_A − ρ_B)) la interfase vive ENTRE la
  // compuerta pesada y la pared (rB < rA < r_i < r_pared), así que la
  // pared es el límite físico superior de r_i (inundación).
  const DEC_R_WALL = 0.30;                 // m — radio interior de pared del decantador
  const SCALE_R_DECANTER = 1.3 / DEC_R_WALL; // m (real) -> unidades de escena
  const SCALE_R_BOWL = 1.13 / 0.18; // radio de pared real (0.18 m) -> radio de escena (1.13) del bowl en scene3d.js

  // -----------------------------------------------------------------------
  // Estado de parámetros por equipo (valores actuales, editables por UI)
  // -----------------------------------------------------------------------
  const state = {
    decanter: { rpm: 3000, rA: 0.12, rB: 0.05, rhoA: 1050, rhoB: 850 },
    bowl: { rpm: 6000, r: 0.12, Dp: 20, rhoP: 2200, rho: 1000, mu: 0.001, tProceso: 120 },
    pump: {
      n: 1750, q1: 40, H1: 30, P1: 7.5,
      rho: 1000, r1imp: 0.04, r2imp: 0.15,
      Pvapor: 2340, zs: 1, npshReq: 3
    }
  };
  const PUMP_N_REF = 1750; // rpm — punto de diseño de referencia (fijo)
  const BOWL_R0 = 0.02;    // m — radio de entrada de la alimentación (punto de partida del trazador)
  const BOWL_R2 = 0.18;    // m — radio interior de la pared del tazón (== BOWL_WALL_R más abajo)
  const BOWL_N_SWARM = 70; // debe coincidir con N_PARTICLES en scene3d.js (buildBowl)

  // -----------------------------------------------------------------------
  // MOTOR DE TIEMPO — cronómetro de simulación compartido por los 3 equipos.
  // Cada equipo mantiene su propio "reloj de proceso" (simTime) para que
  // cambiar de equipo no mezcle escalas de tiempo distintas; Play/Pausa/
  // Velocidad son globales a la sesión pero el tiempo acumulado es propio
  // de cada pestaña de equipo.
  // -----------------------------------------------------------------------
  const sim = {
    playing: false,
    speed: 2,
    t: { decanter: 0, bowl: 0, pump: 0 },
    // Estado físico que se integra cuadro a cuadro (no solo se recalcula
    // instantáneamente): posición del trazador del bowl, ciclos completados
    // (para la torta acumulada), y omega animada de cada equipo.
    bowlTracer: { r: BOWL_R0, ciclos: 0, cakeFraction: 0, ultimaLlegada: false, swarm: [] },
  };

  // ==========================================================================
  // ENJAMBRE DE SEDIMENTACIÓN — MODELO FÍSICO POR PARTÍCULA
  // --------------------------------------------------------------------------
  // Cada partícula integra su propio estado:
  //   r, vr    — posición y velocidad radial. La partícula NO viaja
  //              instantáneamente a su velocidad terminal de Stokes: se
  //              relaja hacia ella (inercia, integrador exponencial exacto,
  //              estable a cualquier velocidad de reproducción).
  //   y, vyFlow— posición axial (fracción -0.5..0.5 de la altura útil) y
  //              velocidad del FLUJO DE PROCESO: el líquido atraviesa el
  //              tazón axialmente en ≈ tProceso segundos y arrastra a las
  //              partículas hacia la descarga superior. Ésta es la
  //              carrera radial-vs-axial que decide la separación:
  //                · llega a la PARED antes que arriba  → RETENIDA (torta)
  //                · llega ARRIBA antes que a la pared  → ESCAPA en el
  //                  efluente clarificado (separación incompleta visible)
  //   ang      — ángulo propio con deriva lenta respecto al rotor (slip).
  //   uTurbR/uTurbY — velocidad turbulenta Ornstein-Uhlenbeck: ruido
  //              correlacionado (zigzag suave, no temblor), de media cero
  //              (no altera el tiempo de sedimentación de Stokes).
  //   dpFactor — dispersión de tamaño ±40%: u_t ∝ D_p² hace que las
  //              grandes lleguen a la pared y las finas escapen — la
  //              distribución real de una suspensión.
  //   settled/escaped — estados terminales visibles (reposo en la torta /
  //              salida por arriba) antes de reciclarse como alimentación.
  // ==========================================================================
  const CAKE_SECTORS = 24;        // sectores angulares de acumulación de torta
  const SETTLE_REST_TIME = 2.2;   // s de proceso que la partícula queda depositada visible
  const ESCAPE_TRAVEL_TIME = 1.2; // s que tarda en verse salir por la descarga superior
  const TURB_SIGMA = 0.0016;      // m/s — intensidad RMS de la turbulencia
  const TURB_TAU = 0.9;           // s — tiempo de correlación del ruido OU

  function gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function freshParticle(p) {
    p.r = BOWL_R0 + Math.random() * 0.004;   // la alimentación no es un punto
    p.vr = 0;
    p.ang = Math.random() * Math.PI * 2;
    p.y = -0.34 - Math.random() * 0.02;      // entra por abajo (alimentación inferior)
    p.uTurbR = 0; p.uTurbY = 0;
    p.settled = false; p.escaped = false;
    p.stateTimer = 0;
    return p;
  }

  function initBowlSwarm() {
    const swarm = [];
    for (let i = 0; i < BOWL_N_SWARM; i++) {
      swarm.push(freshParticle({ dpFactor: 0.6 + Math.random() * 0.8 })); // 0.6x .. 1.4x del D_p nominal
    }
    sim.bowlTracer.swarm = swarm;
    // Torta por sectores angulares: cada depósito real alimenta el sector
    // del ángulo de llegada — la torta crece irregular y orgánica y se
    // uniformiza al llenarse, como en el tazón real.
    sim.bowlTracer.cakeSectors = new Array(CAKE_SECTORS).fill(0);
    sim.bowlTracer.nRetenidas = 0;
    sim.bowlTracer.nEscapadas = 0;
    if (typeof Scene3D !== "undefined" && Scene3D.setBowlSwarmSizes) {
      Scene3D.setBowlSwarmSizes(swarm.map((p) => p.dpFactor));
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Definición de grupos de sliders por equipo
  // -----------------------------------------------------------------------
  function paramGroups(equip) {
    const s = state[equip];
    if (equip === "decanter") {
      return [
        { title: "Accionamiento", params: [
          { key: "rpm", label: "Velocidad de rotación (n)", min: 500, max: 6000, step: 50, decimals: 0, unit: "rpm", accent: ACCENT.heavy, value: s.rpm }
        ]},
        { title: "Geometría de compuertas", params: [
          { key: "rA", label: "Radio compuerta pesada (r_A)", min: 0.08, max: 0.15, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.heavy, value: s.rA },
          { key: "rB", label: "Radio compuerta ligera (r_B)", min: 0.02, max: 0.07, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.light, value: s.rB }
        ]},
        { title: "Propiedades de fluidos", params: [
          { key: "rhoA", label: "Densidad fase pesada (ρ_A)", min: 950, max: 1200, step: 5, decimals: 0, unit: "kg/m³", accent: ACCENT.heavy, value: s.rhoA },
          { key: "rhoB", label: "Densidad fase ligera (ρ_B)", min: 700, max: 950, step: 5, decimals: 0, unit: "kg/m³", accent: ACCENT.light, value: s.rhoB }
        ]}
      ];
    }
    if (equip === "bowl") {
      return [
        { title: "Accionamiento", params: [
          { key: "rpm", label: "Velocidad de rotación (n)", min: 1000, max: 12000, step: 100, decimals: 0, unit: "rpm", accent: ACCENT.heavy, value: s.rpm }
        ]},
        { title: "Sedimentación", params: [
          { key: "r", label: "Radio de evaluación (r)", min: 0.05, max: 0.18, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.light, value: s.r },
          { key: "Dp", label: "Diámetro de partícula (D_p)", min: 1, max: 100, step: 1, decimals: 0, unit: "µm", accent: ACCENT.solids, value: s.Dp },
          { key: "rhoP", label: "Densidad de partícula (ρ_p)", min: 1200, max: 3000, step: 25, decimals: 0, unit: "kg/m³", accent: ACCENT.solids, value: s.rhoP }
        ]},
        { title: "Fluido continuo", params: [
          { key: "rho", label: "Densidad del líquido (ρ)", min: 950, max: 1100, step: 5, decimals: 0, unit: "kg/m³", accent: ACCENT.light, value: s.rho },
          { key: "mu", label: "Viscosidad (μ)", min: 0.0005, max: 0.01, step: 0.0005, decimals: 4, unit: "Pa·s", accent: ACCENT.light, value: s.mu }
        ]},
        { title: "Operación por lote", params: [
          { key: "tProceso", label: "Tiempo de proceso disponible", min: 10, max: 400, step: 5, decimals: 0, unit: "s", accent: ACCENT.green, value: s.tProceso }
        ]}
      ];
    }
    // pump
    return [
      { title: "Velocidad de operación", params: [
        { key: "n", label: `Velocidad actual (n) · ref. ${PUMP_N_REF} rpm`, min: 300, max: 3600, step: 25, decimals: 0, unit: "rpm", accent: ACCENT.heavy, value: s.n }
      ]},
      { title: "Punto de referencia (n_ref)", params: [
        { key: "q1", label: "Capacidad de diseño (q₁)", min: 5, max: 100, step: 1, decimals: 0, unit: "m³/h", accent: ACCENT.light, value: s.q1 },
        { key: "H1", label: "Carga de diseño (ΔH₁)", min: 5, max: 80, step: 1, decimals: 0, unit: "m", accent: ACCENT.light, value: s.H1 },
        { key: "P1", label: "Potencia de diseño (P₁)", min: 0.5, max: 50, step: 0.5, decimals: 1, unit: "kW", accent: ACCENT.heavy, value: s.P1 }
      ]},
      { title: "Impulsor y fluido", params: [
        { key: "r1imp", label: "Radio del ojo (r₁)", min: 0.02, max: 0.08, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.green, value: s.r1imp },
        { key: "r2imp", label: "Radio exterior (r₂)", min: 0.08, max: 0.25, step: 0.005, decimals: 3, unit: "m", accent: ACCENT.heavy, value: s.r2imp },
        { key: "rho", label: "Densidad del fluido (ρ)", min: 700, max: 1200, step: 10, decimals: 0, unit: "kg/m³", accent: ACCENT.light, value: s.rho }
      ]},
      { title: "Succión / NPSH", params: [
        { key: "Pvapor", label: "Presión de vapor (P_v)", min: 500, max: 50000, step: 100, decimals: 0, unit: "Pa", accent: ACCENT.light, value: s.Pvapor },
        { key: "zs", label: "Altura de succión (z_s)", min: -5, max: 5, step: 0.1, decimals: 1, unit: "m", accent: ACCENT.green, value: s.zs },
        { key: "npshReq", label: "NPSH requerido (fabricante)", min: 1, max: 8, step: 0.1, decimals: 1, unit: "m", accent: ACCENT.heavy, value: s.npshReq }
      ]}
    ];
  }

  // -----------------------------------------------------------------------
  // §1. CÁLCULO Y RENDER — DECANTADOR L-L
  //
  // Modelo dinámico: r_i (equilibrio hidrostático) se recalcula al
  // instante con cada cambio de parámetro — es la posición de EQUILIBRIO
  // objetivo. Pero la interfase física NO salta ahí de inmediato: migra
  // suavemente (Engine.relajarZonaNeutra, en Scene3D.stepDecanter, llamado
  // desde stepSimulation() en cada frame mientras el cronómetro corre).
  // Las gráficas 1 (r_i vs t) y 2 (P en pared vs t) son streaming y se
  // alimentan también desde stepSimulation(); aquí solo se fija el
  // objetivo y se refresca todo lo instantáneo (readouts, alerta, chart 3).
  // -----------------------------------------------------------------------
  function computeDecanter() {
    const s = state.decanter;
    const omega = Engine.rpmToOmega(s.rpm);
    const zn = Engine.zonaNeutra({ rhoA: s.rhoA, rhoB: s.rhoB, rA: s.rA, rB: s.rB, rWall: DEC_R_WALL });

    // ΔP anular total, calculado por FASES (el anillo no es homogéneo):
    // columna ligera (ρ_B) de r_B a r_i + columna pesada (ρ_A) de r_i a la
    // pared. Si la interfase no es válida se omite (—).
    let totalDP = { deltaP: NaN };
    if (zn.valido) {
      const dpLight = Engine.presionAnular({ rho: s.rhoB, omega, r1: s.rB, r2: zn.ri });
      const dpHeavy = Engine.presionAnular({ rho: s.rhoA, omega, r1: zn.ri, r2: DEC_R_WALL });
      totalDP = { deltaP: dpLight.deltaP + dpHeavy.deltaP };
    }

    // Fija el nuevo objetivo de equilibrio; la transición geométrica suave
    // ocurre cuadro a cuadro en Scene3D.stepDecanter() vía stepSimulation()
    Scene3D.updateDecanter(zn, SCALE_R_DECANTER);

    // Chart 3 — sensibilidad de la interfase a la diferencia de densidad.
    // Con la fórmula correcta, r_i crece sin límite al acercarse ρ_B a ρ_A
    // (singularidad física): los puntos donde r_i sale del equipo
    // (inundación de pared) se dibujan como null para que la curva se
    // corte exactamente en el límite operable — esa interrupción ES la
    // lectura pedagógica de la gráfica.
    const sweep = [];
    const rhoBMin = 700, rhoBMax = s.rhoA * 0.999;
    for (let i = 0; i <= 40; i++) {
      const rhoB = rhoBMin + (i / 40) * (rhoBMax - rhoBMin);
      const znS = Engine.zonaNeutra({ rhoA: s.rhoA, rhoB, rA: s.rA, rB: s.rB, rWall: DEC_R_WALL });
      sweep.push({ diff: znS.diffPorcentual, ri: znS.valido ? znS.ri : null });
    }
    let nearestIdx = 0, nearestDist = Infinity;
    sweep.forEach((p, i) => { const d = Math.abs(p.diff - zn.diffPorcentual); if (d < nearestDist) { nearestDist = d; nearestIdx = i; } });
    const markerData = sweep.map((p, i) => (i === nearestIdx ? (zn.valido ? zn.ri : null) : null));
    Charts.renderThirdChart({
      labels: sweep.map(p => p.diff.toFixed(1)), xLabel: "Δρ (%)", yLabel: "r_i (m)",
      datasets: [
        { label: "r_i(Δρ)", data: sweep.map(p => p.ri), color: Charts.PALETTE.light },
        { label: "Estado actual", data: markerData, color: zn.inestable ? "#E5484D" : Charts.PALETTE.green, point: true }
      ]
    });

    UI.setChartMeta(1, "Migración de la Interfase", "r_i(t) → equilibrio");
    UI.setChartMeta(2, "Presión en Pared vs. Tiempo", "P(r_pared, t)");
    UI.setChartMeta(3, "Estabilidad de la Interfase (referencia)", "r_i(Δρ)");

    UI.renderReadouts([
      { label: "Velocidad angular", value: UI.fmt(omega, 1), unit: "rad/s", status: "good" },
      { label: "Radio de interfase r_i (equilibrio)", value: zn.valido ? UI.fmt(zn.ri, 4) : "—", unit: "m", status: zn.valido ? "good" : "bad" },
      { label: "Diferencia de densidad Δρ", value: UI.fmt(zn.diffPorcentual, 2), unit: "%", status: zn.inestable ? "bad" : "good" },
      { label: "ΔP anular total", value: zn.valido ? UI.fmt(totalDP.deltaP / 1000, 2) : "—", unit: "kPa", status: zn.valido ? "good" : "bad" }
    ]);

    if (!zn.valido) {
      // La fórmula da r_i fuera del anillo físico [r_A, r_pared]: con esta
      // combinación de compuertas y densidades la interfase no puede
      // sostenerse dentro del equipo (arrastre por una compuerta o
      // inundación de la pared).
      const causa = zn.riRaw > DEC_R_WALL
        ? `r_i calculado (${UI.fmt(zn.riRaw, 3)} m) supera el radio de pared (${DEC_R_WALL} m): la fase pesada queda desplazada por completo — inundación. Aumente Δρ o ajuste las compuertas.`
        : `r_i calculado cae por debajo de la compuerta pesada r_A: la fase pesada sería arrastrada por la descarga ligera. Ajuste r_A/r_B o las densidades.`;
      UI.setAlert("bad", "Interfase fuera del rango operable", causa);
      UI.setStatusLed("bad", "FUERA DE RANGO");
    } else if (zn.inestable) {
      UI.setAlert("bad", "Operación inestable", "La diferencia de densidades entre fases es menor al 3%: la posición de la interfase se vuelve extremadamente sensible (el denominador ρ_A−ρ_B tiende a cero) y la separación deja de ser efectiva.");
      UI.setStatusLed("bad", "INESTABLE");
    } else {
      UI.setAlert("good", "Operación estable", "La diferencia de densidades es suficiente para una separación efectiva.");
      UI.setStatusLed("good", "ESTABLE");
    }

    UI.setFootEq("Ecuación gobernante — Zona neutra", "r_i² = (ρ_A r_A² − ρ_B r_B²) / (ρ_A − ρ_B)");
    UI.setViewerTitle("Decantador Líquido-Líquido");
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "r_i → objetivo", value: zn.valido ? `${UI.fmt(zn.ri, 3)} m` : "fuera de rango" },
      { label: "Δρ", value: `${UI.fmt(zn.diffPorcentual, 1)} %` }
    ]);
  }

  // -----------------------------------------------------------------------
  // §2. CÁLCULO Y RENDER — PURIFICADOR DE TAZÓN (BOWL)
  // -----------------------------------------------------------------------
  const BOWL_WALL_R = 0.18; // m — radio interior de pared (fijo, referencia visual)

  // Modelo dinámico: la partícula trazadora se integra en tiempo real
  // (Engine.pasoSedimentacion, avanzada desde stepSimulation) desde
  // BOWL_R0 hasta BOWL_R2. Aquí se hace un pre-cálculo INSTANTÁNEO de la
  // trayectoria completa (Engine.trayectoriaSedimentacion) solo para
  // conocer t_residencia_teórico y poder emitir la alerta de "separación
  // incompleta" comparándolo contra el tiempo de proceso disponible — esa
  // integración auxiliar no dibuja nada, es un cálculo de verificación.
  function computeBowl() {
    const s = state.bowl;
    const omega = Engine.rpmToOmega(s.rpm);
    const DpM = s.Dp * 1e-6;
    const ut = Engine.velocidadTerminalStokes({ Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, r: s.r, mu: s.mu });

    // Tiempo de residencia teórico para SEPARACIÓN COMPLETA de la
    // partícula de diseño (D_p actual) — integración auxiliar, no streaming
    const trayTeorica = Engine.trayectoriaSedimentacion({
      r0: BOWL_R0, Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu, r2: BOWL_R2
    });
    sim.bowlTracer.tResidenciaTeorico = trayTeorica.tResidenciaTeorico;
    sim.bowlTracer.convergeTeorico = trayTeorica.convergio;

    // Chart 3 — curva estática de referencia u_t vs D_p (útil junto a la
    // gráfica evolutiva de concentración; permite ubicar visualmente si el
    // D_p actual sedimenta rápido o lento respecto al resto de tamaños)
    const curvaUt = Engine.curvaUtVsDp({ rhoP: s.rhoP, rho: s.rho, omega, r: s.r, mu: s.mu, DpMin: 1e-6, DpMax: 100e-6, nPuntos: 40 });
    const markerData = curvaUt.map(p => (Math.abs(p.Dp - DpM) < (100e-6 / 40) ? p.ut * 1000 : null));

    UI.setChartMeta(1, "Posición Radial de Partícula", "r(t), trazador");
    UI.setChartMeta(2, "Velocidad Radial vs. Tiempo", "dr/dt (t)");
    UI.setChartMeta(3, "Concentración Acumulada en Pared", "torta(t)");

    const regimen = ut.regimenValido;
    const tDisp = s.tProceso;
    const tReq = trayTeorica.tResidenciaTeorico;
    const separacionIncompleta = trayTeorica.convergio && tReq > tDisp;

    UI.renderReadouts([
      { label: "Velocidad angular", value: UI.fmt(omega, 1), unit: "rad/s", status: "good" },
      { label: "Velocidad terminal u_t (inicial)", value: UI.fmt(ut.ut * 1000, 3), unit: "mm/s", status: "good" },
      { label: "Reynolds de partícula", value: UI.fmt(ut.Rep, 4), unit: "", status: regimen ? "good" : "warn" },
      { label: "t. residencia requerido", value: trayTeorica.convergio ? UI.fmt(tReq, 1) : "—", unit: "s", status: separacionIncompleta ? "bad" : "good" }
    ]);

    if (!regimen) {
      UI.setAlert("warn", "Régimen fuera de Stokes", "Re_p ≥ 1: la ley de Stokes ya no describe con precisión la sedimentación de esta partícula; reduzca D_p o la velocidad, o use un modelo intermedio/Newton.");
      UI.setStatusLed("warn", "FUERA DE STOKES");
    } else if (separacionIncompleta) {
      UI.setAlert("bad", "Separación incompleta: partículas presentes en el efluente", `El tiempo de residencia requerido (${UI.fmt(tReq, 1)} s) supera el tiempo de proceso disponible (${tDisp.toFixed(0)} s): la partícula no alcanza la pared antes de salir del equipo.`);
      UI.setStatusLed("bad", "SEPARACIÓN INCOMPLETA");
    } else if (!trayTeorica.convergio) {
      UI.setAlert("warn", "Sedimentación despreciable", "La velocidad de asentamiento es prácticamente nula con estos parámetros (ρ_p ≈ ρ o D_p muy pequeño): la partícula no converge a la pared en un tiempo razonable.");
      UI.setStatusLed("warn", "SIN SEDIMENTACIÓN");
    } else {
      UI.setAlert("good", "Sedimentación en régimen de Stokes", `El número de Reynolds de partícula es menor a 1 y la partícula alcanza la pared en ${UI.fmt(tReq, 1)} s, dentro del tiempo de proceso disponible.`);
      UI.setStatusLed("good", "ESTABLE");
    }

    UI.setFootEq("Ecuación gobernante — Sedimentación centrífuga (ODE)", "dr/dt = ω² r D_p²(ρ_p−ρ) / 18μ");
    UI.setViewerTitle("Purificador de Tazón");
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "u_t (inicial)", value: `${UI.fmt(ut.ut * 1000, 2)} mm/s` },
      { label: "Re_p", value: UI.fmt(ut.Rep, 3) }
    ]);
  }

  // -----------------------------------------------------------------------
  // §3. CÁLCULO Y RENDER — BOMBA CENTRÍFUGA
  // -----------------------------------------------------------------------
  // Modelo dinámico: al fijar/ajustar n, se define un nuevo objetivo de ω;
  // el arranque real (ω animada aproximándose a ese objetivo) lo resuelve
  // Scene3D.stepPump() en cada frame. Charts 1 y 2 (ω(t) y P(pared,t))
  // se alimentan desde stepSimulation con la ω ANIMADA (real, de arranque),
  // no la de régimen permanente — así se ve crecer la presión junto con
  // la velocidad, tal como pide el enunciado.
  function computePump() {
    const s = state.pump;
    const omega = Engine.rpmToOmega(s.n);

    // Objetivo de arranque — Scene3D.stepPump() relajará omegaAnimada hacia esto
    Scene3D.updatePumpTarget(omega);

    const afin = Engine.leyesAfinidad({ q1: s.q1, H1: s.H1, P1: s.P1, n1: PUMP_N_REF, n2: s.n });
    const npshDisp = Engine.npshDisponible({ Pvapor: s.Pvapor, rho: s.rho, zs: s.zs, hf: 0 });
    const cav = Engine.evaluarCavitacion({ npshDisp, npshReq: s.npshReq });

    UI.setChartMeta(1, "Velocidad Angular — Arranque", "ω(t) → ω_reg");
    UI.setChartMeta(2, "Presión en Pared vs. Tiempo", "P(r₂, t)");
    UI.setChartMeta(3, "Curva Característica", `H(q) @ n animado`);

    UI.renderReadouts([
      { label: "Velocidad angular objetivo", value: UI.fmt(omega, 1), unit: "rad/s", status: "good" },
      { label: "Capacidad q₂ (régimen)", value: UI.fmt(afin.q2, 1), unit: "m³/h", status: "good" },
      { label: "Carga ΔH₂ (régimen)", value: UI.fmt(afin.H2, 2), unit: "m", status: "good" },
      { label: "Potencia P₂ (régimen)", value: UI.fmt(afin.P2, 2), unit: "kW", status: "good" },
      { label: "NPSH disponible", value: UI.fmt(npshDisp, 2), unit: "m", status: cav.estado === "segura" ? "good" : cav.estado === "riesgo" ? "warn" : "bad" },
      { label: "Margen de cavitación", value: UI.fmt(cav.margen, 2), unit: "m", status: cav.estado === "segura" ? "good" : cav.estado === "riesgo" ? "warn" : "bad" }
    ]);

    if (cav.estado === "cavitacion") {
      UI.setAlert("bad", "Riesgo de cavitación: NPSH insuficiente", "El NPSH disponible es menor al requerido: la presión de succión cae por debajo de la presión de vapor y se forman burbujas de vapor que dañan el impulsor.");
      UI.setStatusLed("bad", "CAVITACIÓN");
    } else if (cav.estado === "riesgo") {
      UI.setAlert("warn", "Riesgo de cavitación: NPSH insuficiente", "El margen de NPSH es menor al margen de seguridad recomendado (0.5 m). Considere reducir z_s negativo, aumentar presión de succión o reducir n.");
      UI.setStatusLed("warn", "RIESGO NPSH");
    } else {
      UI.setAlert("good", "Succión segura", "El NPSH disponible supera con margen suficiente al NPSH requerido por el fabricante.");
      UI.setStatusLed("good", "ESTABLE");
    }

    UI.setFootEq("Ecuación gobernante — Leyes de afinidad", "q₂/q₁=n₂/n₁ · ΔH₂/ΔH₁=(n₂/n₁)² · P₂/P₁=(n₂/n₁)³");
    UI.setViewerTitle("Bomba Centrífuga (Corte Transversal)");
    UI.setViewerHud([
      { label: "n → objetivo", value: `${s.n.toFixed(0)} rpm` },
      { label: "ΔH (régimen)", value: `${UI.fmt(afin.H2, 1)} m` },
      { label: "NPSH", value: `${UI.fmt(npshDisp, 1)} m` }
    ]);
  }

  const COMPUTE = { decanter: computeDecanter, bowl: computeBowl, pump: computePump };

  function recompute() {
    COMPUTE[currentEquip]();
  }

  // =========================================================================
  // MOTOR DE SIMULACIÓN — avanza cuadro a cuadro solo el equipo activo,
  // solo mientras sim.playing es true, con dt escalado por sim.speed.
  // Se registra como frameCallback de Scene3D (llamado desde su propio
  // requestAnimationFrame, con el dt real ya acotado a 0.1 s máx).
  // =========================================================================
  function stepSimulation(dtReal) {
    if (!sim.playing) return;
    const dtSim = dtReal * sim.speed;
    sim.t[currentEquip] += dtSim;
    UI.setSimTime(sim.t[currentEquip]);

    if (currentEquip === "decanter") stepDecanterSim(dtSim);
    else if (currentEquip === "bowl") stepBowlSim(dtSim);
    else if (currentEquip === "pump") stepPumpSim(dtSim);
  }

  function stepDecanterSim(dtSim) {
    const s = state.decanter;
    const omega = Engine.rpmToOmega(s.rpm);

    Scene3D.stepDecanter(dtSim);
    const d = Scene3D.dynamic.decanter;
    if (!d || Number.isNaN(d.riAnimado)) return;
    const riReal = d.riAnimado / SCALE_R_DECANTER;

    // Chart 1 — r_i(t): migración de la interfase hacia el equilibrio
    Charts.pushStreamPoint(Charts.chart1, sim.t.decanter,
      [{ label: "r_i(t)", color: Charts.PALETTE.light, value: riReal }], "t (s)", "r_i (m)");

    // Chart 2 — P(pared, t): presión de la columna pesada desde la
    // interfase animada hasta la pared del tazón (cambia mientras r_i migra)
    const dp = Engine.presionAnular({ rho: s.rhoA, omega, r1: riReal, r2: DEC_R_WALL });
    Charts.pushStreamPoint(Charts.chart2, sim.t.decanter,
      [{ label: "P(pared)", color: Charts.PALETTE.heavy, value: dp.deltaP / 1000 }], "t (s)", "P (kPa)");

    const zn = Engine.zonaNeutra({ rhoA: s.rhoA, rhoB: s.rhoB, rA: s.rA, rB: s.rB, rWall: DEC_R_WALL });
    const errorRel = zn.valido ? Math.abs(riReal - zn.ri) / (zn.ri || 1) : 0;
    const fraccion = zn.valido ? Math.min(Math.max(1 - errorRel / 0.02, 0), 1) : 0; // ≈ converge cuando el error es < 2%
    UI.setSimProgress(fraccion, !zn.valido ? "Interfase fuera del rango operable" : fraccion >= 0.98 ? "Interfase en equilibrio" : `Migrando hacia el equilibrio · r_i = ${riReal.toFixed(4)} m`);
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "r_i(t)", value: `${riReal.toFixed(3)} m` },
      { label: "Δρ", value: `${UI.fmt(zn.diffPorcentual, 1)} %` }
    ]);
  }

  function stepBowlSim(dtSim) {
    const s = state.bowl;
    const omega = Engine.rpmToOmega(s.rpm);
    const DpM = s.Dp * 1e-6;
    const bt = sim.bowlTracer;

    const paso = Engine.pasoSedimentacion({ r: bt.r, Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu, dt: dtSim, r2: BOWL_R2 });
    bt.r = paso.r;

    if (paso.llegoAPared) {
      bt.ciclos += 1;
      // Modelo de acumulación asintótica de torta: cada ciclo completado
      // (una "carga" de sólidos que alcanza la pared) aporta una fracción
      // decreciente de espacio libre restante — satura suavemente hacia 1,
      // representando que la capacidad de acumulación de la pared es finita.
      bt.cakeFraction = 1 - Math.exp(-bt.ciclos / 6);
      bt.r = BOWL_R0; // recicla el trazador: nueva partícula entra por el centro
    }

    const rScene = bt.r * SCALE_R_BOWL;
    Scene3D.setBowlTracerRadius(rScene, dtSim);

    // ------------------------------------------------------------------
    // ENJAMBRE — integración por partícula (ver initBowlSwarm):
    //  1. u_t(r) local de Stokes con SU D_p (Engine.drdt — física intacta)
    //  2. Inercia: relajación exponencial exacta de vr hacia u_t
    //     (estable incluso con dt de frame a 20x). El τ físico de una
    //     partícula de micras es de µs; el piso de 0.03 s es un artificio
    //     de visualización (mismo criterio que relajarZonaNeutra §8).
    //  3. Turbulencia OU en r e y (media cero, correlación TURB_TAU)
    //  4. Flujo axial de proceso: vyFlow = altura útil / tProceso — el
    //     líquido arrastra la partícula hacia la descarga superior
    //  5. Desenlace de la carrera radial-vs-axial:
    //     · toca la superficie interna de la TORTA de su sector → RETENIDA
    //     · alcanza el tope (y > +0.36) sin llegar a la pared → ESCAPA
    // ------------------------------------------------------------------
    const cakeMaxThick = 0.035; // m — espesor máximo de torta (≈20% del radio)
    const sectors = bt.cakeSectors;
    const vyFlow = 0.72 / Math.max(s.tProceso, 1); // fracción de altura / s de proceso
    const swarmStates = bt.swarm.map((p) => {
      if (p.settled) {
        p.stateTimer -= dtSim;
        if (p.stateTimer <= 0) freshParticle(p);
        return { r: p.r * SCALE_R_BOWL, ang: p.ang, y: p.y, settled: true, escaped: false };
      }
      if (p.escaped) {
        p.stateTimer -= dtSim;
        p.y += dtSim * 0.35; // sigue subiendo por la descarga mientras se desvanece
        if (p.stateTimer <= 0) freshParticle(p);
        return { r: p.r * SCALE_R_BOWL, ang: p.ang, y: p.y, settled: false, escaped: true };
      }

      const Dp_i = DpM * p.dpFactor;
      const ut = Engine.drdt({ r: p.r, Dp: Dp_i, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu });
      const tauP = Math.max((s.rhoP * Dp_i * Dp_i) / (18 * s.mu), 0.03);
      p.vr += (ut - p.vr) * (1 - Math.exp(-dtSim / tauP));

      const ouK = Math.min(dtSim / TURB_TAU, 1);
      const ouNoise = TURB_SIGMA * Math.sqrt(2 * ouK);
      p.uTurbR += -p.uTurbR * ouK + ouNoise * gaussian();
      p.uTurbY += -p.uTurbY * ouK + ouNoise * gaussian();

      p.r = Math.max(p.r + (p.vr + p.uTurbR) * dtSim, BOWL_R0 * 0.5);
      p.y = Math.min(Math.max(p.y + (vyFlow + p.uTurbY * 8) * dtSim, -0.38), 0.42);
      p.ang += dtSim * (0.05 + 0.25 * (p.r / BOWL_R2)); // slip angular ∝ r

      const secIdx = ((Math.floor((p.ang / (Math.PI * 2)) * CAKE_SECTORS) % CAKE_SECTORS) + CAKE_SECTORS) % CAKE_SECTORS;
      const cakeInnerR = BOWL_R2 - sectors[secIdx] * cakeMaxThick;

      if (p.r >= cakeInnerR) {
        p.r = cakeInnerR; p.vr = 0; p.settled = true;
        p.stateTimer = SETTLE_REST_TIME * (0.7 + Math.random() * 0.6);
        bt.nRetenidas += 1;
        const add = (1 - sectors[secIdx]) * 0.055; // saturación suave + difusión a vecinos
        sectors[secIdx] = Math.min(1, sectors[secIdx] + add);
        sectors[(secIdx + 1) % CAKE_SECTORS] = Math.min(1, sectors[(secIdx + 1) % CAKE_SECTORS] + add * 0.35);
        sectors[(secIdx - 1 + CAKE_SECTORS) % CAKE_SECTORS] = Math.min(1, sectors[(secIdx - 1 + CAKE_SECTORS) % CAKE_SECTORS] + add * 0.35);
      } else if (p.y >= 0.36) {
        p.escaped = true; p.stateTimer = ESCAPE_TRAVEL_TIME;
        bt.nEscapadas += 1;
      }
      return { r: p.r * SCALE_R_BOWL, ang: p.ang, y: p.y, settled: p.settled, escaped: p.escaped };
    });
    Scene3D.setBowlSwarm(swarmStates);

    // Métrica de torta = promedio real de sectores (misma acumulación que
    // se ve crecer en 3D — una sola fuente de verdad); ciclos del trazador
    // aporta como cota inferior histórica.
    const sectorMean = sectors.reduce((a, b) => a + b, 0) / CAKE_SECTORS;
    bt.cakeFraction = Math.max(bt.cakeFraction, sectorMean);
    Scene3D.setBowlCake(bt.cakeFraction, sectors);

    // Chart 1 — r(t) del trazador
    Charts.pushStreamPoint(Charts.chart1, sim.t.bowl,
      [{ label: "r(t)", color: Charts.PALETTE.light, value: bt.r }], "t (s)", "r (m)");

    // Chart 2 — velocidad radial instantánea dr/dt (mm/s) — se acelera con r
    const v = Engine.drdt({ r: bt.r, Dp: DpM, rhoP: s.rhoP, rho: s.rho, omega, mu: s.mu });
    Charts.pushStreamPoint(Charts.chart2, sim.t.bowl,
      [{ label: "dr/dt", color: Charts.PALETTE.heavy, value: v * 1000 }], "t (s)", "dr/dt (mm/s)");

    // Chart 3 — concentración acumulada en pared (fracción de torta)
    Charts.pushStreamPoint(Charts.chart3, sim.t.bowl,
      [{ label: "Torta acumulada", color: Charts.PALETTE.green, value: bt.cakeFraction }], "t (s)", "fracción");

    const fraccion = bt.r / BOWL_R2;
    const totSep = bt.nRetenidas + bt.nEscapadas;
    const retencion = totSep > 0 ? (100 * bt.nRetenidas / totSep) : null;
    UI.setSimProgress(fraccion, `${(fraccion * 100).toFixed(0)}% hacia la pared · ${bt.ciclos} ciclo(s)` +
      (retencion !== null ? ` · retención observada ${retencion.toFixed(0)}%` : ""));
    UI.setViewerHud([
      { label: "n", value: `${s.rpm.toFixed(0)} rpm` },
      { label: "r(t)", value: `${(bt.r * 1000).toFixed(1)} mm` },
      { label: "Retención", value: retencion !== null ? `${retencion.toFixed(0)} % (${bt.nRetenidas}/${totSep})` : "—" }
    ]);
  }

  function stepPumpSim(dtSim) {
    const s = state.pump;
    const omegaAnimada = Scene3D.stepPump(dtSim);
    if (omegaAnimada === null || Number.isNaN(omegaAnimada)) return;
    const nAnimada = Engine.omegaToRpm(omegaAnimada);

    // Chart 1 — ω(t) durante el arranque
    Charts.pushStreamPoint(Charts.chart1, sim.t.pump,
      [{ label: "ω(t)", color: Charts.PALETTE.heavy, value: omegaAnimada }], "t (s)", "ω (rad/s)");

    // Chart 2 — P(pared del impulsor) vs t, mientras ω se estabiliza
    const dpImp = Engine.presionAnular({ rho: s.rho, omega: omegaAnimada, r1: s.r1imp, r2: s.r2imp });
    Charts.pushStreamPoint(Charts.chart2, sim.t.pump,
      [{ label: "P(r₂)", color: Charts.PALETTE.light, value: dpImp.deltaP / 1000 }], "t (s)", "P (kPa)");

    // Chart 3 — curva característica H(q), recalculada en vivo con n animada
    // (se ve crecer/encoger conforme la bomba arranca hacia su régimen)
    const H0 = s.H1 * 1.25, qMax = s.q1 * 2.0;
    const curva = Engine.curvaCaracteristicaReescalada({ H0, qMax, n1: PUMP_N_REF, n2: nAnimada, nPuntos: 40 });
    Charts.renderThirdChart({
      labels: curva.puntos.map(p => p.q.toFixed(1)), xLabel: "q (m³/h)", yLabel: "H (m)",
      datasets: [{ label: `H(q) @ ${nAnimada.toFixed(0)} rpm`, data: curva.puntos.map(p => p.H), color: Charts.PALETTE.light }]
    });

    const afinAnimada = Engine.leyesAfinidad({ q1: s.q1, H1: s.H1, P1: s.P1, n1: PUMP_N_REF, n2: nAnimada });
    const fraccion = s.n > 0 ? Math.min(nAnimada / s.n, 1) : 1;
    UI.setSimProgress(fraccion, fraccion >= 0.98 ? "Régimen permanente alcanzado" : `Arrancando · ${nAnimada.toFixed(0)} / ${s.n.toFixed(0)} rpm`);
    UI.setViewerHud([
      { label: "n(t)", value: `${nAnimada.toFixed(0)} rpm` },
      { label: "ΔH(t)", value: `${UI.fmt(afinAnimada.H2, 1)} m` },
      { label: "P(r₂,t)", value: `${UI.fmt(dpImp.deltaP / 1000, 1)} kPa` }
    ]);
  }

  // Reinicia el cronómetro y el estado físico integrado del equipo activo
  // (no afecta a los otros equipos, cada uno lleva su propio reloj/estado)
  function resetSimulation() {
    sim.t[currentEquip] = 0;
    UI.setSimTime(0);
    Charts.resetAllStreams();

    if (currentEquip === "bowl") {
      sim.bowlTracer.r = BOWL_R0;
      sim.bowlTracer.ciclos = 0;
      sim.bowlTracer.cakeFraction = 0;
      initBowlSwarm();
      Scene3D.resetBowlTracer();
      Scene3D.resetBowlSwarm();
      UI.setSimProgress(0, "0% hacia la pared");
    } else if (currentEquip === "pump") {
      const d = Scene3D.dynamic.pump;
      if (d) d.omegaAnimada = 0; // el motor arranca desde reposo en el próximo Play
      UI.setSimProgress(0, "Detenida · 0 rpm");
    } else if (currentEquip === "decanter") {
      UI.setSimProgress(0, "—");
    }
    recompute();
  }

  // -----------------------------------------------------------------------
  // Cambio de equipo activo
  // -----------------------------------------------------------------------
  let currentEquip = "decanter";

  function switchEquip(name) {
    currentEquip = name;
    document.querySelectorAll(".equip-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.equip === name);
    });
    Scene3D.setEquip(name);
    UI.renderParams(paramGroups(name), (key, value) => {
      state[name][key] = value;
      recompute();
    });
    Charts.resetAllStreams();
    UI.setSimTime(sim.t[name]);
    UI.setSimProgress(0, "—");
    recompute();
  }

  // -----------------------------------------------------------------------
  // Arranque de la aplicación
  // -----------------------------------------------------------------------
  function init() {
    Charts.init();
    Scene3D.init(document.getElementById("viewer3d"));

    // Conecta el cronómetro de simulación al loop de render de Scene3D:
    // cada frame (dt real ya acotado a 0.1s) invoca stepSimulation(), que
    // solo avanza la física del equipo activo mientras sim.playing es true.
    Scene3D.setFrameCallback(stepSimulation);

    document.getElementById("equipSelect").addEventListener("click", (e) => {
      const btn = e.target.closest(".equip-tab");
      if (!btn) return;
      switchEquip(btn.dataset.equip);
    });

    document.getElementById("btnReset").addEventListener("click", () => Scene3D.resetCamera());

    const btnSpin = document.getElementById("btnSpin");
    btnSpin.classList.add("active");
    btnSpin.addEventListener("click", () => {
      const active = btnSpin.classList.toggle("active");
      Scene3D.setSpinning(active);
    });

    // Selector de vista — Industrial (carcasa cerrada, aspecto real de
    // planta) vs. Interior (carcasa traslúcida, ve el proceso por dentro)
    document.getElementById("viewModeGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".view-mode-btn");
      if (!btn) return;
      const mode = btn.dataset.mode;
      Scene3D.setViewMode(mode);
      document.querySelectorAll(".view-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    });
    Scene3D.setViewMode("interior");

    window.addEventListener("resize", () => Scene3D.resize());

    // Transporte del cronómetro — funciones compartidas por la UI de
    // escritorio y por el panel de control del modo AR (window.Centrix)
    function setPlaying(v) {
      sim.playing = v;
      UI.setPlayingState(v);
      if (typeof AR !== "undefined" && AR.syncTransport) AR.syncTransport();
    }
    function setSpeed(v) {
      sim.speed = v;
      UI.setSpeedActive(v);
      if (typeof AR !== "undefined" && AR.syncTransport) AR.syncTransport();
    }

    document.getElementById("simPlay").addEventListener("click", () => setPlaying(true));
    document.getElementById("simPause").addEventListener("click", () => setPlaying(false));
    document.getElementById("simReset").addEventListener("click", () => resetSimulation());

    // Selector de velocidad (1x / 2x / 5x / 20x)
    document.getElementById("simSpeedGroup").addEventListener("click", (e) => {
      const btn = e.target.closest(".speed-btn");
      if (!btn) return;
      setSpeed(parseFloat(btn.dataset.speed));
    });

    // ---------------------------------------------------------------------
    // API PÚBLICA (window.Centrix) — puente controlado para el modo AR:
    // le permite leer/escribir parámetros, controlar Play/Pausa/Reset/
    // velocidad, cambiar de equipo y consultar el estado, sin exponer los
    // internos del IIFE. Es la base de la "paridad AR": el panel de
    // parámetros y el transporte dentro de AR usan exactamente las mismas
    // rutas de código (updateParam → recompute, setPlaying, resetSimulation,
    // switchEquip) que la UI de escritorio — no puede haber desincronización.
    // ---------------------------------------------------------------------
    window.Centrix = {
      getCurrentEquip: () => currentEquip,
      switchEquip: (name) => switchEquip(name),
      getParamGroups: () => paramGroups(currentEquip),
      getParam: (key) => state[currentEquip][key],
      updateParam: (key, value) => {
        state[currentEquip][key] = value;
        // Mantiene el slider y la lectura de escritorio en sincronía, con
        // los decimales/unidad definidos para ese parámetro.
        let meta = null;
        paramGroups(currentEquip).forEach((g) => g.params.forEach((p) => { if (p.key === key) meta = p; }));
        UI.updateParamDisplay(key, value, meta ? meta.decimals : 2, meta ? meta.unit : "");
        recompute();
      },
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      togglePlay: () => setPlaying(!sim.playing),
      reset: () => resetSimulation(),
      setSpeed,
      isPlaying: () => sim.playing,
      getSpeed: () => sim.speed,
      getSimTime: () => sim.t[currentEquip]
    };

    // Estado inicial del transporte: en pausa, 2x (coincide con el HTML)
    UI.setPlayingState(sim.playing);
    UI.setSpeedActive(sim.speed);

    initBowlSwarm();
    switchEquip("decanter");

    // Red de seguridad para móvil: tras el primer layout (y de nuevo un
    // instante después, ya con las pestañas móviles aplicadas), se fuerza
    // un resize del canvas 3D. Sin esto, en algunos teléfonos el visor
    // arranca con tamaño 0 y se queda negro hasta cambiar de pestaña.
    requestAnimationFrame(() => Scene3D.resize());
    setTimeout(() => Scene3D.resize(), 300);
    window.addEventListener("load", () => Scene3D.resize());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
