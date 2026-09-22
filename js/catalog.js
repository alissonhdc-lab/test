/* ==========================================================================
   catalog.js
   Dados de referência: tipos de equipamento, frequências de CQ e o acervo
   de testes vinculáveis a módulos da biblioteca pylinac (Python), além da
   opção de teste "manual" (genérico, sem vínculo com pylinac).
   ========================================================================== */

(function (global) {
  "use strict";

  // ------------------------------------------------------------------
  // Tipos de equipamento
  // ------------------------------------------------------------------
  const EQUIPMENT_TYPES = {
    linac: { label: "Acelerador Linear", short: "LINAC" },
    ct: { label: "Tomógrafo (CT / CBCT)", short: "CT" },
    brachy: { label: "Braquiterapia", short: "BRAQUI" },
    ortho: { label: "Ortovoltagem", short: "ORTHO" },
    other: { label: "Outro equipamento", short: "OUTRO" },
  };

  // ------------------------------------------------------------------
  // Frequências de controle de qualidade
  // ------------------------------------------------------------------
  const FREQUENCIES = {
    diario: { label: "Diário", days: 1 },
    semanal: { label: "Semanal", days: 7 },
    mensal: { label: "Mensal", days: 30 },
    trimestral: { label: "Trimestral", days: 91 },
    semestral: { label: "Semestral", days: 182 },
    anual: { label: "Anual", days: 365 },
  };

  // ------------------------------------------------------------------
  // Tipos de parâmetro de configuração (formulário amigável)
  // ------------------------------------------------------------------
  // type: 'number' | 'text' | 'select' | 'checkbox'

  // Tipos de tolerância para métricas de resultado
  // tolType: 'max' (valor <= tol), 'min' (valor >= tol),
  //          'range' (tolLow <= valor <= tolHigh), 'bool' (aprovado/reprovado manual), 'info' (sem tolerância)

  const PYLINAC_CATALOG = [
    // ---------------- LINAC: geometria de imagem / MLC ----------------
    {
      id: "picketfence",
      name: "Picket Fence (posicionamento de MLC)",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.picketfence.PicketFence",
      applicableTypes: ["linac"],
      description: "Avalia o posicionamento das lâminas do MLC a partir de imagens de picket fence em EPID.",
      params: [
        { key: "orientation", label: "Orientação dos pickets", type: "select", options: ["Up-Down", "Left-Right"], default: "Up-Down" },
        { key: "tolerance_mm", label: "Tolerância", type: "number", default: 0.5, unit: "mm", step: 0.05 },
        { key: "action_tolerance_mm", label: "Nível de ação", type: "number", default: 1.0, unit: "mm", step: 0.05 },
        { key: "num_pickets", label: "Número de pickets esperado", type: "number", default: 10, step: 1 },
        { key: "invert", label: "Inverter imagem", type: "checkbox", default: false },
      ],
      metrics: [
        { key: "max_error_mm", label: "Erro máximo de lâmina", unit: "mm", tolType: "max", tol: 0.5 },
        { key: "mean_error_mm", label: "Erro médio de lâmina", unit: "mm", tolType: "max", tol: 0.3 },
        { key: "num_pickets_detected", label: "Nº de pickets detectados", unit: "", tolType: "info" },
        { key: "passed", label: "Aprovado (pylinac)", unit: "", tolType: "bool" },
      ],
    },
    {
      id: "starshot",
      name: "Starshot (isocentro de irradiação)",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.starshot.Starshot",
      applicableTypes: ["linac"],
      description: "Determina o diâmetro do menor círculo que intercepta todas as retas de um teste de estrela (colimador/gantry/mesa).",
      params: [
        { key: "eixo", label: "Eixo avaliado", type: "select", options: ["Colimador", "Gantry", "Mesa"], default: "Colimador" },
        { key: "tolerance_mm", label: "Tolerância (diâmetro)", type: "number", default: 1.0, unit: "mm", step: 0.05 },
        { key: "sid_mm", label: "Distância fonte-imagem (SID)", type: "number", default: 1000, unit: "mm", step: 1 },
      ],
      metrics: [
        { key: "wobble_diameter_mm", label: "Diâmetro do wobble", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "passed", label: "Aprovado (pylinac)", unit: "", tolType: "bool" },
      ],
    },
    {
      id: "winston_lutz",
      name: "Winston-Lutz (isocentro mecânico/radiante)",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.winston_lutz.WinstonLutz",
      applicableTypes: ["linac"],
      description: "Avalia a coincidência entre o isocentro de radiação e o isocentro mecânico usando imagens de EPID de uma esfera (BB).",
      params: [
        { key: "bb_size_mm", label: "Diâmetro da esfera (BB)", type: "number", default: 5, unit: "mm", step: 0.5 },
        { key: "tolerance_mm", label: "Tolerância", type: "number", default: 1.0, unit: "mm", step: 0.05 },
        { key: "machine_scale", label: "Escala da máquina", type: "select", options: ["IEC61217", "Varian", "Elekta"], default: "IEC61217" },
      ],
      metrics: [
        { key: "max_2d_error_mm", label: "Erro 2D máximo", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "gantry_iso_size_mm", label: "Isocentro do gantry", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "collimator_iso_size_mm", label: "Isocentro do colimador", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "couch_iso_size_mm", label: "Isocentro da mesa", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "epid_iso_size_mm", label: "Isocentro do EPID", unit: "mm", tolType: "max", tol: 1.0 },
      ],
    },
    {
      id: "winston_lutz_mtmf",
      name: "Winston-Lutz Multi-Alvo/Multi-Campo",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.winston_lutz.WinstonLutzMultiTargetMultiField",
      applicableTypes: ["linac"],
      description: "Winston-Lutz para técnicas estereotáxicas com múltiplos alvos/campos (ex.: SRS multi-lesão).",
      params: [
        { key: "bb_arrangement", label: "Arranjo de esferas", type: "text", default: "Padrão do fantoma" },
        { key: "tolerance_mm", label: "Tolerância por alvo", type: "number", default: 1.0, unit: "mm", step: 0.05 },
      ],
      metrics: [
        { key: "max_bb_error_mm", label: "Erro máximo por esfera", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "mean_bb_error_mm", label: "Erro médio", unit: "mm", tolType: "max", tol: 0.5 },
      ],
    },
    {
      id: "dlg",
      name: "DLG - Dosimetric Leaf Gap",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.dlg",
      applicableTypes: ["linac"],
      description: "Estimativa do gap dosimétrico das lâminas do MLC, utilizado em planejamento e VMAT.",
      params: [
        { key: "tolerance_mm", label: "Tolerância", type: "number", default: 0.2, unit: "mm", step: 0.05 },
      ],
      metrics: [
        { key: "dlg_mm", label: "DLG calculado", unit: "mm", tolType: "range", tolLow: -0.5, tolHigh: 0.5 },
      ],
    },
    {
      id: "vmat_drgs",
      name: "VMAT - DRGS (Dose Rate & Gantry Speed)",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.vmat.DRGS",
      applicableTypes: ["linac"],
      description: "Teste VMAT de variação de taxa de dose e velocidade de gantry.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 3.0, unit: "%", step: 0.1 },
      ],
      metrics: [
        { key: "max_deviation_percent", label: "Desvio máximo", unit: "%", tolType: "max", tol: 3.0 },
        { key: "passed", label: "Aprovado (pylinac)", unit: "", tolType: "bool" },
      ],
    },
    {
      id: "vmat_drmlc",
      name: "VMAT - DRMLC (Dose Rate & MLC Speed)",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.vmat.DRMLC",
      applicableTypes: ["linac"],
      description: "Teste VMAT de variação de taxa de dose e velocidade das lâminas do MLC.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 3.0, unit: "%", step: 0.1 },
      ],
      metrics: [
        { key: "max_deviation_percent", label: "Desvio máximo", unit: "%", tolType: "max", tol: 3.0 },
        { key: "passed", label: "Aprovado (pylinac)", unit: "", tolType: "bool" },
      ],
    },
    {
      id: "field_analysis",
      name: "Field Analysis (Flatness & Symmetry)",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.field_analysis.FieldAnalysis",
      applicableTypes: ["linac"],
      description: "Planeza, simetria, tamanho de campo e penumbra a partir de perfis de dose/imagem.",
      params: [
        { key: "protocol", label: "Protocolo", type: "select", options: ["Varian", "Elekta", "Siemens", "Personalizado"], default: "Varian" },
        { key: "flatness_tolerance_percent", label: "Tolerância de planeza", type: "number", default: 3.0, unit: "%", step: 0.1 },
        { key: "symmetry_tolerance_percent", label: "Tolerância de simetria", type: "number", default: 2.0, unit: "%", step: 0.1 },
      ],
      metrics: [
        { key: "flatness_percent", label: "Planeza", unit: "%", tolType: "max", tol: 3.0 },
        { key: "symmetry_percent", label: "Simetria", unit: "%", tolType: "max", tol: 2.0 },
        { key: "field_size_x_mm", label: "Tamanho de campo (X)", unit: "mm", tolType: "info" },
        { key: "field_size_y_mm", label: "Tamanho de campo (Y)", unit: "mm", tolType: "info" },
        { key: "penumbra_mm", label: "Penumbra", unit: "mm", tolType: "info" },
      ],
    },
    {
      id: "log_analyzer",
      name: "Análise de Log de Trajetória (Trajectory Log)",
      group: "Acelerador Linear",
      pylinacRef: "pylinac.log_analyzer.TrajectoryLog",
      applicableTypes: ["linac"],
      description: "Compara posições planejadas x executadas do MLC/gantry a partir dos logs da máquina (análise gama).",
      params: [
        { key: "gamma_dose_tolerance_percent", label: "Tolerância de dose (gama)", type: "number", default: 1.0, unit: "%", step: 0.1 },
        { key: "gamma_distance_tolerance_mm", label: "Tolerância de distância (gama)", type: "number", default: 1.0, unit: "mm", step: 0.1 },
        { key: "threshold_percent", label: "Limiar de dose", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "gamma_pass_rate_percent", label: "Taxa de aprovação gama", unit: "%", tolType: "min", tol: 95 },
        { key: "max_mlc_error_mm", label: "Erro máximo de MLC", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "mean_mlc_error_mm", label: "Erro médio de MLC", unit: "mm", tolType: "max", tol: 0.5 },
      ],
    },

    // ---------------- Calibração absoluta de dose ----------------
    {
      id: "tg51_photon",
      name: "Calibração TG-51 - Fótons",
      group: "Calibração / Dosimetria",
      pylinacRef: "pylinac.calibration.tg51.TG51Photon",
      applicableTypes: ["linac", "ortho"],
      description: "Calibração absoluta de feixes de fótons segundo o protocolo TG-51 (AAPM).",
      params: [
        { key: "energy_MV", label: "Energia nominal", type: "text", default: "6X" },
        { key: "chamber_model", label: "Modelo da câmara", type: "text", default: "" },
        { key: "nd_w_gy_per_c", label: "Nd,w (câmara)", type: "number", default: 0, unit: "Gy/C", step: 0.0001 },
        { key: "temperature_c", label: "Temperatura", type: "number", default: 22, unit: "°C", step: 0.1 },
        { key: "pressure_kpa", label: "Pressão", type: "number", default: 101.3, unit: "kPa", step: 0.1 },
      ],
      metrics: [
        { key: "dose_per_mu_cGy", label: "Dose por UM", unit: "cGy/UM", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
        { key: "kQ", label: "Fator kQ", unit: "", tolType: "info" },
        { key: "output_ratio", label: "Razão em relação à referência", unit: "", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
      ],
    },
    {
      id: "tg51_electron",
      name: "Calibração TG-51 - Elétrons",
      group: "Calibração / Dosimetria",
      pylinacRef: "pylinac.calibration.tg51.TG51Electron",
      applicableTypes: ["linac"],
      description: "Calibração absoluta de feixes de elétrons segundo o protocolo TG-51 (AAPM).",
      params: [
        { key: "energy_MeV", label: "Energia nominal", type: "text", default: "6E" },
        { key: "chamber_model", label: "Modelo da câmara", type: "text", default: "" },
        { key: "r50_cm", label: "R50 medido", type: "number", default: 0, unit: "cm", step: 0.01 },
      ],
      metrics: [
        { key: "dose_per_mu_cGy", label: "Dose por UM", unit: "cGy/UM", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
        { key: "output_ratio", label: "Razão em relação à referência", unit: "", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
      ],
    },
    {
      id: "trs398_photon",
      name: "Calibração TRS-398 - Fótons",
      group: "Calibração / Dosimetria",
      pylinacRef: "pylinac.calibration.trs398.TRS398Photon",
      applicableTypes: ["linac", "ortho"],
      description: "Calibração absoluta de feixes de fótons segundo o protocolo TRS-398 (IAEA).",
      params: [
        { key: "energy_MV", label: "Energia nominal", type: "text", default: "6X" },
        { key: "nd_w_gy_per_c", label: "Nd,w (câmara)", type: "number", default: 0, unit: "Gy/C", step: 0.0001 },
        { key: "temperature_c", label: "Temperatura", type: "number", default: 22, unit: "°C", step: 0.1 },
        { key: "pressure_kpa", label: "Pressão", type: "number", default: 101.3, unit: "kPa", step: 0.1 },
      ],
      metrics: [
        { key: "dose_per_mu_cGy", label: "Dose por UM", unit: "cGy/UM", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
        { key: "output_ratio", label: "Razão em relação à referência", unit: "", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
      ],
    },
    {
      id: "trs398_electron",
      name: "Calibração TRS-398 - Elétrons",
      group: "Calibração / Dosimetria",
      pylinacRef: "pylinac.calibration.trs398.TRS398Electron",
      applicableTypes: ["linac"],
      description: "Calibração absoluta de feixes de elétrons segundo o protocolo TRS-398 (IAEA).",
      params: [
        { key: "energy_MeV", label: "Energia nominal", type: "text", default: "6E" },
        { key: "r50_cm", label: "R50 medido", type: "number", default: 0, unit: "cm", step: 0.01 },
      ],
      metrics: [
        { key: "dose_per_mu_cGy", label: "Dose por UM", unit: "cGy/UM", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
        { key: "output_ratio", label: "Razão em relação à referência", unit: "", tolType: "range", tolLow: 0.98, tolHigh: 1.02 },
      ],
    },

    // ---------------- Imagem planar (painel EPID / kV) ----------------
    {
      id: "planar_leeds",
      name: "Imagem Planar - Leeds TOR (kV)",
      group: "Imagem Planar (EPID / kV)",
      pylinacRef: "pylinac.planar_imaging.LeedsTOR",
      applicableTypes: ["linac", "ortho", "ct"],
      description: "Avaliação de qualidade de imagem kV com o fantoma Leeds TOR (resolução, contraste, uniformidade).",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "mtf_result_lp_mm", label: "MTF (50%)", unit: "lp/mm", tolType: "info" },
        { key: "contrast_result", label: "Contraste", unit: "", tolType: "info" },
        { key: "low_contrast_visibility", label: "Objetos de baixo contraste visíveis", unit: "", tolType: "info" },
      ],
    },
    {
      id: "planar_qc3",
      name: "Imagem Planar - Standard Imaging QC-3",
      group: "Imagem Planar (EPID / kV)",
      pylinacRef: "pylinac.planar_imaging.StandardImagingQC3",
      applicableTypes: ["linac"],
      description: "Avaliação de qualidade de imagem MV/kV com o fantoma QC-3.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "mtf_result_lp_mm", label: "MTF (50%)", unit: "lp/mm", tolType: "info" },
        { key: "contrast_result", label: "Contraste", unit: "", tolType: "info" },
      ],
    },
    {
      id: "planar_lasvegas",
      name: "Imagem Planar - Las Vegas",
      group: "Imagem Planar (EPID / kV)",
      pylinacRef: "pylinac.planar_imaging.LasVegas",
      applicableTypes: ["linac"],
      description: "Avaliação de contraste de baixo relevo com o fantoma Las Vegas.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "contrast_result", label: "Contraste", unit: "", tolType: "info" },
        { key: "low_contrast_visibility", label: "Objetos de baixo contraste visíveis", unit: "", tolType: "info" },
      ],
    },
    {
      id: "planar_doselab_kv",
      name: "Imagem Planar - Doselab MC2 (kV)",
      group: "Imagem Planar (EPID / kV)",
      pylinacRef: "pylinac.planar_imaging.DoselabMC2kV",
      applicableTypes: ["linac"],
      description: "QA de imagem kV com fantoma Doselab MC2.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "mtf_result_lp_mm", label: "MTF (50%)", unit: "lp/mm", tolType: "info" },
        { key: "contrast_result", label: "Contraste", unit: "", tolType: "info" },
      ],
    },
    {
      id: "planar_doselab_mv",
      name: "Imagem Planar - Doselab MC2 (MV)",
      group: "Imagem Planar (EPID / kV)",
      pylinacRef: "pylinac.planar_imaging.DoselabMC2MV",
      applicableTypes: ["linac"],
      description: "QA de imagem MV (EPID) com fantoma Doselab MC2.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "mtf_result_lp_mm", label: "MTF (50%)", unit: "lp/mm", tolType: "info" },
        { key: "contrast_result", label: "Contraste", unit: "", tolType: "info" },
      ],
    },
    {
      id: "planar_snc_kv",
      name: "Imagem Planar - SNC kV",
      group: "Imagem Planar (EPID / kV)",
      pylinacRef: "pylinac.planar_imaging.SNCkV",
      applicableTypes: ["linac"],
      description: "QA de imagem kV com fantoma Sun Nuclear.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "mtf_result_lp_mm", label: "MTF (50%)", unit: "lp/mm", tolType: "info" },
        { key: "contrast_result", label: "Contraste", unit: "", tolType: "info" },
      ],
    },
    {
      id: "planar_snc_mv",
      name: "Imagem Planar - SNC MV",
      group: "Imagem Planar (EPID / kV)",
      pylinacRef: "pylinac.planar_imaging.SNCMV",
      applicableTypes: ["linac"],
      description: "QA de imagem MV (EPID) com fantoma Sun Nuclear.",
      params: [
        { key: "tolerance_percent", label: "Tolerância", type: "number", default: 10, unit: "%", step: 1 },
      ],
      metrics: [
        { key: "mtf_result_lp_mm", label: "MTF (50%)", unit: "lp/mm", tolType: "info" },
        { key: "contrast_result", label: "Contraste", unit: "", tolType: "info" },
      ],
    },

    // ---------------- CT / CBCT ----------------
    {
      id: "catphan",
      name: "CatPhan (CT / CBCT)",
      group: "Tomógrafo (CT / CBCT)",
      pylinacRef: "pylinac.ct.CatPhan504 / CatPhan503 / CatPhan600 / CatPhan604",
      applicableTypes: ["ct"],
      description: "Avaliação de HU, geometria, uniformidade, resolução espacial e baixo contraste com fantoma CatPhan.",
      params: [
        { key: "phantom_model", label: "Modelo do fantoma", type: "select", options: ["CatPhan 504", "CatPhan 503", "CatPhan 600", "CatPhan 604"], default: "CatPhan 504" },
        { key: "hu_tolerance", label: "Tolerância de HU", type: "number", default: 40, unit: "HU", step: 1 },
        { key: "scaling_tolerance_mm", label: "Tolerância geométrica", type: "number", default: 1.0, unit: "mm", step: 0.1 },
        { key: "thickness_tolerance_mm", label: "Tolerância de espessura de corte", type: "number", default: 0.5, unit: "mm", step: 0.1 },
      ],
      metrics: [
        { key: "hu_linearity_max_error", label: "Erro máx. de linearidade de HU", unit: "HU", tolType: "max", tol: 40 },
        { key: "ctp404_geometry_mm", label: "Precisão geométrica (CTP404)", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "uniformity_hu", label: "Uniformidade", unit: "HU", tolType: "max", tol: 40 },
        { key: "mtf_50_lp_cm", label: "MTF 50%", unit: "lp/cm", tolType: "info" },
        { key: "low_contrast_visibility", label: "Visibilidade de baixo contraste", unit: "", tolType: "info" },
        { key: "slice_thickness_mm", label: "Espessura de corte medida", unit: "mm", tolType: "info" },
      ],
    },
    {
      id: "quart",
      name: "Quart DVT (CBCT)",
      group: "Tomógrafo (CT / CBCT)",
      pylinacRef: "pylinac.quart.QuartDVT",
      applicableTypes: ["ct"],
      description: "QA de CBCT com fantoma Quart (linearidade de HU, distorção geométrica, uniformidade, resolução).",
      params: [
        { key: "tolerance_mm", label: "Tolerância geométrica", type: "number", default: 1.0, unit: "mm", step: 0.1 },
      ],
      metrics: [
        { key: "hu_linearity", label: "Linearidade de HU", unit: "HU", tolType: "info" },
        { key: "geometric_distortion_mm", label: "Distorção geométrica", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "uniformity_hu", label: "Uniformidade", unit: "HU", tolType: "info" },
        { key: "resolution_lp_mm", label: "Resolução espacial", unit: "lp/mm", tolType: "info" },
      ],
    },
    {
      id: "acr_ct",
      name: "ACR CT",
      group: "Tomógrafo (CT / CBCT)",
      pylinacRef: "pylinac.acr.ACRCT",
      applicableTypes: ["ct"],
      description: "Programa de acreditação ACR para tomografia computadorizada.",
      params: [
        { key: "hu_tolerance", label: "Tolerância de HU", type: "number", default: 40, unit: "HU", step: 1 },
      ],
      metrics: [
        { key: "hu_linearity_max_error", label: "Erro máx. de linearidade de HU", unit: "HU", tolType: "max", tol: 40 },
        { key: "geometry_mm", label: "Precisão geométrica", unit: "mm", tolType: "max", tol: 1.0 },
        { key: "uniformity_hu", label: "Uniformidade", unit: "HU", tolType: "max", tol: 40 },
        { key: "low_contrast_visibility", label: "Visibilidade de baixo contraste", unit: "", tolType: "info" },
      ],
    },
    {
      id: "acr_mri",
      name: "ACR MRI",
      group: "Tomógrafo (CT / CBCT)",
      pylinacRef: "pylinac.acr.ACRMRI",
      applicableTypes: ["ct", "other"],
      description: "Programa de acreditação ACR para ressonância magnética.",
      params: [
        { key: "geometric_tolerance_mm", label: "Tolerância de precisão geométrica", type: "number", default: 2.0, unit: "mm", step: 0.1 },
      ],
      metrics: [
        { key: "geometric_accuracy_mm", label: "Precisão geométrica", unit: "mm", tolType: "max", tol: 2.0 },
        { key: "slice_thickness_mm", label: "Espessura de corte", unit: "mm", tolType: "info" },
        { key: "slice_position_mm", label: "Posição de corte", unit: "mm", tolType: "info" },
        { key: "resolution", label: "Resolução espacial", unit: "", tolType: "info" },
        { key: "uniformity", label: "Uniformidade de imagem", unit: "%", tolType: "info" },
        { key: "ghosting_percent", label: "Ghosting", unit: "%", tolType: "max", tol: 3.0 },
      ],
    },
    {
      id: "cheese",
      name: "Cheese Phantom / TomoCheese",
      group: "Tomógrafo (CT / CBCT)",
      pylinacRef: "pylinac.cheese.TomoCheese / CheesePhantom",
      applicableTypes: ["ct"],
      description: "Avaliação de HU por inserções em fantoma tipo 'queijo' (uso frequente em TomoTherapy e CBCT).",
      params: [
        { key: "hu_tolerance", label: "Tolerância de HU", type: "number", default: 40, unit: "HU", step: 1 },
      ],
      metrics: [
        { key: "hu_max_error", label: "Erro máx. de HU", unit: "HU", tolType: "max", tol: 40 },
        { key: "uniformity_hu", label: "Uniformidade", unit: "HU", tolType: "info" },
      ],
    },
  ];

  // ------------------------------------------------------------------
  // Teste manual / genérico (sem vínculo obrigatório com pylinac)
  // Útil para Braquiterapia, Ortovoltagem ou qualquer checagem que não
  // tenha um módulo pylinac correspondente.
  // ------------------------------------------------------------------
  const MANUAL_TEST_TYPE = {
    id: "manual",
    name: "Teste manual / genérico (sem pylinac)",
    group: "Genérico",
    pylinacRef: null,
    applicableTypes: ["linac", "ct", "brachy", "ortho", "other"],
    description: "Registro manual de resultados numéricos ou aprovação/reprovação, com métricas definidas pelo usuário.",
  };

  function getModulesForType(equipmentType) {
    return PYLINAC_CATALOG.filter((m) => m.applicableTypes.includes(equipmentType));
  }

  function getModuleById(id) {
    return PYLINAC_CATALOG.find((m) => m.id === id) || null;
  }

  function groupModules(modules) {
    const groups = {};
    modules.forEach((m) => {
      if (!groups[m.group]) groups[m.group] = [];
      groups[m.group].push(m);
    });
    return groups;
  }

  global.RTQC = global.RTQC || {};
  global.RTQC.catalog = {
    EQUIPMENT_TYPES,
    FREQUENCIES,
    PYLINAC_CATALOG,
    MANUAL_TEST_TYPE,
    getModulesForType,
    getModuleById,
    groupModules,
  };
})(window);
