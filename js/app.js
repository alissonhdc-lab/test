/* ==========================================================================
   app.js — roteamento (hash), estado de sessão e ligação de eventos.
   Todos os dados agora vêm do backend (API REST) — este arquivo trata a
   maior parte das chamadas como assíncronas.
   ========================================================================== */

(function (global) {
  "use strict";

  const { store, auth, ui, modal, chart, catalog, util } = global.RTQC;
  const appRoot = document.getElementById("app");

  let trendSelection = {}; // routineId -> [metricKey,...]
  let resultFilters = {}; // routineId -> {gantry:Set, collimator:Set, status:Set, dateRange}
  let lastRoutineView = null; // { routineId, routine, filteredResults } — usado por drawTrendChart/resize

  function getOrInitFilters(routineId) {
    if (!resultFilters[routineId]) resultFilters[routineId] = ui.defaultFilters();
    return resultFilters[routineId];
  }

  function formatAngle(v) {
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    const rounded = Math.round(n * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}°`;
  }

  function buildFilterOptions(allResults) {
    const gantrySet = new Set();
    const collimatorSet = new Set();
    allResults.forEach((r) => {
      if (r.values.dicom_gantry_angle_deg !== undefined) gantrySet.add(formatAngle(r.values.dicom_gantry_angle_deg));
      if (r.values.dicom_collimator_angle_deg !== undefined) collimatorSet.add(formatAngle(r.values.dicom_collimator_angle_deg));
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
        if (!filters.gantry.has(formatAngle(r.values.dicom_gantry_angle_deg))) return false;
      }
      if (filters.collimator.size > 0) {
        if (r.values.dicom_collimator_angle_deg === undefined) return false;
        if (!filters.collimator.has(formatAngle(r.values.dicom_collimator_angle_deg))) return false;
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
        if (new Date(r.date) < cutoff) return false;
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
    const route = parts[0] || "dashboard";

    let db;
    try {
      db = await store.get();
    } catch (err) {
      appRoot.innerHTML = ui.renderBackendError(err.message, store.getBackendUrl());
      bindBackendErrorScreen();
      return;
    }

    let content = "";
    let watchFolders = [];
    if (route === "dashboard") {
      content = ui.renderDashboard(db);
    } else if (route === "equipamentos" && parts.length === 1) {
      content = ui.renderEquipmentsList(db);
    } else if (route === "equipamentos" && parts.length === 2) {
      const eq = db.equipments.find((e) => e.id === parts[1]);
      if (!eq) {
        location.hash = "#/equipamentos";
        return;
      }
      content = ui.renderEquipmentDetail(db, eq);
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
      watchFolders = await store.listWatchFolders(routine.id);
      const allResults = db.results.filter((r) => r.routineId === routine.id);
      const filters = getOrInitFilters(routine.id);
      const filteredResults = applyResultFilters(routine, allResults, filters);
      const filterOptions = buildFilterOptions(allResults);
      lastRoutineView = { routineId: routine.id, routine, filteredResults };
      content = ui.renderRoutineDetail(db, eq, routine, trendSelection[routine.id], watchFolders, allResults, filteredResults, filters, filterOptions);
    } else if (route === "usuarios") {
      content = ui.renderUsers(db, session);
    } else if (route === "backup") {
      content = ui.renderBackup(db, store.getBackendUrl());
    } else if (route === "ajuda") {
      content = ui.renderHelp();
    } else {
      content = ui.renderDashboard(db);
    }

    appRoot.innerHTML = ui.renderShell(route, session, content);

    if (route === "equipamentos" && parts.length === 4 && lastRoutineView) {
      drawTrendChart(lastRoutineView.routine, lastRoutineView.filteredResults);
    }
  }

  function defaultTrendMetrics(routine) {
    const metrics = routine.metrics || [];
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
        return s;
      })
      .filter(Boolean);

    chart.renderTrendChart(container, { series });
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
      case "view-result": {
        const db = await store.get();
        const result = db.results.find((x) => x.id === el.dataset.id);
        const routine = db.routines.find((x) => x.id === result.routineId);
        modal.openModal({ title: "Detalhe do resultado", bodyHtml: ui.resultDetailHtml(routine, result), wide: true });
        break;
      }
      case "approve-result":
        openApprovalModal(el.dataset.id);
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
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches('input[name="testType"]')) {
      const val = e.target.value;
      document.getElementById("pylinac-section").classList.toggle("hidden", val !== "pylinac");
      document.getElementById("manual-section").classList.toggle("hidden", val !== "manual");
    }
    if (e.target.id === "module-select") {
      const module = catalog.getModuleById(e.target.value);
      document.getElementById("module-description").textContent = module ? `${module.description} (${module.pylinacRef})` : "";
      document.getElementById("module-params-container").innerHTML = module ? ui.moduleParamsFormHtml(module, {}) : "";
      document.getElementById("module-metrics-container").innerHTML = module ? ui.moduleMetricsPreviewHtml(module, []) : "";
    }
    if (e.target.dataset.action === "manual-metric-toltype") {
      const row = e.target.closest(".manual-metric-row");
      const index = row.dataset.manualRow;
      const tolSpan = row.querySelector(`[data-manual-tol="${index}"]`);
      tolSpan.innerHTML = ui.toleranceInputsHtml("mm_" + index, e.target.value, {});
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
  // Modais: Rotina
  // ------------------------------------------------------------------
  async function openRoutineModal(equipmentId, routine) {
    const db = await store.get();
    const equipment = db.equipments.find((e) => e.id === equipmentId);
    modal.openModal({ title: routine ? "Editar rotina de CQ" : "Nova rotina de CQ", bodyHtml: ui.routineFormHtml(equipment, routine), wide: true });
    const form = document.getElementById("routine-form");
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
            const entry = { key: slugify(label) + "_" + idx, label, unit, tolType };
            if (tolType === "max" || tolType === "min") entry.tol = parseFloat(fd.get(`mm_${idx}__tol`));
            if (tolType === "range") {
              entry.tolLow = parseFloat(fd.get(`mm_${idx}__tolLow`));
              entry.tolHigh = parseFloat(fd.get(`mm_${idx}__tolHigh`));
            }
            return entry;
          })
          .filter(Boolean);
      }

      const data = {
        equipmentId,
        name: fd.get("name"),
        frequency: fd.get("frequency"),
        testType,
        moduleId: testType === "pylinac" ? fd.get("moduleId") : null,
        params,
        metrics,
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
  function openResultModal(routine) {
    const module = routine.testType === "pylinac" ? catalog.getModuleById(routine.moduleId) : null;
    modal.openModal({ title: "Registrar resultado", bodyHtml: ui.resultFormHtml(routine, module), wide: true });
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
      const resp = await fetch(`${backendUrl}/api/analyze`, { method: "POST", body: formData });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.detail || "Falha na análise.");
      }

      (routine.metrics || []).forEach((m) => {
        const value = data.metrics[m.key];
        if (value === undefined) return;
        const input = form.querySelector(`.result-metric-input[data-metric-key="${cssEscape(m.key)}"]`);
        if (!input) return;
        if (m.tolType === "bool") input.value = String(!!value);
        else input.value = typeof value === "number" ? value : parseFloat(value);
      });

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

  function cssEscape(str) {
    return String(str).replace(/[.[\]"']/g, "\\$&");
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
