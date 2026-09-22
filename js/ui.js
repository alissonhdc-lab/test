/* ==========================================================================
   ui.js — funções de renderização (views) da aplicação.
   Cada função retorna uma string HTML. A lógica de eventos fica em app.js.
   ========================================================================== */

(function (global) {
  "use strict";

  const { EQUIPMENT_TYPES, FREQUENCIES, PYLINAC_CATALOG, MANUAL_TEST_TYPE, getModulesForType, getModuleById, groupModules } =
    global.RTQC.catalog;

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("pt-BR");
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("pt-BR");
  }

  function statusBadge(status) {
    const map = {
      overdue: { label: "Atrasado", cls: "badge-danger" },
      soon: { label: "Próximo do prazo", cls: "badge-warning" },
      ok: { label: "Em dia", cls: "badge-success" },
      unknown: { label: "Sem data", cls: "badge-muted" },
    };
    const s = map[status] || map.unknown;
    return `<span class="badge ${s.cls}">${s.label}</span>`;
  }

  function approvalBadge(result) {
    if (result.approval) {
      return `<span class="badge badge-success" title="Aprovado por ${esc(result.approval.fullName)} em ${fmtDateTime(result.approval.approvedAt)}">✔ Aprovado</span>`;
    }
    return `<span class="badge badge-muted">Pendente de aprovação</span>`;
  }

  function passBadge(passed) {
    if (passed === true) return `<span class="badge badge-success">Conforme</span>`;
    if (passed === false) return `<span class="badge badge-danger">Não conforme</span>`;
    return `<span class="badge badge-muted">—</span>`;
  }

  // ------------------------------------------------------------------
  // Login / setup inicial
  // ------------------------------------------------------------------
  function renderSetupAdmin() {
    return `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>Controle de Qualidade — Radioterapia</h1>
        <p class="muted">Nenhum usuário cadastrado ainda. Crie o primeiro usuário (administrador) para começar a usar o sistema.</p>
        <form id="setup-admin-form" class="stacked-form">
          <label>Nome completo
            <input type="text" name="fullName" required autocomplete="name" />
          </label>
          <label>Usuário (login)
            <input type="text" name="username" required autocomplete="username" />
          </label>
          <label>Senha
            <input type="password" name="password" required minlength="4" autocomplete="new-password" />
          </label>
          <label>Confirmar senha
            <input type="password" name="password2" required minlength="4" autocomplete="new-password" />
          </label>
          <button type="submit" class="btn btn-primary btn-block">Criar usuário administrador</button>
        </form>
        <p class="muted small">Os dados ficam salvos apenas neste navegador/computador (armazenamento local). Use o backup em JSON para preservar seus dados.</p>
      </div>
    </div>`;
  }

  function renderLogin(error) {
    return `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>Controle de Qualidade — Radioterapia</h1>
        <p class="muted">Entre com seu usuário e senha para acessar o sistema.</p>
        ${error ? `<p class="form-error">${esc(error)}</p>` : ""}
        <form id="login-form" class="stacked-form">
          <label>Usuário
            <input type="text" name="username" required autocomplete="username" />
          </label>
          <label>Senha
            <input type="password" name="password" required autocomplete="current-password" />
          </label>
          <button type="submit" class="btn btn-primary btn-block">Entrar</button>
        </form>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------------
  // Shell (layout com barra lateral)
  // ------------------------------------------------------------------
  function renderShell(activeRoute, session, contentHtml) {
    const nav = [
      { route: "dashboard", label: "Painel", icon: "📊" },
      { route: "equipamentos", label: "Equipamentos", icon: "🏥" },
      { route: "usuarios", label: "Usuários", icon: "👤" },
      { route: "backup", label: "Backup", icon: "💾" },
      { route: "ajuda", label: "Ajuda", icon: "❓" },
    ];
    const navHtml = nav
      .map(
        (n) => `<a href="#/${n.route}" class="nav-link ${activeRoute === n.route ? "active" : ""}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`
      )
      .join("");

    return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">☢</span>
          <div>
            <div class="brand-title">CQ Radioterapia</div>
            <div class="brand-sub">pylinac toolkit</div>
          </div>
        </div>
        <nav class="sidebar-nav">${navHtml}</nav>
        <div class="sidebar-footer">
          <div class="session-user">
            <div class="avatar">${esc((session.fullName || "?").charAt(0).toUpperCase())}</div>
            <div>
              <div class="session-name">${esc(session.fullName)}</div>
              <div class="session-role">${esc(session.role === "admin" ? "Administrador" : "Técnico")}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-block" data-action="logout">Sair</button>
        </div>
      </aside>
      <main class="content">${contentHtml}</main>
    </div>`;
  }

  // ------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------
  function renderDashboard(db) {
    const { util } = global.RTQC;
    const rows = db.routines
      .filter((r) => r.active !== false)
      .map((r) => {
        const eq = db.equipments.find((e) => e.id === r.equipmentId);
        const due = util.routineDueStatus(r, db.results);
        return { routine: r, equipment: eq, due };
      })
      .filter((x) => x.equipment)
      .sort((a, b) => {
        const order = { overdue: 0, soon: 1, unknown: 2, ok: 3 };
        return order[a.due.status] - order[b.due.status] || (a.due.nextDue || 0) - (b.due.nextDue || 0);
      });

    const pendingApprovals = db.results.filter((r) => !r.approval).length;
    const overdueCount = rows.filter((r) => r.due.status === "overdue").length;
    const soonCount = rows.filter((r) => r.due.status === "soon").length;

    const statCards = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-value">${db.equipments.length}</div><div class="stat-label">Equipamentos</div></div>
        <div class="stat-card"><div class="stat-value">${db.routines.filter((r) => r.active !== false).length}</div><div class="stat-label">Rotinas de CQ ativas</div></div>
        <div class="stat-card stat-danger"><div class="stat-value">${overdueCount}</div><div class="stat-label">Rotinas atrasadas</div></div>
        <div class="stat-card stat-warning"><div class="stat-value">${soonCount}</div><div class="stat-label">Vencendo em breve</div></div>
        <div class="stat-card stat-muted"><div class="stat-value">${pendingApprovals}</div><div class="stat-label">Resultados sem aprovação</div></div>
      </div>`;

    const tableRows = rows
      .slice(0, 50)
      .map(
        (x) => `
        <tr>
          <td><a href="#/equipamentos/${x.equipment.id}">${esc(x.equipment.name)}</a><div class="muted small">${esc(EQUIPMENT_TYPES[x.equipment.type]?.label || x.equipment.type)}</div></td>
          <td><a href="#/equipamentos/${x.equipment.id}/rotinas/${x.routine.id}">${esc(x.routine.name)}</a></td>
          <td>${esc(FREQUENCIES[x.routine.frequency]?.label || x.routine.frequency)}</td>
          <td>${x.due.last ? fmtDate(x.due.last.date) : "Nunca realizado"}</td>
          <td>${x.due.nextDue ? fmtDate(x.due.nextDue) : "—"}</td>
          <td>${statusBadge(x.due.status)}</td>
        </tr>`
      )
      .join("");

    return `
      <div class="page-header">
        <h2>Painel de Controle</h2>
      </div>
      ${statCards}
      <div class="panel">
        <div class="panel-header"><h3>Rotinas de CQ — próximos vencimentos</h3></div>
        ${
          rows.length === 0
            ? `<div class="empty-state">Nenhuma rotina cadastrada ainda. Vá em <a href="#/equipamentos">Equipamentos</a> para adicionar seu primeiro equipamento e rotina de CQ.</div>`
            : `<table class="data-table">
                <thead><tr><th>Equipamento</th><th>Rotina</th><th>Frequência</th><th>Última execução</th><th>Próxima prevista</th><th>Status</th></tr></thead>
                <tbody>${tableRows}</tbody>
              </table>`
        }
      </div>`;
  }

  // ------------------------------------------------------------------
  // Equipamentos — listagem
  // ------------------------------------------------------------------
  function renderEquipmentsList(db) {
    const cards = db.equipments
      .map((eq) => {
        const routineCount = db.routines.filter((r) => r.equipmentId === eq.id && r.active !== false).length;
        return `
        <div class="equip-card" data-action="open-equipment" data-id="${eq.id}">
          <div class="equip-card-top">
            <span class="equip-type-tag">${esc(EQUIPMENT_TYPES[eq.type]?.label || eq.type)}</span>
            ${eq.active === false ? '<span class="badge badge-muted">Inativo</span>' : ""}
          </div>
          <h3>${esc(eq.name)}</h3>
          <p class="muted">${esc(eq.model || "")} ${eq.manufacturer ? "· " + esc(eq.manufacturer) : ""}</p>
          <p class="muted small">${esc(eq.location || "")}</p>
          <div class="equip-card-footer">${routineCount} rotina(s) de CQ</div>
        </div>`;
      })
      .join("");

    return `
      <div class="page-header">
        <h2>Equipamentos</h2>
        <button class="btn btn-primary" data-action="new-equipment">+ Novo equipamento</button>
      </div>
      ${
        db.equipments.length === 0
          ? `<div class="empty-state">Nenhum equipamento cadastrado. Clique em "Novo equipamento" para começar (Acelerador Linear, Tomógrafo, Braquiterapia, Ortovoltagem ou outro).</div>`
          : `<div class="equip-grid">${cards}</div>`
      }`;
  }

  function equipmentForm(equipment) {
    const eq = equipment || {};
    const typeOptions = Object.entries(EQUIPMENT_TYPES)
      .map(([key, t]) => `<option value="${key}" ${eq.type === key ? "selected" : ""}>${esc(t.label)}</option>`)
      .join("");
    return `
      <form id="equipment-form" class="stacked-form" data-id="${eq.id || ""}">
        <label>Tipo de equipamento
          <select name="type" required>${typeOptions}</select>
        </label>
        <label>Nome / identificação
          <input type="text" name="name" required value="${esc(eq.name || "")}" placeholder="Ex.: LINAC 1 - Sala A" />
        </label>
        <div class="form-grid-2">
          <label>Fabricante
            <input type="text" name="manufacturer" value="${esc(eq.manufacturer || "")}" />
          </label>
          <label>Modelo
            <input type="text" name="model" value="${esc(eq.model || "")}" />
          </label>
        </div>
        <label>Número de série
          <input type="text" name="serialNumber" value="${esc(eq.serialNumber || "")}" />
        </label>
        <label>Localização
          <input type="text" name="location" value="${esc(eq.location || "")}" placeholder="Ex.: Bunker 2" />
        </label>
        <label>Observações
          <textarea name="notes" rows="2">${esc(eq.notes || "")}</textarea>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" name="active" ${eq.active !== false ? "checked" : ""} /> Equipamento ativo
        </label>
        <div class="form-actions">
          <button type="button" class="btn" data-action="close-modal">Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </form>`;
  }

  // ------------------------------------------------------------------
  // Detalhe do equipamento — rotinas agrupadas por frequência
  // ------------------------------------------------------------------
  function renderEquipmentDetail(db, equipment) {
    const { util } = global.RTQC;
    const routines = db.routines.filter((r) => r.equipmentId === equipment.id);

    const groups = Object.keys(FREQUENCIES).map((freqKey) => {
      const items = routines.filter((r) => r.frequency === freqKey);
      return { freqKey, items };
    });

    const groupsHtml = groups
      .filter((g) => g.items.length > 0)
      .map((g) => {
        const rows = g.items
          .map((r) => {
            const due = util.routineDueStatus(r, db.results);
            const module = r.testType === "pylinac" ? getModuleById(r.moduleId) : MANUAL_TEST_TYPE;
            const resultsCount = db.results.filter((x) => x.routineId === r.id).length;
            return `
            <tr class="clickable-row" data-action="open-routine" data-id="${r.id}">
              <td>
                <div class="routine-name">${esc(r.name)} ${r.active === false ? '<span class="badge badge-muted">Inativa</span>' : ""}</div>
                <div class="muted small">${esc(module ? module.name : "")}</div>
              </td>
              <td>${resultsCount}</td>
              <td>${due.last ? fmtDate(due.last.date) : "Nunca"}</td>
              <td>${due.nextDue ? fmtDate(due.nextDue) : "—"}</td>
              <td>${statusBadge(due.status)}</td>
              <td class="row-actions">
                <button class="icon-btn" data-action="edit-routine" data-id="${r.id}" title="Editar">✎</button>
                <button class="icon-btn" data-action="delete-routine" data-id="${r.id}" title="Excluir">🗑</button>
              </td>
            </tr>`;
          })
          .join("");
        return `
        <div class="panel">
          <div class="panel-header"><h3>${FREQUENCIES[g.freqKey].label}</h3></div>
          <table class="data-table">
            <thead><tr><th>Rotina</th><th>Resultados</th><th>Última</th><th>Próxima</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      })
      .join("");

    return `
      <div class="page-header">
        <div>
          <a href="#/equipamentos" class="back-link">← Equipamentos</a>
          <h2>${esc(equipment.name)} <span class="equip-type-tag">${esc(EQUIPMENT_TYPES[equipment.type]?.label)}</span></h2>
          <p class="muted">${esc(equipment.manufacturer || "")} ${equipment.model ? "· " + esc(equipment.model) : ""} ${equipment.location ? "· " + esc(equipment.location) : ""}</p>
        </div>
        <div class="header-actions">
          <button class="btn" data-action="edit-equipment" data-id="${equipment.id}">Editar equipamento</button>
          <button class="btn btn-danger" data-action="delete-equipment" data-id="${equipment.id}">Excluir</button>
          <button class="btn btn-primary" data-action="new-routine" data-equipment-id="${equipment.id}">+ Nova rotina de CQ</button>
        </div>
      </div>
      ${routines.length === 0 ? `<div class="empty-state">Nenhuma rotina de CQ cadastrada para este equipamento ainda.</div>` : groupsHtml}
    `;
  }

  // ------------------------------------------------------------------
  // Formulário de rotina (novo/editar) — escolha de módulo pylinac ou manual
  // ------------------------------------------------------------------
  function moduleParamsFormHtml(module, savedParams) {
    if (!module || !module.params) return "";
    const params = savedParams || {};
    return module.params
      .map((p) => {
        const val = params[p.key] !== undefined ? params[p.key] : p.default;
        if (p.type === "select") {
          const opts = p.options.map((o) => `<option value="${esc(o)}" ${val === o ? "selected" : ""}>${esc(o)}</option>`).join("");
          return `<label>${esc(p.label)}<select name="param__${p.key}">${opts}</select></label>`;
        }
        if (p.type === "checkbox") {
          return `<label class="checkbox-label"><input type="checkbox" name="param__${p.key}" ${val ? "checked" : ""} /> ${esc(p.label)}</label>`;
        }
        if (p.type === "number") {
          return `<label>${esc(p.label)} ${p.unit ? `<span class="unit-tag">${esc(p.unit)}</span>` : ""}
            <input type="number" step="${p.step || "any"}" name="param__${p.key}" value="${esc(val)}" /></label>`;
        }
        return `<label>${esc(p.label)}<input type="text" name="param__${p.key}" value="${esc(val)}" /></label>`;
      })
      .join("");
  }

  function moduleMetricsPreviewHtml(module, savedMetrics) {
    if (!module || !module.metrics) return "";
    const savedByKey = {};
    (savedMetrics || []).forEach((m) => (savedByKey[m.key] = m));
    return `
    <table class="mini-table">
      <thead><tr><th>Métrica</th><th>Unidade</th><th>Tolerância</th></tr></thead>
      <tbody>
        ${module.metrics
          .map((m) => {
            const saved = savedByKey[m.key] || {};
            const tolType = saved.tolType || m.tolType;
            return `
            <tr data-metric-row="${m.key}">
              <td>${esc(m.label)}
                <input type="hidden" name="metric__${m.key}__label" value="${esc(m.label)}" />
                <input type="hidden" name="metric__${m.key}__unit" value="${esc(m.unit || "")}" />
                <input type="hidden" name="metric__${m.key}__tolType" value="${esc(tolType)}" />
              </td>
              <td>${esc(m.unit || "—")}</td>
              <td>${toleranceInputsHtml("metric__" + m.key, tolType, saved)}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
  }

  function toleranceInputsHtml(prefix, tolType, saved) {
    saved = saved || {};
    if (tolType === "max") {
      return `≤ <input type="number" step="any" class="tol-input" name="${prefix}__tol" value="${esc(saved.tol !== undefined ? saved.tol : "")}" />`;
    }
    if (tolType === "min") {
      return `≥ <input type="number" step="any" class="tol-input" name="${prefix}__tol" value="${esc(saved.tol !== undefined ? saved.tol : "")}" />`;
    }
    if (tolType === "range") {
      return `entre <input type="number" step="any" class="tol-input" name="${prefix}__tolLow" value="${esc(saved.tolLow !== undefined ? saved.tolLow : "")}" />
        e <input type="number" step="any" class="tol-input" name="${prefix}__tolHigh" value="${esc(saved.tolHigh !== undefined ? saved.tolHigh : "")}" />`;
    }
    if (tolType === "bool") {
      return `<span class="muted small">aprovado/reprovado manual</span>`;
    }
    return `<span class="muted small">informativo (sem tolerância)</span>`;
  }

  function manualMetricsEditorHtml(metrics) {
    const rows = (metrics && metrics.length ? metrics : [{ key: "", label: "", unit: "", tolType: "info" }])
      .map((m, i) => manualMetricRowHtml(m, i))
      .join("");
    return `<div id="manual-metrics-rows">${rows}</div>
      <button type="button" class="btn btn-ghost" data-action="add-manual-metric">+ Adicionar métrica</button>`;
  }

  function manualMetricRowHtml(m, index) {
    m = m || {};
    const tolType = m.tolType || "info";
    const options = [
      ["info", "Somente informativo"],
      ["max", "Valor máximo aceitável"],
      ["min", "Valor mínimo aceitável"],
      ["range", "Faixa aceitável (min–max)"],
      ["bool", "Aprovado/Reprovado manual"],
    ]
      .map(([v, l]) => `<option value="${v}" ${tolType === v ? "selected" : ""}>${l}</option>`)
      .join("");
    return `
    <div class="manual-metric-row" data-manual-row="${index}">
      <input type="text" placeholder="Nome da métrica (ex.: Dose por UM)" name="mm_label_${index}" value="${esc(m.label || "")}" />
      <input type="text" placeholder="Unidade (ex.: cGy/UM)" name="mm_unit_${index}" value="${esc(m.unit || "")}" class="unit-input" />
      <select name="mm_toltype_${index}" data-action="manual-metric-toltype">${options}</select>
      <span class="manual-metric-tol" data-manual-tol="${index}">${toleranceInputsHtml("mm_" + index, tolType, m)}</span>
      <button type="button" class="icon-btn" data-action="remove-manual-metric" data-index="${index}" title="Remover">🗑</button>
    </div>`;
  }

  function routineFormHtml(equipment, routine) {
    const r = routine || {};
    const testType = r.testType || "pylinac";
    const modules = getModulesForType(equipment.type);
    const grouped = groupModules(modules);
    const moduleOptions = Object.entries(grouped)
      .map(
        ([group, mods]) =>
          `<optgroup label="${esc(group)}">${mods
            .map((m) => `<option value="${m.id}" ${r.moduleId === m.id ? "selected" : ""}>${esc(m.name)}</option>`)
            .join("")}</optgroup>`
      )
      .join("");

    const freqOptions = Object.entries(FREQUENCIES)
      .map(([k, f]) => `<option value="${k}" ${r.frequency === k ? "selected" : ""}>${esc(f.label)}</option>`)
      .join("");

    const selectedModule = r.moduleId ? getModuleById(r.moduleId) : null;

    return `
    <form id="routine-form" class="stacked-form" data-equipment-id="${equipment.id}" data-id="${r.id || ""}">
      <label>Nome da rotina
        <input type="text" name="name" required value="${esc(r.name || "")}" placeholder="Ex.: Picket Fence mensal" />
      </label>
      <label>Frequência
        <select name="frequency" required>${freqOptions}</select>
      </label>

      <fieldset class="test-type-fieldset">
        <legend>Tipo de teste</legend>
        <label class="radio-label">
          <input type="radio" name="testType" value="pylinac" ${testType === "pylinac" ? "checked" : ""} data-action="toggle-test-type" /> Vinculado a módulo pylinac
        </label>
        <label class="radio-label">
          <input type="radio" name="testType" value="manual" ${testType === "manual" ? "checked" : ""} data-action="toggle-test-type" /> Manual / genérico
        </label>
      </fieldset>

      <div id="pylinac-section" class="${testType === "pylinac" ? "" : "hidden"}">
        <label>Módulo pylinac
          <select name="moduleId" id="module-select">
            <option value="">Selecione um módulo...</option>
            ${moduleOptions}
          </select>
        </label>
        <div id="module-description" class="muted small">${selectedModule ? esc(selectedModule.description) + " (" + esc(selectedModule.pylinacRef) + ")" : ""}</div>
        <div id="module-params-container" class="params-grid">${selectedModule ? moduleParamsFormHtml(selectedModule, r.params) : ""}</div>
        <h4 class="mt">Métricas e tolerâncias de aprovação</h4>
        <div id="module-metrics-container">${selectedModule ? moduleMetricsPreviewHtml(selectedModule, r.metrics) : ""}</div>
      </div>

      <div id="manual-section" class="${testType === "manual" ? "" : "hidden"}">
        <h4>Métricas do teste manual</h4>
        <p class="muted small">Defina as métricas que serão preenchidas manualmente a cada execução (ex.: Output %, Atividade da fonte, etc.).</p>
        ${manualMetricsEditorHtml(r.metrics)}
      </div>

      <label>Observações / protocolo de referência
        <textarea name="notes" rows="2">${esc(r.notes || "")}</textarea>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="active" ${r.active !== false ? "checked" : ""} /> Rotina ativa
      </label>

      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar rotina</button>
      </div>
    </form>`;
  }

  // ------------------------------------------------------------------
  // Detalhe da rotina — resultados, tendências, aprovação
  // ------------------------------------------------------------------
  function renderRoutineDetail(db, equipment, routine, selectedMetricKeys) {
    const module = routine.testType === "pylinac" ? getModuleById(routine.moduleId) : MANUAL_TEST_TYPE;
    const results = db.results.filter((r) => r.routineId === routine.id).sort((a, b) => new Date(b.date) - new Date(a.date));
    const metrics = routine.metrics || [];

    const metricChecks = metrics
      .map(
        (m) => `
      <label class="checkbox-label inline">
        <input type="checkbox" class="trend-metric-check" value="${esc(m.key)}" ${selectedMetricKeys.includes(m.key) ? "checked" : ""} />
        ${esc(m.label)} ${m.unit ? `(${esc(m.unit)})` : ""}
      </label>`
      )
      .join("");

    const resultRows = results
      .map((res) => {
        const passed = computeResultPass(routine, res);
        const valuesSummary = metrics
          .slice(0, 3)
          .map((m) => `${esc(m.label)}: <b>${res.values[m.key] !== undefined ? esc(res.values[m.key]) : "—"}</b>${m.unit ? " " + esc(m.unit) : ""}`)
          .join(" · ");
        return `
        <tr>
          <td>${fmtDate(res.date)}<div class="muted small">${esc(res.performedByName || "")}</div></td>
          <td>${valuesSummary}${metrics.length > 3 ? " …" : ""}</td>
          <td>${passBadge(passed)}</td>
          <td>${approvalBadge(res)}</td>
          <td class="row-actions">
            <button class="icon-btn" data-action="view-result" data-id="${res.id}" title="Ver detalhes">👁</button>
            ${!res.approval ? `<button class="icon-btn" data-action="approve-result" data-id="${res.id}" title="Aprovar">✔</button>` : ""}
            <button class="icon-btn" data-action="delete-result" data-id="${res.id}" title="Excluir">🗑</button>
          </td>
        </tr>`;
      })
      .join("");

    return `
      <div class="page-header">
        <div>
          <a href="#/equipamentos/${equipment.id}" class="back-link">← ${esc(equipment.name)}</a>
          <h2>${esc(routine.name)}</h2>
          <p class="muted">${esc(module ? module.name : "")} · ${esc(FREQUENCIES[routine.frequency]?.label)} ${routine.testType === "pylinac" && module.pylinacRef ? "· <code>" + esc(module.pylinacRef) + "</code>" : ""}</p>
        </div>
        <div class="header-actions">
          <button class="btn" data-action="edit-routine" data-id="${routine.id}">Editar rotina</button>
          <button class="btn btn-primary" data-action="new-result" data-routine-id="${routine.id}">+ Registrar resultado</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Tendência de resultados</h3></div>
        <div class="trend-controls">${metricChecks || '<span class="muted">Nenhuma métrica configurada.</span>'}</div>
        <div id="trend-chart-container" class="chart-container"></div>
      </div>

      <div class="panel">
        <div class="panel-header"><h3>Histórico de resultados</h3></div>
        ${
          results.length === 0
            ? `<div class="empty-state">Nenhum resultado registrado ainda.</div>`
            : `<table class="data-table">
              <thead><tr><th>Data</th><th>Resumo</th><th>Resultado</th><th>Aprovação</th><th></th></tr></thead>
              <tbody>${resultRows}</tbody>
            </table>`
        }
      </div>
    `;
  }

  function computeResultPass(routine, result) {
    const metrics = routine.metrics || [];
    if (metrics.length === 0) return result.passOverride === undefined ? null : result.passOverride;
    let anyFail = false;
    let anyChecked = false;
    for (const m of metrics) {
      const v = result.values[m.key];
      if (v === undefined || v === null || v === "") continue;
      if (m.tolType === "info") continue;
      anyChecked = true;
      const num = Number(v);
      if (m.tolType === "bool") {
        if (v === "false" || v === false) anyFail = true;
      } else if (m.tolType === "max") {
        if (!(num <= Number(m.tol))) anyFail = true;
      } else if (m.tolType === "min") {
        if (!(num >= Number(m.tol))) anyFail = true;
      } else if (m.tolType === "range") {
        if (!(num >= Number(m.tolLow) && num <= Number(m.tolHigh))) anyFail = true;
      }
    }
    if (!anyChecked) return result.passOverride === undefined ? null : result.passOverride;
    return !anyFail;
  }

  function pylinacUploadSectionHtml(module) {
    const mode = module.fileMode;
    let inputsHtml = "";
    if (mode === "single") {
      inputsHtml = `<label>Arquivo
        <input type="file" class="pylinac-file-input" data-slot="0" accept="${esc(module.fileAccept || "")}" />
      </label>`;
    } else if (mode === "multiple") {
      inputsHtml = `<label>Arquivos (selecione todos de uma vez)
        <input type="file" class="pylinac-file-input" data-slot="multi" accept="${esc(module.fileAccept || "")}" multiple />
      </label>`;
    } else if (mode === "pair") {
      const labels = module.fileLabels || ["Arquivo 1", "Arquivo 2"];
      inputsHtml = labels
        .map(
          (label, i) => `<label>${esc(label)}
            <input type="file" class="pylinac-file-input" data-slot="${i}" accept="${esc(module.fileAccept || "")}" />
          </label>`
        )
        .join("");
    } else if (mode === "series") {
      inputsHtml = `<label>Cortes DICOM da série (selecione todos) ou um único arquivo .zip
        <input type="file" class="pylinac-file-input" data-slot="multi" accept="${esc(module.fileAccept || "")}" multiple />
      </label>`;
    }

    return `
    <div class="pylinac-upload-section" data-file-mode="${esc(mode)}" data-module-id="${esc(module.id)}">
      <h4>Análise automática via pylinac</h4>
      ${module.fileHint ? `<p class="muted small">${esc(module.fileHint)}</p>` : ""}
      <div class="params-grid">${inputsHtml}</div>
      <button type="button" class="btn btn-primary" data-action="run-pylinac-analysis">▶ Analisar com pylinac</button>
      <div id="pylinac-analysis-status" class="pylinac-status muted small"></div>
      <details id="pylinac-raw-details" class="hidden mt">
        <summary>Ver todos os dados retornados pelo pylinac</summary>
        <pre id="pylinac-raw-json" class="raw-json"></pre>
      </details>
      <input type="hidden" name="raw_metrics_json" id="raw-metrics-json-field" value="" />
      <input type="hidden" name="source_files_json" id="source-files-json-field" value="" />
    </div>`;
  }

  function resultFormHtml(routine, module) {
    const metrics = routine.metrics || [];
    const fields = metrics
      .map((m) => {
        if (m.tolType === "bool") {
          return `<label>${esc(m.label)}
            <select name="value__${m.key}" class="result-metric-input" data-metric-key="${esc(m.key)}">
              <option value="">—</option>
              <option value="true">Aprovado</option>
              <option value="false">Reprovado</option>
            </select>
          </label>`;
        }
        return `<label>${esc(m.label)} ${m.unit ? `<span class="unit-tag">${esc(m.unit)}</span>` : ""}
          <input type="number" step="any" name="value__${m.key}" class="result-metric-input" data-metric-key="${esc(m.key)}" placeholder="${toleranceHint(m)}" />
        </label>`;
      })
      .join("");

    const showUpload = module && module.requiresFiles;

    return `
    <form id="result-form" class="stacked-form" data-routine-id="${routine.id}">
      <label>Data da execução
        <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}" />
      </label>
      <label>Executado por
        <input type="text" name="performedByName" required placeholder="Nome de quem realizou o teste" />
      </label>
      ${showUpload ? pylinacUploadSectionHtml(module) : ""}
      ${
        module && !module.requiresFiles && module.autoAnalysisNote
          ? `<p class="muted small">ℹ️ ${esc(module.autoAnalysisNote)}</p>`
          : ""
      }
      <h4 class="${showUpload ? "mt" : ""}">Valores do resultado${showUpload ? " (confira antes de salvar)" : ""}</h4>
      <div class="params-grid">${fields || '<p class="muted">Esta rotina não possui métricas configuradas.</p>'}</div>
      ${
        metrics.length === 0
          ? `<label>Resultado geral
              <select name="passOverride"><option value="">—</option><option value="true">Conforme</option><option value="false">Não conforme</option></select>
            </label>`
          : ""
      }
      <label>Observações
        <textarea name="notes" rows="2"></textarea>
      </label>
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar resultado</button>
      </div>
    </form>`;
  }

  function toleranceHint(m) {
    if (m.tolType === "max") return `≤ ${m.tol}`;
    if (m.tolType === "min") return `≥ ${m.tol}`;
    if (m.tolType === "range") return `${m.tolLow} a ${m.tolHigh}`;
    return "";
  }

  function resultDetailHtml(routine, result) {
    const metrics = routine.metrics || [];
    const rows = metrics
      .map((m) => {
        const v = result.values[m.key];
        return `<tr><td>${esc(m.label)}</td><td>${v !== undefined && v !== "" ? esc(v) : "—"} ${m.unit ? esc(m.unit) : ""}</td><td>${esc(toleranceHint(m) || "—")}</td></tr>`;
      })
      .join("");
    return `
      <div class="result-detail">
        <p><b>Data:</b> ${fmtDate(result.date)} &nbsp; <b>Executado por:</b> ${esc(result.performedByName || "—")}</p>
        <table class="mini-table">
          <thead><tr><th>Métrica</th><th>Valor</th><th>Tolerância</th></tr></thead>
          <tbody>${rows || "<tr><td colspan=3>Sem métricas.</td></tr>"}</tbody>
        </table>
        ${result.notes ? `<p><b>Observações:</b> ${esc(result.notes)}</p>` : ""}
        ${
          result.analyzedWithPylinac
            ? `<p class="muted small">⚙ Calculado automaticamente pelo pylinac a partir de: ${esc((result.sourceFiles || []).join(", "))}</p>`
            : ""
        }
        <p><b>Situação:</b> ${passBadge(computeResultPass(routine, result))}</p>
        <p><b>Aprovação:</b> ${
          result.approval
            ? `Aprovado por <b>${esc(result.approval.fullName)}</b> (usuário: ${esc(result.approval.username)}) em ${fmtDateTime(result.approval.approvedAt)}`
            : "Pendente de aprovação"
        }</p>
        ${
          result.rawMetrics
            ? `<details><summary>Ver todos os dados retornados pelo pylinac</summary><pre class="raw-json">${esc(JSON.stringify(result.rawMetrics, null, 2))}</pre></details>`
            : ""
        }
        <div class="form-actions">
          <button type="button" class="btn" data-action="close-modal">Fechar</button>
          ${!result.approval ? `<button type="button" class="btn btn-primary" data-action="approve-result" data-id="${result.id}">Aprovar resultado</button>` : ""}
        </div>
      </div>`;
  }

  function approvalFormHtml(resultId) {
    return `
    <form id="approval-form" class="stacked-form" data-result-id="${resultId}">
      <p class="muted">A aprovação será registrada (carimbada) com data/hora e vinculada ao usuário informado abaixo, funcionando como assinatura eletrônica do responsável.</p>
      <label>Usuário
        <input type="text" name="username" required autocomplete="username" />
      </label>
      <label>Senha
        <input type="password" name="password" required autocomplete="current-password" />
      </label>
      <div id="approval-error" class="form-error"></div>
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Confirmar aprovação</button>
      </div>
    </form>`;
  }

  // ------------------------------------------------------------------
  // Usuários
  // ------------------------------------------------------------------
  function renderUsers(db, session) {
    const rows = db.users
      .map(
        (u) => `
      <tr>
        <td>${esc(u.fullName)}</td>
        <td>${esc(u.username)}</td>
        <td>${esc(u.role === "admin" ? "Administrador" : "Técnico")}</td>
        <td>${fmtDate(u.createdAt)}</td>
        <td class="row-actions">
          <button class="icon-btn" data-action="reset-password" data-id="${u.id}" title="Redefinir senha">🔑</button>
          ${u.id !== session.userId ? `<button class="icon-btn" data-action="delete-user" data-id="${u.id}" title="Excluir">🗑</button>` : ""}
        </td>
      </tr>`
      )
      .join("");
    return `
      <div class="page-header">
        <h2>Usuários</h2>
        <button class="btn btn-primary" data-action="new-user">+ Novo usuário</button>
      </div>
      <div class="panel">
        <table class="data-table">
          <thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Criado em</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="muted small">Cada usuário cadastrado aqui pode aprovar resultados de CQ informando seu próprio usuário e senha, criando um registro de responsabilidade (assinatura eletrônica) mesmo que outra pessoa esteja com a sessão aberta.</p>
    `;
  }

  function userFormHtml() {
    return `
    <form id="user-form" class="stacked-form">
      <label>Nome completo
        <input type="text" name="fullName" required />
      </label>
      <label>Usuário (login)
        <input type="text" name="username" required />
      </label>
      <label>Perfil
        <select name="role">
          <option value="tecnico">Técnico</option>
          <option value="admin">Administrador</option>
        </select>
      </label>
      <label>Senha
        <input type="password" name="password" required minlength="4" />
      </label>
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar usuário</button>
      </div>
    </form>`;
  }

  function resetPasswordFormHtml(userId) {
    return `
    <form id="reset-password-form" class="stacked-form" data-user-id="${userId}">
      <label>Nova senha
        <input type="password" name="password" required minlength="4" />
      </label>
      <label>Confirmar nova senha
        <input type="password" name="password2" required minlength="4" />
      </label>
      <div class="form-actions">
        <button type="button" class="btn" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Salvar nova senha</button>
      </div>
    </form>`;
  }

  // ------------------------------------------------------------------
  // Backup
  // ------------------------------------------------------------------
  function renderBackup(db, backendUrl) {
    return `
      <div class="page-header"><h2>Backup e dados</h2></div>
      <div class="panel">
        <div class="panel-header"><h3>Servidor de Análise (pylinac)</h3></div>
        <p class="muted">Para que o botão "Analisar com pylinac" funcione, o backend Python precisa estar rodando (veja <code>backend/README.md</code> no repositório). Informe abaixo o endereço onde ele está disponível.</p>
        <label>URL do backend
          <input type="text" id="backend-url-input" value="${esc(backendUrl)}" placeholder="http://localhost:8420" />
        </label>
        <div class="form-actions" style="justify-content:flex-start; margin-top:10px;">
          <button class="btn" data-action="save-backend-url">Salvar URL</button>
          <button class="btn" data-action="test-backend-connection">Testar conexão</button>
        </div>
        <div id="backend-connection-status" class="muted small mt"></div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Exportar</h3></div>
        <p class="muted">Todos os dados (equipamentos, rotinas, resultados e usuários) ficam salvos apenas no armazenamento local deste navegador. Exporte periodicamente um arquivo de backup em JSON.</p>
        <button class="btn btn-primary" data-action="export-backup">Exportar backup (.json)</button>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Importar</h3></div>
        <p class="muted">Importar um backup <b>substitui todos os dados atuais</b> deste navegador.</p>
        <input type="file" id="import-file-input" accept="application/json" />
        <button class="btn btn-danger" data-action="import-backup">Importar e substituir dados</button>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Estatísticas</h3></div>
        <ul class="plain-list">
          <li>${db.equipments.length} equipamento(s)</li>
          <li>${db.routines.length} rotina(s) de CQ</li>
          <li>${db.results.length} resultado(s) registrado(s)</li>
          <li>${db.users.length} usuário(s)</li>
        </ul>
      </div>
    `;
  }

  function renderHelp() {
    return `
      <div class="page-header"><h2>Ajuda</h2></div>
      <div class="panel">
        <div class="panel-header"><h3>Sobre este sistema</h3></div>
        <p>Esta é uma plataforma de <b>controle de qualidade em radioterapia</b> que roda inteiramente no navegador (HTML/JS), sem servidor. Os dados são salvos no armazenamento local (localStorage) deste computador/navegador.</p>
        <ul class="plain-list">
          <li>Cadastre quantos <b>equipamentos</b> quiser (Acelerador Linear, Tomógrafo, Braquiterapia, Ortovoltagem ou outro).</li>
          <li>Para cada equipamento, crie <b>rotinas de CQ</b> com frequência diária, semanal, mensal, trimestral, semestral ou anual.</li>
          <li>Cada rotina pode ser vinculada a um <b>módulo da biblioteca pylinac</b> (Python) — o acervo cobre os principais testes de Linac, CT/CBCT, calibração absoluta e imagem planar — ou pode ser um <b>teste manual</b> com métricas definidas por você.</li>
          <li>Cada resultado registrado pode ser visualizado em <b>gráficos de tendência</b>, escolhendo quais métricas exibir.</li>
          <li>Cada resultado possui um botão de <b>Aprovar</b>, que exige usuário e senha (assinatura eletrônica) e carimba data/hora e responsável.</li>
        </ul>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Análise automática de arquivos DICOM (pylinac de verdade)</h3></div>
        <p>Para a maioria dos testes de Linac, CT/CBCT e imagem planar, é possível <b>enviar os arquivos DICOM</b> na tela de "Registrar resultado" e clicar em <b>"Analisar com pylinac"</b>: o app envia os arquivos para um pequeno servidor Python (backend), que roda o pylinac de verdade e devolve os resultados já prontos para conferência e gravação.</p>
        <p>Isso exige rodar o backend (pasta <code>backend/</code> do repositório) em algum computador acessível pelo navegador — normalmente o seu próprio computador. Veja <code>backend/README.md</code> para o passo a passo, e configure o endereço em <a href="#/backup">Backup → Servidor de Análise</a>.</p>
        <p class="muted small">Testes que são calculadoras numéricas (TG-51/TRS-398) ou que exigem configuração muito específica do fantoma (Winston-Lutz multi-alvo, DLG, ACR, log de trajetória) permanecem com lançamento manual dos resultados — o app avisa isso na tela do teste.</p>
        <p class="muted small">Os arquivos DICOM enviados são processados apenas em memória/temporariamente pelo backend e descartados após a análise; o app guarda somente os números resultantes (e, quando disponível, o relatório bruto do pylinac) — não guarda as imagens.</p>
      </div>
      <div class="panel">
        <p class="muted small">Como não há servidor central de dados, senha e login funcionam como um registro de responsabilidade local, não como segurança de nível hospitalar/multiusuário. Faça backups regulares (menu Backup).</p>
      </div>
    `;
  }

  global.RTQC = global.RTQC || {};
  global.RTQC.ui = {
    esc,
    fmtDate,
    fmtDateTime,
    statusBadge,
    approvalBadge,
    passBadge,
    renderSetupAdmin,
    renderLogin,
    renderShell,
    renderDashboard,
    renderEquipmentsList,
    equipmentForm,
    renderEquipmentDetail,
    routineFormHtml,
    moduleParamsFormHtml,
    moduleMetricsPreviewHtml,
    manualMetricRowHtml,
    toleranceInputsHtml,
    renderRoutineDetail,
    computeResultPass,
    resultFormHtml,
    resultDetailHtml,
    approvalFormHtml,
    renderUsers,
    userFormHtml,
    resetPasswordFormHtml,
    renderBackup,
    renderHelp,
  };
})(window);
