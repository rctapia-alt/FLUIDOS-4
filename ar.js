/* =========================================================================
   AR.JS — Modo de Realidad Aumentada SIN MARCADOR ("modo cámara")
   ---------------------------------------------------------------------
   El estudiante abre la cámara y el modelo 3D del equipo aparece flotando
   centrado frente a ella (una "calcomanía 3D" sobre el vídeo). No hay
   marcador Hiro que imprimir ni al que apuntar, ni tracking del entorno:
   el modelo se coloca a una distancia fija delante de la cámara y el alumno
   lo manipula con gestos (1 dedo = orbitar, 2 dedos = escalar y mover).

   Ventaja: funciona en CUALQUIER móvil con cámara (iPhone incluido) porque
   solo usa getUserMedia — no depende de AR.js/ArToolkit, ni de ARCore/ARKit,
   ni de WebXR. El fondo es simplemente el <video> de la cámara trasera a
   pantalla completa; encima se renderiza la escena Three.js con una cámara
   en perspectiva normal.

   Estrategia de integración (clave para no duplicar el motor 3D): en vez de
   reconstruir los modelos, este módulo REPARENTA de forma temporal el grupo
   Three.js del equipo activo (Scene3D.groups[equip]) desde la escena
   principal (oculta durante la sesión AR) hacia la escena AR, como hijo de
   placedRoot. Como son las MISMAS mallas, todo lo que ya anima
   main.js/scene3d.js (rotor girando, interfase migrando, trazador
   sedimentando, arranque de la bomba) se sigue viendo en AR sin escribir
   una sola línea de física nueva. Al salir, el grupo se devuelve intacto a
   la escena principal.

   Este módulo es independiente y opcional: si el navegador/dispositivo no
   tiene cámara o getUserMedia, el botón de AR se oculta y el resto del
   simulador sigue funcionando exactamente igual que antes.
   ========================================================================= */

