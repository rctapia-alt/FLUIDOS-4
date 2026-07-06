/* =========================================================================
   SCENE3D.JS — Visor 3D interactivo (Three.js r128)
   Modelos: Decantador L-L · Purificador de tazón · Bomba centrífuga
   ========================================================================= */

const Scene3D = (() => {

  let renderer, scene, camera, clock;
  let currentEquip = "decanter";
  let spinning = true;
  let crossSection = true;
  let viewMode = "interior"; // 'industrial' (carcasa cerrada, opaca) | 'interior' (corte, ve el proceso)
  let animId = null;
  let frameCallback = null; // registrado por main.js: recibe el dt real (s) de cada frame
  let renderPaused = false; // ar.js lo activa mientras la sesión WebXR está presentando,
                             // para no gastar GPU renderizando el canvas principal oculto
                             // (la física sigue avanzando: frameCallback se sigue llamando)
  let simPlaying = false;    // refleja sim.playing de main.js (setSimPlaying lo actualiza).
                             // Cuando es false, el modelo se CONGELA: ni el rotor/impulsor
                             // giran ni las gotas/flujo circulan. Solo Play lo reanuda.
                             // Es independiente de "spinning" (botón girar de escritorio).

  function setFrameCallback(fn) { frameCallback = fn; }
  function setRenderPaused(v) { renderPaused = v; }
  function setSimPlaying(v) { simPlaying = v; }

  // Grupos raíz por equipo — se muestran/ocultan según selección
  const groups = { decanter: null, bowl: null, pump: null };

  // Referencias a partes dinámicas que se re-generan al cambiar parámetros
  const dynamic = {
    decanter: {},
    bowl: {},
    pump: {}
  };

  const COLORS = {
    heavy: 0xE8A33D,   // ámbar de proceso — líquido pesado
    light: 0x4FC3D9,   // cian de fluido — líquido ligero
    interface: 0xF4F1EA,
    shell: 0x8B929C,   // acero inoxidable pulido (base neutra, el brillo lo da el envMap)
    shellWire: 0x4A5568,
    shaft: 0xAEB4BC,   // acero de eje, más claro/pulido
    solids: 0x9C6B3E,
    impeller: 0xC7CCD3,
    volute: 0x8B929C,
    accent: 0x3DCB7A
  };

  // Textura de ambiente (env map) procedural: un pequeño cubemap generado
  // por código que simula una nave industrial — un plano de luz cenital
  // frío arriba, un piso oscuro abajo y una franja ámbar de "iluminación
  // de proceso" al costado. No es una foto HDRI real, pero al usarse como
  // envMap en materiales metalness:1 produce reflejos direccionales
  // creíbles de acero pulido sin depender de assets externos.
  let envMap = null;

  function buildProceduralEnvMap() {
    const size = 128;
    const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter
    });
    const envScene = new THREE.Scene();

    // Fondo degradado frío→oscuro (simulado con esfera invertida + shader simple)
    const skyGeo = new THREE.SphereGeometry(50, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(0x3a4250) },
        bottom: { value: new THREE.Color(0x05070a) },
        band: { value: new THREE.Color(0xE8A33D) }
      },
      vertexShader: `
        varying vec3 vPos;
        void main(){ vPos = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: `
        varying vec3 vPos;
        uniform vec3 top; uniform vec3 bottom; uniform vec3 band;
        void main(){
          float h = clamp(vPos.y*0.5+0.5, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.6));
          float bandMask = smoothstep(0.02,0.0,abs(vPos.y+0.15)) * smoothstep(1.0,0.3,abs(vPos.x));
          col = mix(col, band, bandMask*0.5);
          gl_FragColor = vec4(col,1.0);
        }
      `
    });
    envScene.add(new THREE.Mesh(skyGeo, skyMat));

    // Un par de "paneles de luz" rectangulares (simulan lámparas de nave
    // industrial) para dar highlights especulares suaves al acero — brillo
    // moderado (no blanco puro) para evitar reflejos tipo espejo
    [[3, 4, 3, 0xb8bcc2], [-4, 2, -2, 0x3d8fa0], [0, -1, 5, 0xa87730]].forEach(([x, y, z, col]) => {
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 2.2),
        new THREE.MeshBasicMaterial({ color: col })
      );
      panel.position.set(x, y, z);
      panel.lookAt(0, 0, 0);
      envScene.add(panel);
    });

    const cubeCam = new THREE.CubeCamera(0.1, 50, cubeRT);
    cubeCam.update(renderer, envScene);
    envMap = cubeRT.texture;
    return envMap;
  }

  // Material de acero inoxidable de proceso — metalness y brillo moderados
  // (el acero industrial real, ya con uso y maquinado, dispersa la luz de
  // forma mucho más difusa que un metal pulido de laboratorio; valores
  // altos de metalness/envMapIntensity producen el efecto "espejo" que
  // no corresponde a un equipo de planta real).
  // Textura de RUGOSIDAD procedural "acero cepillado" — estrías finas de
  // rugosidad variable generadas en un canvas. Como roughnessMap rompe la
  // uniformidad del material y produce los reflejos alargados/estriados del
  // acero inoxidable maquinado real, sin assets externos. Se genera una
  // sola vez y la comparten todos los materiales metálicos.
  let brushedRoughnessTex = null;
  function buildBrushedTexture() {
    if (brushedRoughnessTex) return brushedRoughnessTex;
    const size = 256;
    const cnv = document.createElement("canvas");
    cnv.width = size; cnv.height = size;
    const ctx = cnv.getContext("2d");
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 900; i++) {
      const y = Math.random() * size;
      const w = 20 + Math.random() * 140;
      const x = Math.random() * size;
      const v = 105 + Math.floor(Math.random() * 60);
      ctx.strokeStyle = `rgba(${v},${v},${v},0.35)`;
      ctx.lineWidth = 0.6 + Math.random() * 0.9;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke();
    }
    brushedRoughnessTex = new THREE.CanvasTexture(cnv);
    brushedRoughnessTex.wrapS = brushedRoughnessTex.wrapT = THREE.RepeatWrapping;
    brushedRoughnessTex.repeat.set(3, 2);
    // Filtrado anisotrópico + mipmaps trilineales: el acabado cepillado deja de
    // verse pixelado/con moaré en ángulos oblicuos (clave en AR, donde se mira
    // el modelo desde posiciones bajas y rasantes).
    if (renderer && renderer.capabilities) {
      brushedRoughnessTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }
    brushedRoughnessTex.minFilter = THREE.LinearMipmapLinearFilter;
    brushedRoughnessTex.magFilter = THREE.LinearFilter;
    brushedRoughnessTex.generateMipmaps = true;
    return brushedRoughnessTex;
  }

  function steelMaterial({ color = COLORS.shell, roughness = 0.52, metalness = 0.78, opacity = 1, transparent = false, clearcoat = 0 } = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness, metalness, envMap, envMapIntensity: 0.5,
      roughnessMap: buildBrushedTexture(), // acabado cepillado industrial
      transparent, opacity, clearcoat, clearcoatRoughness: 0.4,
      side: THREE.FrontSide
    });
  }

  // Variante translúcida (carcasas de observación) — mismo acabado pero
  // con transparencia para ver el proceso interior, típico de las
  // ventanillas de inspección en equipos reales.
  function steelGlassMaterial({ color = COLORS.shell, opacity = 0.16 } = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness: 0.22, metalness: 0.08, envMap, envMapIntensity: 0.35,
      transparent: true, opacity, side: THREE.DoubleSide,
      transmission: 0.55, thickness: 0.4
    });
  }

  // Variante OPACA de la carcasa — usada en "Vista industrial": acero de
  // proceso sólido y realista, sin transmisión, para representar el
  // equipo tal como se vería cerrado en planta.
  function steelShellOpaqueMaterial({ color = COLORS.shell } = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness: 0.48, metalness: 0.7, envMap, envMapIntensity: 0.45,
      transparent: false, opacity: 1, side: THREE.FrontSide
    });
  }

  // -----------------------------------------------------------------------
  // Inicialización
  // -----------------------------------------------------------------------
  function init(canvas) {
    // En celular (pantalla angosta o puntero "coarse", es decir touch) el
    // costo de antialiasing MSAA + un pixelRatio alto se nota mucho más
    // que en escritorio, porque las GPUs móviles son bastante más
    // limitadas: cada frame renderizado a 2x o 3x resolución con MSAA
    // activo puede fácilmente ser el cuello de botella que hace sentir
    // "lento" el simulador (tabs, sliders, todo comparte el mismo hilo
    // principal con el compositor). Se detecta una sola vez al iniciar.
    const isMobileGPU = window.matchMedia("(max-width: 980px), (pointer: coarse)").matches;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobileGPU, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileGPU ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    renderer.physicallyCorrectLights = true;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    scene = new THREE.Scene();
    clock = new THREE.Clock();

    camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    camera.position.set(3.2, 2.1, 3.6);

    // Iluminación técnica — clave + relleno + contorno para lectura de forma
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(4, 6, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x4FC3D9, 0.4);
    fill.position.set(-4, 2, -3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xE8A33D, 0.45);
    rim.position.set(0, -3, -5);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0x1a2028, 1.1));

    // Rejilla de piso sutil para anclaje espacial
    const grid = new THREE.GridHelper(8, 16, 0x2A313C, 0x1A2028);
    grid.position.y = -1.35;
    scene.add(grid);

    buildProceduralEnvMap();
    scene.environment = envMap;

    groups.decanter = buildDecanter();
    groups.bowl = buildBowl();
    groups.pump = buildPump();
    scene.add(groups.decanter, groups.bowl, groups.pump);
    setEquip("decanter");
    setViewMode(viewMode);

    initOrbitControls(canvas);
    resize();
    animate();
  }

  // -----------------------------------------------------------------------
  // Controles de órbita ligeros (sin dependencia externa OrbitControls)
  // -----------------------------------------------------------------------
  let orbit = { theta: 0.7, phi: 1.05, radius: 5.0, target: new THREE.Vector3(0, 0, 0) };
  let dragging = false, panning = false, lastX = 0, lastY = 0;

  function initOrbitControls(canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) panning = true; else dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", () => { dragging = false; panning = false; });
    canvas.addEventListener("pointerleave", () => { dragging = false; panning = false; });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointermove", (e) => {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging) {
        orbit.theta -= dx * 0.008;
        orbit.phi = Math.min(Math.max(orbit.phi - dy * 0.008, 0.15), Math.PI - 0.15);
      } else if (panning) {
        const panSpeed = orbit.radius * 0.0012;
        const right = new THREE.Vector3(); camera.getWorldDirection(right);
        const camRight = new THREE.Vector3().crossVectors(camera.up, right).normalize();
        orbit.target.addScaledVector(camRight, dx * panSpeed);
        orbit.target.y += dy * panSpeed;
      }
      updateCameraFromOrbit();
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      orbit.radius = Math.min(Math.max(orbit.radius + e.deltaY * 0.0028, 1.2), 12);
      updateCameraFromOrbit();
    }, { passive: false });
  }

  function updateCameraFromOrbit() {
    const { theta, phi, radius, target } = orbit;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }

  function resetCamera() {
    orbit = { theta: 0.7, phi: 1.05, radius: 5.0, target: new THREE.Vector3(0, 0, 0) };
    updateCameraFromOrbit();
  }

  // -----------------------------------------------------------------------
  // MODELO 1 — DECANTADOR LÍQUIDO-LÍQUIDO
  // Cilindro rotatorio con interfase vertical cilíndrica (r_i) visible,
  // dos coronas de líquido (pesado exterior / ligero interior) y las
  // compuertas de rebose a rA y rB.
  // -----------------------------------------------------------------------
  function buildDecanter() {
    const g = new THREE.Group();
    const H = 1.7;

    // Carcasa exterior — acero inoxidable de proceso. Se guardan DOS
    // materiales (opaco "industrial" y traslúcido "interior") y se
    // intercambian en setViewMode() sin reconstruir geometría.
    const shellGeo = new THREE.CylinderGeometry(1.3, 1.3, H, 48, 1, true);
    const shellGlassMat = steelGlassMaterial({ color: COLORS.shell, opacity: 0.13 });
    const shellOpaqueMat = steelShellOpaqueMaterial({ color: COLORS.shell });
    const shell = new THREE.Mesh(shellGeo, shellGlassMat);
    g.add(shell);
    // Anillos de refuerzo (bridas) — acero pulido sólido, típicos de carcasas reales
    const braceRings = [];
    [-H * 0.42, 0, H * 0.42].forEach((y) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.028, 10, 48), steelMaterial({ roughness: 0.45 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = y;
      g.add(ring);
      braceRings.push(ring);
      // Pernos de brida — pequeños cilindros distribuidos en el anillo,
      // detalle industrial típico de uniones atornilladas reales
      const boltMat = steelMaterial({ color: 0x6b7280, roughness: 0.55, metalness: 0.6 });
      const nBolts = 8;
      for (let i = 0; i < nBolts; i++) {
        const ang = (i / nBolts) * Math.PI * 2;
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8), boltMat);
        bolt.position.set(Math.cos(ang) * 1.3, y, Math.sin(ang) * 1.3);
        bolt.lookAt(0, y, 0);
        bolt.rotateX(Math.PI / 2);
        g.add(bolt);
      }
    });
    const shellEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.3, 1.3, H, 32, 1)),
      new THREE.LineBasicMaterial({ color: COLORS.shellWire, transparent: true, opacity: 0.4 })
    );
    g.add(shellEdges);

    // Base / skid — estructura de soporte metálica típica de equipo de
    // planta anclado al piso, da presencia industrial inmediata
    const skidMat = steelMaterial({ color: 0x3a4250, roughness: 0.6, metalness: 0.55 });
    const skidBase = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.12, 1.7), skidMat);
    skidBase.position.y = -H * 0.5 - 0.42;
    g.add(skidBase);
    [-1.15, 1.15].forEach((x) => {
      [-0.65, 0.65].forEach((z) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.14), skidMat);
        leg.position.set(x, -H * 0.5 - 0.21, z);
        g.add(leg);
      });
    });

    // Cabezal motriz superior — carcasa del motorreductor + acople,
    // representa el accionamiento real que hace girar el eje
    const motorMat = steelMaterial({ color: 0x2c3542, roughness: 0.55, metalness: 0.5 });
    const motorHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.5, 24), motorMat);
    motorHousing.position.y = H * 0.5 + 0.5;
    g.add(motorHousing);
    const coupling = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.2, 16), steelMaterial({ roughness: 0.4 }));
    coupling.position.y = H * 0.5 + 0.2;
    g.add(coupling);

    // Tubería de alimentación — entra axialmente por arriba, al centro
    const feedPipe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.55, 16),
      steelMaterial({ color: 0x6b7280, roughness: 0.4 })
    );
    feedPipe.position.set(0.85, H * 0.5 + 0.15, 0);
    g.add(feedPipe);
    g.add(makeFlowArrow(new THREE.Vector3(0.85, H * 0.5 + 0.42, 0), new THREE.Vector3(0, -1, 0), COLORS.solids));

    // Eje central — acero de precisión pulido
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, H + 0.5, 20),
      steelMaterial({ color: COLORS.shaft, roughness: 0.3, metalness: 0.82 })
    );
    g.add(shaft);

    // Rotor (grupo que gira) — contiene las dos fases líquidas
    const rotor = new THREE.Group();
    g.add(rotor);

    // DISPOSICIÓN FÍSICA DE FASES (coherente con la fórmula de zona neutra
    // corregida, r_i² = (ρ_A r_A² − ρ_B r_B²)/(ρ_A − ρ_B)): las dos
    // compuertas están cerca del eje (rB < rA) y la interfase en el seno
    // del anillo: rB < rA < r_i < r_pared. La fase LIGERA ocupa [rB, r_i] y
    // la PESADA el anillo exterior [r_i, pared].
    //
    // RENDIMIENTO: todas las superficies de fase se construyen con RADIO
    // UNITARIO y se posicionan escalando (scale.set(r,1,r)) — stepDecanter
    // corre cada frame y escalar una malla es gratis, mientras que
    // dispose+new CylinderGeometry por frame generaba basura de GC continua.
    const WALL_R = 1.3; // radio de escena de la pared (== DEC_R_WALL real)

    // Superficie libre de la fase ligera (radio ≈ rB) — cian translúcido
    const lightGeo = new THREE.CylinderGeometry(1, 1, H * 0.86, 40, 1, true);
    const lightMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.light, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, roughness: 0.15, metalness: 0, transmission: 0.25
    });
    const lightPhase = new THREE.Mesh(lightGeo, lightMat);
    lightPhase.scale.set(0.22, 1, 0.22);
    rotor.add(lightPhase);

    // Fase pesada — cilindro indicador en el CENTRO del anillo [r_i, pared]
    const heavyGeo = new THREE.CylinderGeometry(1, 1, H * 0.86, 40, 1, true);
    const heavyMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.heavy, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, roughness: 0.2, metalness: 0
    });
    const heavyPhase = new THREE.Mesh(heavyGeo, heavyMat);
    heavyPhase.scale.set(1.2, 1, 1.2);
    rotor.add(heavyPhase);

    // Superficie de interfase (r_i) — anillo destacado brillante
    const ifaceGeo = new THREE.CylinderGeometry(1, 1, H * 0.87, 48, 1, true);
    const ifaceMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.interface, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, roughness: 0.05, metalness: 0,
      emissive: COLORS.interface, emissiveIntensity: 0.15
    });
    const iface = new THREE.Mesh(ifaceGeo, ifaceMat);
    iface.scale.set(1.1, 1, 1.1);
    rotor.add(iface);
    const ifaceRingTop = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.012, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    ifaceRingTop.rotation.x = Math.PI / 2;
    ifaceRingTop.position.y = H * 0.435;
    ifaceRingTop.scale.set(1.1, 1.1, 1);
    rotor.add(ifaceRingTop);
    const ifaceRingBot = ifaceRingTop.clone();
    ifaceRingBot.position.y = -H * 0.435;
    rotor.add(ifaceRingBot);

    // Compuertas de salida (weirs) — ambas cerca del eje (rB < rA), como en
    // el equipo real: son los anillos de rebose de cada descarga.
    const weirA = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.022, 10, 40),
      steelMaterial({ color: COLORS.heavy, roughness: 0.4 })
    );
    weirA.material.emissive = new THREE.Color(COLORS.heavy);
    weirA.material.emissiveIntensity = 0.22;
    weirA.rotation.x = Math.PI / 2; weirA.position.y = H * 0.5 + 0.02;
    weirA.scale.set(0.52, 0.52, 1);
    rotor.add(weirA);
    const weirB = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.022, 10, 40),
      steelMaterial({ color: COLORS.light, roughness: 0.4 })
    );
    weirB.material.emissive = new THREE.Color(COLORS.light);
    weirB.material.emissiveIntensity = 0.22;
    weirB.rotation.x = Math.PI / 2; weirB.position.y = H * 0.5 + 0.02;
    weirB.scale.set(0.22, 0.22, 1);
    rotor.add(weirB);

    // Tuberías de descarga — salen radialmente de cada compuerta hacia la
    // carcasa exterior, con flecha de flujo del color de la fase (las
    // etiquetas r_A/r_B ya identifican cuál es cuál, sin duplicar texto)
    const dischargeA = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.5, 14),
      steelMaterial({ color: 0x6b7280, roughness: 0.4 })
    );
    dischargeA.position.set(1.5, H * 0.5 + 0.02, 0);
    dischargeA.rotation.z = Math.PI / 2;
    g.add(dischargeA);
    g.add(makeFlowArrow(new THREE.Vector3(1.32, H * 0.5 + 0.02, 0), new THREE.Vector3(1, 0, 0), COLORS.heavy));

    const dischargeB = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.4, 14),
      steelMaterial({ color: 0x6b7280, roughness: 0.4 })
    );
    dischargeB.position.set(0, H * 0.5 + 0.02, -0.75);
    dischargeB.rotation.x = Math.PI / 2;
    g.add(dischargeB);
    g.add(makeFlowArrow(new THREE.Vector3(0, H * 0.5 + 0.02, -0.58), new THREE.Vector3(0, 0, -1), COLORS.light));

    // Etiquetas de radio — registradas en dynamic para reposicionarlas
    // cuando el usuario mueve las compuertas (updateDecanter)
    const labelA = makeLabelSprite("r_A", COLORS.heavy, new THREE.Vector3(0.52, H * 0.62, 0));
    const labelB = makeLabelSprite("r_B", COLORS.light, new THREE.Vector3(0.22, H * 0.75, 0));
    const labelI = makeLabelSprite("r_i", 0xffffff, new THREE.Vector3(1.1, -H * 0.62, 0));
    g.add(labelA, labelB, labelI);

    // GOTAS DISPERSAS CON MIGRACIÓN FÍSICA — la separación se hace
    // visualmente evidente: gotas de fase PESADA dispersas en la zona ligera
    // migran HACIA AFUERA (mayor ρ ⇒ mayor fuerza centrífuga) hasta coalescer
    // en la interfase; gotas LIGERAS dispersas en el anillo pesado migran
    // HACIA ADENTRO (flotación centrífuga) hasta la misma interfase. Es el
    // mecanismo real que mantiene nítidas ambas fases. El estado (ang, r, y)
    // vive en userData y lo integra el loop de animación.
    function makeDrop(geo, mat, parent) {
      const drop = new THREE.Mesh(geo, mat);
      drop.userData = {
        ang: Math.random() * Math.PI * 2,
        r: 0.3, y: (Math.random() - 0.5) * H * 0.78,
        phase: Math.random() * Math.PI * 2,
        freq: 0.5 + Math.random() * 0.9,
        slip: 0.08 + Math.random() * 0.22,
        amp: 0.015 + Math.random() * 0.02
      };
      drop.scale.setScalar(0.65 + Math.random() * 0.85);
      parent.add(drop);
      return drop;
    }
    const heavyParticles = [];
    const heavyDropGeo = new THREE.SphereGeometry(0.016, 8, 8);
    const heavyDropMat = new THREE.MeshStandardMaterial({ color: 0xF4C97A, emissive: COLORS.heavy, emissiveIntensity: 0.25, roughness: 0.5, transparent: true, opacity: 0.9 });
    for (let i = 0; i < 30; i++) {
      const d = makeDrop(heavyDropGeo, heavyDropMat, rotor);
      d.userData.r = 0.25 + Math.random() * 0.7; // nacen en la zona ligera
      heavyParticles.push(d);
    }
    const lightParticles = [];
    const lightDropGeo = new THREE.SphereGeometry(0.014, 8, 8);
    const lightDropMat = new THREE.MeshStandardMaterial({ color: 0xBDEEF7, emissive: COLORS.light, emissiveIntensity: 0.25, roughness: 0.5, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 26; i++) {
      const d = makeDrop(lightDropGeo, lightDropMat, rotor);
      d.userData.r = 1.12 + Math.random() * 0.15; // nacen en el anillo pesado
      lightParticles.push(d);
    }

    dynamic.decanter = {
      rotor, lightPhase, heavyPhase, iface, ifaceRingTop, ifaceRingBot, weirA, weirB, H,
      labelA, labelB, labelI, WALL_R,
      shell, shellGlassMat, shellOpaqueMat, braceRings,
      heavyParticles, lightParticles,
      riObjetivo: NaN, riAnimado: NaN // radio de interfase (unidades de escena): objetivo de equilibrio vs. posición animada actual
    };
    g.rotation.x = 0.05;
    return g;
  }

  // Fija el nuevo objetivo de equilibrio (rA, rB, ri de equilibrio ya
  // calculados por Engine.zonaNeutra). NO mueve la geometría de inmediato:
  // eso lo hace stepDecanter() en cada frame relajando riAnimado → riObjetivo,
  // para que el usuario vea la interfase migrar suavemente al ajustar sliders.
  // Fija el nuevo objetivo de equilibrio (rA, rB, ri de equilibrio ya
  // calculados por Engine.zonaNeutra). NO mueve la geometría de inmediato:
  // eso lo hace stepDecanter() en cada frame relajando riAnimado → riObjetivo,
  // para que el usuario vea la interfase migrar suavemente al ajustar sliders.
  //
  // OPTIMIZACIÓN: un slider tipo range puede disparar su evento "input"
  // muy seguido mientras se arrastra (varias veces por frame en algunos
  // navegadores). Se evita reconstruir rA/rB si el arrastre no alcanzó a
  // moverlos lo suficiente como para notarse.
  // Fija el nuevo objetivo de equilibrio ESCALANDO mallas unitarias (sin
  // dispose/new: cero basura de GC aunque el slider dispare "input" varias
  // veces por frame). stepDecanter relaja la interfase cuadro a cuadro.
  function updateDecanter(zn, scaleR) {
    const d = dynamic.decanter;
    if (!d.rotor) return;
    const rA = zn.rA * scaleR, rB = zn.rB * scaleR;

    d.weirA.scale.set(rA, rA, 1);
    d.weirB.scale.set(rB, rB, 1);
    d.lightPhase.scale.set(rB, 1, rB);
    if (d.labelA) d.labelA.position.x = rA;
    if (d.labelB) d.labelB.position.x = rB;

    if (!zn.valido) {
      // Interfase fuera del rango operable: se congela el último estado
      // válido y el parpadeo de alerta (unstable) comunica el problema.
      d.unstable = true;
      return;
    }
    d.riObjetivo = zn.ri * scaleR;
    if (Number.isNaN(d.riAnimado)) d.riAnimado = d.riObjetivo; // primer render: sin transición
    d.unstable = zn.inestable;
  }

  // Avanza un paso de la relajación temporal de la interfase, ESCALANDO las
  // mallas unitarias (sin dispose/new por frame). En equilibrio el costo es
  // prácticamente cero.
  function stepDecanter(dtSim) {
    const d = dynamic.decanter;
    if (!d.rotor || Number.isNaN(d.riObjetivo)) return;
    d.riAnimado = Engine.relajarZonaNeutra({ riActual: d.riAnimado, riObjetivo: d.riObjetivo, dt: dtSim });
    const ri = d.riAnimado;
    d.iface.scale.set(ri, 1, ri);
    d.ifaceRingTop.scale.set(ri, ri, 1);
    d.ifaceRingBot.scale.set(ri, ri, 1);
    // La fase pesada ocupa el anillo [r_i, pared]: su cilindro indicador se
    // mantiene en el punto medio del anillo, siguiendo a la interfase.
    const rHeavy = (ri + d.WALL_R) / 2;
    d.heavyPhase.scale.set(rHeavy, 1, rHeavy);
    if (d.labelI) d.labelI.position.x = ri;
  }

  // -----------------------------------------------------------------------
  // MODELO 2 — PURIFICADOR DE TAZÓN (bowl centrifuge)
  // Superficie líquida virtualmente cilíndrica + partículas sedimentando
  // radialmente hacia la pared según Stokes centrífugo.
  // -----------------------------------------------------------------------
  function buildBowl() {
    const g = new THREE.Group();
    const H = 1.5;

    // Carcasa — acero de proceso con ventanilla de inspección. Se guardan
    // ambos materiales (opaco/traslúcido) para alternar en setViewMode().
    const shellGlassMat = steelGlassMaterial({ color: COLORS.shell, opacity: 0.12 });
    const shellOpaqueMat = steelShellOpaqueMaterial({ color: COLORS.shell });
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, H, 48, 1, true),
      shellGlassMat
    );
    g.add(shell);
    [-H * 0.4, H * 0.4].forEach((y) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.026, 10, 48), steelMaterial({ roughness: 0.28 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = y;
      g.add(ring);
    });
    g.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.15, 1.15, H, 32, 1)),
      new THREE.LineBasicMaterial({ color: COLORS.shellWire, transparent: true, opacity: 0.4 })
    ));

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, H + 0.5, 20),
      steelMaterial({ color: COLORS.shaft, roughness: 0.18, metalness: 0.95 })
    );
    g.add(shaft);

    const rotor = new THREE.Group();
    g.add(rotor);

    // Superficie líquida virtualmente cilíndrica (concepto clave McCabe & Smith:
    // a alta ω la gravedad es despreciable frente a la fuerza centrífuga, por
    // lo que la superficie libre del líquido es un cilindro vertical, no un
    // plano horizontal como en reposo)
    const liquidGeo = new THREE.CylinderGeometry(0.95, 0.95, H * 0.82, 48, 1, true);
    const liquidMat = new THREE.MeshPhysicalMaterial({
      color: COLORS.light, transparent: true, opacity: 0.32,
      side: THREE.DoubleSide, roughness: 0.08, transmission: 0.35,
      envMap, envMapIntensity: 0.6
    });
    const liquidSurface = new THREE.Mesh(liquidGeo, liquidMat);
    rotor.add(liquidSurface);

    const surfRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.01, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 })
    );
    surfRing.rotation.x = Math.PI / 2; surfRing.position.y = H * 0.41;
    rotor.add(surfRing);

    // Torta de sólidos depositada en la pared — crece con el tiempo según
    // la concentración acumulada (ver stepBowl)
    const cakeGeo = new THREE.CylinderGeometry(1.13, 1.13, H * 0.02, 40, 1, true);
    // Sólidos húmedos compactados: mate, rugosidad casi total, con leve
    // calidez emisiva para que lea contra la pared oscura del tazón.
    const cakeMat = new THREE.MeshStandardMaterial({
      color: 0x8a5f36, roughness: 0.96, metalness: 0.02,
      side: THREE.DoubleSide, emissive: 0x2a1c0e, emissiveIntensity: 0.12
    });
    const cake = new THREE.Mesh(cakeGeo, cakeMat);
    cake.visible = false;
    rotor.add(cake);

    // ENJAMBRE DE SEDIMENTACIÓN — cada esfera es una partícula real que
    // avanza radialmente según la física de Stokes centrífugo (calculada
    // en main.js/stepBowlSim con Engine.drdt, igual que el trazador). Solo
    // avanzan mientras el cronómetro de simulación está en Play; por eso
    // "sedimentan" de verdad con el tiempo de proceso y no con animación
    // decorativa. Ángulo y altura son fijos por partícula (solo r cambia),
    // lo que deja leer con claridad el barrido radial hacia la pared.
    const particles = [];
    const particleGeo = new THREE.SphereGeometry(0.016, 8, 8);
    const particleMat = new THREE.MeshStandardMaterial({ color: COLORS.solids, emissive: COLORS.solids, emissiveIntensity: 0.22, roughness: 0.6 });
    // Partícula DEPOSITADA — mate y sin emisión: al asentarse deja de ser
    // una partícula "viva" en suspensión y se lee como sólido acumulado.
    const settledMat = new THREE.MeshStandardMaterial({ color: 0x7d5630, roughness: 0.95, metalness: 0.02 });
    // Partícula ESCAPADA — se tiñe del cian del efluente clarificado y se
    // desvanece mientras sube por la descarga: lectura inmediata de "esta
    // partícula NO fue retenida" (separación incompleta visible).
    const escapedMat = new THREE.MeshStandardMaterial({ color: 0x9adfef, emissive: COLORS.light, emissiveIntensity: 0.4, roughness: 0.4, transparent: true, opacity: 0.8 });
    const N_PARTICLES = 70;
    for (let i = 0; i < N_PARTICLES; i++) {
      const p = new THREE.Mesh(particleGeo, particleMat);
      const ang = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * H * 0.7;
      p.userData = { ang, y, stateVisual: "live" };
      p.position.set(0.08, y, 0);
      rotor.add(p);
      particles.push(p);
    }

    // Partícula TRAZADORA — su posición radial es exactamente r(t) de
    // Engine.trayectoriaSedimentacion / pasoSedimentacion, la que se lee
    // en Gráfica 1. Más grande, con emisión fuerte y una estela (trail)
    // de puntos que marca el camino recorrido, para lectura pedagógica clara.
    const tracerGeo = new THREE.SphereGeometry(0.038, 16, 16);
    const tracerMat = new THREE.MeshStandardMaterial({ color: 0xF4F1EA, emissive: 0xF4F1EA, emissiveIntensity: 0.55, roughness: 0.3 });
    const tracer = new THREE.Mesh(tracerGeo, tracerMat);
    tracer.userData = { ang: 0.4, y: 0 };
    rotor.add(tracer);

    const trailCount = 24;
    const trailGeo = new THREE.SphereGeometry(0.013, 6, 6);
    const trail = [];
    for (let i = 0; i < trailCount; i++) {
      const m = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ color: 0xF4F1EA, transparent: true, opacity: 0 }));
      rotor.add(m);
      trail.push({ mesh: m, r: 0, active: false });
    }

    dynamic.bowl = {
      rotor, liquidSurface, surfRing, cake, particles, tracer, trail, trailCount, H,
      shell, shellGlassMat, shellOpaqueMat,
      particleMat, settledMat, escapedMat, // intercambiados por setBowlSwarm según estado
      wallR: 1.13, // radio de escena de la pared (== r2 escalado)
      tracerRScene: NaN, // radio actual del trazador en unidades de escena
      trailTimer: 0, trailIdx: 0,
      cakeThickness: 0, _cakeSumLast: 0
    };
    g.rotation.x = 0.05;
    return g;
  }

  // Coloca cada partícula del enjambre con su ESTADO FÍSICO COMPLETO
  // calculado por main.js: {r (unid. escena), ang, y (fracción -0.5..0.5),
  // settled, escaped}. Ángulo y altura son variables de estado integradas
  // (slip angular + flujo axial + turbulencia), así que la trayectoria 3D
  // completa —no solo el radio— es física. Estados terminales visibles:
  //   settled → material mate compactado, reposa sobre la torta
  //   escaped → se tiñe de efluente y se desvanece subiendo por la descarga
  function setBowlSwarm(states) {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.particles.forEach((p, i) => {
      const st = states[i];
      if (st === undefined) return;
      if (typeof st === "number") { // retrocompatibilidad: solo radio
        const ud = p.userData;
        p.position.set(Math.cos(ud.ang) * st, ud.y, Math.sin(ud.ang) * st);
        return;
      }
      p.position.set(Math.cos(st.ang) * st.r, st.y * d.H, Math.sin(st.ang) * st.r);
      const ud = p.userData;
      const visual = st.settled ? "settled" : st.escaped ? "escaped" : "live";
      if (visual !== ud.stateVisual) {
        ud.stateVisual = visual;
        if (visual === "settled") {
          p.material = d.settledMat;
          p.scale.multiplyScalar(0.8); // se compacta contra la torta
        } else if (visual === "escaped") {
          p.material = d.escapedMat;
        } else {
          p.material = d.particleMat;
          setBowlParticleScale(p, ud.dpFactorCached ?? 1);
        }
      }
    });
  }

  function setBowlParticleScale(p, f) {
    p.scale.setScalar(0.45 + f * 0.85);
  }

  // Escala visual de cada partícula según su D_p individual (dpFactor
  // 0.6–1.4 de main.js): las que sedimentan más rápido (u_t ∝ D_p²) también
  // SE VEN más grandes, reforzando la lectura física.
  function setBowlSwarmSizes(dpFactors) {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.particles.forEach((p, i) => {
      const f = dpFactors[i];
      if (f === undefined) return;
      p.userData.dpFactorCached = f;
      setBowlParticleScale(p, f);
    });
  }

  function resetBowlSwarm() {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.particles.forEach((p) => {
      p.position.set(0.08, p.userData.y, 0);
      p.userData.stateVisual = "live";
      p.material = d.particleMat;
      setBowlParticleScale(p, p.userData.dpFactorCached ?? 1);
    });
  }

  // Coloca al trazador en un radio de escena específico (llamado desde
  // main.js con el r(t) real que produce el motor de integración) y
  // actualiza su estela dejando un punto cada cierto intervalo.
  function setBowlTracerRadius(rScene, dtSim) {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.tracerRScene = rScene;
    const ang = d.tracer.userData.ang;
    d.tracer.position.set(Math.cos(ang) * rScene, d.tracer.userData.y, Math.sin(ang) * rScene);

    d.trailTimer += dtSim;
    if (d.trailTimer > 0.35) {
      d.trailTimer = 0;
      const slot = d.trail[d.trailIdx % d.trailCount];
      slot.r = rScene;
      slot.active = true;
      slot.mesh.position.copy(d.tracer.position);
      slot.mesh.material.opacity = 0.55;
      d.trailIdx++;
    }
  }

  // ------------------------------------------------------------------------
  // TORTA POR SECTORES ANGULARES — el espesor radial local depende de los
  // depósitos reales por sector (sectors[] ∈ 0..1, integrados en main.js con
  // las llegadas de las partículas). Malla anular: pared exterior fija en
  // wallR, borde interior variable — crece hacia adentro, irregular y
  // orgánica mientras se llena, con grano determinista por ángulo.
  // ------------------------------------------------------------------------
  const CAKE_RADIAL_MAX = 0.22;  // unidades de escena — espesor máx.
  const CAKE_ANG_SEGS = 48;
  const CAKE_H_FRAC = 0.72;

  function buildCakeGeometry(sectors, H) {
    const nSec = sectors.length;
    const cakeH = H * CAKE_H_FRAC;
    const wallR = 1.13;
    const positions = [], indices = [];

    const thickAt = (angFrac) => {
      const x = angFrac * nSec;
      const i0 = Math.floor(x) % nSec;
      const i1 = (i0 + 1) % nSec;
      const f = x - Math.floor(x);
      const tt = sectors[i0] * (1 - f) + sectors[i1] * f;
      const grain = 0.9 + 0.1 * Math.sin(angFrac * 97.3) * Math.sin(angFrac * 41.7);
      return tt * CAKE_RADIAL_MAX * grain;
    };

    for (let a = 0; a <= CAKE_ANG_SEGS; a++) {
      const angFrac = a / CAKE_ANG_SEGS;
      const ang = angFrac * Math.PI * 2;
      const th = Math.max(thickAt(angFrac), 0.004);
      const rIn = wallR - th;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      positions.push(rIn * cos, -cakeH / 2, rIn * sin);
      positions.push(rIn * cos, cakeH / 2, rIn * sin);
      positions.push(wallR * cos, -cakeH / 2, wallR * sin);
      positions.push(wallR * cos, cakeH / 2, wallR * sin);
    }
    for (let a = 0; a < CAKE_ANG_SEGS; a++) {
      const b = a * 4, c = (a + 1) * 4;
      indices.push(b, b + 1, c);         indices.push(b + 1, c + 1, c);
      indices.push(b + 1, b + 3, c + 1); indices.push(b + 3, c + 3, c + 1);
      indices.push(b, c, b + 2);         indices.push(b + 2, c, c + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // fraction: métrica global 0..1 · sectors: acumulación angular real
  // (llamadas antiguas sin sectors se reparten uniforme).
  function setBowlCake(fraction, sectors) {
    const d = dynamic.bowl;
    if (!d.rotor || !d.cake) return;
    const secs = sectors || new Array(24).fill(fraction);
    const maxSec = Math.max(...secs);
    d.cake.visible = maxSec > 0.015;
    if (!d.cake.visible) { d._cakeSumLast = 0; return; }
    const sum = secs.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - (d._cakeSumLast || 0)) < 0.02) return; // evita rebuilds por frame
    d._cakeSumLast = sum;
    d.cake.geometry.dispose();
    d.cake.geometry = buildCakeGeometry(secs, d.H);
  }

  function resetBowlTracer() {
    const d = dynamic.bowl;
    if (!d.rotor) return;
    d.tracerRScene = NaN;
    d.trailTimer = 0; d.trailIdx = 0;
    d.trail.forEach((slot) => { slot.active = false; slot.mesh.material.opacity = 0; });
    setBowlCake(0);
  }

  // -----------------------------------------------------------------------
  // MODELO 3 — BOMBA CENTRÍFUGA MONOBLOCK (anatomía industrial)
  // Voluta espiral con caras laterales + brida de descarga con pernos ·
  // succión axial embridada · impulsor semiabierto con placa trasera,
  // álabes curvados hacia atrás y ojo de succión · portacojinete con aletas
  // · motor eléctrico con carcasa aleteada sobre placa base común. El FLUJO
  // es continuo y legible: los trazadores entran por la succión, cruzan el
  // ojo del impulsor y son acelerados en espiral (velocidad tangencial
  // creciente con el radio, ∝ ωr) hasta la descarga — se VE al impulsor
  // impulsando el fluido.
  // -----------------------------------------------------------------------
  function buildPump() {
    const g = new THREE.Group();

    // --- Espiral de la voluta ---
    const spiralPts = [];
    const turns = 1.0, steps = 90, rStart = 0.55, rGrowth = 0.62;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = t * turns * Math.PI * 2 - Math.PI * 0.15;
      const r = rStart + rGrowth * t;
      spiralPts.push(new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r));
    }
    const spiralCurve = new THREE.CatmullRomCurve3(spiralPts);
    // Radio del tubo CRECIENTE hacia la descarga (difusión real de la
    // voluta: el área de paso aumenta para convertir velocidad en presión)
    const voluteGeo = new THREE.TubeGeometry(spiralCurve, 120, 0.11, 14, false);
    {
      const pos = voluteGeo.attributes.position;
      const tmp = new THREE.Vector3();
      const nSeg = 120, nRad = 15; // TubeGeometry: (tubularSegments+1)*(radialSegments+1)
      for (let s = 0; s <= nSeg; s++) {
        const tFrac = s / nSeg;
        const grow = 1 + tFrac * 0.55;
        const center = spiralCurve.getPoint(tFrac);
        for (let rIdx = 0; rIdx < nRad; rIdx++) {
          const idx = s * nRad + rIdx;
          if (idx >= pos.count) break;
          tmp.fromBufferAttribute(pos, idx).sub(center).multiplyScalar(grow).add(center);
          pos.setXYZ(idx, tmp.x, tmp.y, tmp.z);
        }
      }
      voluteGeo.computeVertexNormals();
    }
    const voluteMat = steelMaterial({ color: 0x5b7d8f, roughness: 0.55, metalness: 0.55 }); // hierro fundido pintado azul-gris
    const volute = new THREE.Mesh(voluteGeo, voluteMat);
    g.add(volute);

    // Caras laterales de la carcasa — la trasera es fija; la frontal se
    // oculta en vista interior para ver el impulsor.
    const backDisc = new THREE.Mesh(new THREE.CircleGeometry(0.62, 48), voluteMat.clone());
    backDisc.rotation.x = -Math.PI / 2;
    backDisc.position.y = -0.13;
    g.add(backDisc);
    const frontDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 48),
      steelGlassMaterial({ color: COLORS.shell, opacity: 0.14 })
    );
    frontDisc.rotation.x = Math.PI / 2;
    frontDisc.position.y = 0.14;
    g.add(frontDisc);
    // Nervaduras radiales de refuerzo sobre la cara trasera (fundición real)
    for (let i = 0; i < 6; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.025, 0.045), voluteMat.clone());
      rib.position.y = -0.145;
      rib.rotation.y = (i / 6) * Math.PI * 2;
      rib.translateX(0.32);
      g.add(rib);
    }

    // --- Impulsor semiabierto con placa trasera ---
    const impeller = new THREE.Group();
    const impMat = steelMaterial({ color: 0xd6c9a3, roughness: 0.35, metalness: 0.85 }); // bronce naval
    const backplate = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.02, 48), impMat);
    backplate.position.y = -0.065;
    impeller.add(backplate);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.16, 24), impMat);
    impeller.add(hub);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 6), steelMaterial({ roughness: 0.3 }));
    nut.position.y = 0.1;
    impeller.add(nut);
    const eyeRing = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.018, 10, 32), impMat);
    eyeRing.rotation.x = Math.PI / 2;
    eyeRing.position.y = 0.05;
    impeller.add(eyeRing);

    const nBlades = 6;
    const blades = [];
    for (let i = 0; i < nBlades; i++) {
      const ang0 = (i / nBlades) * Math.PI * 2;
      // Álabe curvado hacia atrás (backswept), más alto y desarrollado —
      // la geometría clásica de impulsor centrífugo
      const bladeShape = new THREE.Shape();
      bladeShape.moveTo(0.13, -0.02);
      bladeShape.quadraticCurveTo(0.3, -0.16, 0.48, -0.06);
      bladeShape.lineTo(0.48, -0.015);
      bladeShape.quadraticCurveTo(0.31, -0.1, 0.13, 0.025);
      bladeShape.lineTo(0.13, -0.02);
      const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.12, bevelEnabled: false });
      bladeGeo.rotateX(Math.PI / 2);
      bladeGeo.translate(0, 0.065, 0);
      const blade = new THREE.Mesh(bladeGeo, impMat);
      blade.rotation.y = ang0;
      impeller.add(blade);
      blades.push(blade);
    }
    g.add(impeller);

    // --- Eje + portacojinete con aletas + motor ---
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.45, 20),
      steelMaterial({ color: COLORS.shaft, roughness: 0.18, metalness: 0.95 })
    );
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = 0.72;
    g.add(shaft);

    const bearingMat = steelMaterial({ color: 0x3a4250, roughness: 0.6, metalness: 0.5 });
    const bearing = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.42, 24), bearingMat);
    bearing.rotation.x = Math.PI / 2;
    bearing.position.z = 0.42;
    g.add(bearing);
    [0.3, 0.42, 0.54].forEach((z) => {
      const fin = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.012, 8, 24), bearingMat);
      fin.position.z = z;
      g.add(fin);
    });

    const motorMat = steelMaterial({ color: 0x2c3542, roughness: 0.55, metalness: 0.5 });
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.75, 28), motorMat);
    motor.rotation.x = Math.PI / 2;
    motor.position.z = 1.15;
    g.add(motor);
    for (let i = 0; i < 7; i++) { // carcasa aleteada del motor eléctrico
      const fin = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.01, 8, 28), motorMat);
      fin.position.z = 0.85 + i * 0.1;
      g.add(fin);
    }
    const termBox = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.2), motorMat); // caja de bornes
    termBox.position.set(0, 0.3, 1.15);
    g.add(termBox);

    // --- Placa base común (montaje monoblock real) ---
    const baseMat = steelMaterial({ color: 0x3a4250, roughness: 0.65, metalness: 0.5 });
    const basePlate = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.09, 2.4), baseMat);
    basePlate.position.set(0, -0.72, 0.45);
    g.add(basePlate);
    const pumpFoot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.55, 0.22), baseMat);
    pumpFoot.position.set(0, -0.42, -0.1);
    g.add(pumpFoot);
    const motorFoot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 0.5), baseMat);
    motorFoot.position.set(0, -0.48, 1.15);
    g.add(motorFoot);

    // --- Succión axial con brida y pernos ---
    const suction = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.9, 24, 1, true),
      new THREE.MeshPhysicalMaterial({ color: COLORS.light, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    suction.rotation.x = Math.PI / 2;
    suction.position.z = -0.75;
    g.add(suction);
    const suctionFlange = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 24), voluteMat.clone());
    suctionFlange.rotation.x = Math.PI / 2;
    suctionFlange.position.z = -1.18;
    g.add(suctionFlange);
    addFlangeBolts(g, new THREE.Vector3(0, 0, -1.18), new THREE.Vector3(0, 0, 1), 0.24, 6);
    g.add(makeFlowArrow(new THREE.Vector3(0, 0, -1.32), new THREE.Vector3(0, 0, 1), COLORS.light));

    // --- Descarga tangencial con brida y pernos ---
    const dischargeAngle = 1.0 * Math.PI * 2 - Math.PI * 0.15;
    const dischargeR = rStart + rGrowth * 1.0;
    const dischargeDir = new THREE.Vector3(Math.cos(dischargeAngle), 0, Math.sin(dischargeAngle)).normalize();
    const discharge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.17, 0.7, 20, 1, true),
      new THREE.MeshPhysicalMaterial({ color: COLORS.heavy, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    discharge.position.copy(dischargeDir.clone().multiplyScalar(dischargeR + 0.35));
    discharge.lookAt(dischargeDir.clone().multiplyScalar(dischargeR + 2));
    discharge.rotateX(Math.PI / 2);
    g.add(discharge);
    const dischargeFlange = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 24), voluteMat.clone());
    dischargeFlange.position.copy(dischargeDir.clone().multiplyScalar(dischargeR + 0.72));
    dischargeFlange.lookAt(dischargeDir.clone().multiplyScalar(dischargeR + 3));
    dischargeFlange.rotateX(Math.PI / 2);
    g.add(dischargeFlange);
    addFlangeBolts(g, dischargeDir.clone().multiplyScalar(dischargeR + 0.72), dischargeDir, 0.2, 6);
    g.add(makeFlowArrow(dischargeDir.clone().multiplyScalar(dischargeR + 0.85), dischargeDir, COLORS.heavy));

    // --- Trazadores de flujo: succión → ojo → espiral → descarga ---
    const flowDots = [];
    const flowDotGeo = new THREE.SphereGeometry(0.018, 8, 8);
    const flowDotMat = new THREE.MeshBasicMaterial({ color: COLORS.light, transparent: true, opacity: 0.9 });
    const PUMP_SUCTION_FRAC = 0.28; // fracción del ciclo que ocupa el viaje axial de succión
    for (let i = 0; i < 34; i++) {
      const dot = new THREE.Mesh(flowDotGeo, flowDotMat);
      dot.userData = { t: i / 34, s: 0.6 + Math.random() * 0.8, jitter: Math.random() * Math.PI * 2 };
      g.add(dot);
      flowDots.push(dot);
    }

    dynamic.pump = {
      impeller, blades, volute, frontDisc, flowDots, spiralCurve, rStart, rGrowth, turns,
      suctionFrac: PUMP_SUCTION_FRAC, eyeR: 0.16, suctionZ: -1.2,
      omegaObjetivo: NaN, omegaAnimada: NaN, // rad/s — objetivo instantáneo vs. arranque suavizado (relajarOmega)
      flowSpeedFactor: 1 // proporcional a ω_animada/ω_objetivo — el flujo se establece junto con la velocidad
    };
    g.rotation.x = 0.35;
    g.rotation.y = 0.3;
    return g;
  }

  // Corona de pernos alrededor de una brida — detalle de unión atornillada
  function addFlangeBolts(parent, center, axis, radius, n) {
    const boltMat = steelMaterial({ color: 0x6b7280, roughness: 0.5, metalness: 0.6 });
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize());
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const local = new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius).applyQuaternion(quat);
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.09, 6), boltMat);
      bolt.position.copy(center.clone().add(local));
      bolt.quaternion.copy(quat);
      parent.add(bolt);
    }
  }

  // Fija el nuevo objetivo de velocidad angular (rad/s, ya calculado por
  // Engine.rpmToOmega en main.js). El arranque real —cómo omegaAnimada se
  // aproxima a este objetivo— lo resuelve stepPump() cuadro a cuadro.
  function updatePumpTarget(omegaObjetivo) {
    const d = dynamic.pump;
    if (!d) return;
    d.omegaObjetivo = omegaObjetivo;
    if (Number.isNaN(d.omegaAnimada)) d.omegaAnimada = omegaObjetivo;
  }

  function stepPump(dtSim) {
    const d = dynamic.pump;
    if (!d || Number.isNaN(d.omegaObjetivo)) return null;
    d.omegaAnimada = Engine.relajarOmega({ omegaActual: d.omegaAnimada, omegaObjetivo: d.omegaObjetivo, dt: dtSim });
    const ratio = d.omegaObjetivo > 0 ? d.omegaAnimada / d.omegaObjetivo : 1;
    d.flowSpeedFactor = Math.max(0.05, ratio);
    return d.omegaAnimada;
  }

  function makeFlowArrow(pos, dir, color) {
    const arrow = new THREE.ArrowHelper(dir.normalize(), pos, 0.4, color, 0.14, 0.08);
    return arrow;
  }

  // Etiqueta de texto simple como sprite (canvas 2D → textura)
  function makeLabelSprite(text, color, position) {
    const cnv = document.createElement("canvas");
    cnv.width = 128; cnv.height = 64;
    const ctx = cnv.getContext("2d");
    ctx.font = "600 30px 'JetBrains Mono', monospace";
    const hex = "#" + color.toString(16).padStart(6, "0");
    ctx.fillStyle = hex;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 64, 32);
    const tex = new THREE.CanvasTexture(cnv);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.4, 0.2, 1);
    sprite.position.copy(position);
    sprite.renderOrder = 999;
    return sprite;
  }

  // -----------------------------------------------------------------------
  // Selección de equipo activo
  // -----------------------------------------------------------------------
  function setEquip(name) {
    currentEquip = name;
    for (const key in groups) {
      groups[key].visible = (key === name);
    }
    resetCamera();
  }

  function setSpinning(v) { spinning = v; }

  // Alterna entre "Vista industrial" (carcasa cerrada y opaca, aspecto de
  // equipo real en planta) y "Vista interior" (carcasa traslúcida tipo
  // corte, para observar fases, partículas y trazadores en movimiento).
  // No se regenera geometría: solo se intercambian los materiales/opacidad
  // de la carcasa de cada equipo, así el cambio es instantáneo y barato.
  function setViewMode(mode) {
    viewMode = mode;
    crossSection = mode === "interior";

    const dDec = dynamic.decanter;
    if (dDec.shell) {
      dDec.shell.material = crossSection ? dDec.shellGlassMat : dDec.shellOpaqueMat;
    }
    const dBowl = dynamic.bowl;
    if (dBowl.shell) {
      dBowl.shell.material = crossSection ? dBowl.shellGlassMat : dBowl.shellOpaqueMat;
    }
    if (dynamic.pump.frontDisc) dynamic.pump.frontDisc.visible = !crossSection;
  }

  // Alias retrocompatible (algún llamador antiguo podría usar el nombre previo)
  function setCrossSection(v) { setViewMode(v ? "interior" : "industrial"); }

  // -----------------------------------------------------------------------
  // Loop de animación
  // -----------------------------------------------------------------------
  function animate() {
    animId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1); // clamp: evita saltos grandes si la pestaña estuvo en background
    const t = clock.getElapsedTime();

    if (frameCallback) frameCallback(dt);

    // Desvanecimiento gradual de la estela del trazador (independiente de
    // spinning, pero también se detiene en pausa para que el modelo quede
    // totalmente estático)
    if (simPlaying && currentEquip === "bowl" && dynamic.bowl.trail) {
      dynamic.bowl.trail.forEach((slot) => {
        if (slot.active && slot.mesh.material.opacity > 0) {
          slot.mesh.material.opacity = Math.max(0, slot.mesh.material.opacity - dt * 0.18);
        }
      });
    }

    // El movimiento visual del modelo (giro del rotor/impulsor, migración de
    // gotas, circulación del flujo) solo avanza si la simulación está
    // reproduciéndose Y el usuario tiene activado "girar". Al pausar, el
    // modelo queda congelado en su pose actual hasta que se toque Play.
    if (spinning && simPlaying) {
      if (currentEquip === "decanter" && dynamic.decanter.rotor) {
        const dDec = dynamic.decanter;
        dDec.rotor.rotation.y += dt * 1.4;

        // MIGRACIÓN DE GOTAS DISPERSAS — separación visualmente evidente:
        // la gota pesada dispersa en la zona ligera migra hacia AFUERA hasta
        // coalescer en la interfase; la ligera dispersa en el anillo pesado
        // migra hacia ADENTRO. Al cruzar r_i "coalescen" y renacen dispersas
        // en su zona de origen, manteniendo la circulación continua del
        // proceso. Velocidad ∝ (0.4 + r): crece con el campo centrífugo local.
        const riNow = Number.isNaN(dDec.riAnimado) ? 1.1 : dDec.riAnimado;
        const migrate = (list, dir, rHomeMin, rHomeSpan) => {
          for (let i = 0; i < list.length; i++) {
            const ud = list[i].userData;
            ud.ang += dt * ud.slip;
            ud.r += dir * dt * 0.05 * (0.4 + ud.r);
            const crossed = dir > 0 ? ud.r >= riNow - 0.02 : ud.r <= riNow + 0.02;
            if (crossed) { // coalescencia en la interfase → renace dispersa
              ud.r = rHomeMin + Math.random() * Math.max(rHomeSpan, 0.03);
              ud.y = (Math.random() - 0.5) * dDec.H * 0.78;
              ud.ang = Math.random() * Math.PI * 2;
            }
            const r = ud.r + Math.sin(t * 0.6 + ud.phase) * 0.01;
            list[i].position.set(
              Math.cos(ud.ang) * r,
              ud.y + Math.sin(t * ud.freq + ud.phase) * ud.amp,
              Math.sin(ud.ang) * r
            );
          }
        };
        migrate(dDec.heavyParticles, +1, 0.25, riNow * 0.6);
        migrate(dDec.lightParticles, -1, Math.min(riNow + 0.06, dDec.WALL_R - 0.05), Math.max(dDec.WALL_R - riNow - 0.1, 0.03));

        // Parpadeo de alerta en interfase si inestable
        if (dynamic.decanter.unstable) {
          const pulse = (Math.sin(t * 6) + 1) / 2;
          dynamic.decanter.iface.material.emissive.setRGB(1, pulse * 0.2, pulse * 0.2);
          dynamic.decanter.iface.material.emissiveIntensity = 0.3 + pulse * 0.4;
          dynamic.decanter.iface.material.color.setHex(0xE5484D);
        } else {
          dynamic.decanter.iface.material.emissiveIntensity = 0.15;
          dynamic.decanter.iface.material.color.setHex(COLORS.interface);
        }
      }
      if (currentEquip === "bowl" && dynamic.bowl.rotor) {
        dynamic.bowl.rotor.rotation.y += dt * 1.6;
      }
      if (currentEquip === "pump" && dynamic.pump.impeller) {
        // La velocidad visual de giro y de las partículas de flujo sigue el
        // arranque real (flowSpeedFactor = ω_animada/ω_objetivo), no un
        // valor fijo: durante el arranque ambos se ven acelerar gradualmente.
        const dP = dynamic.pump;
        const fsf = dP.flowSpeedFactor || 1;
        dP.impeller.rotation.y += dt * 5.2 * fsf;
        // Trayectoria del flujo POR TRAMOS — se ve el recorrido completo:
        //   t < suctionFrac : viaje axial por la succión hasta el ojo del
        //     impulsor (z de suctionZ → 0, radio decreciente hacia el eje)
        //   t ≥ suctionFrac : el impulsor lo lanza en espiral, con velocidad
        //     tangencial creciente con el radio (∝ ωr) y ascenso de escala,
        //     hasta salir por la descarga. Un leve serpenteo (jitter) evita
        //     la lectura de "riel" perfecto.
        const sF = dP.suctionFrac, eyeR = dP.eyeR, sZ = dP.suctionZ;
        dP.flowDots.forEach((dot) => {
          const ud = dot.userData;
          // avance no uniforme: más lento en succión, más rápido en espiral
          ud.t = (ud.t + dt * 0.16 * fsf * ud.s) % 1;
          if (ud.t < sF) {
            const k = ud.t / sF;                       // 0..1 dentro de la succión
            const z = sZ * (1 - k);                     // avanza hacia el ojo (z→0)
            const r = eyeR * (0.3 + 0.7 * (1 - k));      // converge hacia el eje
            const a = ud.jitter + k * 6;
            dot.position.set(Math.cos(a) * r, Math.sin(a) * r * 0.4, z);
            dot.scale.setScalar(0.8);
          } else {
            const k = (ud.t - sF) / (1 - sF);            // 0..1 dentro de la espiral
            const ang = k * dP.turns * Math.PI * 2 - Math.PI * 0.15 + t * 0.6 * fsf;
            const r = eyeR + (dP.rStart + dP.rGrowth * k - eyeR) * k;
            const wob = Math.sin(t * 4 + ud.jitter) * 0.02 * (1 - k);
            dot.position.set(Math.cos(ang) * (r + wob), Math.sin(t * 3 + ud.jitter) * 0.015, Math.sin(ang) * (r + wob));
            dot.scale.setScalar(0.8 + k * 0.7);          // se agranda hacia la descarga
          }
        });
      }
    }

    if (!renderPaused) renderer.render(scene, camera);
  }

  // -----------------------------------------------------------------------
  // Resize responsivo
  // -----------------------------------------------------------------------
  function resize() {
    if (!renderer) return;
    const canvas = renderer.domElement;
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth, h = parent.clientHeight;
    // En móvil, durante el arranque o justo tras cambiar de pestaña, el
    // contenedor puede reportar tamaño 0 (aún sin layout / venía de
    // display:none). Redimensionar a 0 deja el canvas negro y NO se
    // recupera solo. Se ignora ese caso y se reintenta en el próximo frame.
    if (w < 2 || h < 2) {
      requestAnimationFrame(resize);
      return;
    }
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    init, resize, setEquip, setSpinning, setCrossSection, setViewMode, resetCamera,
    updateDecanter,
    setFrameCallback, setRenderPaused, setSimPlaying,
    stepDecanter,
    setBowlTracerRadius, setBowlCake, resetBowlTracer,
    setBowlSwarm, setBowlSwarmSizes, resetBowlSwarm,
    updatePumpTarget, stepPump,
    get dynamic() { return dynamic; },
    get currentEquip() { return currentEquip; },
    // Expuesto para ar.js: necesita reparentar temporalmente el grupo del
    // equipo activo desde la escena principal hacia la escena AR (y de
    // vuelta al salir), reutilizando las MISMAS mallas — así toda la
    // física/animación que ya corre en el motor de simulación (rotor
    // girando, interfase migrando, trazador sedimentando, arranque de la
    // bomba) se refleja automáticamente en AR sin duplicar lógica.
    get groups() { return groups; },
    get scene() { return scene; },
    get envMap() { return envMap; },
    get COLORS() { return COLORS; }
  };
})();
