"""
analysis.py — Lógica de execução do pylinac, compartilhada entre o endpoint
HTTP /api/analyze e o observador de pastas (watcher.py).
"""

import base64
import io
import logging
import re
import traceback
from pathlib import Path

import numpy as np
import pydicom

from modules_config import MODULES
from wl_custom import threshold_from_pct

logger = logging.getLogger("rtqc-backend")


class AnalysisError(Exception):
    def __init__(self, message, status_code=422):
        super().__init__(message)
        self.status_code = status_code


def flatten(obj, prefix="", exclude_prefixes=()):
    """Achata um resultado pylinac (já convertido em dict/list/escalar via
    model_dump()) em um dicionário de chaves com ponto, mantendo apenas
    valores simples (número, texto, booleano) e listas curtas de escalares."""
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            if any(key == p or key.startswith(p + ".") or key.startswith(p + "[") for p in exclude_prefixes):
                continue
            out.update(flatten(v, key, exclude_prefixes))
    elif isinstance(obj, (list, tuple)):
        if len(obj) <= 8 and all(isinstance(x, (int, float, str, bool)) or x is None for x in obj):
            for i, x in enumerate(obj):
                out[f"{prefix}[{i}]"] = x
    elif isinstance(obj, (int, float, str, bool)) or obj is None:
        out[prefix] = obj
    else:
        try:
            out[prefix] = str(obj)
        except Exception:
            pass
    return out


FIELD_NAME_TAG = (0x0008, 0x103E)  # SeriesDescription
DICOM_STUDY_DATE_TAG = (0x0008, 0x0020)  # StudyDate, formato AAAAMMDD