const AR = (() => {

  // -----------------------------------------------------------------------
  // Estado interno
  // -----------------------------------------------------------------------
  let renderer, scene, camera;
  let videoEl = null;        // <video> de la cámara trasera (getUserMedia directo, sin AR.js)
  let videoStream = null;    // MediaStream para poder detener las pistas al salir
  let placedRoot = null;     // THREE.Group con el modelo — offset del usuario (rotar/escalar/mover)
  let equipGroup = null;     // referencia al Scene3D.groups[equip] reparentado
  let equipOriginalTransform = null; // para restaurar posición/rotación al salir
  let equipParentOriginal = null;    // escena original a la que devolver el grupo
  let running = false;
  let rafId = null;

  let labelsOn = true;
  let theoryMode = false;

  // Estado de colocación (modo SIN MARCADOR): el modelo aparece flotando
  // centrado frente a la cámara al pulsar "Colocar". No hay tracking del
  // entorno: es una calcomanía 3D sobre el vídeo, manipulable con gestos.
  let modelPlaced = false;

  // Gestos táctiles:
  //   1 dedo  = orbitar (girar el modelo en yaw + pitch para verlo desde
  //             cualquier ángulo)
  //   2 dedos = pellizco para escalar  +  arrastre para DESPLAZAR (pan) el
  //             modelo por la escena (izq/der, arriba/abajo)
  //   tap     = inspeccionar componente (modo teoría)
  const pointers = new Map();
  let gestureStartDist = null;
  let gestureStartScale = 1;
  let gestureStartMid = null;      // punto medio inicial de los 2 dedos (para el pan)
  let gestureStartOffset = null;   // placedRoot.position al empezar el pan
  let tapCandidate = null;         // {x,y,moved}

  // Profundidad (distancia a la cámara) a la que se coloca el modelo. El
  // modelo se centra en X=0, un poco abajo en Y, a esta Z negativa (la
  // cámara mira hacia -Z). El pinch escala; el pan mueve en X/Y.
  const PLACE_DEPTH = 6;

  // Límites de desplazamiento (pan) del modelo respecto al centro, en
  // unidades de mundo. Evita que el estudiante "pierda" el modelo
  // empujándolo fuera de cuadro sin querer.
  const PAN_LIMIT = 4.0;
  const PAN_SPEED = 0.012; // px de pantalla → unidades de mundo

  // -----------------------------------------------------------------------
  // Tamaño y orientación objetivo por equipo (modo SIN MARCADOR). El modelo
  // se coloca flotando frente a la cámara; baseScale fija su tamaño aparente
  // y liftY lo sube para que quede centrado verticalmente en el encuadre.
  // rotX/rotY dan una orientación de frente agradable. Todo es ajustable en
  // vivo con los gestos (pellizco para escalar, 1 dedo para orbitar).
  // -----------------------------------------------------------------------
  const AR_MODEL_INFO = {
    // rotX/rotY: orientación inicial de presentación. Los decantador/bowl
    // tienen su eje en Y (vertical) y se dejan casi rectos, con un leve
    // cabeceo para verlos en perspectiva. La bomba está modelada "acostada"
    // (eje de giro Z, con g.rotation.x=0.35 horneada): aquí se endereza y se
    // orienta para ver la voluta y el impulsor de frente.
    decanter: { baseScale: 0.34, liftY: 1.20, rotX: -0.12, rotY: 0.5,  label: "Decantador Líquido-Líquido" },
    bowl:     { baseScale: 0.40, liftY: 0.95, rotX: -0.12, rotY: 0.5,  label: "Purificador de Tazón" },
    pump:     { baseScale: 0.46, liftY: 0.55, rotX: -0.5,  rotY: 0.35, label: "Bomba Centrífuga" }
  };
  const SCALE_MIN = 0.4, SCALE_MAX = 2.5; // límites del gesto de pellizco (factor sobre baseScale)
  let userScale = 1;

  // -----------------------------------------------------------------------
  // §T. CONTENIDO TEÓRICO — "Mostrar teoría": al tocar un componente del
  // equipo aparece una ficha con su función, principio físico, ecuaciones,
  // variables/unidades, hipótesis del modelo y aplicaciones industriales.
  // Se indexa por equipo → clave del componente en Scene3D.dynamic[equip].
  // -----------------------------------------------------------------------
  const THEORY = {
    decanter: {
      shell: {
        nombre: "Carcasa (tazón rotatorio)",
        funcion: "Contiene ambas fases líquidas mientras giran solidariamente con el rotor.",
        principio: "Rotación de cuerpo rígido: todo el fluido gira a la misma ω, generando un campo de aceleración centrífuga ω²r que reemplaza a la gravedad como fuerza motriz de la separación.",
        ecuaciones: "P₂−P₁ = (ρω²/2)(r₂²−r₁²)",
        variables: "ρ: densidad [kg/m³] · ω: velocidad angular [rad/s] · r: radio [m]",
        hipotesis: "Flujo en rotación de cuerpo rígido, sin deslizamiento entre fluido y carcasa.",
        aplicaciones: "Separación líquido-líquido continua: aceite/agua, crudo/salmuera, extracción por solventes."
      },
      rotor: {
        nombre: "Rotor / tazón",
        funcion: "Estructura que gira y arrastra a las dos fases, generando el campo centrífugo.",
        principio: "La energía mecánica del accionamiento se transmite como aceleración centrífuga al fluido.",
        ecuaciones: "ω = 2πn/60",
        variables: "n: velocidad de rotación [rpm]",
        hipotesis: "Arranque instantáneo a ω constante en el modelo simplificado de equilibrio.",
        aplicaciones: "Común a todos los equipos centrífugos industriales."
      },
      heavyPhase: {
        nombre: "Fase pesada (ρ_A)",
        funcion: "Líquido de mayor densidad; migra hacia la pared exterior y descarga por la compuerta r_A.",
        principio: "La fuerza centrífuga es proporcional a ρ, así que la fase más densa siempre se ubica en el radio mayor en el equilibrio.",
        ecuaciones: "r_i² = (ρ_A r_A² − ρ_B r_B²)/(ρ_A − ρ_B)",
        variables: "ρ_A: densidad fase pesada [kg/m³] · r_A: radio compuerta pesada [m]",
        hipotesis: "Equilibrio hidrostático instantáneo en cada compuerta (P_atm en ambas).",
        aplicaciones: "Ej.: fase acuosa/salmuera en decantación de crudo."
      },
      lightPhase: {
        nombre: "Fase ligera (ρ_B)",
        funcion: "Líquido de menor densidad; migra hacia el eje y descarga por la compuerta r_B.",
        principio: "Análogo a la fase pesada, pero se ubica en el radio menor por tener menor ρ.",
        ecuaciones: "r_i² = (ρ_A r_A² − ρ_B r_B²)/(ρ_A − ρ_B)",
        variables: "ρ_B: densidad fase ligera [kg/m³] · r_B: radio compuerta ligera [m]",
        hipotesis: "Sin arrastre de gotas de una fase en la otra (separación ideal).",
        aplicaciones: "Ej.: fase oleosa en decantación de crudo."
      },
      iface: {
        nombre: "Interfase (r_i, zona neutra)",
        funcion: "Superficie cilíndrica que separa ambas fases; su radio de equilibrio fija el diseño de las compuertas.",
        principio: "Balance de presión: ambas columnas líquidas alcanzan P_atm en su respectiva compuerta, igualando presiones en r_i.",
        ecuaciones: "r_i² = (ρ_A r_A² − ρ_B r_B²)/(ρ_A − ρ_B)",
        variables: "r_i: radio de interfase [m]",
        hipotesis: "Disposición real rB < rA < r_i < r_pared. Estable solo si Δρ > 3%: al acercarse ρ_A a ρ_B el denominador (ρ_A−ρ_B) tiende a cero y r_i se dispara fuera del equipo (inundación).",
        aplicaciones: "Criterio de diseño de compuertas (gate plates) en decantadores centrífugos reales."
      },
      weirA: {
        nombre: "Compuerta pesada (r_A)",
        funcion: "Anillo de rebose por donde descarga la fase pesada.",
        principio: "Su radio fija, junto con r_B, la posición de equilibrio de la interfase.",
        ecuaciones: "r_i² = (ρ_A r_A² − ρ_B r_B²)/(ρ_A − ρ_B)",
        variables: "r_A: radio de la compuerta pesada [m]",
        hipotesis: "Descarga a presión atmosférica.",
        aplicaciones: "Ajustable en equipos reales cambiando el anillo (gate ring) instalado."
      },
      weirB: {
        nombre: "Compuerta ligera (r_B)",
        funcion: "Anillo de rebose por donde descarga la fase ligera.",
        principio: "Análogo a la compuerta pesada, en el radio menor.",
        ecuaciones: "r_i² = (ρ_A r_A² − ρ_B r_B²)/(ρ_A − ρ_B)",
        variables: "r_B: radio de la compuerta ligera [m]",
        hipotesis: "Descarga a presión atmosférica.",
        aplicaciones: "Ajustable en equipos reales cambiando el anillo (gate ring) instalado."
      }
    },
    bowl: {
      shell: {
        nombre: "Carcasa del purificador",
        funcion: "Encierra el tazón rotatorio donde sedimentan los sólidos.",
        principio: "Igual que en el decantador: rotación de cuerpo rígido genera el campo centrífugo.",
        ecuaciones: "u_t = D_p²(ρ_p−ρ)ω²r / 18μ",
        variables: "ω: velocidad angular [rad/s]",
        hipotesis: "Rotación de cuerpo rígido, sin deslizamiento.",
        aplicaciones: "Clarificación de aceites, purificación de combustibles, separación de lodos."
      },
      liquidSurface: {
        nombre: "Superficie líquida cilíndrica",
        funcion: "Representa la superficie libre del líquido, que a alta ω deja de ser un plano horizontal y se vuelve un cilindro vertical.",
        principio: "A ω alta, la aceleración centrífuga (ω²r) domina completamente sobre la gravedad (g), por lo que la superficie de equilibrio sigue la geometría del campo centrífugo.",
        ecuaciones: "ω²r ≫ g",
        variables: "r: radio de la superficie libre [m]",
        hipotesis: "Régimen de alta velocidad (factor de separación Σ = ω²r/g ≫ 1).",
        aplicaciones: "Concepto base del diseño de purificadores de tazón (bowl centrifuges)."
      },
      cake: {
        nombre: "Torta de sólidos",
        funcion: "Capa de partículas acumuladas contra la pared conforme avanza el proceso por lotes.",
        principio: "Cada partícula que alcanza la pared queda retenida; con el tiempo, la torta reduce el volumen líquido disponible.",
        ecuaciones: "Modelo de acumulación asintótica: fracción = 1 − e^(−ciclos/6)",
        variables: "ciclos: número de partículas que han llegado a la pared",
        hipotesis: "Capacidad de acumulación finita en la pared (saturación suave, no del libro, es un artificio de visualización).",
        aplicaciones: "Determina la frecuencia de limpieza/descarga de sólidos del equipo real."
      },
      tracer: {
        nombre: "Partícula trazadora",
        funcion: "Representa la trayectoria radial r(t) de una partícula típica, integrada paso a paso.",
        principio: "Ley de Stokes centrífuga: la velocidad de sedimentación es proporcional a D_p², a Δρ y al campo centrífugo local ω²r.",
        ecuaciones: "dr/dt = ω² r D_p²(ρ_p−ρ) / 18μ",
        variables: "D_p: diámetro de partícula [m] · ρ_p: densidad del sólido [kg/m³] · μ: viscosidad [Pa·s]",
        hipotesis: "Régimen de Stokes válido (Re_p < 1); partícula esférica y aislada.",
        aplicaciones: "Cálculo del tiempo de residencia requerido para separación completa."
      }
    },
    pump: {
      impeller: {
        nombre: "Impulsor",
        funcion: "Componente rotatorio que transfiere energía mecánica al fluido, generando carga (ΔH) y capacidad (q).",
        principio: "Leyes de afinidad: para bombas geométricamente similares, capacidad, carga y potencia escalan con la velocidad de giro.",
        ecuaciones: "q₂/q₁ = n₂/n₁ · ΔH₂/ΔH₁ = (n₂/n₁)² · P₂/P₁ = (n₂/n₁)³",
        variables: "n: velocidad de rotación [rpm]",
        hipotesis: "Mismo diámetro de impulsor, punto de operación geométricamente semejante.",
        aplicaciones: "Base del control de bombas centrífugas mediante variadores de velocidad (VFD)."
      },
      volute: {
        nombre: "Voluta",
        funcion: "Carcasa espiral que colecta el fluido descargado por el impulsor y lo conduce hacia la tubería de descarga, convirtiendo velocidad en presión.",
        principio: "Difusión gradual del flujo: al aumentar el área de paso a lo largo de la espiral, la velocidad disminuye y la presión estática aumenta (Bernoulli).",
        ecuaciones: "P₂−P₁ = (ρω²/2)(r₂²−r₁²) — presión generada por el campo rotatorio",
        variables: "r₂: radio exterior del impulsor [m]",
        hipotesis: "Flujo incompresible, en régimen permanente.",
        aplicaciones: "Diseño estándar de bombas centrífugas de succión simple."
      },
      frontDisc: {
        nombre: "Carcasa frontal",
        funcion: "Cierra el cuerpo de la bomba; en vista industrial es opaca, en vista interior se oculta para observar el impulsor.",
        principio: "Elemento estructural/de contención, sin función hidráulica activa.",
        ecuaciones: "—",
        variables: "—",
        hipotesis: "—",
        aplicaciones: "Punto de acceso para mantenimiento del impulsor en equipos reales."
      }
    }
  };

  // -----------------------------------------------------------------------
  // §0. DETECCIÓN DE SOPORTE — se llama al cargar la página.
  //
  // AR.js necesita: (1) contexto seguro (HTTPS o localhost) porque
  // getUserMedia lo exige, y (2) la API MediaDevices.getUserMedia en sí.
  // A diferencia de WebXR, esto SÍ funciona en Safari de iOS y en
  // cualquier Android con cualquier navegador moderno — no depende de
  // ARCore/ARKit. Por eso los mensajes de error aquí son mucho más cortos
  // que en la versión WebXR: solo hay dos causas reales de fallo.
  // -----------------------------------------------------------------------
  function isSecureContext() {
    return typeof window.isSecureContext === "boolean" ? window.isSecureContext : location.protocol === "https:";
  }

  function checkSupport() {
    const btn = document.getElementById("btnAR");
    const unsupportedMsg = document.getElementById("arUnsupported");
    if (!btn) return;

    const showUnsupported = (msg) => {
      btn.style.display = "none";
      if (unsupportedMsg) {
        unsupportedMsg.textContent = msg;
        unsupportedMsg.title = msg;
        unsupportedMsg.style.display = "flex";
      }
    };

    if (!isSecureContext()) {
      showUnsupported("Realidad Aumentada requiere HTTPS · abre el simulador desde un link https:// (no http:// ni un archivo local)");
      return;
    }
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      showUnsupported("Este navegador no da acceso a la cámara · usa Chrome, Safari o Firefox actualizados");
      return;
    }

    btn.style.display = "flex";
    if (unsupportedMsg) unsupportedMsg.style.display = "none";
  }

  // -----------------------------------------------------------------------
  // §1. INICIALIZACIÓN DE LA ESCENA AR (renderer/escena/cámara en perspectiva
  // propios, independientes del visor 3D de escritorio). El vídeo de la
  // cámara se crea aparte en initCamera() con getUserMedia directo.
  // -----------------------------------------------------------------------
  function initARScene() {
    const canvas = document.getElementById("arCanvas");
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      // "high-performance" pide la GPU discreta/potente en móviles con dos
      // GPUs y mejora el filtrado del render sobre el vídeo de la cámara.
      powerPreference: "high-performance"
    });
    // MEJOR CALIDAD: se sube el pixelRatio hasta 2.5 (antes 2) para que los
    // bordes del modelo se vean más nítidos sobre la cámara en pantallas
    // de alta densidad, sin dispararlo (3+ mata el framerate en gama media).
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.5));
    renderer.setClearColor(0x000000, 0);

    // Gestión de color y tono correctos: sin esto los metales se ven
    // "lavados" o quemados. sRGB + ACES da un acabado más realista y
    // fotográfico que casa mejor con la imagen de la cámara.
    if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else if ("outputEncoding" in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
    }
    // Sombras suaves: dan volumen al modelo y lo "asientan" sobre el plano.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    // Cámara en PERSPECTIVA normal (ya no es una THREE.Camera cruda cuya
    // matriz sobreescribía AR.js). El fov y el aspecto se ajustan en
    // onResizeAR para llenar la pantalla del móvil.
    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);

    // Iluminación de 3 puntos + hemisférica: da relieve, brillos metálicos
    // controlados y una sombra proyectada, en vez de la luz plana anterior.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4658, 0.95));

    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(2.5, 5, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -6; key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;   key.shadow.camera.bottom = -6;
    key.shadow.bias = -0.0005;
    scene.add(key);

    // Relleno frontal suave para que la cara vista por la cámara no quede
    // en penumbra, y luz de contra (rim) para separar el modelo del fondo.
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.45);
    fill.position.set(-3, 2, 2);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
    rim.position.set(-1, 3, -4);
    scene.add(rim);

    // placedRoot: contiene el modelo y su sombra. Se coloca centrado frente
    // a la cámara (X=0, ligeramente abajo, a PLACE_DEPTH de distancia). Los
    // gestos del alumno modifican su rotación (orbitar), escala (pellizco) y
    // posición X/Y (arrastre de 2 dedos). Arranca oculto hasta "Colocar".
    placedRoot = new THREE.Group();
    placedRoot.position.set(0, -PLACE_DEPTH * 0.12, -PLACE_DEPTH);
    placedRoot.visible = false;
    scene.add(placedRoot);

    // Plano "cazador de sombras" invisible bajo el modelo: solo recibe la
    // sombra proyectada (ShadowMaterial es transparente salvo donde cae
    // sombra), lo que da sensación de que el equipo "descansa" sobre una
    // superficie en vez de flotar del todo.
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.28 });
    const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), shadowMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -0.01;
    shadowPlane.receiveShadow = true;
    placedRoot.add(shadowPlane);
  }

  // -----------------------------------------------------------------------
  // §1. ARRANQUE DE LA CÁMARA (SIN MARCADOR) — se pide la cámara trasera con
  // getUserMedia directo y su vídeo se muestra a pantalla completa como
  // fondo. No hay AR.js / ArToolkit: el modelo 3D se dibuja encima con una
  // cámara en perspectiva normal, así que corre en CUALQUIER móvil con
  // cámara (iPhone incluido), sin imprimir ni apuntar a ningún marcador.
  // -----------------------------------------------------------------------
  function initCamera(onReady) {
    const wrap = document.getElementById("arVideoWrap");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      onCameraError({ name: "NotFoundError" });
      return;
    }

    // facingMode "environment" = cámara trasera (la que enfoca la escena).
    // Se piden resoluciones ideales altas para más nitidez del fondo; el
    // navegador da lo que pueda sin fallar.
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
      videoStream = stream;

      videoEl = document.createElement("video");
      videoEl.setAttribute("playsinline", "");
      videoEl.setAttribute("webkit-playsinline", "");
      videoEl.muted = true;
      videoEl.autoplay = true;
      videoEl.srcObject = stream;

      // El vídeo llena el contenedor recortando (cover), centrado, detrás
      // del canvas 3D. z-index 0; el canvas AR va por encima con z mayor.
      videoEl.style.position = "absolute";
      videoEl.style.top = "50%";
      videoEl.style.left = "50%";
      videoEl.style.transform = "translate(-50%, -50%)";
      videoEl.style.minWidth = "100%";
      videoEl.style.minHeight = "100%";
      videoEl.style.width = "auto";
      videoEl.style.height = "auto";
      videoEl.style.objectFit = "cover";
      videoEl.style.zIndex = "0";

      if (wrap) { wrap.innerHTML = ""; wrap.appendChild(videoEl); }

      videoEl.addEventListener("loadedmetadata", () => {
        videoEl.play && videoEl.play().catch(() => {});
        onResizeAR();
        if (onReady) onReady();
      }, { once: true });
    }).catch((err) => {
      onCameraError(err);
    });

    window.addEventListener("resize", onResizeAR);
  }

  function onResizeAR() {
    if (!renderer || !camera) return;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function onCameraError(err) {
    let msg = "No se pudo acceder a la cámara. Verifica los permisos del sitio.";
    if (err && err.name === "NotAllowedError") {
      msg = "Permiso de cámara denegado · actívalo en los ajustes del sitio y vuelve a intentar";
    } else if (err && err.name === "NotFoundError") {
      msg = "No se detectó ninguna cámara en este dispositivo";
    } else if (err && err.name === "NotReadableError") {
      msg = "La cámara está siendo usada por otra aplicación";
    }
    showToast(msg);
    stop();
  }

  // -----------------------------------------------------------------------
  // §2. COLOCAR / QUITAR EL MODELO (sin marcador) — "placeModel" muestra el
  // equipo flotando centrado frente a la cámara; "removeModel" lo oculta.
  // El botón "Colocar" del overlay alterna entre ambos.
  // -----------------------------------------------------------------------
  function placeModel() {
    if (!placedRoot) return;
    // Reinicia la orientación/posición del gesto para que aparezca centrado
    // y de frente cada vez que se coloca.
    placedRoot.position.set(0, -PLACE_DEPTH * 0.12, -PLACE_DEPTH);
    placedRoot.rotation.set(0, 0, 0);
    placedRoot.visible = true;
    modelPlaced = true;
    syncPlaceButton();
  }

  function removeModel() {
    if (placedRoot) placedRoot.visible = false;
    modelPlaced = false;
    hideTheoryCard();
    syncPlaceButton();
  }

  function togglePlacement() {
    if (modelPlaced) removeModel();
    else placeModel();
  }

  function syncPlaceButton() {
    const btn = document.getElementById("arPlaceBtn");
    if (!btn) return;
    btn.classList.toggle("active", modelPlaced);
    const lbl = btn.querySelector(".ar-place-label");
    if (lbl) lbl.textContent = modelPlaced ? "Quitar" : "Colocar";
  }

  // -----------------------------------------------------------------------
  // §3. ARRANQUE / FIN DE SESIÓN
  // -----------------------------------------------------------------------
  const CAMERA_WATCHDOG_MS = 8000;
  let cameraWatchdog = null;

  function start() {
    if (running) return;
    // Red de seguridad: si algo del arranque de AR lanza una excepción
    // (contexto, WebGL, permisos raros), se informa al usuario y se revierte
    // en vez de dejar la pantalla a medias.
    try {
      if (typeof THREE === "undefined" || typeof Scene3D === "undefined") {
        showToast("No se pudo iniciar AR: faltan componentes 3D. Recarga la página e inténtalo de nuevo.");
        return;
      }
      const overlay = document.getElementById("arOverlay");
      const videoWrap = document.getElementById("arVideoWrap");

      document.getElementById("arCanvas").style.display = "block";
      if (videoWrap) videoWrap.style.display = "block";
      if (overlay) overlay.style.display = "flex";

      if (!renderer) initARScene();
      Scene3D.setRenderPaused(true); // deja de renderizar (no de calcular) el canvas principal oculto

      attachEquipGroup();
      setupGestures();
      showGestureHint();
      updateOverlayEquipLabel();
      syncEquipSwitch();
      buildARParamsPanel();
      syncTransport();
      syncPlaceButton();

      // Watchdog: si tras 8 s el vídeo de la cámara no entregó fotogramas
      // (permiso colgado, cámara ocupada, pestaña sin gesto válido), se avisa
      // en vez de dejar la pantalla en negro sin explicación.
      clearTimeout(cameraWatchdog);
      cameraWatchdog = setTimeout(() => {
        const ready = videoEl && videoEl.readyState >= 2;
        if (!ready) showToast("La cámara está tardando en responder. Revisa el permiso de cámara del sitio o ciérrala en otras apps.");
      }, CAMERA_WATCHDOG_MS);

      initCamera(() => {
        running = true;
        // El modelo aparece centrado automáticamente al abrir la cámara.
        // (El botón "Colocar/Quitar" permite ocultarlo y volverlo a mostrar.)
        placeModel();
        rafId = requestAnimationFrame(renderLoop);
      });
    } catch (err) {
      console.error("[AR] fallo en start()", err);
      showToast("No se pudo iniciar la Realidad Aumentada en este dispositivo.");
      try { stop(); } catch (e) { /* noop */ }
    }
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    running = false;
    clearTimeout(cameraWatchdog);
    cameraWatchdog = null;

    window.removeEventListener("resize", onResizeAR);

    // Detiene la cámara: para las pistas del MediaStream y quita el <video>.
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      videoStream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
      if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl);
      videoEl = null;
    }

    detachEquipGroup();
    teardownGestures();

    document.getElementById("arCanvas").style.display = "none";
    const videoWrap = document.getElementById("arVideoWrap");
    if (videoWrap) { videoWrap.style.display = "none"; videoWrap.innerHTML = ""; }
    const overlay = document.getElementById("arOverlay");
    if (overlay) overlay.style.display = "none";
    hideTheoryCard();
    const panel = document.getElementById("arReadoutPanel");
    if (panel) panel.style.display = "none";
    const paramsSheet = document.getElementById("arParamsSheet");
    if (paramsSheet) paramsSheet.classList.remove("open");

    Scene3D.setRenderPaused(false); // el visor 3D de escritorio vuelve a renderizar normalmente

    // La escena AR (renderer/placedRoot) se conserva entre sesiones para no
    // reconstruir WebGL en cada entrada/salida; solo se resetea el estado de
    // colocación del usuario.
    userScale = 1;
    modelPlaced = false;
    if (placedRoot) {
      placedRoot.visible = false;
      placedRoot.rotation.set(0, 0, 0);
      placedRoot.position.set(0, -PLACE_DEPTH * 0.12, -PLACE_DEPTH);
    }
  }

  // -----------------------------------------------------------------------
  // §4. REPARENTADO DEL MODELO ACTIVO — mueve Scene3D.groups[equip] desde
  // la escena principal a la escena AR (y de vuelta al terminar). No se
  // clona geometría: son las mismas mallas que anima el motor de
  // simulación, por eso RPM/interfase/trazador/arranque de bomba se ven
  // sincronizados automáticamente sin código adicional.
  // -----------------------------------------------------------------------
  function attachEquipGroup(equipOverride) {
    const equip = equipOverride || Scene3D.currentEquip;
    equipGroup = Scene3D.groups[equip];
    equipParentOriginal = Scene3D.scene;
    equipOriginalTransform = {
      position: equipGroup.position.clone(),
      rotation: equipGroup.rotation.clone(),
      scale: equipGroup.scale.clone(),
      visible: equipGroup.visible
    };

    const info = AR_MODEL_INFO[equip];
    equipGroup.visible = true;
    equipGroup.position.set(0, info.liftY * info.baseScale * userScale, 0);
    // ORIENTACIÓN EN AR: el marcador Hiro define el plano del suelo (XZ) con
    // Y hacia arriba. Los modelos traen una leve inclinación horneada
    // (g.rotation.x/y) pensada para la cámara de ESCRITORIO — si se hereda
    // tal cual, sobre el marcador el equipo se ve volcado o "de cabeza"
    // (sobre todo la bomba, con 0.35 rad). Se aplica una orientación propia
    // de AR: el eje del equipo vertical, con un giro fijo por modelo para
    // presentarlo de frente. El usuario lo rota luego con un dedo.
    equipGroup.rotation.set(info.rotX || 0, info.rotY || 0, 0);
    equipGroup.scale.setScalar(info.baseScale * userScale);

    // Que todas las mallas del equipo proyecten (y reciban) sombra en AR,
    // para el acabado con sombra bajo el modelo. En escritorio no llevan
    // castShadow, así que se activa aquí y se revierte en detachEquipGroup.
    equipGroup.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });

    placedRoot.add(equipGroup); // reparenta: Three.js lo quita automáticamente de la escena principal
  }

  function detachEquipGroup() {
    if (!equipGroup) return;
    // Revierte el castShadow/receiveShadow que se activó solo para AR, para
    // no alterar el render de escritorio.
    equipGroup.traverse((o) => {
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; }
    });
    equipGroup.position.copy(equipOriginalTransform.position);
    equipGroup.rotation.copy(equipOriginalTransform.rotation);
    equipGroup.scale.copy(equipOriginalTransform.scale);
    equipGroup.visible = equipOriginalTransform.visible;
    equipParentOriginal.add(equipGroup); // lo devuelve a la escena principal
    equipGroup = null;
  }

  // Cambiar de equipo SIN salir de la sesión AR (menú "Seleccionar equipo").
  function switchEquip(name) {
    if (!running || !AR_MODEL_INFO[name]) return;
    detachEquipGroup();
    // Usa el puente Centrix (no solo Scene3D.setEquip) para que TODO el
    // simulador se sincronice: parámetros, gráficas, ecuación gobernante.
    if (window.Centrix && Centrix.switchEquip) Centrix.switchEquip(name);
    else Scene3D.setEquip(name);
    attachEquipGroup(name);
    updateOverlayEquipLabel();
    syncEquipSwitch();
    buildARParamsPanel();       // repuebla los sliders del nuevo equipo
    syncTransport();
  }

  // Resalta en el selector de equipo (iconos) cuál está activo.
  function syncEquipSwitch() {
    const current = Scene3D.currentEquip;
    document.querySelectorAll("[data-ar-equip]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.arEquip === current);
    });
  }

  // -----------------------------------------------------------------------
  // §5. GESTOS TÁCTILES — 1 dedo = rotar (yaw), 2 dedos = pellizco (escala),
  // toque simple = inspeccionar componente (si "Mostrar teoría" está activo).
  // -----------------------------------------------------------------------
  const TAP_MOVE_THRESHOLD = 12; // px — por debajo de esto, un toque cuenta como "tap" y no como arrastre
  const ROTATE_SPEED = 0.012;
  const PITCH_LIMIT = 1.35; // rad (~77°) — tope de cabeceo al orbitar con 1 dedo

  function setupGestures() {
    const canvas = document.getElementById("arCanvas");
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
  }
  function teardownGestures() {
    const canvas = document.getElementById("arCanvas");
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    pointers.clear();
  }

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      tapCandidate = { x: e.clientX, y: e.clientY, moved: false };
    } else {
      tapCandidate = null; // dos dedos en pantalla: ya no puede ser un "tap" simple
    }
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      gestureStartDist = dist(pts[0], pts[1]);
      gestureStartScale = userScale;
      // Punto de partida para el pan de 2 dedos (desplazar el modelo).
      gestureStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      gestureStartOffset = placedRoot ? { x: placedRoot.position.x, y: placedRoot.position.y } : { x: 0, y: 0 };
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && placedRoot && placedRoot.visible) {
      const p = pointers.get(e.pointerId);
      if (tapCandidate) {
        const dx = p.x - tapCandidate.x, dy = p.y - tapCandidate.y;
        if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) tapCandidate.moved = true;
        if (tapCandidate.moved) {
          // ORBITAR: arrastre horizontal = yaw (girar alrededor del eje
          // vertical), arrastre vertical = pitch (cabecear), para verlo
          // desde arriba, abajo o cualquier ángulo lateral.
          placedRoot.rotation.y += dx * ROTATE_SPEED;
          placedRoot.rotation.x += dy * ROTATE_SPEED;
          // Limita el pitch para que no se dé la vuelta por completo.
          placedRoot.rotation.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, placedRoot.rotation.x));
          tapCandidate.x = p.x; tapCandidate.y = p.y; // acumula solo el delta de este frame
        }
      }
    } else if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const d = dist(pts[0], pts[1]);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

      // PELLIZCO → escala.
      if (gestureStartDist) {
        const scaleFactor = d / gestureStartDist;
        userScale = Math.min(Math.max(gestureStartScale * scaleFactor, SCALE_MIN), SCALE_MAX);
        applyUserScale();
      }
      // ARRASTRE DE 2 DEDOS → desplaza (pan) el modelo en X (izq/der) e Y
      // (arriba/abajo), para colocarlo donde el alumno quiera dentro del cuadro.
      if (gestureStartMid && gestureStartOffset && placedRoot) {
        const mdx = (mid.x - gestureStartMid.x) * PAN_SPEED;
        const mdy = (mid.y - gestureStartMid.y) * PAN_SPEED;
        let nx = gestureStartOffset.x + mdx;
        let ny = gestureStartOffset.y - mdy; // pantalla-Y hacia abajo → mundo-Y hacia arriba
        nx = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, nx));
        ny = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, ny));
        placedRoot.position.x = nx;
        placedRoot.position.y = ny;
      }
    }
  }

  function onPointerUp(e) {
    const wasTap = tapCandidate && !tapCandidate.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { gestureStartDist = null; gestureStartMid = null; gestureStartOffset = null; }

    if (wasTap) handleTap(tapCandidate.x, tapCandidate.y);
    if (pointers.size === 0) tapCandidate = null;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function applyUserScale() {
    if (!equipGroup) return;
    const equip = Scene3D.currentEquip;
    const info = AR_MODEL_INFO[equip];
    const s = info.baseScale * userScale;
    equipGroup.scale.setScalar(s);
    equipGroup.position.y = info.liftY * s;
  }

  // -----------------------------------------------------------------------
  // §6. MANEJO DEL TOQUE — en modo teoría, dispara un raycast contra los
  // componentes del equipo activo para mostrar la ficha didáctica del que
  // fue tocado.
  // -----------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  function handleTap(clientX, clientY) {
    if (theoryMode && placedRoot && placedRoot.visible) {
      pickComponent(clientX, clientY);
    }
  }

  function pickComponent(clientX, clientY) {
    const canvas = document.getElementById("arCanvas");
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);

    const equip = Scene3D.currentEquip;
    const dyn = Scene3D.dynamic[equip] || {};
    const theoryForEquip = THEORY[equip] || {};
    const candidates = [];
    Object.keys(theoryForEquip).forEach((key) => {
      const obj = dyn[key];
      if (obj && obj.isObject3D) candidates.push({ key, obj });
    });

    const hits = raycaster.intersectObjects(candidates.map(c => c.obj), true);
    if (hits.length === 0) return;
    const hitObj = hits[0].object;

    // Varios candidatos pueden ser ancestro unos de otros (p. ej. "rotor"
    // contiene a "heavyPhase", "iface", etc.). Se elige el candidato MÁS
    // ESPECÍFICO: el que está a menor distancia (en niveles del árbol) del
    // objeto realmente golpeado por el rayo, no el primero en declararse.
    let best = null, bestDepth = Infinity;
    candidates.forEach((c) => {
      const d = depthTo(c.obj, hitObj);
      if (d < bestDepth) { bestDepth = d; best = c; }
    });
    if (best) showTheoryCard(theoryForEquip[best.key]);
  }

  // Distancia (en niveles) entre `node` y su ancestro `root`; 0 si son el
  // mismo objeto, Infinity si `root` no es ancestro de `node`.
  function depthTo(root, node) {
    let d = 0, p = node;
    while (p) { if (p === root) return d; p = p.parent; d++; }
    return Infinity;
  }

  // -----------------------------------------------------------------------
  // §7. LOOP DE RENDER — sin tracking de marcador: el modelo está fijo en la
  // escena (los gestos lo mueven). Solo se refrescan las etiquetas flotantes
  // y se dibuja el frame sobre el vídeo de la cámara de fondo.
  // -----------------------------------------------------------------------
  function renderLoop() {
    rafId = requestAnimationFrame(renderLoop);
    updateBillboards();
    renderer.render(scene, camera);
  }

  // -----------------------------------------------------------------------
  // §8. ETIQUETAS FLOTANTES (billboards) — panel HTML de lecturas en vivo
  // anclado sobre el modelo colocado. Se recalcula su posición en pantalla
  // proyectando un punto 3D sobre el equipo con la cámara AR de cada
  // frame, así que sigue al modelo mientras el marcador se mueve.
  // -----------------------------------------------------------------------
  const projVec = new THREE.Vector3();
  function updateBillboards() {
    const panel = document.getElementById("arReadoutPanel");
    if (!panel) return;
    if (!labelsOn || !placedRoot || !placedRoot.visible) { panel.style.display = "none"; return; }

    const equip = Scene3D.currentEquip;
    const info = AR_MODEL_INFO[equip];
    const anchorHeight = info.liftY * info.baseScale * userScale * 2.1;
    const worldPoint = placedRoot.localToWorld(projVec.set(0, anchorHeight, 0));

    const p = worldPoint.clone().project(camera);
    if (p.z > 1) { panel.style.display = "none"; return; } // detrás de la cámara

    const canvas = document.getElementById("arCanvas");
    const x = (p.x * 0.5 + 0.5) * canvas.clientWidth;
    const y = (-p.y * 0.5 + 0.5) * canvas.clientHeight;

    panel.style.display = "block";
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;

    // Contenido — se toma directamente de la última lectura calculada por
    // main.js (cacheada en ui.js), así nunca se desincroniza del panel de
    // datos del visor de escritorio.
    const last = UI.getLastState();
    panel.innerHTML = `
      <div class="ar-panel-title">${info.label}</div>
      ${last.readouts.slice(0, 4).map(r => `
        <div class="ar-panel-row"><span>${r.label}</span><b>${r.value}${r.unit ? ` ${r.unit}` : ""}</b></div>
      `).join("")}
    `;
  }

  // -----------------------------------------------------------------------
  // §9. TARJETA DE TEORÍA (modo didáctico)
  // -----------------------------------------------------------------------
  function showTheoryCard(t) {
    const card = document.getElementById("arTheoryCard");
    if (!card || !t) return;
    card.innerHTML = `
      <button class="ar-theory-close" id="arTheoryClose" aria-label="Cerrar">✕</button>
      <div class="ar-theory-name">${t.nombre}</div>
      <div class="ar-theory-row"><b>Función</b><span>${t.funcion}</span></div>
      <div class="ar-theory-row"><b>Principio físico</b><span>${t.principio}</span></div>
      <div class="ar-theory-row"><b>Ecuación</b><span class="ar-theory-eq">${t.ecuaciones}</span></div>
      <div class="ar-theory-row"><b>Variables</b><span>${t.variables}</span></div>
      <div class="ar-theory-row"><b>Hipótesis</b><span>${t.hipotesis}</span></div>
      <div class="ar-theory-row"><b>Aplicaciones</b><span>${t.aplicaciones}</span></div>
    `;
    card.style.display = "block";
    document.getElementById("arTheoryClose").addEventListener("click", hideTheoryCard);
  }
  function hideTheoryCard() {
    const card = document.getElementById("arTheoryCard");
    if (card) card.style.display = "none";
  }

  // -----------------------------------------------------------------------
  // §10. CONTROLES DEL OVERLAY (salir, reiniciar posición, etiquetas, teoría)
  // -----------------------------------------------------------------------
  function resetPlacement() {
    userScale = 1;
    if (placedRoot) {
      placedRoot.rotation.set(0, 0, 0);
      // Vuelve a centrar el modelo frente a la cámara (deshace orbita/pan).
      placedRoot.position.set(0, -PLACE_DEPTH * 0.12, -PLACE_DEPTH);
      placedRoot.visible = true;
    }
    modelPlaced = true;
    syncPlaceButton();
    applyUserScale();
    hideTheoryCard();
  }

  function toggleLabels(v) {
    labelsOn = v;
    if (!v) {
      const panel = document.getElementById("arReadoutPanel");
      if (panel) panel.style.display = "none";
    }
  }

  function toggleTheory(v) {
    theoryMode = v;
    if (!v) hideTheoryCard();
  }

  function updateOverlayEquipLabel() {
    const el = document.getElementById("arEquipLabel");
    if (el) el.textContent = AR_MODEL_INFO[Scene3D.currentEquip].label;
  }

  function showGestureHint() {
    const h = document.getElementById("arGestureHint");
    if (!h) return;
    h.classList.add("show");
    clearTimeout(showGestureHint._tid);
    showGestureHint._tid = setTimeout(() => h.classList.remove("show"), 4500);
  }

  function showToast(msg) {
    const t = document.getElementById("arToast");
    if (!t) { alert(msg); return; }
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(showToast._tid);
    showToast._tid = setTimeout(() => { t.style.display = "none"; }, 3500);
  }

  // -----------------------------------------------------------------------
  // §10b. PANEL DE PARÁMETROS Y TRANSPORTE EN AR — "paridad" con escritorio.
  // El panel se puebla desde window.Centrix.getParamGroups() (la MISMA
  // fuente que la UI de escritorio) y cada slider llama Centrix.updateParam,
  // así que ajustar un parámetro en AR recalcula y redibuja exactamente
  // igual que en el simulador principal, sin salir del modo cámara.
  // -----------------------------------------------------------------------
  function buildARParamsPanel() {
    const host = document.getElementById("arParamsScroll");
    if (!host || !window.Centrix) return;
    host.innerHTML = "";
    const groups = Centrix.getParamGroups();
    groups.forEach((group) => {
      const gEl = document.createElement("div");
      gEl.className = "ar-param-group";
      const title = document.createElement("div");
      title.className = "ar-param-group-title";
      title.textContent = group.title;
      gEl.appendChild(title);

      group.params.forEach((p) => {
        const row = document.createElement("div");
        row.className = "ar-param-row";
        row.style.setProperty("--accent-c", p.accent || "#E8A33D");

        const head = document.createElement("div");
        head.className = "ar-param-row-head";
        const label = document.createElement("span");
        label.textContent = p.label;
        const val = document.createElement("span");
        val.className = "ar-param-value";
        val.id = `arpv-${p.key}`;
        const fmt = (v) => (Number.isFinite(v) ? v.toFixed(p.decimals) : "—");
        val.innerHTML = `${fmt(p.value)} <span class="ar-unit">${p.unit || ""}</span>`;
        head.appendChild(label); head.appendChild(val);

        const input = document.createElement("input");
        input.type = "range";
        input.min = p.min; input.max = p.max; input.step = p.step; input.value = p.value;
        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          val.innerHTML = `${fmt(v)} <span class="ar-unit">${p.unit || ""}</span>`;
          if (window.Centrix) Centrix.updateParam(p.key, v);
        });

        row.appendChild(head); row.appendChild(input);
        gEl.appendChild(row);
      });
      host.appendChild(gEl);
    });
  }

  function toggleParamsSheet(force) {
    const sheet = document.getElementById("arParamsSheet");
    if (!sheet) return;
    const open = force !== undefined ? force : !sheet.classList.contains("open");
    sheet.classList.toggle("open", open);
    const btn = document.getElementById("arParamsToggle");
    if (btn) btn.classList.toggle("active", open);
    if (open) buildARParamsPanel();
  }

  // Refleja en los botones de transporte AR el estado real del cronómetro
  // (Centrix es la única fuente de verdad; escritorio y AR comparten estado).
  function syncTransport() {
    if (!window.Centrix) return;
    const playing = Centrix.isPlaying();
    const speed = Centrix.getSpeed();
    const bPlay = document.getElementById("arPlay");
    const bPause = document.getElementById("arPause");
    if (bPlay) bPlay.classList.toggle("active", playing);
    if (bPause) bPause.classList.toggle("active", !playing);
    document.querySelectorAll("#arSpeedGroup .ar-speed-btn").forEach((b) => {
      b.classList.toggle("active", parseFloat(b.dataset.speed) === speed);
    });
  }

  function wireARTransport() {
    const bPlay = document.getElementById("arPlay");
    const bPause = document.getElementById("arPause");
    const bReset = document.getElementById("arReset");
    if (bPlay) bPlay.addEventListener("click", () => { if (window.Centrix) { Centrix.play(); syncTransport(); } });
    if (bPause) bPause.addEventListener("click", () => { if (window.Centrix) { Centrix.pause(); syncTransport(); } });
    if (bReset) bReset.addEventListener("click", () => { if (window.Centrix) { Centrix.reset(); syncTransport(); } });
    document.querySelectorAll("#arSpeedGroup .ar-speed-btn").forEach((b) => {
      b.addEventListener("click", () => { if (window.Centrix) { Centrix.setSpeed(parseFloat(b.dataset.speed)); syncTransport(); } });
    });
    const bParams = document.getElementById("arParamsToggle");
    if (bParams) bParams.addEventListener("click", () => toggleParamsSheet());
    const bParamsClose = document.getElementById("arParamsClose");
    if (bParamsClose) bParamsClose.addEventListener("click", () => toggleParamsSheet(false));
  }

  // -----------------------------------------------------------------------
  // §11. CABLEADO DE LA UI (botón de entrada + controles del overlay)
  // -----------------------------------------------------------------------
  function wireUI() {
    const btnAR = document.getElementById("btnAR");
    if (btnAR) btnAR.addEventListener("click", start);

    const btnExit = document.getElementById("arExit");
    if (btnExit) btnExit.addEventListener("click", stop);

    const btnResetPos = document.getElementById("arResetPlacement");
    if (btnResetPos) btnResetPos.addEventListener("click", resetPlacement);

    // Botón "Colocar / Quitar" el modelo (modo sin marcador).
    const btnPlace = document.getElementById("arPlaceBtn");
    if (btnPlace) btnPlace.addEventListener("click", togglePlacement);

    const chkLabels = document.getElementById("arToggleLabels");
    if (chkLabels) chkLabels.addEventListener("click", () => {
      const active = chkLabels.classList.toggle("active");
      toggleLabels(active);
    });

    const chkTheory = document.getElementById("arToggleTheory");
    if (chkTheory) chkTheory.addEventListener("click", () => {
      const active = chkTheory.classList.toggle("active");
      toggleTheory(active);
    });

    // Menú "Seleccionar equipo" dentro del overlay AR (opcional en el DOM;
    // si no existe simplemente no se cablea nada).
    document.querySelectorAll("[data-ar-equip]").forEach((btn) => {
      btn.addEventListener("click", () => switchEquip(btn.dataset.arEquip));
    });

    // Panel de parámetros + transporte (Play/Pausa/Reset/velocidad) en AR
    wireARTransport();
  }

  function init() {
    wireUI();
    checkSupport();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { start, stop, switchEquip, syncTransport };
})();
