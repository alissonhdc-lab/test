"""
modules_config.py
Tabela de despacho: para cada módulo do catálogo do app (mesmos IDs usados em
js/catalog.js), define como construir a classe pylinac a partir dos arquivos
enviados, como traduzir os parâmetros vindos do formulário do app para os
argumentos reais do pylinac, e (opcionalmente) uma função para tratar campos
específicos do resultado (ex.: valor absoluto de simetria/planeza).

Cada entrada:
    cls:            classe pylinac usada
    input_mode:     "single" | "multiple" | "pair" | "series"
                     - single:   1 arquivo de imagem
                     - multiple: N arquivos de imagem (ex.: Winston-Lutz), passados
                                 como diretório
                     - pair:     exatamente 2 arquivos, em ordem (ex.: VMAT)
                     - series:   conjunto de cortes DICOM (CT/CBCT) ou um .zip
    param_map:      dict {chave_do_formulário: nome_do_kwarg_em_analyze}
    param_cast:     dict opcional {chave_do_formulário: função de conversão}
    postprocess:    função opcional (flat_dict) -> flat_dict, para ajustes finos
                     (ex.: valor absoluto em campos de simetria)
"""

import pylinac


def _abs_fields(*keys):
    def _fn(flat):
        for k in keys:
            if k in flat and flat[k] is not None:
                try:
                    flat[k] = abs(float(flat[k]))
                except (TypeError, ValueError):
                    pass
        return flat

    return _fn


def _enum_by_name(enum_cls):
    def _cast(value):
        if value is None or value == "":
            return None
        return enum_cls[value]

    return _cast


def _bool_cast(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "on", "yes")


def _float_cast(value):
    if value is None or value == "":
        return None
    return float(value)


def _int_cast(value):
    if value is None or value == "":
        return None
    return int(float(value))


