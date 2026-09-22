/* ==========================================================================
   app.js — roteamento (hash), estado de sessão e ligação de eventos.
   ========================================================================== */

(function (global) {
  "use strict";

  const { store, auth, ui, modal, chart, catalog, util } = global.RTQC;
  const appRoot = document.getElementById("app");

  let trendSelection = {}; // routineId -> [metricKey,...]

  // ------------------------------------------------------------------
  // Roteamento
  // ------------------------------------------------------------------
  function parseHash() {
    const hash = location.hash.replace(/^#\/?/, "");
    return hash.split("/").filter(Boolean);
  }

  async function render() {
    const session = auth.currentSession();

    if (!auth.hasAnyUser()) {
      appRoot.innerHTML = ui.renderSetupAdmin();
      bindSetupAdminForm();
      return;
    }

    if (!session) {
      appRoot.innerHTML = ui.renderLogin();
      bindLoginForm();
      return;
    }

    const parts = parseHash();
    const route = parts[0] || "dashboard";
    const db = store.get();

    let content = "";
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
      content = ui.renderRoutineDetail(db, eq, routine, trendSelection[routine.id]);
    } else if (route === "usuarios") {
      content = ui.renderUsers(db, session);
    } else if (route === "backup") {
      content = ui.renderBackup(db);
    } else if (route === "ajuda") {
      content = ui.renderHelp();
    } else {
      content = ui.renderDashboard(db);
    }

    appRoot.innerHTML = ui.renderShell(route, session, content);

    if (route === "equipamentos" && parts.length === 4) {
      const routine = db.routines.find((r) => r.id === parts[3]);
      drawTrendChart(routine, db);
    }
  }

  function defaultTrendMetrics(routine) {
    const metrics = routine.metrics || [];
    const numeric = metrics.filter((m) => m.tolType !== "bool");
    if (numeric.length > 0) return [numeric[0].key];
    if (metrics.length > 0) return [metrics[0].key];
    return [];
  }

  function drawTrendChart(routine, db) {
    const container = document.getElementById("trend-chart-container");
    if (!container) return;
    const results = store.resultsByRoutine(routine.id);
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
        await auth.createUser({
          fullName: fd.get("fullName"),
          username: fd.get("username"),
          password,
          role: "admin",
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
        const db = store.get();
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
          onConfirm: () => {
            store.deleteEquipment(el.dataset.id);
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
        const db = store.get();
        const routine = db.routines.find((x) => x.id === el.dataset.id);
        openRoutineModal(routine.equipmentId, routine);
        break;
      }
      case "delete-routine":
        modal.confirmModal({
          title: "Excluir rotina",
          message: "Isto excluirá a rotina e todos os resultados registrados. Deseja continuar?",
          confirmLabel: "Excluir",
          danger: true,
          onConfirm: () => {
            store.deleteRoutine(el.dataset.id);
            modal.toast("Rotina excluída.", "success");
            render();
          },
        });
        break;
      case "new-result": {
        const db = store.get();
        const routine = db.routines.find((x) => x.id === el.dataset.routineId);
        openResultModal(routine);
        break;
      }
      case "view-result": {
        const db = store.get();
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
          onConfirm: () => {
            store.deleteResult(el.dataset.id);
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
          onConfirm: () => {
            store.deleteUser(el.dataset.id);
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
      case "add-manual-metric":
        addManualMetricRow();
        break;
      case "remove-manual-metric":
        el.closest(".manual-metric-row").remove();
        break;
      default:
        break;
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
      const db = store.get();
      const routine = db.routines.find((r) => r.id === routineId);
      drawTrendChart(routine, db);
    }
  });

  window.addEventListener("resize", () => {
    const parts = parseHash();
    if (parts[0] === "equipamentos" && parts.length === 4) {
      const db = store.get();
      const routine = db.routines.find((r) => r.id === parts[3]);
      if (routine) drawTrendChart(routine, db);
    }
  });

  // ------------------------------------------------------------------
  // Modais: Equipamento
  // ------------------------------------------------------------------
  function openEquipmentModal(equipment) {
    modal.openModal({ title: equipment ? "Editar equipamento" : "Novo equipamento", bodyHtml: ui.equipmentForm(equipment), wide: true });
    const form = document.getElementById("equipment-form");
    form.addEventListener("submit", (e) => {
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
      if (id) {
        store.updateEquipment(id, data);
        modal.toast("Equipamento atualizado.", "success");
      } else {
        data.id = store.uid();
        data.createdAt = store.nowIso();
        store.addEquipment(data);
        modal.toast("Equipamento cadastrado.", "success");
      }
      modal.closeModal();
      render();
    });
  }

  // ------------------------------------------------------------------
  // Modais: Rotina
  // ------------------------------------------------------------------
  function openRoutineModal(equipmentId, routine) {
    const db = store.get();
    const equipment = db.equipments.find((e) => e.id === equipmentId);
    modal.openModal({ title: routine ? "Editar rotina de CQ" : "Nova rotina de CQ", bodyHtml: ui.routineFormHtml(equipment, routine), wide: true });
    const form = document.getElementById("routine-form");
    form.addEventListener("submit", (e) => {
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
      if (id) {
        store.updateRoutine(id, data);
        modal.toast("Rotina atualizada.", "success");
      } else {
        data.id = store.uid();
        data.createdAt = store.nowIso();
        store.addRoutine(data);
        modal.toast("Rotina cadastrada.", "success");
      }
      modal.closeModal();
      render();
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
    modal.openModal({ title: "Registrar resultado", bodyHtml: ui.resultFormHtml(routine), wide: true });
    const form = document.getElementById("result-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const values = {};
      (routine.metrics || []).forEach((m) => {
        const v = fd.get("value__" + m.key);
        if (v !== null && v !== "") values[m.key] = m.tolType === "bool" ? v === "true" : v;
      });
      const result = {
        id: store.uid(),
        routineId: routine.id,
        date: fd.get("date"),
        performedByName: fd.get("performedByName"),
        values,
        passOverride: fd.get("passOverride") ? fd.get("passOverride") === "true" : undefined,
        notes: fd.get("notes"),
        approval: null,
        createdAt: store.nowIso(),
      };
      store.addResult(result);
      modal.toast("Resultado registrado.", "success");
      modal.closeModal();
      render();
    });
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
        const approval = await auth.signApproval(fd.get("username"), fd.get("password"));
        store.updateResult(resultId, { approval });
        modal.toast(`Resultado aprovado por ${approval.fullName}.`, "success");
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
  function exportBackup() {
    const db = store.get();
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
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
      message: "Isto substituirá TODOS os dados atuais deste navegador pelos dados do arquivo. Deseja continuar?",
      confirmLabel: "Importar e substituir",
      danger: true,
      onConfirm: () => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(reader.result);
            store.replaceAll(data);
            modal.toast("Backup importado com sucesso.", "success");
            auth.logout();
            location.hash = "#/dashboard";
            render();
          } catch (err) {
            modal.toast("Arquivo inválido.", "error");
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
