"""
analysis.py — Lógica de execução do pylinac, compartilhada entre o endpoint
HTTP /api/analyze e o observador de pastas (watcher.py).
"""

import logging
import re
import traceback
from pathlib import Path

import pydicom

from modules_config import MODULES

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
# nos outros testes, extraímos os dados POR IMAGEM a partir de
# "keyed_image_details" do pylinac — cuja chave já codifica os 3 eixos no
# formato "G<gantry>B<colimador>P<mesa>" (ex.: "G45.0B0.0P0.0"), com um
# sufixo "_N" quando há imagens repetidas na mesma combinação de eixos.
WL_KEY_ANGLES_RE = re.compile(r"^G(-?[\d.]+)B(-?[\d.]+)P(-?[\d.]+)")


def extract_wl_image_details(results_dict):
    """Constrói uma lista (ordenada por eixo e ângulo) com os dados de cada
    imagem individual de um teste Winston-Lutz, para alimentar os gráficos
    interativos por imagem (dispersão 2D e gráficos polares por eixo)."""
    keyed = results_dict.get("keyed_image_details") or {}
    axis_order = {"Reference": 0, "Gantry": 1, "Collimator": 2, "Couch": 3, "GB Combo": 4}
    out = []
    for key, rec in keyed.items():
        match = WL_KEY_ANGLES_RE.match(key)
        gantry = float(match.group(1)) if match else None
        collimator = float(match.group(2)) if match else None
        couch = float(match.group(3)) if match else None
        cax2bb = rec.get("cax2bb_vector") or {}
        out.append(
            {
                "key": key,
                "axis": rec.get("variable_axis"),
                "gantry": gantry,
                "collimator": collimator,
                "couch": couch,
                "cax2bbDistanceMm": rec.get("cax2bb_distance"),
                "cax2bbVectorXMm": cax2bb.get("x"),
                "cax2bbVectorYMm": cax2bb.get("y"),
                "cax2epidDistanceMm": rec.get("cax2epid_distance"),
            }
        )
    out.sort(key=lambda r: (axis_order.get(r["axis"], 99), r["gantry"] or 0, r["collimator"] or 0, r["couch"] or 0))
    return out


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

    try:
        analyze_kwargs = build_kwargs(config, params_dict)
        instance.analyze(**analyze_kwargs)

        results = instance.results_data()
        results_dict = results.model_dump() if hasattr(results, "model_dump") else results
        flat = flatten(results_dict, exclude_prefixes=config.get("exclude_prefixes", ()))

        postprocess = config.get("postprocess")
        if postprocess:
            flat = postprocess(flat)

        if config.get("extract_dicom_angles") and len(saved_paths) >= 1:
            flat.update(extract_dicom_angles(saved_paths[0]))

        if config.get("extract_wl_image_details") and isinstance(results_dict, dict):
            flat["_wl_image_details"] = extract_wl_image_details(results_dict)

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
