"""
main.py — Backend de análise pylinac para a plataforma de CQ em Radioterapia.

Este serviço roda localmente (ou em um servidor da sua rede) e expõe uma API
HTTP que o app (estático, hospedado no GitHub Pages ou aberto localmente)
chama para enviar arquivos DICOM e receber de volta os resultados calculados
pelo pylinac, prontos para alimentar os gráficos de tendência.

Rodar:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8420

Veja README.md nesta pasta para instruções completas.
"""

import json
import logging
import os
import shutil
import tempfile
import traceback
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from modules_config import MODULES

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("rtqc-backend")

app = FastAPI(title="RTQC pylinac backend", version="1.0")

# CORS liberado por padrão (o app roda no navegador de quem faz o upload;
# como o backend normalmente fica em localhost/rede interna, isso é
# aceitável). Restrinja via RTQC_ALLOWED_ORIGINS se publicar em rede maior.
allowed_origins = os.environ.get("RTQC_ALLOWED_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in allowed_origins.split(",")] if allowed_origins != "*" else ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = os.environ.get("RTQC_API_KEY", "").strip()


def check_api_key(x_api_key: Optional[str]):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Chave de API inválida ou ausente (cabeçalho X-API-Key).")


@app.get("/api/health")
def health():
    return {"status": "ok", "modules": sorted(MODULES.keys())}


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
        # listas grandes/complexas (ex.: posição de cada lâmina) são omitidas
        # do resultado achatado para manter a resposta enxuta.
    elif isinstance(obj, (int, float, str, bool)) or obj is None:
        out[prefix] = obj
    else:
        try:
            out[prefix] = str(obj)
        except Exception:
            pass
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
            raise HTTPException(status_code=400, detail=f"Parâmetro inválido '{form_key}': {e}")
        if value is not None and value != "":
            kwargs[pylinac_key] = value
    return kwargs


@app.post("/api/analyze")
async def analyze(
    module_id: str = Form(...),
    params: str = Form("{}"),
    files: List[UploadFile] = File(...),
    x_api_key: Optional[str] = Header(None),
):
    check_api_key(x_api_key)

    if module_id not in MODULES:
        raise HTTPException(status_code=404, detail=f"Módulo desconhecido: {module_id}")

    try:
        params_dict = json.loads(params) if params else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Campo 'params' não é um JSON válido.")

    config = MODULES[module_id]

    # Resolve a classe pylinac (CatPhan tem 4 variantes conforme o modelo do fantoma)
    if "cls_by_model" in config:
        model = params_dict.get("phantom_model")
        cls = config["cls_by_model"].get(model)
        if cls is None:
            raise HTTPException(
                status_code=400,
                detail=f"phantom_model inválido ou ausente. Opções: {list(config['cls_by_model'].keys())}",
            )
    else:
        cls = config["cls"]

    input_mode = config["input_mode"]
    tmp_dir = tempfile.mkdtemp(prefix="rtqc_")
    warnings_list = []

    try:
        saved_paths = []
        for f in files:
            dest = Path(tmp_dir) / f.filename
            with open(dest, "wb") as out:
                shutil.copyfileobj(f.file, out)
            saved_paths.append(dest)

        if len(saved_paths) == 0:
            raise HTTPException(status_code=400, detail="Nenhum arquivo enviado.")

        constructor_kwargs = build_kwargs(config, params_dict, "constructor_param_map", "constructor_param_cast")

        # ---- Constrói a instância pylinac conforme o modo de entrada ----
        if input_mode == "single":
            if len(saved_paths) != 1:
                raise HTTPException(status_code=400, detail="Este teste espera exatamente 1 arquivo.")
            instance = cls(str(saved_paths[0]), **constructor_kwargs)

        elif input_mode == "pair":
            if len(saved_paths) != 2:
                raise HTTPException(
                    status_code=400,
                    detail="Este teste espera exatamente 2 arquivos (campo aberto e campo de teste, nesta ordem).",
                )
            instance = cls([str(p) for p in saved_paths])

        elif input_mode == "multiple":
            # Winston-Lutz e similares: aceitam um diretório com as imagens
            instance = cls(tmp_dir)

        elif input_mode == "series":
            if len(saved_paths) == 1 and saved_paths[0].suffix.lower() == ".zip":
                instance = cls(str(saved_paths[0]), is_zip=True)
            else:
                instance = cls(tmp_dir)

        else:
            raise HTTPException(status_code=500, detail=f"input_mode não suportado: {input_mode}")

        analyze_kwargs = build_kwargs(config, params_dict)
        instance.analyze(**analyze_kwargs)

        results = instance.results_data()
        results_dict = results.model_dump() if hasattr(results, "model_dump") else results
        flat = flatten(results_dict, exclude_prefixes=config.get("exclude_prefixes", ()))

        postprocess = config.get("postprocess")
        if postprocess:
            flat = postprocess(flat)

        if isinstance(results_dict, dict) and results_dict.get("warnings"):
            warnings_list = [str(w) for w in results_dict.get("warnings", [])]

        return JSONResponse(
            {
                "success": True,
                "module_id": module_id,
                "metrics": flat,
                "warnings": warnings_list,
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        full_trace = traceback.format_exc()
        logger.error("Falha ao analisar módulo %s: %s", module_id, full_trace)
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
            hint = " — Dica: confira se o arquivo enviado é realmente do tipo de teste selecionado e se os parâmetros da rotina (orientação, inversão, etc.) batem com a imagem."
        raise HTTPException(status_code=422, detail=f"Falha na análise pylinac: {e}{hint}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
