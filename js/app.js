/* ==========================================================================
   app.js — roteamento (hash), estado de sessão e ligação de eventos.
   Todos os dados agora vêm do backend (API REST) — este arquivo trata a
   maior parte das chamadas como assíncronas.
   ========================================================================== */

(function (global) {
  "use strict";

  const { store, auth, ui, modal, chart, catalog, util, wlChart } = global.RTQC;
  const appRoot = document.getElementById("app");

  let trendSelection = {}; // routineId -> [metricKey,...]
  let resultFilters = {}; // routineId -> {gantry:Set, collimator:Set, status:Set, dateRange}
  let lastRoutineView = null; // { routineId, routine, filteredResults } — usado por drawTrendChart/resize
  let currentAssetsByType = {}; // preenchido ao abrir o modal de rotina/resultado, usado pelos campos "asset-select"
  let currentSncTemplates = []; // preenchido ao abrir o modal de rotina, usado pelo campo "snc-template-select"
  let dashboardSort = { key: null, dir: 1 }; // coluna/sentido escolhido clicando no cabeçalho da tabela do painel
  let dashboardFilter = null; // null | "overdue" | "soon" — clique nos cards "Rotinas atrasadas"/"Vencendo em breve"
  let dashboardShowPending = false; // clique no card "Resultados sem aprovação"

  // Lê os campos chartStyle__* do formulário de rotina, caindo de volta ao
  // padrão do catálogo sempre que o campo estiver vazio/inválido (ex.:
  // enquanto o técnico apaga o número para digitar outro) — sem isso um
  // parseFloat(NaN) ia parar num atributo SVG inválido (r="NaN").
  function readChartStyleFromForm(fd) {
    const d = catalog.DEFAULT_CHART_STYLE;
    const num = (key, fallback) => {
      const v = parseFloat(fd.get(key));
      return Number.isNaN(v) ? fallback : v;
    };
    return {
      pointRadius: num("chartStyle__pointRadius", d.pointRadius),
      lineWidth: num("chartStyle__lineWidth", d.lineWidth),
      showLine: fd.get("chartStyle__showLine") === "on",
      lineOpacityPct: num("chartStyle__lineOpacityPct", d.lineOpacityPct),
      pointOpacityPct: num("chartStyle__pointOpacityPct", d.pointOpacityPct),
    };
  }

  // Parâmetros do módulo pylinac como estão no formulário da rotina agora;
  // campos ainda não desenhados caem no padrão do catálogo.
  function readModuleParams(form, module) {
    const params = {};
    module.params.forEach((p) => {
      const el = form && form.querySelector(`[name="param__${p.key}"]`);
      if (!el) params[p.key] = p.default;
      else params[p.key] = p.type === "checkbox" ? el.checked : el.value;
    });
    return params;
  }

  // Monta as métricas da rotina a partir da tabela "Métricas e tolerâncias"
  // do formulário. O valor predito (nominal) vem do catálogo, não do form.
  function readModuleMetrics(fd, metricList) {
    return metricList.map((m) => {
      const tolType = fd.get(`metric__${m.key}__tolType`) || m.tolType;
      const entry = { key: m.key, label: m.label, unit: m.unit, tolType };
      if (m.nominal !== undefined) entry.nominal = m.nominal;
      if (tolType === "max" || tolType === "min") entry.tol = parseFloat(fd.get(`metric__${m.key}__tol`));
      if (tolType === "range") {
        entry.tolLow = parseFloat(fd.get(`metric__${m.key}__tolLow`));
        entry.tolHigh = parseFloat(fd.get(`metric__${m.key}__tolHigh`));
      }
      if (tolType === "action") {
        entry.actionPct = parseFloat(fd.get(`metric__${m.key}__actionPct`));
        entry.tolerancePct = parseFloat(fd.get(`metric__${m.key}__tolerancePct`));
      }
      return entry;
    });
  }

  function groupAssetsByType(assets) {
    const byType = {};
    (assets || []).forEach((a) => {
      if (!byType[a.type]) byType[a.type] = [];
      byType[a.type].push(a);
    });
    return byType;
  }

  // O formulário de rotina tem 4 seções (pylinac/trs398/snc_daily/manual),
  // só uma visível por vez, mas todas ficam no mesmo <form> — um campo
  // obrigatório numa seção escondida (ex.: câmara da rotina TRS-398)
  // bloquearia o envio do formulário mesmo estando invisível, porque a
  // validação nativa do HTML5 não distingue "display:none" de "só não é a
  // aba ativa" da forma que a gente precisa aqui. Por isso os campos desse
  // tipo nunca nascem com o atributo `required` nativo (ver
  // data-cond-required em ui.js) — este helper liga/desliga `required` de
  // verdade só na seção atualmente visível, toda vez que o tipo de teste
  // muda (e uma vez ao abrir o modal, para bater com o testType inicial).
  function syncConditionalRequired() {
    ["pylinac-section", "trs398-section", "snc-section", "manual-section"].forEach((id) => {
      const section = document.getElementById(id);
      if (!section) return;
      const visible = !section.classList.contains("hidden");
      section.querySelectorAll('[data-cond-required="true"]').forEach((el) => {
        el.required = visible;
      });
    });
  }

  function getOrInitFilters(routineId) {
    if (!resultFilters[routineId]) resultFilters[routineId] = ui.defaultFilters();
    return resultFilters[routineId];
  }

  // Ângulos reais de gantry/colimador raramente batem exatamente com o
  // valor nominal (ex.: 89.9° ou 90.1° em vez de 90°) — para os filtros,
  // agrupamos pelo múltiplo de 90° mais próximo (0, 90, 180, 270, ...) em
  // vez de usar o valor exato, senão cada pequena variação viraria um chip
  // de filtro separado.
  function snapAngleForFilter(v) {
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    const snapped = Math.round(n / 90) * 90;
    const normalized = ((snapped % 360) + 360) % 360;
    return `${normalized}°`;
  }

  function buildFilterOptions(allResults) {
    const gantrySet = new Set();
    const collimatorSet = new Set();
    allResults.forEach((r) => {
      if (r.values.dicom_gantry_angle_deg !== undefined) gantrySet.add(snapAngleForFilter(r.values.dicom_gantry_angle_deg));
      if (r.values.dicom_collimator_angle_deg !== undefined) collimatorSet.add(snapAngleForFilter(r.values.dicom_collimator_angle_deg));
    });
    const sortByNumber = (a, b) => parseFloat(a) - parseFloat(b);
    return {
      gantryOptions: Array.from(gantrySet).sort(sortByNumber),
      collimatorOptions: Array.from(collimatorSet).sort(sortByNumber),
    };
  }

  function applyResultFilters(routine, allResults, filters) {
    return allResults.filter((r) => {
      if (filters.gantry.size > 0) {
        if (r.values.dicom_gantry_angle_deg === undefined) return false;
        if (!filters.gantry.has(snapAngleForFilter(r.values.dicom_gantry_angle_deg))) return false;
      }
      if (filters.collimator.size > 0) {
        if (r.values.dicom_collimator_angle_deg === undefined) return false;
        if (!filters.collimator.has(snapAngleForFilter(r.values.dicom_collimator_angle_deg))) return false;
      }
      if (filters.status.size > 0) {
        const passed = ui.computeResultPass(routine, r);
        const key = passed === true ? "pass" : passed === false ? "fail" : null;
        if (!key || !filters.status.has(key)) return false;
      }
      if (filters.dateRange !== "all") {
        const days = parseInt(filters.dateRange, 10);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        if (util.parseLocalDate(r.date) < cutoff) return false;
      }
      return true;
    });
  }

  // ------------------------------------------------------------------
  // Roteamento
  // ------------------------------------------------------------------
  function parseHash() {
    const hash = location.hash.replace(/^#\/?/, "");
    return hash.split("/").filter(Boolean);
  }

  async function render() {
    let hasUsers;
    try {
      hasUsers = await auth.hasAnyUser();
    } catch (err) {
      appRoot.innerHTML = ui.renderBackendError(err.message, store.getBackendUrl());
      bindBackendErrorScreen();
      return;
    }

    if (!hasUsers) {
      appRoot.innerHTML = ui.renderSetupAdmin();
      bindSetupAdminForm();
      return;
    }

    const session = auth.currentSession();
    if (!session) {
      appRoot.innerHTML = ui.renderLogin();
      bindLoginForm();
      return;
    }

    const parts = parseHash();
    let route = parts[0] || "dashboard";
    if ((route === "usuarios" || route === "backup") && session.role !== "admin") {
      location.hash = "#/dashboard";
      route = "dashboard";
    }

    let db;
    try {
      db = await store.get();
    } catch (err) {
      if (err.status === 401) {
        // Sessão local sem token válido (ex.: sessão salva antes deste
        // mecanismo existir, ou expirada no backend) — em vez de travar
        // numa tela de erro, descarta a sessão e volta para o login.
        auth.logout();
        appRoot.innerHTML = ui.renderLogin();
        bindLoginForm();
        return;
      }
      appRoot.innerHTML = ui.renderBackendError(err.message, store.getBackendUrl());
      bindBackendErrorScreen();
      return;
    }

    let content = "";
    let watchFolders = [];
    if (route === "dashboard") {
      content = ui.renderDashboard(db, session, { sortKey: dashboardSort.key, sortDir: dashboardSort.dir, filter: dashboardFilter, showPending: dashboardShowPending });
    } else if (route === "equipamentos" && parts.length === 1) {
      content = ui.renderEquipmentsList(db, session);
    } else if (route === "equipamentos" && parts.length === 2) {
      const eq = db.equipments.find((e) => e.id === parts[1]);
      if (!eq) {
        location.hash = "#/equipamentos";
        return;
      }
      content = ui.renderEquipmentDetail(db, eq, session);
    } else if (route === "equipamentos" && parts.length === 4 && parts[2] === "rotinas") {
      const eq = db.equipments.find((e) => e.id === parts[1]);
      const routine = db.routines.find((r) => r.id === parts[3]);
      if (!eq || !routine) {
        location.hash = "#/equipamentos";
        return;
      }
      if (!trendSelection[routine.id]) {
        trendSelection[routine.id] = defaultTrendMetrics(routine);
      }
      // Pastas observadas são configuração administrativa — técnicos não têm
      // acesso a esse endpoint (403), então nem tentamos buscá-las para eles.
      watchFolders = session.role === "admin" ? await store.listWatchFolders(routine.id) : [];
      const allResults = db.results.filter((r) => r.routineId === routine.id);
      const filters = getOrInitFilters(routine.id);
      const filteredResults = applyResultFilters(routine, allResults, filters);
      const filterOptions = buildFilterOptions(allResults);
      lastRoutineView = { routineId: routine.id, routine, filteredResults };
      content = ui.renderRoutineDetail(db, eq, routine, trendSelection[routine.id], watchFolders, allResults, filteredResults, filters, filterOptions, session);
    } else if (route === "ativos" && parts.length === 1) {
      const assets = await store.listAssets();
      content = ui.renderAssetsList(assets, session);
    } else if (route === "ativos" && parts.length === 2) {
      const assets = await store.listAssets();
      const asset = assets.find((a) => a.id === parts[1]);
      if (!asset) {
        location.hash = "#/ativos";
        return;
      }
      const [certificates, measurements] = await Promise.all([
        store.listAssetCertificates(asset.id),
        catalog.ASSET_TYPES[asset.type] && catalog.ASSET_TYPES[asset.type].hasMeasurementHistory
          ? store.listAssetMeasurements(asset.id)
          : Promise.resolve([]),
      ]);
      content = ui.renderAssetDetail(asset, certificates, measurements, session);
    } else if (route === "usuarios") {
      content = ui.renderUsers(db, session);
    } else if (route === "backup") {
      let autoBackupSetting = {};
      try {
        autoBackupSetting = await store.getAutoBackupSetting();
      } catch (err) {
        // segue sem essa informação; a página ainda funciona
      }
      let sncSetting = {};
      try {
        sncSetting = await store.getSncFdbSetting();
      } catch (err) {
        // segue sem essa informação; a página ainda funciona
      }
      content = ui.renderBackup(db, store.getBackendUrl(), autoBackupSetting, sncSetting);
    } else if (route === "ajuda") {
      content = ui.renderHelp();
    } else {
      content = ui.renderDashboard(db, session, { sortKey: dashboardSort.key, sortDir: dashboardSort.dir, filter: dashboardFilter, showPending: dashboardShowPending });
    }

    appRoot.innerHTML = ui.renderShell(route, session, content);

    if (route === "equipamentos" && parts.length === 4 && lastRoutineView) {
      drawTrendChart(lastRoutineView.routine, lastRoutineView.filteredResults);
    }
  }

  function defaultTrendMetrics(routine) {
    const metrics = routine.metrics || [];
    // Dosimetria: abre direto no fator de calibração (o que o histórico
    // importado da planilha tem), não na primeira métrica da lista (Ktp).
    if (routine.testType === "trs398") {
      const preferred = catalog.DOSIMETRY_TRS398_TYPE.summaryKeys.find((k) => metrics.some((m) => m.key === k));
      if (preferred) return [preferred];
    }
    const numeric = metrics.filter((m) => m.tolType !== "bool");
    if (numeric.length > 0) return [numeric[0].key];
    if (metrics.length > 0) return [metrics[0].key];
    return [];
  }

  function drawTrendChart(routine, results) {
    const container = document.getElementById("trend-chart-container");
    if (!container) return;
    const selected = trendSelection[routine.id] || [];
    const metricsByKey = {};
    (routine.metrics || []).forEach((m) => (metricsByKey[m.key] = m));

    const series = selected
      .map((key) => {
        const m = metricsByKey[key];
        if (!m) return null;
        const points = results
          .map((r) => {
            const raw = r.values[key];
            if (raw === undefined || raw === "" || raw === null) return null;
            let y;
            if (m.tolType === "bool") y = raw === true || raw === "true" ? 1 : 0;
            else y = Number(raw);
            if (Number.isNaN(y)) return null;
            return { x: r.date, y };
          })
          .filter(Boolean);
        const s = { label: m.label, unit: m.unit, points };
        if (m.tolType === "max") s.toleranceMax = Number(m.tol);
        if (m.tolType === "min") s.toleranceMin = Number(m.tol);
        if (m.tolType === "range") {
          s.toleranceLow = Number(m.tolLow);
          s.toleranceHigh = Number(m.tolHigh);
        }
        if (m.tolType === "action") {
          // Duas faixas no gráfico: nível de ação (mais estreita, "ok") e
          // tolerância (mais larga, limite duro) — sempre na mesma unidade
          // da métrica (m.unit), nunca necessariamente "%".
          // Com valor predito (HU nominal de inserto do CatPhan), as faixas
          // ficam em torno dele em vez de em torno de zero.
          const base = Number(m.nominal) || 0;
          s.actionLow = base - Number(m.actionPct);
          s.actionHigh = base + Number(m.actionPct);
          s.toleranceLow = base - Number(m.tolerancePct);
          s.toleranceHigh = base + Number(m.tolerancePct);
        }
        return s;
      })
      .filter(Boolean);

    chart.renderTrendChart(container, { series, style: routine.chartStyle });
  }

  // ------------------------------------------------------------------
  // Tela de erro de conexão com o backend
  // ------------------------------------------------------------------
  function bindBackendErrorScreen() {
    const btn = document.querySelector('[data-action="retry-backend-connection"]');
    if (!btn) return;
    btn.addEventListener("click", () => {
      const input = document.getElementById("backend-url-input-boot");
      if (input && input.value.trim()) store.setBackendUrl(input.value);
      render();
    });
  }

  // ------------------------------------------------------------------
  // Login / Setup
  // ------------------------------------------------------------------
  function bindSetupAdminForm() {
    const form = document.getElementById("setup-admin-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const password = fd.get("password");
      const password2 = fd.get("password2");
      if (password !== password2) {
        modal.toast("As senhas não coincidem.", "error");
        return;
      }
      try {
        await auth.setupFirstAdmin({
          fullName: fd.get("fullName"),
          username: fd.get("username"),
          password,
        });
        await auth.login(fd.get("username"), password);
        modal.toast("Usuário administrador criado com sucesso.", "success");
        location.hash = "#/dashboard";
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    });
  }

  function bindLoginForm() {
    const form = document.getElementById("login-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await auth.login(fd.get("username"), fd.get("password"));
        render();
      } catch (err) {
        appRoot.innerHTML = ui.renderLogin(err.message);
        bindLoginForm();
      }
    });
  }

  // ------------------------------------------------------------------
  // Delegação global de eventos
  // ------------------------------------------------------------------
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;

    switch (action) {
      case "close-modal":
        modal.closeModal();
        break;
      case "logout":
        auth.logout();
        location.hash = "#/dashboard";
        render();
        break;
      case "new-equipment":
        openEquipmentModal(null);
        break;
      case "open-equipment":
        location.hash = `#/equipamentos/${el.dataset.id}`;
        break;
      case "edit-equipment": {
        const db = await store.get();
        const eq = db.equipments.find((x) => x.id === el.dataset.id);
        openEquipmentModal(eq);
        break;
      }
      case "delete-equipment":
        modal.confirmModal({
          title: "Excluir equipamento",
          message: "Isto excluirá o equipamento e todas as rotinas e resultados associados. Esta ação não pode ser desfeita. Deseja continuar?",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            await store.deleteEquipment(el.dataset.id);
            modal.toast("Equipamento excluído.", "success");
            location.hash = "#/equipamentos";
            render();
          },
        });
        break;
      case "new-asset":
        openAssetModal(null);
        break;
      case "open-asset":
        location.hash = `#/ativos/${el.dataset.id}`;
        break;
      case "edit-asset": {
        const assets = await store.listAssets();
        const asset = assets.find((x) => x.id === el.dataset.id);
        openAssetModal(asset);
        break;
      }
      case "delete-asset":
        modal.confirmModal({
          title: "Excluir ativo",
          message: "Isto excluirá o ativo, seus certificados e todo o histórico de medições. Rotinas de dosimetria vinculadas a ele deixarão de encontrar Ndw/Ks/Kpol. Deseja continuar?",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            await store.deleteAsset(el.dataset.id);
            modal.toast("Ativo excluído.", "success");
            location.hash = "#/ativos";
            render();
          },
        });
        break;
      case "download-certificate": {
        e.preventDefault();
        await downloadCertificate(el.dataset.assetId, el.dataset.certId, el.dataset.filename);
        break;
      }
      case "delete-certificate":
        modal.confirmModal({
          title: "Excluir certificado",
          message: "Deseja excluir este certificado de calibração?",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            await store.deleteAssetCertificate(el.dataset.assetId, el.dataset.certId);
            modal.toast("Certificado excluído.", "success");
            render();
          },
        });
        break;
      case "delete-measurement":
        modal.confirmModal({
          title: "Excluir medição",
          message: "Deseja excluir esta medição do histórico?",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            await store.deleteAssetMeasurement(el.dataset.assetId, el.dataset.measurementId);
            modal.toast("Medição excluída.", "success");
            render();
          },
        });
        break;
      case "new-routine":
        openRoutineModal(el.dataset.equipmentId, null);
        break;
      case "open-routine": {
        const parts = parseHash();
        location.hash = `#/equipamentos/${parts[1]}/rotinas/${el.dataset.id}`;
        break;
      }
      case "edit-routine": {
        const db = await store.get();
        const routine = db.routines.find((x) => x.id === el.dataset.id);
        openRoutineModal(routine.equipmentId, routine);
        break;
      }
      case "delete-routine":
        modal.confirmModal({
          title: "Excluir rotina",
          message: "Isto excluirá a rotina, os resultados registrados e as pastas observadas associadas. Deseja continuar?",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            await store.deleteRoutine(el.dataset.id);
            modal.toast("Rotina excluída.", "success");
            render();
          },
        });
        break;
      case "new-result": {
        const db = await store.get();
        const routine = db.routines.find((x) => x.id === el.dataset.routineId);
        openResultModal(routine);
        break;
      }
      case "run-pylinac-analysis":
        runPylinacAnalysis(el);
        break;
      case "run-dosimetry-calculation":
        runDosimetryCalculation(el);
        break;
      case "import-dosimetry":
        openDosimetryImportModal(el.dataset.equipmentId);
        break;
      case "dosimetry-import-preview":
        previewDosimetryImport();
        break;
      case "dosimetry-import-commit":
        commitDosimetryImport(el);
        break;
      case "view-result": {
        const db = await store.get();
        const result = db.results.find((x) => x.id === el.dataset.id);
        const routine = db.routines.find((x) => x.id === result.routineId);
        modal.openModal({ title: "Detalhe do resultado", bodyHtml: ui.resultDetailHtml(routine, result, auth.currentSession()), wide: true });
        const wlDetails = ui.winstonLutzImageDetails(routine, result);
        if (wlDetails) {
          const tolMetric = (routine.metrics || []).find((m) => m.key === "max_2d_cax_to_bb_mm");
          const actionRaw = routine.params && routine.params.action_level_mm;
          const actionLevelMm = actionRaw !== undefined && actionRaw !== null && actionRaw !== "" ? Number(actionRaw) : undefined;
          wlChart.renderWinstonLutzPanel(document.getElementById("wl-image-panel"), wlDetails, {
            toleranceMm: tolMetric && typeof tolMetric.tol === "number" ? tolMetric.tol : undefined,
            actionLevelMm: actionLevelMm !== undefined && !Number.isNaN(actionLevelMm) ? actionLevelMm : undefined,
          });
        }
        break;
      }
      case "approve-result":
        openApprovalModal(el.dataset.id);
        break;
      case "approve-all-results": {
        const db = await store.get();
        const count = db.results.filter((r) => !r.approval).length;
        openApproveAllModal(count);
        break;
      }
      case "sort-dashboard": {
        const key = el.dataset.key;
        dashboardSort = dashboardSort.key === key ? { key, dir: -dashboardSort.dir } : { key, dir: 1 };
        render();
        break;
      }
      case "filter-dashboard": {
        const clicked = el.dataset.filter;
        dashboardFilter = dashboardFilter === clicked ? null : clicked;
        render();
        break;
      }
      case "toggle-pending-approvals":
        dashboardShowPending = !dashboardShowPending;
        render();
        break;
      case "delete-result":
        modal.confirmModal({
          title: "Excluir resultado",
          message: "Deseja excluir este resultado registrado?",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            await store.deleteResult(el.dataset.id);
            modal.toast("Resultado excluído.", "success");
            render();
          },
        });
        break;
      case "new-user":
        modal.openModal({ title: "Novo usuário", bodyHtml: ui.userFormHtml() });
        bindUserForm();
        break;
      case "delete-user":
        modal.confirmModal({
          title: "Excluir usuário",
          message: "Deseja excluir este usuário? Aprovações já assinadas por ele serão mantidas no histórico.",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: async () => {
            await store.deleteUser(el.dataset.id);
            modal.toast("Usuário excluído.", "success");
            render();
          },
        });
        break;
      case "reset-password":
        modal.openModal({ title: "Redefinir senha", bodyHtml: ui.resetPasswordFormHtml(el.dataset.id) });
        bindResetPasswordForm();
        break;
      case "export-backup":
        exportBackup();
        break;
      case "import-backup":
        importBackup();
        break;
      case "save-backend-url": {
        const input = document.getElementById("backend-url-input");
        store.setBackendUrl(input.value);
        modal.toast("URL do backend salva.", "success");
        render();
        break;
      }
      case "test-backend-connection":
        testBackendConnection();
        break;
      case "save-auto-backup-dir": {
        const input = document.getElementById("auto-backup-dir-input");
        if (!input.value.trim()) {
          modal.toast("Informe um caminho de pasta.", "error");
          break;
        }
        try {
          await store.setAutoBackupDir(input.value.trim());
          modal.toast("Pasta de backup automático salva.", "success");
          render();
        } catch (err) {
          modal.toast(err.message, "error");
        }
        break;
      }
      case "run-auto-backup-now":
        try {
          await store.runAutoBackupNow();
          modal.toast("Backup gravado.", "success");
          render();
        } catch (err) {
          modal.toast(err.message, "error");
        }
        break;
      case "disable-auto-backup":
        modal.confirmModal({
          title: "Desativar backup automático",
          message: "O arquivo já gravado não será apagado, mas novas alterações deixarão de ser salvas automaticamente nele.",
          confirmLabel: "Desativar",
          danger: true,
          onConfirm: async () => {
            await store.setAutoBackupDir(null);
            modal.toast("Backup automático desativado.", "success");
            render();
          },
        });
        break;
      case "save-snc-fdb-path": {
        const input = document.getElementById("snc-fdb-path-input");
        if (!input.value.trim()) {
          modal.toast("Informe o caminho do Sncdata.fdb.", "error");
          break;
        }
        try {
          await store.setSncFdbPath(input.value.trim());
          modal.toast("Caminho salvo. Sincronizando pela primeira vez...", "success");
          await store.runSncSyncNow();
          render();
        } catch (err) {
          modal.toast(err.message, "error");
        }
        break;
      }
      case "run-snc-sync-now": {
        const statusEl = document.getElementById("snc-sync-status");
        if (statusEl) statusEl.textContent = "Sincronizando...";
        try {
          const result = await store.runSncSyncNow();
          modal.toast(
            result.created > 0 ? `${result.created} resultado(s) novo(s) importado(s).` : "Nada novo para importar.",
            "success"
          );
          render();
        } catch (err) {
          modal.toast(err.message, "error");
          if (statusEl) statusEl.textContent = "";
        }
        break;
      }
      case "add-manual-metric":
        addManualMetricRow();
        break;
      case "remove-manual-metric":
        el.closest(".manual-metric-row").remove();
        break;
      case "toggle-watch-folder":
        await store.setWatchFolderActive(el.dataset.id, el.dataset.active === "1");
        render();
        break;
      case "delete-watch-folder":
        modal.confirmModal({
          title: "Remover pasta observada",
          message: "O backend vai parar de observar essa pasta. Arquivos já processados não são afetados.",
          confirmLabel: "Remover",
          danger: true,
          onConfirm: async () => {
            await store.deleteWatchFolder(el.dataset.id);
            render();
          },
        });
        break;
      case "toggle-filter": {
        const parts = parseHash();
        const routineId = parts[3];
        const filters = getOrInitFilters(routineId);
        const set = filters[el.dataset.filterType];
        const value = el.dataset.filterValue;
        if (set.has(value)) set.delete(value);
        else set.add(value);
        render();
        break;
      }
      case "set-date-filter": {
        const parts = parseHash();
        const routineId = parts[3];
        const filters = getOrInitFilters(routineId);
        filters.dateRange = el.dataset.value;
        render();
        break;
      }
      case "clear-filters": {
        const parts = parseHash();
        const routineId = parts[3];
        resultFilters[routineId] = ui.defaultFilters();
        render();
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.id === "watch-folder-form") {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      try {
        await store.addWatchFolder(form.dataset.routineId, fd.get("folderPath"));
        modal.toast("Pasta configurada para observação.", "success");
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    }
    if (e.target.id === "certificate-upload-form") {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const file = fd.get("file");
      if (!file || !file.name) {
        modal.toast("Selecione um arquivo.", "error");
        return;
      }
      try {
        await store.uploadAssetCertificate(form.dataset.assetId, file, {
          issuedDate: fd.get("issuedDate") || undefined,
          validUntil: fd.get("validUntil") || undefined,
          notes: fd.get("notes") || undefined,
        });
        modal.toast("Certificado enviado.", "success");
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    }
    if (e.target.id === "measurement-form") {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const numOrNull = (v) => (v === null || v === "" ? null : Number(v));
      try {
        await store.addAssetMeasurement(form.dataset.assetId, {
          measuredAt: fd.get("measuredAt"),
          ndw: numOrNull(fd.get("ndw")),
          ndwUncertaintyPct: numOrNull(fd.get("ndwUncertaintyPct")),
          ks: numOrNull(fd.get("ks")),
          kpol: numOrNull(fd.get("kpol")),
          workingVoltageV: numOrNull(fd.get("workingVoltageV")),
          beamLabel: fd.get("beamLabel") || null,
          notes: fd.get("notes") || null,
        });
        modal.toast("Medição adicionada.", "success");
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    }
  });

  // Leituras da dosimetria: média e Max/Min (%) ao lado de cada linha,
  // atualizados a cada número digitado (como a planilha).
  document.addEventListener("input", (e) => {
    if (!e.target.classList.contains("reading-input")) return;
    const row = e.target.closest(".readings-row");
    row.querySelector("[data-readings-stats]").textContent = ui.readingsStats(readingsFromRow(row));
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches(".trs398-session-input[data-session-type='checkbox']")) {
      const key = e.target.dataset.sessionKey;
      document
        .querySelectorAll(`.readings-row[data-show-when="${key}"]`)
        .forEach((row) => row.classList.toggle("hidden", !e.target.checked));
    }
    if (e.target.id === "dosimetry-import-machine") {
      document.getElementById("dosimetry-import-preview").innerHTML = ui.dosimetryImportPreviewHtml(dosimetryImportState.summary, e.target.value);
    }
    if (e.target.id === "dosimetry-import-approve") {
      document.getElementById("dosimetry-import-signature").classList.toggle("hidden", !e.target.checked);
    }
    if (e.target.matches('input[name="testType"]')) {
      const val = e.target.value;
      document.getElementById("pylinac-section").classList.toggle("hidden", val !== "pylinac");
      document.getElementById("manual-section").classList.toggle("hidden", val !== "manual");
      document.getElementById("trs398-section").classList.toggle("hidden", val !== "trs398");
      document.getElementById("snc-section").classList.toggle("hidden", val !== "snc_daily");
      syncConditionalRequired();
    }
    if (e.target.id === "module-select") {
      const module = catalog.getModuleById(e.target.value);
      document.getElementById("module-description").textContent = module ? `${module.description} (${module.pylinacRef})` : "";
      document.getElementById("module-params-container").innerHTML = module ? ui.moduleParamsFormHtml(module, {}, currentAssetsByType) : "";
      document.getElementById("module-metrics-container").innerHTML = module
        ? ui.moduleMetricsPreviewHtml(module, [], readModuleParams(e.target.form, module))
        : "";
    }
    // Métricas que dependem de parâmetro (ex.: insertos de HU por modelo de
    // CatPhan): ao trocar o parâmetro, refaz a tabela mantendo o que já
    // tinha sido configurado nas linhas que continuam existindo.
    if (e.target.name && e.target.name.startsWith("param__") && e.target.form) {
      const moduleSelect = e.target.form.querySelector("#module-select");
      const module = moduleSelect && catalog.getModuleById(moduleSelect.value);
      if (module && module.metricsForParams) {
        const form = e.target.form;
        const current = readModuleMetrics(new FormData(form), catalog.getModuleMetrics(module, readModuleParams(form, module))).filter((m) =>
          form.querySelector(`[name="metric__${m.key}__tolType"]`)
        );
        document.getElementById("module-metrics-container").innerHTML = ui.moduleMetricsPreviewHtml(module, current, readModuleParams(form, module));
      }
    }
    // Dosimetria TRS-398: trocar fótons/elétrons troca os parâmetros e as
    // métricas que valem para o feixe; trocar a câmara mostra o ND,w dela.
    if (e.target.name === "param__beam_type" && e.target.closest("#trs398-section")) {
      const form = e.target.form;
      const module = catalog.DOSIMETRY_TRS398_TYPE;
      form
        .querySelectorAll("#trs398-section [data-beam-type]")
        .forEach((el) => el.classList.toggle("hidden", el.dataset.beamType !== e.target.value));
      const current = readModuleMetrics(new FormData(form), module.metrics).filter((m) =>
        form.querySelector(`#trs398-metrics-container [name="metric__${m.key}__tolType"]`)
      );
      document.getElementById("trs398-metrics-container").innerHTML = ui.moduleMetricsPreviewHtml(module, current, readModuleParams(form, module));
    }
    if (e.target.name === "param__chamber_asset_id" && e.target.closest("#trs398-section")) {
      refreshTrs398NdwInfo(e.target.form);
    }
    if (e.target.dataset.action === "manual-metric-toltype") {
      const row = e.target.closest(".manual-metric-row");
      const index = row.dataset.manualRow;
      const tolSpan = row.querySelector(`[data-manual-tol="${index}"]`);
      const unitInput = row.querySelector(`input[name="mm_unit_${index}"]`);
      tolSpan.innerHTML = ui.toleranceInputsHtml("mm_" + index, e.target.value, {}, unitInput ? unitInput.value : "");
    }
    if (e.target.dataset.action === "pylinac-metric-toltype") {
      const key = e.target.dataset.metricKey;
      const row = e.target.closest("tr[data-metric-row]");
      const tolCell = row.querySelector(`[data-metric-tol-cell="${key}"]`);
      const unitInput = row.querySelector(`input[name="metric__${key}__unit"]`);
      tolCell.innerHTML = ui.toleranceInputsHtml("metric__" + key, e.target.value, {}, unitInput ? unitInput.value : "");
    }
    if (e.target.classList.contains("trend-metric-check")) {
      const parts = parseHash();
      const routineId = parts[3];
      const checks = Array.from(document.querySelectorAll(".trend-metric-check"));
      trendSelection[routineId] = checks.filter((c) => c.checked).map((c) => c.value);
      if (lastRoutineView && lastRoutineView.routineId === routineId) {
        drawTrendChart(lastRoutineView.routine, lastRoutineView.filteredResults);
      }
    }
  });

  window.addEventListener("resize", () => {
    const parts = parseHash();
    if (parts[0] === "equipamentos" && parts.length === 4 && lastRoutineView && lastRoutineView.routineId === parts[3]) {
      drawTrendChart(lastRoutineView.routine, lastRoutineView.filteredResults);
    }
  });

  // ------------------------------------------------------------------
  // Modais: Equipamento
  // ------------------------------------------------------------------
  function openEquipmentModal(equipment) {
    modal.openModal({ title: equipment ? "Editar equipamento" : "Novo equipamento", bodyHtml: ui.equipmentForm(equipment), wide: true });
    const form = document.getElementById("equipment-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const data = {
        type: fd.get("type"),
        name: fd.get("name"),
        manufacturer: fd.get("manufacturer"),
        model: fd.get("model"),
        serialNumber: fd.get("serialNumber"),
        location: fd.get("location"),
        notes: fd.get("notes"),
        active: fd.get("active") === "on",
      };
      const id = form.dataset.id;
      try {
        if (id) {
          await store.updateEquipment(id, data);
          modal.toast("Equipamento atualizado.", "success");
        } else {
          await store.addEquipment(data);
          modal.toast("Equipamento cadastrado.", "success");
        }
        modal.closeModal();
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    });
  }

  // ------------------------------------------------------------------
  // Modais: Ativos
  // ------------------------------------------------------------------
  function openAssetModal(asset) {
    modal.openModal({ title: asset ? "Editar ativo" : "Novo ativo", bodyHtml: ui.assetFormHtml(asset), wide: true });
    const form = document.getElementById("asset-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const data = {
        type: fd.get("type"),
        name: fd.get("name"),
        manufacturer: fd.get("manufacturer"),
        model: fd.get("model"),
        serialNumber: fd.get("serialNumber"),
        location: fd.get("location"),
        notes: fd.get("notes"),
        active: fd.get("active") === "on",
      };
      const id = form.dataset.id;
      try {
        if (id) {
          await store.updateAsset(id, data);
          modal.toast("Ativo atualizado.", "success");
        } else {
          await store.addAsset(data);
          modal.toast("Ativo cadastrado.", "success");
        }
        modal.closeModal();
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    });
  }

  async function downloadCertificate(assetId, certId, filename) {
    const backendUrl = store.getBackendUrl();
    const session = auth.currentSession();
    const headers = session && session.token ? { Authorization: `Bearer ${session.token}` } : {};
    try {
      const resp = await fetch(`${backendUrl}/api/ativos/${assetId}/certificados/${certId}/arquivo`, { headers });
      if (!resp.ok) throw new Error(`Erro ${resp.status} ao baixar o certificado.`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "certificado";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      modal.toast(err.message, "error");
    }
  }

  // ------------------------------------------------------------------
  // Modais: Rotina
  // ------------------------------------------------------------------

  // Mostra no formulário da rotina TRS-398 o ND,w que o cálculo vai usar:
  // a última calibração com ND,w no histórico da câmara escolhida (a
  // lista vem do backend já da mais recente para a mais antiga).
  async function refreshTrs398NdwInfo(form) {
    const box = document.getElementById("trs398-ndw-info");
    const select = form && form.querySelector("#trs398-section [name='param__chamber_asset_id']");
    if (!box || !select) return;
    box.classList.remove("hidden");
    const chamberId = select.value;
    const chamber = (currentAssetsByType.ionization_chamber || []).find((a) => a.id === chamberId);
    if (!chamber) {
      box.innerHTML = ui.trs398NdwInfoHtml(null, null);
      return;
    }
    try {
      const measurements = await store.listAssetMeasurements(chamberId);
      if (select.value !== chamberId) return; // câmara trocada enquanto carregava
      const latest = measurements.find((m) => m.ndw !== null && m.ndw !== undefined) || null;
      box.innerHTML = ui.trs398NdwInfoHtml(chamber, latest);
    } catch (err) {
      box.innerHTML = `<div class="muted">Não foi possível carregar o N<sub>D,w</sub> da câmara: ${ui.esc(err.message)}</div>`;
    }
  }

  async function openRoutineModal(equipmentId, routine) {
    const db = await store.get();
    const equipment = db.equipments.find((e) => e.id === equipmentId);
    let assets = [];
    try {
      assets = await store.listAssets();
    } catch (err) {
      // segue sem os ativos — os selects de câmara/eletrômetro ficam vazios
    }
    currentAssetsByType = groupAssetsByType(assets);
    try {
      currentSncTemplates = await store.listSncTemplates();
    } catch (err) {
      // segue sem os modelos do Atlas — provavelmente o caminho do
      // Sncdata.fdb ainda não foi configurado em Backup
      currentSncTemplates = [];
    }
    modal.openModal({
      title: routine ? "Editar rotina de CQ" : "Nova rotina de CQ",
      bodyHtml: ui.routineFormHtml(equipment, routine, currentAssetsByType, currentSncTemplates, db.users),
      wide: true,
    });
    syncConditionalRequired();
    const form = document.getElementById("routine-form");
    refreshTrs398NdwInfo(form);

    // Pré-visualização da aparência do gráfico: o modal cobre a tela
    // inteira, então sem isso o técnico muda os campos e não vê nenhum
    // efeito até salvar e fechar — a prévia mostra na hora, com dados de
    // exemplo, exatamente a mesma renderização que o gráfico real vai usar.
    function drawChartStylePreview() {
      const previewContainer = document.getElementById("chart-style-preview");
      if (!previewContainer) return;
      const fd = new FormData(form);
      const style = readChartStyleFromForm(fd);
      const dates = ["2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15", "2026-10-01", "2026-10-13"];
      const sample = [0.8, 1.6, -1.2, 2.4, 0.3, -2.8];
      chart.renderTrendChart(previewContainer, {
        height: 150,
        series: [
          {
            label: "Exemplo",
            unit: "%",
            points: dates.map((x, i) => ({ x, y: sample[i] })),
            actionLow: -3,
            actionHigh: 3,
            toleranceLow: -5,
            toleranceHigh: 5,
          },
        ],
        style,
      });
    }
    drawChartStylePreview();
    form.addEventListener("input", (e) => {
      if (e.target.name && e.target.name.startsWith("chartStyle__")) drawChartStylePreview();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const testType = fd.get("testType");
      let metrics = [];
      let params = {};

      if (testType === "pylinac") {
        const moduleId = fd.get("moduleId");
        const module = catalog.getModuleById(moduleId);
        if (!module) {
          modal.toast("Selecione um módulo pylinac.", "error");
          return;
        }
        params = readModuleParams(form, module);
        metrics = readModuleMetrics(fd, catalog.getModuleMetrics(module, params));
      } else if (testType === "trs398") {
        const module = catalog.DOSIMETRY_TRS398_TYPE;
        module.params.forEach((p) => {
          const raw = fd.get("param__" + p.key);
          params[p.key] = p.type === "checkbox" ? form.querySelector(`[name="param__${p.key}"]`).checked : raw;
        });
        // Só as métricas do tipo de feixe escolhido (fótons: PDD/TPR20,10;
        // elétrons: leitura em I50).
        metrics = readModuleMetrics(fd, catalog.getModuleMetrics(module, params));
      } else if (testType === "snc_daily") {
        const module = catalog.DAILY_SNC_TYPE;
        module.params.forEach((p) => {
          const raw = fd.get("param__" + p.key);
          params[p.key] = p.type === "checkbox" ? form.querySelector(`[name="param__${p.key}"]`).checked : raw;
        });
        metrics = module.metrics.map((m) => {
          const tolType = fd.get(`metric__${m.key}__tolType`) || m.tolType;
          const entry = { key: m.key, label: m.label, unit: m.unit, tolType };
          if (tolType === "max" || tolType === "min") entry.tol = parseFloat(fd.get(`metric__${m.key}__tol`));
          if (tolType === "range") {
            entry.tolLow = parseFloat(fd.get(`metric__${m.key}__tolLow`));
            entry.tolHigh = parseFloat(fd.get(`metric__${m.key}__tolHigh`));
          }
          if (tolType === "action") {
            entry.actionPct = parseFloat(fd.get(`metric__${m.key}__actionPct`));
            entry.tolerancePct = parseFloat(fd.get(`metric__${m.key}__tolerancePct`));
          }
          return entry;
        });
      } else {
        const rows = Array.from(form.querySelectorAll(".manual-metric-row"));
        metrics = rows
          .map((row) => {
            const idx = row.dataset.manualRow;
            const label = fd.get(`mm_label_${idx}`);
            if (!label) return null;
            const unit = fd.get(`mm_unit_${idx}`);
            const tolType = fd.get(`mm_toltype_${idx}`);
            const requiredInput = row.querySelector(`[name="mm_required_${idx}"]`);
            const entry = { key: slugify(label) + "_" + idx, label, unit, tolType, required: requiredInput ? requiredInput.checked : false };
            if (tolType === "max" || tolType === "min") entry.tol = parseFloat(fd.get(`mm_${idx}__tol`));
            if (tolType === "range") {
              entry.tolLow = parseFloat(fd.get(`mm_${idx}__tolLow`));
              entry.tolHigh = parseFloat(fd.get(`mm_${idx}__tolHigh`));
            }
            if (tolType === "action") {
              entry.actionPct = parseFloat(fd.get(`mm_${idx}__actionPct`));
              entry.tolerancePct = parseFloat(fd.get(`mm_${idx}__tolerancePct`));
            }
            if (tolType === "select") {
              entry.options = (fd.get(`mm_${idx}__options`) || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            }
            return entry;
          })
          .filter(Boolean);
      }

      const chartStyle = readChartStyleFromForm(fd);

      // Só os técnicos marcados aqui conseguem ver esta rotina — nenhum
      // marcado (padrão) significa que só administradores a veem.
      const visibleTo = Array.from(form.querySelectorAll('[name^="visibleTo__"]:checked')).map((el) => el.name.replace("visibleTo__", ""));

      const data = {
        equipmentId,
        name: fd.get("name"),
        frequency: fd.get("frequency"),
        testType,
        moduleId: testType === "pylinac" ? fd.get("moduleId") : null,
        params,
        metrics,
        chartStyle,
        visibleTo,
        notes: fd.get("notes"),
        active: fd.get("active") === "on",
      };

      const id = form.dataset.id;
      try {
        if (id) {
          await store.updateRoutine(id, data);
          modal.toast("Rotina atualizada.", "success");
        } else {
          await store.addRoutine(data);
          modal.toast("Rotina cadastrada.", "success");
        }
        modal.closeModal();
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    });
  }

  function slugify(str) {
    return String(str)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function addManualMetricRow() {
    const container = document.getElementById("manual-metrics-rows");
    const index = container.children.length;
    container.insertAdjacentHTML("beforeend", ui.manualMetricRowHtml({}, index));
  }

  // ------------------------------------------------------------------
  // Modais: Resultado + Aprovação
  // ------------------------------------------------------------------
  async function openResultModal(routine) {
    const module =
      routine.testType === "pylinac"
        ? catalog.getModuleById(routine.moduleId)
        : routine.testType === "trs398"
          ? catalog.DOSIMETRY_TRS398_TYPE
          : routine.testType === "snc_daily"
            ? catalog.DAILY_SNC_TYPE
            : null;
    if (routine.testType === "trs398") {
      let assets = [];
      try {
        assets = await store.listAssets();
      } catch (err) {
        // segue sem os ativos — os selects de barômetro/termômetro ficam vazios
      }
      currentAssetsByType = groupAssetsByType(assets);
    }
    modal.openModal({ title: "Registrar resultado", bodyHtml: ui.resultFormHtml(routine, module, currentAssetsByType), wide: true });
    const form = document.getElementById("result-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const values = {};
      (routine.metrics || []).forEach((m) => {
        const v = fd.get("value__" + m.key);
        if (v !== null && v !== "") values[m.key] = m.tolType === "bool" ? v === "true" : v;
      });
      const rawMetricsJson = fd.get("raw_metrics_json");
      const sourceFilesJson = fd.get("source_files_json");
      const result = {
        routineId: routine.id,
        date: fd.get("date"),
        performedByName: fd.get("performedByName"),
        values,
        passOverride: fd.get("passOverride") ? fd.get("passOverride") === "true" : undefined,
        notes: fd.get("notes"),
        analyzedWithPylinac: !!rawMetricsJson,
        rawMetrics: rawMetricsJson ? JSON.parse(rawMetricsJson) : null,
        sourceFiles: sourceFilesJson ? JSON.parse(sourceFilesJson) : [],
      };
      try {
        await store.addResult(result);
        modal.toast("Resultado registrado.", "success");
        modal.closeModal();
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    });
  }

  async function runPylinacAnalysis(triggerEl) {
    const section = triggerEl.closest(".pylinac-upload-section");
    const form = document.getElementById("result-form");
    const routineId = form.dataset.routineId;
    const db = await store.get();
    const routine = db.routines.find((r) => r.id === routineId);
    const moduleId = section.dataset.moduleId;
    const fileMode = section.dataset.fileMode;
    const statusEl = document.getElementById("pylinac-analysis-status");

    const fileInputs = Array.from(section.querySelectorAll(".pylinac-file-input"));
    const files = [];
    for (const input of fileInputs) {
      if (!input.files || input.files.length === 0) {
        statusEl.textContent = "Selecione o(s) arquivo(s) necessário(s) antes de analisar.";
        statusEl.className = "pylinac-status form-error";
        return;
      }
      for (const f of input.files) files.push(f);
    }
    if (fileMode === "pair" && files.length !== 2) {
      statusEl.textContent = "Este teste exige exatamente 2 arquivos (um em cada campo).";
      statusEl.className = "pylinac-status form-error";
      return;
    }
    if (fileMode === "single" && files.length !== 1) {
      statusEl.textContent = "Este teste exige exatamente 1 arquivo.";
      statusEl.className = "pylinac-status form-error";
      return;
    }

    const formData = new FormData();
    formData.append("module_id", moduleId);
    formData.append("params", JSON.stringify(routine.params || {}));
    files.forEach((f) => formData.append("files", f, f.name));

    const backendUrl = store.getBackendUrl();
    triggerEl.disabled = true;
    triggerEl.textContent = "Analisando (pode levar alguns segundos)...";
    statusEl.textContent = "";
    statusEl.className = "pylinac-status muted small";

    try {
      const session = auth.currentSession();
      const headers = session && session.token ? { Authorization: `Bearer ${session.token}` } : {};
      const resp = await fetch(`${backendUrl}/api/analyze`, { method: "POST", headers, body: formData });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.detail || "Falha na análise.");
      }

      (routine.metrics || []).forEach((m) => {
        const value = data.metrics[m.key];
        if (value === undefined) return;
        const input = form.querySelector(`.result-metric-input[data-metric-key="${cssEscape(m.key)}"]`);
        if (!input) return;
        if (m.tolType === "bool") {
          input.value = String(!!value);
        } else {
          const formatted = ui.fixDecimals(value, ui.isAngleUnit(m.unit) ? 1 : 2);
          input.value = formatted === null ? value : formatted;
        }
      });

      if (data.metrics.dicom_study_date) {
        const dateInput = form.querySelector('input[name="date"]');
        if (dateInput) dateInput.value = data.metrics.dicom_study_date;
      }

      document.getElementById("raw-metrics-json-field").value = JSON.stringify(data.metrics);
      document.getElementById("source-files-json-field").value = JSON.stringify(files.map((f) => f.name));
      const rawJsonEl = document.getElementById("pylinac-raw-json");
      rawJsonEl.textContent = JSON.stringify(data.metrics, null, 2);
      document.getElementById("pylinac-raw-details").classList.remove("hidden");

      statusEl.textContent =
        "Análise concluída." + (data.warnings && data.warnings.length ? ` Avisos do pylinac: ${data.warnings.join("; ")}` : "");
      statusEl.className = "pylinac-status muted small";
      modal.toast("Análise pylinac concluída. Confira os valores antes de salvar.", "success");
    } catch (err) {
      const isNetworkError = err instanceof TypeError;
      statusEl.textContent = isNetworkError
        ? `Não foi possível conectar ao servidor de análise (${backendUrl}). Verifique se o backend está rodando e a URL configurada em Backup.`
        : `Erro na análise: ${err.message}`;
      statusEl.className = "pylinac-status form-error";
      modal.toast("Falha ao analisar com pylinac.", "error");
    } finally {
      triggerEl.disabled = false;
      triggerEl.textContent = "▶ Analisar com pylinac";
    }
  }

  async function runDosimetryCalculation(triggerEl) {
    const section = triggerEl.closest(".trs398-session-section");
    const form = document.getElementById("result-form");
    const routineId = form.dataset.routineId;
    const db = await store.get();
    const routine = db.routines.find((r) => r.id === routineId);
    const statusEl = document.getElementById("pylinac-analysis-status");

    const sessionData = {};
    const missing = [];
    section.querySelectorAll(".trs398-session-input").forEach((input) => {
      const key = input.dataset.sessionKey;
      const type = input.dataset.sessionType;
      if (type === "checkbox") {
        sessionData[key] = input.checked;
      } else if (type === "readings") {
        const hidden = input.classList.contains("hidden");
        sessionData[key] = hidden ? [] : readingsFromRow(input);
        if (!hidden && input.dataset.required && !sessionData[key].length) {
          missing.push(input.querySelector(".readings-label").textContent.replace("nC", "").trim());
        }
      } else if (type === "asset-select") {
        sessionData[key] = input.value || null;
      } else {
        sessionData[key] = input.value === "" ? null : Number(input.value);
      }
    });

    const contextEl = document.getElementById("dosimetry-context");
    if (missing.length) {
      statusEl.textContent = `Lance ao menos uma leitura em: ${missing.join("; ")}.`;
      statusEl.className = "pylinac-status form-error";
      return;
    }

    const backendUrl = store.getBackendUrl();
    triggerEl.disabled = true;
    triggerEl.textContent = "Calculando...";
    statusEl.textContent = "";
    statusEl.className = "pylinac-status muted small";
    contextEl.classList.add("hidden");

    try {
      const authSession = auth.currentSession();
      const headers = { "Content-Type": "application/json" };
      if (authSession && authSession.token) headers.Authorization = `Bearer ${authSession.token}`;
      const resp = await fetch(`${backendUrl}/api/dosimetry/calculate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ routineId, params: routine.params || {}, session: sessionData }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.detail || "Falha no cálculo.");
      }

      (routine.metrics || []).forEach((m) => {
        const value = data.metrics[m.key];
        if (value === undefined) return;
        const input = form.querySelector(`.result-metric-input[data-metric-key="${cssEscape(m.key)}"]`);
        if (!input) return;
        const formatted = ui.fixDecimals(value, 4);
        input.value = formatted === null ? value : formatted;
      });

      // Guarda também as leituras/seleções da sessão (não só os valores
      // calculados) — inclui pressure_asset_id/temperature_asset_id, para
      // rastreabilidade de qual barômetro/termômetro foi usado neste dia.
      const fullRawMetrics = { ...sessionData, ...data.metrics };
      document.getElementById("raw-metrics-json-field").value = JSON.stringify(fullRawMetrics);
      document.getElementById("source-files-json-field").value = JSON.stringify([]);
      const rawJsonEl = document.getElementById("pylinac-raw-json");
      rawJsonEl.textContent = JSON.stringify(fullRawMetrics, null, 2);
      document.getElementById("pylinac-raw-details").classList.remove("hidden");

      statusEl.textContent =
        "Cálculo concluído." + (data.warnings && data.warnings.length ? ` Avisos: ${data.warnings.join("; ")}` : "");
      statusEl.className = "pylinac-status muted small";
      contextEl.innerHTML = ui.dosimetryContextHtml(data.context, data.metrics);
      contextEl.classList.remove("hidden");
      modal.toast("Cálculo da dosimetria concluído. Confira os valores antes de salvar.", "success");
    } catch (err) {
      const isNetworkError = err instanceof TypeError;
      statusEl.textContent = isNetworkError
        ? `Não foi possível conectar ao servidor de análise (${backendUrl}). Verifique se o backend está rodando e a URL configurada em Backup.`
        : `Erro no cálculo: ${err.message}`;
      statusEl.className = "pylinac-status form-error";
      modal.toast("Falha ao calcular a dosimetria.", "error");
    } finally {
      triggerEl.disabled = false;
      triggerEl.textContent = "▶ Calcular";
    }
  }

  function cssEscape(str) {
    return String(str).replace(/[.[\]"']/g, "\\$&");
  }

  function readingsFromRow(row) {
    return Array.from(row.querySelectorAll(".reading-input"))
      .map((input) => (input.value === "" ? NaN : Number(input.value)))
      .filter((n) => !Number.isNaN(n));
  }

  // ---- Importação das planilhas de dosimetria (TRS-398) ----
  const dosimetryImportState = { equipmentId: null, files: [], summary: null };

  function openDosimetryImportModal(equipmentId) {
    Object.assign(dosimetryImportState, { equipmentId, files: [], summary: null });
    modal.openModal({ title: "Importar planilha de dosimetria (TRS-398)", bodyHtml: ui.dosimetryImportFormHtml(), wide: true });
  }

  async function previewDosimetryImport() {
    const errorBox = document.getElementById("dosimetry-import-error");
    const files = Array.from(document.getElementById("dosimetry-import-files").files || []);
    errorBox.textContent = "";
    if (!files.length) {
      errorBox.textContent = "Escolha ao menos uma planilha.";
      return;
    }
    const target = document.getElementById("dosimetry-import-preview");
    target.innerHTML = `<p class="muted small">Lendo planilhas...</p>`;
    try {
      const summary = await store.previewDosimetryImport(files);
      Object.assign(dosimetryImportState, { files, summary });
      target.innerHTML = ui.dosimetryImportPreviewHtml(summary);
      const session = auth.currentSession();
      if (session) document.getElementById("dosimetry-import-username").value = session.username || "";
    } catch (err) {
      target.innerHTML = "";
      errorBox.textContent = err.message;
    }
  }

  async function commitDosimetryImport(triggerEl) {
    const errorBox = document.getElementById("dosimetry-import-error");
    const beamIds = Array.from(document.querySelectorAll('input[name="dosimetry-import-beam"]:checked')).map((el) => el.value);
    errorBox.textContent = "";
    if (!beamIds.length) {
      errorBox.textContent = "Marque ao menos um feixe para importar.";
      return;
    }
    const approve = document.getElementById("dosimetry-import-approve").checked;
    // Métricas/tolerâncias padrão do catálogo para as rotinas novas — as
    // mesmas que uma rotina TRS-398 criada à mão recebe.
    const metricsTemplate = catalog.DOSIMETRY_TRS398_TYPE.metrics.map((m) => {
      const entry = { key: m.key, label: m.label, unit: m.unit, tolType: m.tolType };
      ["tol", "tolLow", "tolHigh", "actionPct", "tolerancePct", "plottable"].forEach((k) => {
        if (m[k] !== undefined) entry[k] = m[k];
      });
      return entry;
    });
    triggerEl.disabled = true;
    triggerEl.textContent = "Importando...";
    try {
      const stats = await store.commitDosimetryImport(dosimetryImportState.files, {
        equipmentId: dosimetryImportState.equipmentId,
        machine: document.getElementById("dosimetry-import-machine").value,
        beamIds,
        metricsTemplate,
        approve,
        username: approve ? document.getElementById("dosimetry-import-username").value : undefined,
        password: approve ? document.getElementById("dosimetry-import-password").value : undefined,
      });
      document.getElementById("dosimetry-import-preview").innerHTML = ui.dosimetryImportResultHtml(stats);
      modal.toast("Planilha de dosimetria importada.", "success");
      render();
    } catch (err) {
      errorBox.textContent = err.message;
      triggerEl.disabled = false;
      triggerEl.textContent = "Importar";
    }
  }

  function openApprovalModal(resultId) {
    modal.openModal({ title: "Aprovar resultado", bodyHtml: ui.approvalFormHtml(resultId) });
    const form = document.getElementById("approval-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const errorBox = document.getElementById("approval-error");
      errorBox.textContent = "";
      try {
        const updated = await store.approveResult(resultId, fd.get("username"), fd.get("password"));
        modal.toast(`Resultado aprovado por ${updated.approval.fullName}.`, "success");
        modal.closeModal();
        render();
      } catch (err) {
        errorBox.textContent = err.message;
      }
    });
  }

  function openApproveAllModal(count) {
    modal.openModal({ title: "Aprovar todos os resultados pendentes", bodyHtml: ui.approveAllFormHtml(count) });
    const form = document.getElementById("approve-all-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const errorBox = document.getElementById("approve-all-error");
      errorBox.textContent = "";
      try {
        const result = await store.approveAllResults(fd.get("username"), fd.get("password"));
        modal.toast(`${result.approvedCount} resultado(s) aprovado(s).`, "success");
        modal.closeModal();
        render();
      } catch (err) {
        errorBox.textContent = err.message;
      }
    });
  }

  // ------------------------------------------------------------------
  // Modais: Usuários
  // ------------------------------------------------------------------
  function bindUserForm() {
    const form = document.getElementById("user-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await auth.createUser({
          fullName: fd.get("fullName"),
          username: fd.get("username"),
          password: fd.get("password"),
          role: fd.get("role"),
        });
        modal.toast("Usuário criado.", "success");
        modal.closeModal();
        render();
      } catch (err) {
        modal.toast(err.message, "error");
      }
    });
  }

  function bindResetPasswordForm() {
    const form = document.getElementById("reset-password-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      if (fd.get("password") !== fd.get("password2")) {
        modal.toast("As senhas não coincidem.", "error");
        return;
      }
      await auth.changePassword(form.dataset.userId, fd.get("password"));
      modal.toast("Senha redefinida.", "success");
      modal.closeModal();
    });
  }

  // ------------------------------------------------------------------
  // Backup
  // ------------------------------------------------------------------
  async function testBackendConnection() {
    const statusEl = document.getElementById("backend-connection-status");
    const url = document.getElementById("backend-url-input").value.trim().replace(/\/+$/, "");
    statusEl.textContent = "Testando...";
    statusEl.className = "muted small mt";
    try {
      const resp = await fetch(`${url}/api/health`);
      const data = await resp.json();
      if (resp.ok && data.status === "ok") {
        statusEl.textContent = `Conectado! ${data.modules.length} tipos de teste com análise automática disponíveis.`;
        statusEl.className = "small mt form-success";
      } else {
        throw new Error("Resposta inesperada do servidor.");
      }
    } catch (err) {
      statusEl.textContent = `Não foi possível conectar em ${url}. Verifique se o backend está rodando (veja backend/README.md).`;
      statusEl.className = "small mt form-error";
    }
  }

  async function exportBackup() {
    let data;
    try {
      data = await store.exportBackup();
    } catch (err) {
      modal.toast(err.message, "error");
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backup-cq-radioterapia-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importBackup() {
    const input = document.getElementById("import-file-input");
    if (!input.files || input.files.length === 0) {
      modal.toast("Selecione um arquivo de backup (.json).", "error");
      return;
    }
    modal.confirmModal({
      title: "Importar backup",
      message: "Isto substituirá TODOS os dados atuais do backend pelos dados do arquivo. Deseja continuar?",
      confirmLabel: "Importar e substituir",
      danger: true,
      onConfirm: () => {
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const data = JSON.parse(reader.result);
            await store.replaceAll(data);
            modal.toast("Backup importado com sucesso.", "success");
            auth.logout();
            location.hash = "#/dashboard";
            render();
          } catch (err) {
            modal.toast(err.message || "Arquivo inválido.", "error");
          }
        };
        reader.readAsText(input.files[0]);
      },
    });
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  window.addEventListener("hashchange", render);
  window.addEventListener("DOMContentLoaded", render);
  if (document.readyState !== "loading") render();
})(window);
