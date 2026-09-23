"""
wl_custom.py — Subclasses do pylinac.WinstonLutz que tornam a detecção da
borda de campo e da BB de cada imagem controlável por um limiar (%)
configurável na rotina.

Sem isso, o parâmetro de limiar só mudaria o CONTORNO desenhado na
galeria (cosmético) — os números do resultado (cax2bb_distance,
max_2d_cax_to_bb_mm, etc.) continuariam vindo do algoritmo interno do
pylinac, sempre com o mesmo valor fixo, não importa o que o físico
configurasse. Aqui o limiar passa a determinar de verdade o centro
calculado:

- Borda de campo: reimplementação fiel do que
  WinstonLutz2D.find_field_centroids() já faz internamente (limiar entre
  os percentis do fundo/platô + centro de massa da região preenchida) —
  só que com o limiar parametrizado em vez de fixo em 50%. Em 50% o
  resultado é idêntico ao do pylinac original.
- BB: REFINA o ponto já detectado pelo algoritmo robusto original do
  pylinac (SizedDiskLocator, baseado em tamanho/forma) dentro de uma
  janela local ao redor dele, escolhendo o COMPONENTE CONECTADO do
  limiar que contém (ou está mais perto d)o ponto original — não um
  centro de massa ingênuo da janela inteira, que pode ser puxado por
  outra região clara/escura sem relação com a BB. Em 50% o desvio fica
  sub-pixel em relação ao pylinac original (validado com o conjunto de
  demonstração); em limiares mais extremos, o centro (e portanto
  cax2bb_distance/vector) muda de verdade.
"""

import numpy as np
from scipy import ndimage as ndi

import pylinac
from pylinac.core.geometry import Point


def threshold_from_pct(arr, pct, lo_hi_percentiles=(5, 99.9)):
    """Converte um limiar em % (0 = nível do fundo, 100 = nível do platô)
    num valor de intensidade real, usando os percentis do array como
    referência de fundo/platô (mais robusto que usar o mínimo/máximo
    absolutos, sensíveis a ruído/artefatos isolados)."""
    lo, hi = np.percentile(arr, lo_hi_percentiles)
    frac = max(0.0, min(100.0, float(pct))) / 100.0
    return lo + frac * (hi - lo)


class ThresholdWinstonLutz2D(pylinac.winston_lutz.WinstonLutz2D):
    # Sobrescritos por imagem em apply_wl_thresholds(), antes do analyze().
    _field_edge_threshold_pct = 50.0
    _bb_threshold_pct = 50.0

    def find_field_centroids(self, is_open_field):
        if is_open_field:
            return [self.cax]
        threshold = threshold_from_pct(self.array, self._field_edge_threshold_pct, (5, 99.9))
        filled = ndi.binary_fill_holes(self.array >= threshold)
        coords = ndi.center_of_mass(filled)
        return [Point(x=coords[-1], y=coords[0])]

    def find_bb_centroids(self, bb_diameter_mm, low_density):
        base_points = super().find_bb_centroids(bb_diameter_mm, low_density)
        dpmm = self.dpmm
        margin_px = max(4, int(bb_diameter_mm * dpmm))
        refined = []
        for p in base_points:
            x0, x1 = max(0, int(p.x - margin_px)), min(self.array.shape[1], int(p.x + margin_px))
            y0, y1 = max(0, int(p.y - margin_px)), min(self.array.shape[0], int(p.y + margin_px))
            if x1 - x0 < 3 or y1 - y0 < 3:
                refined.append(p)
                continue
            crop = self.array[y0:y1, x0:x1]
            threshold = threshold_from_pct(crop, self._bb_threshold_pct, (1, 99))
            mask = crop >= threshold if low_density else crop <= threshold
            labeled, num = ndi.label(mask)
            if num == 0:
                refined.append(p)
                continue
            local_x, local_y = p.x - x0, p.y - y0
            iy = max(0, min(labeled.shape[0] - 1, int(round(local_y))))
            ix = max(0, min(labeled.shape[1] - 1, int(round(local_x))))
            label_at_point = labeled[iy, ix]
            if label_at_point == 0:
                # o ponto original caiu fora de qualquer região acima do limiar
                # (comum em limiares mais extremos) — usa o componente cujo
                # centroide está mais perto do ponto original, em vez de
                # misturar todas as regiões numa média sem sentido.
                coms = ndi.center_of_mass(mask, labeled, list(range(1, num + 1)))
                dists = [(cy - local_y) ** 2 + (cx - local_x) ** 2 for cy, cx in coms]
                best = int(np.argmin(dists)) + 1
            else:
                best = int(label_at_point)
            com = ndi.center_of_mass(mask, labeled, best)
            refined.append(Point(x=com[1] + x0, y=com[0] + y0))
        return refined


class ThresholdWinstonLutz(pylinac.WinstonLutz):
    image_type = ThresholdWinstonLutz2D


def apply_wl_thresholds(instance, params_dict):
    """Aplica os limiares configurados na rotina a cada imagem, ANTES de
    chamar instance.analyze() — precisa ser antes porque é durante o
    analyze() de cada imagem que a detecção de borda de campo/BB roda."""
    params_dict = params_dict or {}
    field_pct = params_dict.get("field_edge_threshold_pct")
    field_pct = 50.0 if field_pct in (None, "") else float(field_pct)
    bb_pct = params_dict.get("bb_threshold_pct")
    bb_pct = 50.0 if bb_pct in (None, "") else float(bb_pct)
    for img in instance.images:
        img._field_edge_threshold_pct = field_pct
        img._bb_threshold_pct = bb_pct
