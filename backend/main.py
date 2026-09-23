"""
main.py — Backend da plataforma de CQ em Radioterapia.

Este serviço roda localmente (ou em um servidor da sua rede) e agora é a
fonte de dados da aplicação inteira (usuários, equipamentos, rotinas e
resultados ficam num banco SQLite local, não mais no navegador). Ele expõe:

- API REST para o app (estático, hospedado no GitHub Pages ou aberto
  localmente) ler/gravar todos os dados;
- /api/analyze para rodar o pylinac sobre arquivos DICOM enviados pelo
  navegador;
- um observador de pastas em segundo plano que analisa automaticamente
  arquivos novos em pastas configuradas por rotina, mesmo sem nenhum
  navegador aberto.

Rodar:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8420

Veja README.md nesta pasta para instruções completas.
"""

import matplotlib

# Precisa ser configurado ANTES de qualquer import que puxe o pylinac (que
# importa matplotlib.pyplot internamente para os métodos de plot, ex.:
# Starshot.plot_analyzed_image): "Agg" é um backend sem interface gráfica,
# necessário porque o backend roda como serviço/servidor, sem uma sessão
# de desktop para abrir uma janela.
matplotlib.use("Agg")

import json
import logging
import os
import shutil
import tempfile
import traceback
from pathlib import Path
from typing import List, Optional

from fastapi import Body, Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import auth
import db
import watcher
from analysis import AnalysisError, run_analysis
from modules_config import MODULES

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("rtqc-backend")

app = FastAPI(title="RTQC backend", version="2.0")

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


# ==================================================================
# Autenticação por requisição (sessão via token Bearer) e permissões
# ==================================================================
# Todo usuário da categoria "tecnico" só tem permissão para duas ações:
# registrar resultado de uma rotina já existente e excluir um resultado
# calculado que ainda não foi aprovado. Tudo o mais (gerenciar equipamentos,
# rotinas, usuários, backup e pastas observadas, ou aprovar resultados) é
# restrito a usuários "admin". Essas regras são aplicadas aqui no backend
# (não só escondendo botões na UI), então mesmo uma chamada direta à API
# feita por um técnico é bloqueada.
def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Autenticação necessária. Faça login novamente.")
    token = authorization.split(" ", 1)[1].strip()
    user = db.get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada. Faça login novamente.")
    return user