MODULES = {
    "picketfence": {
        "cls": pylinac.PicketFence,
        "input_mode": "single",
        # Lê ângulo de gantry e colimador direto do cabeçalho DICOM da imagem
        # (tags padrão do RT Image) e inclui nas métricas retornadas, já que
        # o picket fence normalmente é repetido em vários ângulos de gantry.
        "extract_dicom_angles": True,
        "param_map": {
            "orientation": "orientation",
            "tolerance_mm": "tolerance",
            "action_tolerance_mm": "action_tolerance",
            "num_pickets": "num_pickets",
            "invert": "invert",
        },
        "param_cast": {
            "tolerance_mm": _float_cast,
            "action_tolerance_mm": _float_cast,
            "num_pickets": _int_cast,
            "invert": _bool_cast,
        },
        # mlc e crop_mm são passados na construção do objeto (não em analyze()).
        # Escolher o modelo de MLC certo é essencial: o pylinac assume "Millennium"
        # (Varian) por padrão, e se a máquina real usar outro MLC (ex.: MLCi da
        # Elekta), a detecção dos pickets falha (é a causa mais comum do erro
        # "cannot convert float NaN to integer").
        "constructor_param_map": {"mlc": "mlc", "crop_mm": "crop_mm"},
        "constructor_param_cast": {
            "mlc": _enum_by_name(
                __import__("pylinac.picketfence", fromlist=["MLC"]).MLC
            ),
            "crop_mm": _int_cast,
        },
        # Mostra ao físico a imagem com os trilhos-guia, os picos de cada
        # lâmina do MLC detectados, um overlay colorido pelo status de cada
        # lâmina e um gráfico de barras do erro médio/desvio por lâmina —
        # para identificar visualmente quais lâminas tiveram desvio maior
        # (ver render_analyzed_image_png_b64 em analysis.py).
        "render_analyzed_image": True,
    },
    "starshot": {
        "cls": pylinac.Starshot,
        "input_mode": "single",
        "extract_dicom_angles": True,
        # Mostra ao físico a mesma imagem que o relatório do pylinac: a
        # imagem 2D com as linhas ajustadas de cada exposição e o círculo
        # mínimo ("wobble") que elas formam (ver render_analyzed_image_png_b64
        # em analysis.py).
        "render_analyzed_image": True,
        "param_map": {
            "tolerance_mm": "tolerance",
            "radius": "radius",
            "recursive": "recursive",
        },
        "param_cast": {
            "tolerance_mm": _float_cast,
            "radius": _float_cast,
            "recursive": _bool_cast,
        },
        # Imagens escaneadas (filme, sem metadados DICOM) precisam da distância
        # fonte-imagem (SID) informada manualmente na construção do objeto.
        "constructor_param_map": {"sid_mm": "sid"},
        "constructor_param_cast": {"sid_mm": _float_cast},
    },
    "winston_lutz": {
        "cls": pylinac.WinstonLutz,
        "input_mode": "multiple",
        "param_map": {
            "bb_size_mm": "bb_size_mm",
            "machine_scale": "machine_scale",
            "low_density_bb": "low_density_bb",
            "open_field": "open_field",
            "bb_proximity_mm": "bb_proximity_mm",
        },
        "param_cast": {
            "bb_size_mm": _float_cast,
            "machine_scale": _enum_by_name(
                __import__("pylinac.core.scale", fromlist=["MachineScale"]).MachineScale
            ),
            "low_density_bb": _bool_cast,
            "open_field": _bool_cast,
            "bb_proximity_mm": _float_cast,
        },
        # Winston-Lutz é feito por definição em VÁRIOS ângulos de gantry/
        # colimador/mesa numa mesma execução, então em vez de um único par
        # gantry/colimador (como nos outros testes de imagem), extraímos os
        # dados de CADA imagem — incluindo uma miniatura anotada com a
        # borda de campo segmentada e os centros da BB/campo/EPID — para
        # alimentar o painel interativo por imagem do app (ver
        # render_wl_images em analysis.py).
        "extract_wl_image_details": True,
        # Nesta máquina, gantry/colimador/mesa não vêm confiáveis nas tags
        # DICOM — antes de rodar o pylinac, renomeamos cada arquivo para o
        # nome derivado do SeriesDescription (0008,103E) e construímos o
        # WinstonLutz com use_filenames=True, para que ele leia os ângulos
        # do nome do arquivo em vez do cabeçalho DICOM (ver
        # rename_files_by_series_description em analysis.py).
        "rename_files_by_series_description": True,
        "exclude_prefixes": ["keyed_image_details"],
    },
    "field_analysis": {
        "cls": pylinac.FieldAnalysis,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {
            "protocol": "protocol",
            "invert": "invert",
            "is_FFF": "is_FFF",
        },
        "param_cast": {
            "protocol": _enum_by_name(
                __import__("pylinac.field_analysis", fromlist=["Protocol"]).Protocol
            ),
            "invert": _bool_cast,
            "is_FFF": _bool_cast,
        },
        "postprocess": _abs_fields(
            "protocol_results.flatness_horizontal",
            "protocol_results.flatness_vertical",
            "protocol_results.symmetry_horizontal",
            "protocol_results.symmetry_vertical",
        ),
    },
    "vmat_drgs": {
        "cls": pylinac.DRGS,
        "input_mode": "pair",
        "extract_dicom_angles": True,
        "param_map": {"tolerance_percent": "tolerance"},
        "param_cast": {"tolerance_percent": _float_cast},
    },
    "vmat_drmlc": {
        "cls": pylinac.DRMLC,
        "input_mode": "pair",
        "extract_dicom_angles": True,
        "param_map": {"tolerance_percent": "tolerance"},
        "param_cast": {"tolerance_percent": _float_cast},
    },
    "planar_leeds": {
        "cls": pylinac.LeedsTOR,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {"invert": "invert", "ssd": "ssd"},
        "param_cast": {"invert": _bool_cast},
        "exclude_prefixes": ["low_contrast_rois", "mtf_lp_mm"],
    },
    "planar_qc3": {
        "cls": pylinac.StandardImagingQC3,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {"invert": "invert", "ssd": "ssd"},
        "param_cast": {"invert": _bool_cast},
        "exclude_prefixes": ["low_contrast_rois", "mtf_lp_mm"],
    },
    "planar_lasvegas": {
        "cls": pylinac.LasVegas,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {"invert": "invert", "ssd": "ssd"},
        "param_cast": {"invert": _bool_cast},
        "exclude_prefixes": ["low_contrast_rois", "mtf_lp_mm"],
    },
    "planar_doselab_kv": {
        "cls": pylinac.DoselabMC2kV,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {"invert": "invert", "ssd": "ssd"},
        "param_cast": {"invert": _bool_cast},
        "exclude_prefixes": ["low_contrast_rois", "mtf_lp_mm"],
    },
    "planar_doselab_mv": {
        "cls": pylinac.DoselabMC2MV,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {"invert": "invert", "ssd": "ssd"},
        "param_cast": {"invert": _bool_cast},
        "exclude_prefixes": ["low_contrast_rois", "mtf_lp_mm"],
    },
    "planar_snc_kv": {
        "cls": pylinac.SNCkV,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {"invert": "invert", "ssd": "ssd"},
        "param_cast": {"invert": _bool_cast},
        "exclude_prefixes": ["low_contrast_rois", "mtf_lp_mm"],
    },
    "planar_snc_mv": {
        "cls": pylinac.SNCMV,
        "input_mode": "single",
        "extract_dicom_angles": True,
        "param_map": {"invert": "invert", "ssd": "ssd"},
        "param_cast": {"invert": _bool_cast},
        "exclude_prefixes": ["low_contrast_rois", "mtf_lp_mm"],
    },
    "catphan": {
        # classe real escolhida em tempo de execução via params["phantom_model"]
        "cls_by_model": {
            "CatPhan 504": pylinac.CatPhan504,
            "CatPhan 503": pylinac.CatPhan503,
            "CatPhan 600": pylinac.CatPhan600,
            "CatPhan 604": pylinac.CatPhan604,
        },
        "input_mode": "series",
        "param_map": {
            "hu_tolerance": "hu_tolerance",
            "scaling_tolerance_mm": "scaling_tolerance",
            "thickness_tolerance_mm": "thickness_tolerance",
        },
        "param_cast": {
            "hu_tolerance": _float_cast,
            "scaling_tolerance_mm": _float_cast,
            "thickness_tolerance_mm": _float_cast,
        },
        "extract_dicom_angles": True,
        "exclude_prefixes": [
            "ctp404.hu_rois",
            "ctp486.rois",
            "ctp528.roi_settings",
            "ctp528.mtf_lp_mm",
            "ctp515.roi_settings",
            "ctp515.roi_results",
        ],
    },
    "quart": {
        "cls": pylinac.QuartDVT,
        "input_mode": "series",
        "param_map": {"hu_tolerance": "hu_tolerance"},
        "param_cast": {"hu_tolerance": _float_cast},
        "extract_dicom_angles": True,
        "exclude_prefixes": [
            "hu_module.roi_settings",
            "hu_module.rois",
            "uniformity_module.roi_settings",
            "uniformity_module.rois",
            "geometric_module.roi_settings",
            "geometric_module.rois",
        ],
    },
    "cheese": {
        "cls": pylinac.TomoCheese,
        "input_mode": "series",
        "param_map": {},
        "param_cast": {},
        "extract_dicom_angles": True,
        "exclude_prefixes": ["rois"],
    },
}
