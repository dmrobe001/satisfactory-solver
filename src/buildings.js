/* Building counts and bill of materials, shared by the production sheet and
 * the recipe matrix.  Pure logic over a SatSolver (machine counts and flows);
 * no DOM.  window.SatBuildings in the browser, module.exports in node. */
(function (root) {
  "use strict";
  const BELTS = [1, 2, 3, 4, 5, 6].map((k) => "ConveyorBeltMk" + k);
  const PIPES = ["Pipeline", "PipelineMK2"];
  const RAIL = "RailroadTrack";
  /* Computed buildings: each rule bills rate × basis, rounded up per building.
   * The bases are counted in derive(); RULE_BASES fixes their order in Settings. */
  const RULE_BASES = [
    ["machines", "Per production building", "Every running machine, extractor and generator (hand gathering excluded)."],
    ["belts", "Per computed conveyor belt", "All belt marks together, as computed from lanes (extras not included)."],
    ["inLanes", "Per solid input lane", "One per distinct solid input of a recipe, times its machine count."],
    ["outLanes", "Per solid output lane", "One per distinct solid output of a recipe, times its machine count."],
    ["fluidLanes", "Per fluid lane", "One per distinct fluid input or output of a recipe, times its machine count."],
    ["solidTypes", "Per solid item type", "Solid items that any running recipe makes or uses."],
    ["fluidTypes", "Per fluid type", "Fluids that any running recipe makes or uses."],
    ["depotItems", "Per depot item", "Each item in the bill of materials, plus each expendable (ammo, rebar, Nobelisks, filters, portable fuels, batteries, FICSMAS snowballs and fireworks) the sheet makes."],
    ["pipe1", "Per computed Pipeline Mk.1", "Computed Mk.1 pipeline segments."],
    ["pipe2", "Per computed Pipeline Mk.2", "Computed Mk.2 pipeline segments."],
  ];
  const DEFAULT_RULES = {
    machines: { PipeHyper: 1, PowerLine: 2, PowerPoleMk1: 0.5, PowerPoleMk2: 0, PowerPoleMk3: 0, PowerTower: 0.05,
      Foundation_8x1_01: 2, Foundation_Metal_8x1: 2, Foundation_Asphalt_8x1: 2, Foundation_ConcretePolished_8x1: 2,
      Wall_8x4_01: 2, Wall_8x4_02: 2, Wall_Concrete_8x4: 2,
      Roof_Orange_01: 1, Roof_A_01: 1, Roof_Tar_01: 1, Roof_Window_01: 1, Ladder: 1 },
    belts: { ConveyorPole: 0.04 },
    inLanes: { ConveyorAttachmentSplitter: 1 },
    outLanes: { ConveyorAttachmentMerger: 1 },
    fluidLanes: { PipelineJunction_T: 1 },
    solidTypes: { StorageContainerMk2: 1, ConveyorAttachmentSplitterSmart: 1 },
    fluidTypes: { IndustrialTank: 1 },
    depotItems: { CentralStorage: 1 },
    pipe1: { PipelinePump: 0.01 },
    pipe2: { PipelinePumpMk2: 0.01 },
  };
  const DEFAULT_EXTRA = {
    CeilingLight: 100, FloodlightWall: 100, BlueprintDesigner_MK3: 3,
    StandaloneWidgetSign_SmallVeryWide: 100, StandaloneWidgetSign_Square: 100,
    RailroadBlockSignal: 20, ResourceSink: 20, ResourceSinkShop: 1, CatwalkCross: 200,
    DroneTransport: 10, DroneStation: 10, Locomotive: 10, FreightWagon: 50, TrainDockingStation: 30,
    StandaloneWidgetSign_Huge: 10, RadarTower: 20, Elevator: 3, ElevatorFloorStop: 15, PortalSatellite: 20,
  };
  /* Items a pioneer carries and uses up, so they get a depot uploader when the sheet makes them. */
  const EXPENDABLE = ["CartridgeStandard", "CartridgeSmartProjectile", "CartridgeChaos",
    "SpikedRebar", "Rebar_Stunshot", "Rebar_Spreadshot", "Rebar_Explosive",
    "NobeliskExplosive", "NobeliskGas", "NobeliskShockwave", "NobeliskCluster", "NobeliskNuke",
    "Filter", "HazmatFilter", "Biofuel", "Fuel", "TurboFuel", "PackagedBiofuel", "PackagedRocketFuel",
    "PackagedIonizedFuel", "Battery",
    // FICSMAS hand equipment (thrown)
    "SnowballProjectile", "Fireworks_Projectile_01", "Fireworks_Projectile_02", "Fireworks_Projectile_03"];
  const CAL = 2; // building calibration version; older saves get the new rules and default extras
  const cloneRules = () => JSON.parse(JSON.stringify(DEFAULT_RULES));
  const DEFAULTS = () => ({
    timescale: 60,
    lane: Object.fromEntries(BELTS.concat(PIPES, [RAIL]).map((k) => [k, 1])),
    rules: cloneRules(),
    extra: Object.assign({}, DEFAULT_EXTRA),
    ficsmas: false,
    cal: CAL,
  });

  /* Settings from a saved snapshot (any version) merged over the defaults. */
  function normalize(saved) {
    const o = { settings: saved || {} };
    const d = DEFAULTS();
    let settings = Object.assign(d, o.settings || {});
    settings.lane = Object.assign(d.lane, (o.settings || {}).lane || {});
    const os = o.settings || {};
    settings.rules = cloneRules();
    if ((os.cal || 0) >= CAL) {
      for (const [b, m] of Object.entries(os.rules || {})) if (settings.rules[b]) Object.assign(settings.rules[b], m);
      settings.extra = Object.assign({}, os.extra || {});
    } else {
      // Saved before the recalibration: new rules, and default extras under the user's own.
      settings.extra = Object.assign({}, DEFAULT_EXTRA, os.extra || {});
    }
    delete settings.perMachine;
    settings.cal = CAL;
    return settings;
  }

  /* Buildings and bill of materials for the solver's current machine counts.
   * Returns {comp, total, machines, solid, fluid, basis, bom, need, ts}. */
  function compute(S, G, settings) {
    const R = G.recipes, IT = G.items, B = G.buildings, KEYS = S.itemKeys;
    const comp = {};
    let machines = 0, solid = 0, fluid = 0, inLanes = 0, outLanes = 0;
    const seen = new Uint8Array(KEYS.length);
    R.forEach((rec, r) => {
      const b = S.buildings(r);
      if (S.isActive(r) && S.n[r] > 0) for (const [k] of S.ins[r].concat(S.outs[r])) seen[k] = 1;
      if (!b) return;
      comp[rec.m] = (comp[rec.m] || 0) + b;
      machines += b;
      const [s, f] = S.lanes(r);
      solid += s * b; fluid += f * b;
      for (const [k] of S.ins[r]) if (k !== S.P && !IT[KEYS[k]].f) inLanes += b;
      for (const [k] of S.outs[r]) if (k !== S.P && !IT[KEYS[k]].f) outLanes += b;
    });
    const add = (k, v) => { if (v > 0) comp[k] = (comp[k] || 0) + Math.ceil(v - 1e-9); };
    BELTS.forEach((k) => add(k, solid * (settings.lane[k] || 0)));
    PIPES.forEach((k) => add(k, fluid * (settings.lane[k] || 0)));
    add(RAIL, (solid + fluid) * (settings.lane[RAIL] || 0));
    let solidTypes = 0, fluidTypes = 0;
    for (let k = 0; k < KEYS.length; k++) if (seen[k] && k !== S.P) { if (IT[KEYS[k]].f) fluidTypes++; else solidTypes++; }
    const basis = { machines, inLanes, outLanes, fluidLanes: fluid, solidTypes, fluidTypes,
      belts: BELTS.reduce((a, k) => a + (comp[k] || 0), 0), pipe1: comp.Pipeline || 0, pipe2: comp.PipelineMK2 || 0 };
    const applyRules = (b) => { for (const [k, v] of Object.entries(settings.rules[b] || {})) if (B[k]) add(k, basis[b] * (+v || 0)); };
    ["machines", "inLanes", "outLanes", "fluidLanes", "solidTypes", "fluidTypes", "belts", "pipe1", "pipe2"].forEach(applyRules);
    /* Depot uploaders depend on the bill of materials, which depends on the buildings, including
     * the uploaders themselves; two passes settle it (an uploader's own materials are added last). */
    const isBuildable = (k) => !B[k].xmas || settings.ficsmas;
    const bomItems = (extraComp) => {
      const has = new Uint8Array(KEYS.length);
      for (const k of Object.keys(B)) {
        if (!isBuildable(k)) continue;
        const t = (comp[k] || 0) + (extraComp[k] || 0) + (+settings.extra[k] || 0);
        if (t) for (const [it] of B[k].cost) has[S.itemIdx[it]] = 1;
      }
      for (const k of EXPENDABLE) { const i = S.itemIdx[k]; if (i !== undefined && S.prod[i] > 1e-9) has[i] = 1; }
      return has.reduce((a, x) => a + x, 0);
    };
    let depotItems = bomItems({});
    const depotComp = {};
    for (let pass = 0; pass < 2; pass++) {
      for (const k in depotComp) delete depotComp[k];
      for (const [k, v] of Object.entries(settings.rules.depotItems || {})) if (B[k] && v > 0) depotComp[k] = Math.ceil(depotItems * v - 1e-9);
      depotItems = bomItems(depotComp);
    }
    basis.depotItems = depotItems;
    applyRules("depotItems");
    const total = {};
    for (const k of Object.keys(B)) {
      if (B[k].xmas && !settings.ficsmas) continue;
      const t = (comp[k] || 0) + (+settings.extra[k] || 0);
      if (t) total[k] = t;
    }
    const bom = new Float64Array(KEYS.length);
    for (const [k, t] of Object.entries(total)) {
      for (const [it, q] of B[k].cost) bom[S.itemIdx[it]] += t * q;
    }
    const ts = Math.max(1e-6, +settings.timescale || 60);
    const need = bom.map((q) => q / ts);
    return { comp, total, machines, solid, fluid, basis, bom, need, ts };
  }

  const api = { BELTS, PIPES, RAIL, RULE_BASES, DEFAULT_RULES, DEFAULT_EXTRA, EXPENDABLE, CAL, cloneRules, DEFAULTS, normalize, compute };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SatBuildings = api;
})(typeof window !== "undefined" ? window : this);