def extract_dicom_study_date(filepath):
    """Lê a tag DICOM (0008,0020) do primeiro arquivo do conjunto enviado e
    devolve no formato ISO (AAAA-MM-DD). Usada como a data do teste de
    controle de qualidade em TODO teste baseado em imagem DICOM (no lugar
    da data em que o físico efetivamente rodou a análise no app) — ver uso
    em run_analysis(), abaixo, e no observador de pastas (watcher.py)."""
    try:
        ds = pydicom.dcmread(str(filepath), stop_before_pixels=True, force=True)
        elem = ds.get(DICOM_STUDY_DATE_TAG, None)
        if elem and str(elem.value):
            raw = str(elem.value)
            if len(raw) == 8:
                return {"dicom_study_date": f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"}
    except Exception:
        pass
    return {}


# Convenção de nomenclatura do serviço: "...PFG<gantry>C<colimador>"
# (ex.: "...+PFG0C270" -> gantry 0, colimador 270). Essa string é a fonte
# confiável do ângulo de colimador real usado — mais confiável, nesse fluxo
# de trabalho, do que a tag DICOM de colimador (BeamLimitingDeviceAngle).
FIELD_NAME_ANGLES_RE = re.compile(r"PFG(-?\d+(?:\.\d+)?)C(-?\d+(?:\.\d+)?)", re.IGNORECASE)


def extract_dicom_angles(filepath):
    """Lê ângulo de gantry e mesa direto do cabeçalho DICOM (tags padrão do
    módulo RT Image), e o ângulo de colimador a partir do nome do campo
    (SeriesDescription), quando presentes."""
    tags = {
        "dicom_gantry_angle_deg": (0x300A, 0x011E),
        "dicom_collimator_angle_deg": (0x300A, 0x0120),
        "dicom_couch_angle_deg": (0x300A, 0x0122),
    }
    out = {}
    try:
        ds = pydicom.dcmread(str(filepath), stop_before_pixels=True, force=True)
        for key, tag in tags.items():
            if tag in ds:
                try:
                    out[key] = float(ds[tag].value)
                except (TypeError, ValueError):
                    pass

        field_name_elem = ds.get(FIELD_NAME_TAG, None)
        field_name = str(field_name_elem.value) if field_name_elem else ""
        out["dicom_field_name"] = field_name
        match = FIELD_NAME_ANGLES_RE.search(field_name)
        if match:
            out["dicom_collimator_angle_deg"] = float(match.group(2))

        study_date = ds.get((0x0008, 0x0020), None)  # StudyDate, formato AAAAMMDD
        if study_date and str(study_date.value):
            raw = str(study_date.value)
            if len(raw) == 8:
                out["dicom_study_date"] = f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"
    except Exception:
        pass
    return out


def rename_files_by_series_description(paths):
    """Renomeia cada arquivo (no mesmo diretório) para o nome derivado da tag
    DICOM SeriesDescription (0008,103E): a parte após " + ", quando presente,
    senão a descrição inteira (mesma convenção usada no fluxo local do
    físico). Isso é necessário para o Winston-Lutz porque, nesta máquina, os
    ângulos de gantry/colimador/mesa não vêm confiáveis nas tags DICOM
    correspondentes — o pylinac, com ``use_filenames=True``, lê esses
    ângulos direto do NOME do arquivo (padrão "...Gantry<nº>Coll<nº>...").

    Arquivos sem SeriesDescription não são renomeados (ficam como estavam).
    Em caso de nomes duplicados, adiciona um sufixo numérico em vez de pular
    o arquivo, para nunca perder silenciosamente uma imagem da análise."""
    renamed = []
    for raw_path in paths:
        path = Path(raw_path)
        series_desc = ""
        try:
            ds = pydicom.dcmread(str(path), stop_before_pixels=True, force=True)
            elem = ds.get(FIELD_NAME_TAG, None)
            series_desc = str(elem.value) if elem else ""
        except Exception:
            pass

        if not series_desc:
            renamed.append(path)
            continue

        new_stem = series_desc.split(" + ", 1)[1] if " + " in series_desc else series_desc
        new_stem = re.sub(r'[\\/:*?"<>|]', "_", new_stem).strip(" .") or path.stem
        suffix = path.suffix or ".dcm"
        candidate = path.with_name(f"{new_stem}{suffix}")
        counter = 1
        while candidate.exists() and candidate != path:
            candidate = path.with_name(f"{new_stem}_{counter}{suffix}")
            counter += 1

        if candidate != path:
            path.rename(candidate)
        renamed.append(candidate)
    return renamed


# Winston-Lutz não tem UM ângulo de gantry/colimador (o teste é justamente
# feito em VÁRIOS ângulos), então em vez do mecanismo de ângulo único usado
# nos outros testes, construímos uma lista com os dados de CADA imagem
# individual (eixo, ângulos, erro CAX→BB/EPID e uma miniatura já anotada
# com a borda de campo segmentada e os centros da BB/campo/EPID) — lida
# direto de cada objeto de imagem do pylinac (instance.images), não do
# results_data() serializado, porque as mesmas propriedades usadas aqui
# (cax2bb_distance, variable_axis, etc.) são as que o método .plot() de
# cada imagem também usa para desenhar as marcações — não corremos o
# risco de os dois ficarem fora de sincronia.
WL_AXIS_ORDER = {"Reference": 0, "Gantry": 1, "Collimator": 2, "Couch": 3, "GB Combo": 4}


def _draw_wl_field_edge(ax, wl_image, threshold_pct=50.0):
    """Desenha o contorno do campo segmentado por cima da imagem já
    plotada. O pylinac NÃO desenha isso por padrão em WLBaseImage.plot()
    (só marca o centro do campo, não a borda). Usa o mesmo limiar (e a
    mesma lógica) que wl_custom.ThresholdWinstonLutz2D.find_field_centroids()
    já usou para calcular o centro do campo de verdade — o contorno aqui é
    só a representação visual dessa mesma segmentação, então fica sempre
    consistente com o marcador de centro desenhado por cima."""
    from scipy import ndimage as ndi
    from skimage import measure

    try:
        arr = wl_image.array
        threshold = threshold_from_pct(arr, threshold_pct, (5, 99.9))
        filled = ndi.binary_fill_holes(arr >= threshold)
        for contour in measure.find_contours(filled.astype(float), 0.5):
            ax.plot(contour[:, 1], contour[:, 0], color="yellow", linewidth=1.3)
    except Exception:
        logger.exception("Falha ao desenhar a borda de campo segmentada")


def _draw_wl_bb_edge(ax, wl_image, threshold_pct=50.0, low_density_bb=False, bb_diameter_mm=5.0):
    """Desenha o contorno segmentado de cada BB detectada, numa janela
    local ao redor da posição já encontrada (ver
    wl_custom.ThresholdWinstonLutz2D.find_bb_centroids, que usa esse mesmo
    limiar para refinar o centro real da BB usado no resultado). BB normal
    (não 'low density') aparece mais escura que o fundo do campo ao redor;
    BB de baixa densidade aparece mais clara — mesma convenção que o
    parâmetro 'low_density_bb' já usa na análise real."""
    from scipy import ndimage as ndi
    from skimage import measure

    try:
        arr = wl_image.array
        dpmm = wl_image.dpmm
        margin_px = max(4, int(bb_diameter_mm * dpmm * 1.5))
        for match in wl_image.arrangement_matches.values():
            cx, cy = match.bb.x, match.bb.y
            x0, x1 = max(0, int(cx - margin_px)), min(arr.shape[1], int(cx + margin_px))
            y0, y1 = max(0, int(cy - margin_px)), min(arr.shape[0], int(cy + margin_px))
            if x1 - x0 < 3 or y1 - y0 < 3:
                continue
            crop = arr[y0:y1, x0:x1]
            threshold = threshold_from_pct(crop, threshold_pct, (1, 99))
            mask = crop >= threshold if low_density_bb else crop <= threshold
            filled = ndi.binary_fill_holes(mask)
            for contour in measure.find_contours(filled.astype(float), 0.5):
                ax.plot(contour[:, 1] + x0, contour[:, 0] + y0, color="magenta", linewidth=1.2)
    except Exception:
        logger.exception("Falha ao desenhar a borda segmentada da BB")


def render_wl_images(instance, params_dict=None, figsize=(5, 5), dpi=90):
    """Para cada imagem do Winston-Lutz, monta um registro com eixo/ângulos,
    erro CAX→BB/EPID, e uma miniatura PNG (base64) da própria imagem com a
    borda de campo segmentada, a borda da BB segmentada, e os centros da
    BB, do campo e do EPID marcados (mesma anotação que o pylinac desenha
    em seu relatório, via WLBaseImage.plot(), mais as duas bordas
    segmentadas — ver _draw_wl_field_edge / _draw_wl_bb_edge). Os limiares
    de segmentação e o tamanho da BB vêm dos parâmetros da rotina
    (field_edge_threshold_pct, bb_threshold_pct, bb_size_mm,
    low_density_bb), com padrões sensatos quando não informados."""
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    params_dict = params_dict or {}
    field_threshold_pct = params_dict.get("field_edge_threshold_pct")
    field_threshold_pct = 50.0 if field_threshold_pct in (None, "") else float(field_threshold_pct)
    bb_threshold_pct = params_dict.get("bb_threshold_pct")
    bb_threshold_pct = 50.0 if bb_threshold_pct in (None, "") else float(bb_threshold_pct)
    bb_size_mm = params_dict.get("bb_size_mm")
    bb_size_mm = 5.0 if bb_size_mm in (None, "") else float(bb_size_mm)
    low_density_bb = bool(params_dict.get("low_density_bb"))

    legend_handles = [
        Line2D([0], [0], color="yellow", linewidth=1.3, label="Borda de campo"),
        Line2D([0], [0], color="magenta", linewidth=1.2, label="Borda da BB"),
        Line2D([0], [0], marker="s", linestyle="None", markerfacecolor="green", markeredgecolor="green", markersize=7, label="Centro do campo"),
        Line2D([0], [0], marker="o", linestyle="None", markerfacecolor="cyan", markeredgecolor="cyan", markersize=8, label="BB detectada"),
        Line2D([0], [0], color="b", linewidth=1.3, label="Centro do EPID"),
    ]

    out = []
    for wl_image in instance.images:
        fig = None
        image_png_b64 = None
        try:
            fig, ax = plt.subplots(figsize=figsize)
            wl_image.plot(ax=ax, show=False, zoom=True, legend=False)
            _draw_wl_field_edge(ax, wl_image, field_threshold_pct)
            _draw_wl_bb_edge(ax, wl_image, bb_threshold_pct, low_density_bb, bb_size_mm)
            ax.legend(handles=legend_handles, loc="upper right", fontsize=6.5)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
            buf.seek(0)
            image_png_b64 = base64.b64encode(buf.read()).decode("ascii")
        except Exception:
            logger.exception("Falha ao renderizar uma imagem individual do Winston-Lutz")
        finally:
            if fig is not None:
                plt.close(fig)

        axis_value = getattr(wl_image.variable_axis, "value", wl_image.variable_axis)
        cax2bb = wl_image.cax2bb_vector
        out.append(
            {
                "axis": axis_value,
                "gantry": wl_image.gantry_angle,
                "collimator": wl_image.collimator_angle,
                "couch": wl_image.couch_angle,
                "cax2bbDistanceMm": wl_image.cax2bb_distance,
                "cax2bbVectorXMm": cax2bb.x,
                "cax2bbVectorYMm": cax2bb.y,
                "cax2epidDistanceMm": wl_image.cax2epid_distance,
                "imagePngB64": image_png_b64,
            }
        )
    out.sort(
        key=lambda r: (WL_AXIS_ORDER.get(r["axis"], 99), r["gantry"] or 0, r["collimator"] or 0, r["couch"] or 0)
    )
    return out


def _isoalign_line_width(params_dict, key, default):
    raw = (params_dict or {}).get(key)
    if raw in (None, ""):
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _set_isoalign_marker_line_widths(ax, params_dict):
    """Ajusta a espessura das linhas que o próprio plot_analyzed_image() do
    pylinac já desenha (BB Centroid em verde, EPID Center em azul, Field
    Center em vermelho) — o pylinac não expõe linewidth como parâmetro
    dessas linhas, então em vez de reimplementar o desenho, encontramos os
    Line2D já criados (cada grupo é um par: uma linha horizontal com o
    "label" do grupo, mais a vertical companheira logo em seguida, sem
    marcador — os pontos de detecção da BB, que aparecem antes no mesmo
    eixo, têm marcador e ficam de fora) e mudamos a linewidth de cada um
    diretamente."""
    color_width = {
        "g": _isoalign_line_width(params_dict, "bb_line_width", 1.5),
        "b": _isoalign_line_width(params_dict, "epid_line_width", 1.5),
        "red": _isoalign_line_width(params_dict, "field_line_width", 1.5),
    }
    try:
        for line in ax.get_lines():
            if line.get_marker() not in (None, "None", ""):
                continue  # pontos de detecção da BB, não as linhas do centro
            width = color_width.get(line.get_color())
            if width is not None:
                line.set_linewidth(width)
    except Exception:
        logger.exception("Falha ao ajustar a espessura das linhas do IsoAlign")


def _draw_isoalign_field_edge(ax, instance, params_dict=None):
    """Overlay só para visualização: desenha um retângulo tracejado nas
    bordas de campo detectadas pelo FWXM, e ajusta a espessura das linhas
    de BB/EPID/Field já desenhadas pelo pylinac (ver
    _set_isoalign_marker_line_widths) — tudo configurável pela rotina. Não
    reimplementa nada da detecção do campo — usa os mesmos valores que o
    pylinac já calculou e usou para o resultado (instance.field_center,
    field_width_x/y, em StandardImagingFC2._find_field_info): o centro ±
    metade da largura de campo em cada eixo, convertido de mm para pixel
    via image.dpmm. Assim o físico vê exatamente onde a borda do FWXM está
    caindo na imagem, sem risco de a linha desenhada não bater com o
    número do resultado (ao contrário do Winston-Lutz, aqui não há limiar
    configurável nem segmentação 2D para refazer — é literalmente o valor
    já usado)."""
    _set_isoalign_marker_line_widths(ax, params_dict)
    try:
        dpmm = instance.image.dpmm
        cx, cy = instance.field_center.x, instance.field_center.y
        half_w = (instance.field_width_x / 2) * dpmm
        half_h = (instance.field_width_y / 2) * dpmm
        xs = [cx - half_w, cx + half_w, cx + half_w, cx - half_w, cx - half_w]
        ys = [cy - half_h, cy - half_h, cy + half_h, cy + half_h, cy - half_h]
        edge_width = _isoalign_line_width(params_dict, "field_edge_line_width", 0.6)
        ax.plot(xs, ys, color="yellow", linewidth=edge_width, linestyle="--", label="Borda de campo (FWXM)")
        ax.legend()
    except Exception:
        logger.exception("Falha ao desenhar a borda de campo FWXM (IsoAlign)")


def render_analyzed_image_png_b64(instance, figsize=(11, 5.5), dpi=110, overlay_hook=None, params_dict=None):
    """Gera a mesma figura que o pylinac usa no relatório (imagem 2D com as
    marcações da análise, ex.: para o Starshot: as linhas ajustadas de cada
    exposição e o círculo mínimo — 'wobble' — que elas formam) e devolve
    como PNG em base64, pronto para exibir num <img> no navegador. Requer
    que ``instance.plot_analyzed_image`` exista (todo módulo do pylinac com
    imagem 2D tem esse método) e que o matplotlib esteja configurado com o
    backend "Agg" (ver main.py) — sem isso, tentar desenhar trava/lança erro
    num processo de servidor sem tela.

    overlay_hook: função opcional (ax, instance, params_dict) -> None,
    chamada depois do plot_analyzed_image() do próprio pylinac, para
    desenhar por cima algo que o módulo não desenha nativamente (ex.: a
    borda de campo do FWXM no IsoAlign — ver _draw_isoalign_field_edge)."""
    import matplotlib.pyplot as plt

    fig = None
    try:
        # Nem todo módulo do pylinac aceita "figsize" em plot_analyzed_image
        # (ex.: PicketFence usa "figure_size", com "auto" já bem ajustado
        # por eixo/orientação; IsoAlign repassa **kwargs direto para
        # ax.imshow(), que rejeita "figsize" com AttributeError em vez de
        # TypeError) — em qualquer um desses casos cai para o tamanho
        # padrão do próprio módulo em vez de travar a análise por causa
        # disso.
        try:
            instance.plot_analyzed_image(show=False, figsize=figsize)
        except (TypeError, AttributeError):
            instance.plot_analyzed_image(show=False)
        fig = plt.gcf()
        if overlay_hook:
            overlay_hook(fig.axes[0], instance, params_dict)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
        buf.seek(0)
        return base64.b64encode(buf.read()).decode("ascii")
    except Exception:
        logger.exception("Falha ao renderizar a imagem analisada")
        return None
    finally:
        if fig is not None:
            plt.close(fig)


def build_kwargs(config, params: dict, map_key="param_map", cast_key="param_cast"):
    param_map = config.get(map_key, {})
    param_cast = config.get(cast_key, {})
    kwargs = {}
    for form_key, pylinac_key in param_map.items():
        if form_key not in params:
            continue
        raw = params[form_key]
        cast = param_cast.get(form_key)
        try:
            value = cast(raw) if cast else raw
        except Exception as e:
            raise AnalysisError(f"Parâmetro inválido '{form_key}': {e}", 400)
        if value is not None and value != "":
            kwargs[pylinac_key] = value
    return kwargs


def resolve_class(config, params_dict):
    if "cls_by_model" in config:
        model = params_dict.get("phantom_model")
        cls = config["cls_by_model"].get(model)
        if cls is None:
            raise AnalysisError(
                f"phantom_model inválido ou ausente. Opções: {list(config['cls_by_model'].keys())}", 400
            )
        return cls
    return config["cls"]


def run_analysis(module_id, params_dict, saved_paths, tmp_dir):
    """Executa a análise pylinac para module_id sobre os arquivos já salvos
    em disco (saved_paths, dentro de tmp_dir). Retorna {"metrics", "warnings"}
    ou levanta AnalysisError com uma mensagem amigável."""
    if module_id not in MODULES:
        raise AnalysisError(f"Módulo desconhecido: {module_id}", 404)
    if len(saved_paths) == 0:
        raise AnalysisError("Nenhum arquivo enviado.", 400)

    config = MODULES[module_id]
    cls = resolve_class(config, params_dict)
    input_mode = config["input_mode"]
    constructor_kwargs = build_kwargs(config, params_dict, "constructor_param_map", "constructor_param_cast")

    if config.get("rename_files_by_series_description"):
        saved_paths = rename_files_by_series_description(saved_paths)
        constructor_kwargs["use_filenames"] = True

    if input_mode == "single":
        if len(saved_paths) != 1:
            raise AnalysisError("Este teste espera exatamente 1 arquivo.", 400)
        instance = cls(str(saved_paths[0]), **constructor_kwargs)
    elif input_mode == "pair":
        if len(saved_paths) != 2:
            raise AnalysisError(
                "Este teste espera exatamente 2 arquivos (campo aberto e campo de teste, nesta ordem).", 400
            )
        instance = cls([str(p) for p in saved_paths])
    elif input_mode == "multiple":
        instance = cls(tmp_dir, **constructor_kwargs)
    elif input_mode == "series":
        if len(saved_paths) == 1 and saved_paths[0].suffix.lower() == ".zip":
            instance = cls(str(saved_paths[0]), is_zip=True)
        else:
            instance = cls(tmp_dir)
    else:
        raise AnalysisError(f"input_mode não suportado: {input_mode}", 500)

    pre_analyze_hook = config.get("pre_analyze_hook")
    if pre_analyze_hook:
        pre_analyze_hook(instance, params_dict)

    try:
        analyze_kwargs = build_kwargs(config, params_dict)
        instance.analyze(**analyze_kwargs)

        results = instance.results_data()
        results_dict = results.model_dump() if hasattr(results, "model_dump") else results
        flat = flatten(results_dict, exclude_prefixes=config.get("exclude_prefixes", ()))

        postprocess = config.get("postprocess")
        if postprocess:
            flat = postprocess(flat, params_dict)

        if config.get("extract_dicom_angles") and len(saved_paths) >= 1:
            flat.update(extract_dicom_angles(saved_paths[0]))
        elif len(saved_paths) >= 1:
            # Módulos que não usam extract_dicom_angles (hoje só o
            # Winston-Lutz, que extrai os dados por imagem separadamente)
            # ainda assim precisam de dicom_study_date — é a data usada como
            # data do teste de controle de qualidade em qualquer teste
            # baseado em imagem DICOM (ver runPylinacAnalysis no app.js e
            # watcher.py).
            flat.update(extract_dicom_study_date(saved_paths[0]))

        if config.get("extract_wl_image_details"):
            flat["_wl_image_details"] = render_wl_images(instance, params_dict)

        if config.get("render_analyzed_image"):
            overlay_hook = _draw_isoalign_field_edge if config.get("draw_fwxm_field_edge") else None
            flat["_analyzed_image_png_b64"] = render_analyzed_image_png_b64(
                instance, overlay_hook=overlay_hook, params_dict=params_dict
            )

        warnings_list = []
        if isinstance(results_dict, dict) and results_dict.get("warnings"):
            warnings_list = [str(w) for w in results_dict.get("warnings", [])]

        return {"metrics": flat, "warnings": warnings_list}

    except AnalysisError:
        raise
    except Exception as e:
        logger.error("Falha ao analisar módulo %s: %s", module_id, traceback.format_exc())
        hint = ""
        msg = str(e).lower()
        if "nan" in msg and module_id == "picketfence":
            hint = (
                " — Dica: isso costuma acontecer quando o modelo de MLC configurado na "
                "rotina não bate com a máquina real da imagem, a orientação dos pickets "
                "está trocada (Up-Down/Left-Right), ou a imagem precisa da opção "
                "'Inverter imagem'. Confira esses parâmetros na rotina e tente de novo."
            )
        elif "nan" in msg:
            hint = (
                " — Dica: confira se o arquivo enviado é realmente do tipo de teste "
                "selecionado e se os parâmetros da rotina (orientação, inversão, etc.) "
                "batem com a imagem."
            )
        raise AnalysisError(f"Falha na análise pylinac: {e}{hint}", 422)
