/* ==========================================================================
   svgchart.js
   Renderizador leve de gráfico de linha (tendência) em SVG puro, sem
   dependências externas — funciona 100% offline. Suporta múltiplas séries
   (métricas) e faixa de tolerância (min/max) quando apenas uma série está
   selecionada.
   ========================================================================== */

(function (global) {
  "use strict";

  const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];

  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR");
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR");
  }

  /**
   * Renderiza um gráfico de tendência em um container.
   * @param {HTMLElement} container
   * @param {Object} opts
   *   series: [{ label, unit, points: [{x: isoDate, y: number}], toleranceLow, toleranceHigh, toleranceMax, toleranceMin }]
   */
  function renderTrendChart(container, opts) {
    const series = (opts.series || []).filter((s) => s.points && s.points.length > 0);
    container.innerHTML = "";

    if (series.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chart-empty";
      empty.textContent = "Sem dados suficientes para exibir tendência.";
      container.appendChild(empty);
      return;
    }

    const width = container.clientWidth > 0 ? container.clientWidth : 600;
    const height = opts.height || 300;
    const padding = { top: 20, right: 24, bottom: 40, left: 56 };

    const allPoints = series.flatMap((s) => s.points);
    const xValues = allPoints.map((p) => new Date(p.x).getTime());
    const xMin = Math.min(...xValues);
    const xMax = Math.max(...xValues);

    let yValues = allPoints.map((p) => p.y);
    series.forEach((s) => {
      if (typeof s.toleranceLow === "number") yValues.push(s.toleranceLow);
      if (typeof s.toleranceHigh === "number") yValues.push(s.toleranceHigh);
      if (typeof s.toleranceMax === "number") yValues.push(s.toleranceMax);
      if (typeof s.toleranceMin === "number") yValues.push(s.toleranceMin);
    });
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const yPad = (yMax - yMin) * 0.12;
    yMin -= yPad;
    yMax += yPad;

    const xScale = (t) => {
      if (xMax === xMin) return padding.left + (width - padding.left - padding.right) / 2;
      return padding.left + ((t - xMin) / (xMax - xMin)) * (width - padding.left - padding.right);
    };
    const yScale = (v) => {
      return height - padding.bottom - ((v - yMin) / (yMax - yMin)) * (height - padding.top - padding.bottom);
    };

    const svgns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgns, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", height);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "trend-svg");

    // Grid horizontal + labels do eixo Y
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const v = yMin + ((yMax - yMin) * i) / gridLines;
      const y = yScale(v);
      const line = document.createElementNS(svgns, "line");
      line.setAttribute("x1", padding.left);
      line.setAttribute("x2", width - padding.right);
      line.setAttribute("y1", y);
      line.setAttribute("y2", y);
      line.setAttribute("class", "chart-grid");
      svg.appendChild(line);

      const label = document.createElementNS(svgns, "text");
      label.setAttribute("x", padding.left - 8);
      label.setAttribute("y", y + 4);
      label.setAttribute("text-anchor", "end");
      label.setAttribute("class", "chart-axis-label");
      label.textContent = Number.isInteger(v) ? v : v.toFixed(2);
      svg.appendChild(label);
    }

    // Eixo X: labels de data (primeiro, meio, último ponto)
    const sortedX = [...new Set(allPoints.map((p) => p.x))].sort((a, b) => new Date(a) - new Date(b));
    const xTicks = sortedX.length <= 6 ? sortedX : [sortedX[0], sortedX[Math.floor(sortedX.length / 2)], sortedX[sortedX.length - 1]];
    xTicks.forEach((iso) => {
      const x = xScale(new Date(iso).getTime());
      const label = document.createElementNS(svgns, "text");
      label.setAttribute("x", x);
      label.setAttribute("y", height - padding.bottom + 18);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "chart-axis-label");
      label.textContent = fmtDate(iso);
      svg.appendChild(label);
    });

    // Faixa de tolerância — apenas quando uma única série está selecionada
    if (series.length === 1) {
      const s = series[0];
      let low = null;
      let high = null;
      if (typeof s.toleranceLow === "number" && typeof s.toleranceHigh === "number") {
        low = s.toleranceLow;
        high = s.toleranceHigh;
      } else if (typeof s.toleranceMax === "number") {
        low = yMin;
        high = s.toleranceMax;
      } else if (typeof s.toleranceMin === "number") {
        low = s.toleranceMin;
        high = yMax;
      }
      if (low !== null && high !== null) {
        const rect = document.createElementNS(svgns, "rect");
        const yTop = yScale(Math.min(high, yMax));
        const yBottom = yScale(Math.max(low, yMin));
        rect.setAttribute("x", padding.left);
        rect.setAttribute("y", yTop);
        rect.setAttribute("width", width - padding.left - padding.right);
        rect.setAttribute("height", Math.max(0, yBottom - yTop));
        rect.setAttribute("class", "chart-tolerance-band");
        svg.appendChild(rect);
      }
    }

    // Séries (linhas + pontos)
    series.forEach((s, idx) => {
      const color = COLORS[idx % COLORS.length];
      const pts = [...s.points].sort((a, b) => new Date(a.x) - new Date(b.x));
      const pathD = pts
        .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(new Date(p.x).getTime())} ${yScale(p.y)}`)
        .join(" ");
      const path = document.createElementNS(svgns, "path");
      path.setAttribute("d", pathD);
      path.setAttribute("class", "chart-line");
      path.setAttribute("stroke", color);
      svg.appendChild(path);

      pts.forEach((p) => {
        const circle = document.createElementNS(svgns, "circle");
        circle.setAttribute("cx", xScale(new Date(p.x).getTime()));
        circle.setAttribute("cy", yScale(p.y));
        circle.setAttribute("r", 4);
        circle.setAttribute("class", "chart-point");
        circle.setAttribute("fill", color);
        const title = document.createElementNS(svgns, "title");
        title.textContent = `${s.label}: ${p.y}${s.unit ? " " + s.unit : ""} em ${fmtDateTime(p.x)}`;
        circle.appendChild(title);
        svg.appendChild(circle);
      });
    });

    container.appendChild(svg);

    // Legenda
    if (series.length > 1) {
      const legend = document.createElement("div");
      legend.className = "chart-legend";
      series.forEach((s, idx) => {
        const item = document.createElement("span");
        item.className = "chart-legend-item";
        item.innerHTML = `<i style="background:${COLORS[idx % COLORS.length]}"></i>${s.label}`;
        legend.appendChild(item);
      });
      container.appendChild(legend);
    }
  }

  global.RTQC = global.RTQC || {};
  global.RTQC.chart = { renderTrendChart };
})(window);
