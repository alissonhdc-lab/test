/* ==========================================================================
   wlchart.js
   Painel interativo específico para resultados de Winston-Lutz. Ao contrário
   dos outros testes (uma métrica por rotina), o Winston-Lutz produz VÁRIAS
   imagens em ângulos diferentes de gantry/colimador/mesa numa mesma
   execução — o que o relatório PDF do pylinac mostra como miniaturas de
   cada imagem mais tabelas de erro. Como este app não guarda as imagens
   (só os números), reconstruímos a mesma leitura clínica com gráficos
   interativos em SVG puro:
     1. Um gráfico de dispersão ("alvo") com o erro CAX→BB de cada imagem
        no plano XY, para ver se os erros formam um padrão (cluster
        deslocado, "leque" por eixo, etc.) — o equivalente visual do que
        fisicos costumam chamar de "bullseye plot".
     2. Um mini-gráfico polar por eixo (Gantry/Colimador/Mesa) com o erro
        em função do próprio ângulo daquele eixo — evidencia efeitos como
        "gantry sag" (piora do erro em certos ângulos de gantry).
     3. Uma tabela com os dados de cada imagem.
   ========================================================================== */

(function (global) {
  "use strict";

  const AXIS_COLORS = {
    Reference: "#6b7280",
    Gantry: "#2563eb",
    Collimator: "#dc2626",
    Couch: "#16a34a",
    "GB Combo": "#7c3aed",
  };
  const AXIS_LABELS_PT = {
    Reference: "Referência",
    Gantry: "Gantry",
    Collimator: "Colimador",
    Couch: "Mesa",
    "GB Combo": "Gantry+Colimador",
  };
  const POLAR_AXES = ["Gantry", "Collimator", "Couch", "GB Combo"];
  const POLAR_ANGLE_FIELD = { Gantry: "gantry", Collimator: "collimator", Couch: "couch", "GB Combo": "gantry" };

  function fmt(v, decimals) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
    const rounded = Number(Number(v).toFixed(decimals));
    return (rounded === 0 ? 0 : rounded).toFixed(decimals);
  }

  function axisColor(axis) {
    return AXIS_COLORS[axis] || "#94a3b8";
  }

  function axisLabel(axis) {
    return AXIS_LABELS_PT[axis] || axis || "—";
  }

  // Passo "bonito" para os anéis de referência (0.25 / 0.5 / 1 / 2 / 5 mm...)
  function niceStep(maxValue, targetRings) {
    const rough = maxValue / targetRings;
    const steps = [0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20];
    return steps.find((s) => s >= rough) || Math.ceil(rough);
  }

  const svgns = "http://www.w3.org/2000/svg";
  function el(tag, attrs) {
    const node = document.createElementNS(svgns, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  // ------------------------------------------------------------------
  // Gráfico 1: dispersão "alvo" do erro CAX→BB (X/Y em mm)
  // ------------------------------------------------------------------
  function renderBullseye(container, points, toleranceMm) {
    const width = 340;
    const height = 340;
    const padding = 30;
    const radiusLimit = width / 2 - padding;

    const withXY = points.filter((p) => typeof p.cax2bbVectorXMm === "number" && typeof p.cax2bbVectorYMm === "number");
    let maxAbs = withXY.reduce((m, p) => Math.max(m, Math.abs(p.cax2bbVectorXMm), Math.abs(p.cax2bbVectorYMm)), 0);
    if (toleranceMm) maxAbs = Math.max(maxAbs, toleranceMm);
    maxAbs = Math.max(maxAbs * 1.25, 0.5);

    const scale = radiusLimit / maxAbs;
    const cx = width / 2;
    const cy = height / 2;

    const svg = el("svg", { width: "100%", height, viewBox: `0 0 ${width} ${height}`, class: "wl-svg" });

    const step = niceStep(maxAbs, 3);
    for (let r = step; r <= maxAbs + 0.001; r += step) {
      svg.appendChild(el("circle", { cx, cy, r: r * scale, class: "wl-ring" }));
      const label = el("text", { x: cx + 4, y: cy - r * scale - 3, class: "chart-axis-label" });
      label.textContent = `${fmt(r, r < 1 ? 2 : 1)}mm`;
      svg.appendChild(label);
    }
    svg.appendChild(el("line", { x1: padding, y1: cy, x2: width - padding, y2: cy, class: "wl-crosshair" }));
    svg.appendChild(el("line", { x1: cx, y1: padding, x2: cx, y2: height - padding, class: "wl-crosshair" }));

    if (toleranceMm) {
      svg.appendChild(el("circle", { cx, cy, r: toleranceMm * scale, class: "wl-tolerance-circle" }));
    }

    withXY.forEach((p) => {
      const px = cx + p.cax2bbVectorXMm * scale;
      const py = cy - p.cax2bbVectorYMm * scale;
      const dot = el("circle", { cx: px, cy: py, r: 5, class: "wl-point", fill: axisColor(p.axis) });
      const title = el("title", {});
      title.textContent =
        `${axisLabel(p.axis)}${axisAngleSuffix(p)} — Erro CAX→BB: ${fmt(p.cax2bbDistanceMm, 2)} mm ` +
        `(X: ${fmt(p.cax2bbVectorXMm, 2)}, Y: ${fmt(p.cax2bbVectorYMm, 2)})`;
      dot.appendChild(title);
      svg.appendChild(dot);
    });

    container.appendChild(svg);
  }

  function axisAngleSuffix(p) {
    const parts = [];
    if (typeof p.gantry === "number") parts.push(`G${fmt(p.gantry, 0)}`);
    if (typeof p.collimator === "number") parts.push(`Col${fmt(p.collimator, 0)}`);
    if (typeof p.couch === "number") parts.push(`Mesa${fmt(p.couch, 0)}`);
    return parts.length ? ` (${parts.join(" ")}°)` : "";
  }

  // ------------------------------------------------------------------
  // Gráfico 2: mini-gráfico polar por eixo (ângulo x erro CAX→BB)
  // ------------------------------------------------------------------
  function renderPolarAxisChart(container, axis, points) {
    const angleField = POLAR_ANGLE_FIELD[axis];
    const pts = points
      .filter((p) => p.axis === axis && typeof p[angleField] === "number" && typeof p.cax2bbDistanceMm === "number")
      .sort((a, b) => a[angleField] - b[angleField]);
    if (pts.length === 0) return;

    const size = 220;
    const cx = size / 2;
    const cy = size / 2;
    const radiusLimit = size / 2 - 26;
    const maxErr = Math.max(...pts.map((p) => p.cax2bbDistanceMm), 0.3) * 1.2;
    const scale = radiusLimit / maxErr;

    const wrap = document.createElement("div");
    wrap.className = "wl-polar-wrap";
    const title = document.createElement("div");
    title.className = "wl-polar-title";
    title.textContent = `${axisLabel(axis)} — erro vs. ângulo`;
    wrap.appendChild(title);

    const svg = el("svg", { width: "100%", height: size, viewBox: `0 0 ${size} ${size}`, class: "wl-svg" });

    const ringStep = niceStep(maxErr, 2);
    for (let r = ringStep; r <= maxErr + 0.001; r += ringStep) {
      svg.appendChild(el("circle", { cx, cy, r: r * scale, class: "wl-ring" }));
    }
    // marcas de referência nos 4 quadrantes (0/90/180/270°)
    [0, 90, 180, 270].forEach((deg) => {
      const { x, y } = polarToXY(cx, cy, deg, radiusLimit + 10);
      const label = el("text", { x, y, class: "chart-axis-label", "text-anchor": "middle" });
      label.textContent = `${deg}°`;
      svg.appendChild(label);
      const edge = polarToXY(cx, cy, deg, radiusLimit);
      svg.appendChild(el("line", { x1: cx, y1: cy, x2: edge.x, y2: edge.y, class: "wl-crosshair" }));
    });

    if (pts.length > 1) {
      const d = pts
        .map((p, i) => {
          const { x, y } = polarToXY(cx, cy, p[angleField], p.cax2bbDistanceMm * scale);
          return `${i === 0 ? "M" : "L"} ${x} ${y}`;
        })
        .join(" ");
      svg.appendChild(el("path", { d, class: "wl-polar-line", stroke: axisColor(axis) }));
    }

    pts.forEach((p) => {
      const { x, y } = polarToXY(cx, cy, p[angleField], p.cax2bbDistanceMm * scale);
      const dot = el("circle", { cx: x, cy: y, r: 4, class: "wl-point", fill: axisColor(axis) });
      const t = el("title", {});
      t.textContent = `${axisLabel(axis)} ${fmt(p[angleField], 0)}° — Erro CAX→BB: ${fmt(p.cax2bbDistanceMm, 2)} mm`;
      dot.appendChild(t);
      svg.appendChild(dot);
    });

    wrap.appendChild(svg);
    container.appendChild(wrap);
  }

  // 0° no topo, sentido horário (convenção de rotação de gantry mais comum)
  function polarToXY(cx, cy, angleDeg, radius) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) };
  }

  // ------------------------------------------------------------------
  // Tabela de dados por imagem
  // ------------------------------------------------------------------
  function renderTable(container, points) {
    const rows = points
      .map((p) => {
        const angleField = POLAR_ANGLE_FIELD[p.axis];
        const angleTxt = angleField && typeof p[angleField] === "number" ? `${fmt(p[angleField], 0)}°` : axisAngleSuffix(p).replace(/[()°]/g, "").trim() || "—";
        return `<tr>
          <td><span class="wl-axis-dot" style="background:${axisColor(p.axis)}"></span>${axisLabel(p.axis)}</td>
          <td>${angleTxt}</td>
          <td>${fmt(p.cax2bbDistanceMm, 2)} mm</td>
          <td>${fmt(p.cax2epidDistanceMm, 2)} mm</td>
        </tr>`;
      })
      .join("");
    const table = document.createElement("table");
    table.className = "mini-table wl-table";
    table.innerHTML = `
      <thead><tr><th>Eixo</th><th>Ângulo</th><th>Erro CAX→BB</th><th>Erro CAX→EPID</th></tr></thead>
      <tbody>${rows}</tbody>`;
    container.appendChild(table);
  }

  // ------------------------------------------------------------------
  // Painel completo
  // ------------------------------------------------------------------
  function renderWinstonLutzPanel(container, imageDetails, opts) {
    opts = opts || {};
    container.innerHTML = "";
    const points = Array.isArray(imageDetails) ? imageDetails : [];
    if (points.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chart-empty";
      empty.textContent = "Sem dados por imagem para este resultado.";
      container.appendChild(empty);
      return;
    }

    const axesPresent = [...new Set(points.map((p) => p.axis))];
    const countsHtml = axesPresent
      .map((a) => `<span class="wl-stat-chip"><i style="background:${axisColor(a)}"></i>${axisLabel(a)}: ${points.filter((p) => p.axis === a).length}</span>`)
      .join("");

    const header = document.createElement("div");
    header.className = "wl-stats-row";
    header.innerHTML = `<span class="muted small">${points.length} imagem(ns) analisada(s):</span> ${countsHtml}`;
    container.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "wl-panel-grid";

    const bullseyeBox = document.createElement("div");
    bullseyeBox.className = "wl-chart-box";
    bullseyeBox.innerHTML = `<div class="wl-polar-title">Dispersão do erro CAX→BB (vista do EPID)</div>`;
    renderBullseye(bullseyeBox, points, opts.toleranceMm);
    grid.appendChild(bullseyeBox);

    POLAR_AXES.forEach((axis) => {
      if (!axesPresent.includes(axis)) return;
      const box = document.createElement("div");
      box.className = "wl-chart-box";
      renderPolarAxisChart(box, axis, points);
      if (box.children.length > 0) grid.appendChild(box);
    });

    container.appendChild(grid);

    const legend = document.createElement("div");
    legend.className = "chart-legend";
    legend.innerHTML = axesPresent
      .map((a) => `<span class="chart-legend-item"><i style="background:${axisColor(a)}"></i>${axisLabel(a)}</span>`)
      .join("");
    container.appendChild(legend);
    if (opts.toleranceMm) {
      const tolNote = document.createElement("div");
      tolNote.className = "muted small mt";
      tolNote.textContent = `Círculo tracejado = tolerância configurada (${fmt(opts.toleranceMm, 2)} mm).`;
      container.appendChild(tolNote);
    }

    renderTable(container, points);
  }

  global.RTQC = global.RTQC || {};
  global.RTQC.wlChart = { renderWinstonLutzPanel };
})(window);
