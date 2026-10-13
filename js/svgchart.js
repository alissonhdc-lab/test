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

  // Aparência padrão do gráfico (sobrescrita por routine.chartStyle, lida
  // no modal de configuração da rotina) — tamanho do ponto, espessura da
  // linha, se a linha aparece ou não, e transparência de linha/ponto.
  const DEFAULT_STYLE = {
    pointRadius: 3,
    lineWidth: 2,
    showLine: true,
    lineOpacityPct: 100,
    pointOpacityPct: 100,
  };

  function isAngleUnit(unit) {
    return unit === "°" || unit === "graus";
  }

  function fmtValue(v, unit) {
    const decimals = isAngleUnit(unit) ? 1 : 2;
    const rounded = Number(Number(v).toFixed(decimals));
    return (rounded === 0 ? 0 : rounded).toFixed(decimals);
  }

  function fmtDate(iso) {
    // Datas "YYYY-MM-DD" (sem horário, como result.date) são tratadas pelo
    // construtor Date() como meia-noite UTC — em fusos atrás de UTC (ex.:
    // Brasil) isso "puxa" a data para o dia anterior ao converter para
    // horário local. Como é uma data de calendário (sem instante real),
    // formatamos direto a partir dos componentes, sem passar por Date().
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return new Date(iso).toLocaleDateString("pt-BR");
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
    const style = Object.assign({}, DEFAULT_STYLE, opts.style || {});
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
      if (typeof s.actionLow === "number") yValues.push(s.actionLow);
      if (typeof s.actionHigh === "number") yValues.push(s.actionHigh);
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

    // Faixas de ação/tolerância — apenas quando uma única série está
    // selecionada (com mais de uma métrica ao mesmo tempo, cada uma teria
    // escala/unidade diferente e as faixas sobrepostas confundiriam mais
    // do que ajudariam). Aparecem assim que a grandeza é marcada na lista.
    const drawBand = (low, high, cls) => {
      if (typeof low !== "number" || typeof high !== "number") return;
      const rect = document.createElementNS(svgns, "rect");
      const yTop = yScale(Math.min(high, yMax));
      const yBottom = yScale(Math.max(low, yMin));
      rect.setAttribute("x", padding.left);
      rect.setAttribute("y", yTop);
      rect.setAttribute("width", width - padding.left - padding.right);
      rect.setAttribute("height", Math.max(0, yBottom - yTop));
      rect.setAttribute("class", cls);
      svg.appendChild(rect);
    };
    const drawThresholdLine = (value, cls, text) => {
      if (typeof value !== "number") return;
      const y = yScale(value);
      const line = document.createElementNS(svgns, "line");
      line.setAttribute("x1", padding.left);
      line.setAttribute("x2", width - padding.right);
      line.setAttribute("y1", y);
      line.setAttribute("y2", y);
      line.setAttribute("class", cls);
      svg.appendChild(line);
      if (text) {
        const label = document.createElementNS(svgns, "text");
        label.setAttribute("x", width - padding.right - 4);
        label.setAttribute("y", y - 4);
        label.setAttribute("text-anchor", "end");
        label.setAttribute("class", "chart-threshold-label");
        label.textContent = text;
        svg.appendChild(label);
      }
    };

    if (series.length === 1) {
      const s = series[0];
      const unitSuffix = !s.unit ? "" : s.unit === "%" ? "%" : ` ${s.unit}`;
      if (typeof s.actionLow === "number" && typeof s.actionHigh === "number") {
        // Três zonas visuais: tolerância (âmbar, mais larga) por baixo,
        // nível de ação (verde, mais estreita) por cima — o que sobra fora
        // de ambas (sem faixa) é reprovado.
        drawBand(s.toleranceLow, s.toleranceHigh, "chart-tolerance-band-outer");
        drawBand(s.actionLow, s.actionHigh, "chart-tolerance-band");
        drawThresholdLine(s.actionLow, "chart-threshold-action");
        drawThresholdLine(s.actionHigh, "chart-threshold-action", `nível de ação ±${fmtValue(s.actionHigh, s.unit)}${unitSuffix}`);
        drawThresholdLine(s.toleranceLow, "chart-threshold-tolerance");
        drawThresholdLine(s.toleranceHigh, "chart-threshold-tolerance", `tolerância ±${fmtValue(s.toleranceHigh, s.unit)}${unitSuffix}`);
      } else {
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
        drawBand(low, high, "chart-tolerance-band");
      }
    }

    // Séries (linhas + pontos) — tamanho do ponto, espessura/transparência
    // da linha, exibir linha ou não, e transparência do ponto vêm de
    // routine.chartStyle (configurável no cadastro da rotina).
    series.forEach((s, idx) => {
      const color = COLORS[idx % COLORS.length];
      const pts = [...s.points].sort((a, b) => new Date(a.x) - new Date(b.x));

      if (style.showLine && style.lineWidth > 0) {
        const pathD = pts
          .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(new Date(p.x).getTime())} ${yScale(p.y)}`)
          .join(" ");
        const path = document.createElementNS(svgns, "path");
        path.setAttribute("d", pathD);
        path.setAttribute("class", "chart-line");
        path.setAttribute("stroke", color);
        path.style.strokeWidth = `${style.lineWidth}px`;
        path.style.opacity = style.lineOpacityPct / 100;
        svg.appendChild(path);
      }

      pts.forEach((p) => {
        const circle = document.createElementNS(svgns, "circle");
        circle.setAttribute("cx", xScale(new Date(p.x).getTime()));
        circle.setAttribute("cy", yScale(p.y));
        circle.setAttribute("r", style.pointRadius);
        circle.setAttribute("class", "chart-point");
        circle.setAttribute("fill", color);
        circle.style.opacity = style.pointOpacityPct / 100;
        const title = document.createElementNS(svgns, "title");
        title.textContent = `${s.label}: ${fmtValue(p.y, s.unit)}${s.unit ? " " + s.unit : ""} em ${fmtDate(p.x)}`;
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