def require_admin(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Ação permitida apenas para administradores.")
    return user


@app.on_event("startup")
def on_startup():
    db.init_db()
    db.maybe_restore_from_auto_backup()
    watcher.start()
    logger.info("Backend pronto. Banco de dados: %s", db.DB_PATH)


@app.get("/api/health")
def health():
    return {"status": "ok", "modules": sorted(MODULES.keys())}


# ==================================================================
# Autenticação / usuários
# ==================================================================
@app.get("/api/auth/status")
def auth_status():
    return {"hasUsers": len(db.list_users()) > 0}


@app.post("/api/auth/setup")
def auth_setup(data: dict = Body(...)):
    if len(db.list_users()) > 0:
        raise HTTPException(status_code=400, detail="Já existem usuários cadastrados.")
    try:
        uid = auth.create_user(data["fullName"], data["username"], data["password"], "admin")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    token = db.create_session(uid)
    return {**auth.public_user(db.get_user_by_id(uid)), "token": token}


@app.post("/api/auth/login")
def auth_login(data: dict = Body(...)):
    user = auth.verify_credentials(data.get("username", ""), data.get("password", ""))
    if not user:
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")
    token = db.create_session(user["id"])
    return {**auth.public_user(user), "token": token}


@app.post("/api/auth/logout")
def auth_logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.lower().startswith("bearer "):
        db.delete_session(authorization.split(" ", 1)[1].strip())
    return {"success": True}


@app.post("/api/auth/verify")
def auth_verify(data: dict = Body(...), _: dict = Depends(get_current_user)):
    """Usado para a assinatura eletrônica de aprovação de resultados."""
    user = auth.verify_credentials(data.get("username", ""), data.get("password", ""))
    if not user:
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")
    return auth.public_user(user)


@app.get("/api/usuarios")
def list_usuarios(_: dict = Depends(require_admin)):
    return [auth.public_user(u) for u in db.list_users()]


@app.post("/api/usuarios")
def create_usuario(data: dict = Body(...), _: dict = Depends(require_admin)):
    try:
        uid = auth.create_user(data["fullName"], data["username"], data["password"], data.get("role", "tecnico"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return auth.public_user(db.get_user_by_id(uid))


@app.post("/api/usuarios/{user_id}/reset-password")
def reset_password(user_id: str, data: dict = Body(...), _: dict = Depends(require_admin)):
    if not db.get_user_by_id(user_id):
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    auth.change_password(user_id, data["password"])
    return {"success": True}


@app.delete("/api/usuarios/{user_id}")
def delete_usuario(user_id: str, _: dict = Depends(require_admin)):
    db.delete_user(user_id)
    return {"success": True}


# ==================================================================
# Equipamentos
# ==================================================================
@app.get("/api/equipamentos")
def list_equipamentos(_: dict = Depends(get_current_user)):
    return db.list_equipments()


@app.post("/api/equipamentos")
def create_equipamento(data: dict = Body(...), _: dict = Depends(require_admin)):
    eid = db.create_equipment(data)
    return next(e for e in db.list_equipments() if e["id"] == eid)


@app.put("/api/equipamentos/{eid}")
def update_equipamento(eid: str, data: dict = Body(...), _: dict = Depends(require_admin)):
    db.update_equipment(eid, data)
    return {"success": True}


@app.delete("/api/equipamentos/{eid}")
def delete_equipamento(eid: str, _: dict = Depends(require_admin)):
    db.delete_equipment(eid)
    return {"success": True}


# ==================================================================
# Rotinas
# ==================================================================
@app.get("/api/rotinas")
def list_rotinas(equipment_id: Optional[str] = Query(None), _: dict = Depends(get_current_user)):
    return db.list_routines(equipment_id)


@app.post("/api/rotinas")
def create_rotina(data: dict = Body(...), _: dict = Depends(require_admin)):
    rid = db.create_routine(data)
    return db.get_routine(rid)


@app.put("/api/rotinas/{rid}")
def update_rotina(rid: str, data: dict = Body(...), _: dict = Depends(require_admin)):
    if not db.get_routine(rid):
        raise HTTPException(status_code=404, detail="Rotina não encontrada.")
    db.update_routine(rid, data)
    return db.get_routine(rid)


@app.delete("/api/rotinas/{rid}")
def delete_rotina(rid: str, _: dict = Depends(require_admin)):
    db.delete_routine(rid)
    return {"success": True}


# ==================================================================
# Resultados
# ==================================================================
@app.get("/api/resultados")
def list_resultados(routine_id: Optional[str] = Query(None), _: dict = Depends(get_current_user)):
    return db.list_results(routine_id)


@app.post("/api/resultados")
def create_resultado(data: dict = Body(...), _: dict = Depends(get_current_user)):
    rid = db.create_result(data)
    return db.get_result(rid)


@app.post("/api/resultados/{result_id}/approve")
def approve_resultado(result_id: str, data: dict = Body(...), _: dict = Depends(get_current_user)):
    if not db.get_result(result_id):
        raise HTTPException(status_code=404, detail="Resultado não encontrado.")
    signer = auth.verify_credentials(data.get("username", ""), data.get("password", ""))
    if not signer:
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos para assinatura de aprovação.")
    if signer.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Somente um administrador pode aprovar resultados.")
    approval = {
        "userId": signer["id"],
        "username": signer["username"],
        "fullName": signer["fullName"],
        "approvedAt": db.now_iso(),
    }
    db.set_result_approval(result_id, approval)
    return db.get_result(result_id)


@app.delete("/api/resultados/{result_id}")
def delete_resultado(result_id: str, user: dict = Depends(get_current_user)):
    result = db.get_result(result_id)
    if not result:
        raise HTTPException(status_code=404, detail="Resultado não encontrado.")
    if user.get("role") != "admin" and result.get("approval") is not None:
        raise HTTPException(
            status_code=403,
            detail="Técnicos só podem excluir resultados que ainda não foram aprovados.",
        )
    db.delete_result(result_id)
    return {"success": True}


# ==================================================================
# Pastas observadas (análise automática)
# ==================================================================
@app.get("/api/watch-folders")
def list_watch_folders(routine_id: Optional[str] = Query(None), _: dict = Depends(require_admin)):
    folders = db.list_watch_folders()
    if routine_id:
        folders = [f for f in folders if f["routineId"] == routine_id]
    return folders


@app.post("/api/watch-folders")
def create_watch_folder(data: dict = Body(...), _: dict = Depends(require_admin)):
    routine = db.get_routine(data["routineId"])
    if not routine:
        raise HTTPException(status_code=404, detail="Rotina não encontrada.")
    if not routine.get("moduleId") or routine.get("testType") != "pylinac":
        raise HTTPException(status_code=400, detail="Só é possível observar uma pasta para rotinas vinculadas a um módulo pylinac.")
    wid = db.create_watch_folder(data["routineId"], data["folderPath"])
    return next(f for f in db.list_watch_folders() if f["id"] == wid)


@app.put("/api/watch-folders/{wid}")
def update_watch_folder(wid: str, data: dict = Body(...), _: dict = Depends(require_admin)):
    db.set_watch_folder_active(wid, data.get("active", True))
    return {"success": True}


@app.delete("/api/watch-folders/{wid}")
def delete_watch_folder(wid: str, _: dict = Depends(require_admin)):
    db.delete_watch_folder(wid)
    return {"success": True}


# ==================================================================
# Backup / restauração
# ==================================================================
@app.get("/api/backup/export")
def backup_export(_: dict = Depends(require_admin)):
    return {
        "version": 2,
        "users": db.list_users(),
        "equipments": db.list_equipments(),
        "routines": db.list_routines(),
        "results": db.list_results(),
        "watchFolders": db.list_watch_folders(),
    }


@app.post("/api/backup/import")
def backup_import(data: dict = Body(...), _: dict = Depends(require_admin)):
    try:
        db.import_backup(data)
    except KeyError as e:
        raise HTTPException(status_code=400, detail=f"Arquivo de backup inválido ou incompleto (faltando campo {e}).")
    except Exception as e:
        logger.error("Falha ao importar backup: %s", traceback.format_exc())
        raise HTTPException(
            status_code=422,
            detail=f"Falha ao importar backup ({e}). Nenhum dado foi alterado — a importação é tudo-ou-nada.",
        )
    return {"success": True}


@app.get("/api/settings/auto-backup")
def get_auto_backup_setting(_: dict = Depends(require_admin)):
    backup_dir = db.get_auto_backup_dir()
    target = os.path.join(backup_dir, db.AUTO_BACKUP_FILENAME) if backup_dir else None
    return {
        "autoBackupDir": backup_dir,
        "fileExists": bool(target and os.path.isfile(target)),
        "filePath": target,
    }


@app.post("/api/settings/auto-backup")
def set_auto_backup_setting(data: dict = Body(...), _: dict = Depends(require_admin)):
    path = (data.get("autoBackupDir") or "").strip() or None
    db.set_auto_backup_dir(path)
    if path:
        db.write_auto_backup_now()
    return get_auto_backup_setting(_)


@app.post("/api/settings/auto-backup/run-now")
def run_auto_backup_now(_: dict = Depends(require_admin)):
    if not db.get_auto_backup_dir():
        raise HTTPException(status_code=400, detail="Nenhuma pasta de backup automático configurada.")
    db.write_auto_backup_now()
    return get_auto_backup_setting(_)


# ==================================================================
# Análise manual (upload pelo navegador)
# ==================================================================
@app.post("/api/analyze")
async def analyze(
    module_id: str = Form(...),
    params: str = Form("{}"),
    files: List[UploadFile] = File(...),
    x_api_key: Optional[str] = Header(None),
    _: dict = Depends(get_current_user),
):
    check_api_key(x_api_key)

    try:
        params_dict = json.loads(params) if params else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Campo 'params' não é um JSON válido.")

    tmp_dir = tempfile.mkdtemp(prefix="rtqc_")
    try:
        saved_paths = []
        for f in files:
            dest = Path(tmp_dir) / f.filename
            with open(dest, "wb") as out:
                shutil.copyfileobj(f.file, out)
            saved_paths.append(dest)

        result = run_analysis(module_id, params_dict, saved_paths, tmp_dir)
        return JSONResponse({"success": True, "module_id": module_id, **result})

    except AnalysisError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
