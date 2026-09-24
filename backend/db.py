"""
db.py — Persistência em SQLite para a plataforma de CQ em Radioterapia.

Substitui o antigo armazenamento no navegador (localStorage): agora todos os
dados (usuários, equipamentos, rotinas, resultados e pastas observadas)
ficam num arquivo local (rtqc.db), lido e escrito pelo backend. Isso permite
que o observador de pastas grave resultados automaticamente mesmo sem
nenhum navegador aberto.
"""

import json
import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = os.environ.get("RTQC_DB_PATH", os.path.join(os.path.dirname(__file__), "rtqc.db"))

# Configuração do backup automático de segurança fica num arquivo separado do
# banco (não dentro do rtqc.db) de propósito: se o próprio rtqc.db for
# perdido ou corrompido — o cenário que este mecanismo existe para cobrir —
# ainda precisamos saber onde procurar a última cópia JSON para restaurar.
CONFIG_PATH = os.environ.get("RTQC_CONFIG_PATH", os.path.join(os.path.dirname(__file__), "rtqc_config.json"))
AUTO_BACKUP_FILENAME = "rtqc_backup.json"

logger = logging.getLogger("rtqc-backend")

_lock = threading.Lock()


def _read_config():
    if not os.path.isfile(CONFIG_PATH):
        return {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        logger.exception("Falha ao ler %s", CONFIG_PATH)
        return {}


def _write_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def get_auto_backup_dir():
    return _read_config().get("autoBackupDir") or None


def set_auto_backup_dir(path):
    cfg = _read_config()
    if path:
        cfg["autoBackupDir"] = path
    else:
        cfg.pop("autoBackupDir", None)
    _write_config(cfg)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def new_id():
    return str(uuid.uuid4())


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    changed = False
    try:
        with _lock:
            yield conn
            conn.commit()
            changed = conn.total_changes > 0
    finally:
        conn.close()
    # Fica fora do "with _lock" de propósito: libera o lock antes de fazer
    # o trabalho (potencialmente mais lento) de gravar o backup automático,
    # e evita reentrância no lock (write_auto_backup_now também usa get_conn
    # para ler os dados a exportar).
    if changed:
        write_auto_backup_now()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipments (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,
    location TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    equipment_id TEXT NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    frequency TEXT NOT NULL,
    test_type TEXT NOT NULL,
    module_id TEXT,
    params_json TEXT NOT NULL DEFAULT '{}',
    metrics_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    performed_by_name TEXT,
    values_json TEXT NOT NULL DEFAULT '{}',
    pass_override INTEGER,
    notes TEXT,
    analyzed_with_pylinac INTEGER NOT NULL DEFAULT 0,
    auto_generated INTEGER NOT NULL DEFAULT 0,
    raw_metrics_json TEXT,
    source_files_json TEXT,
    approval_user_id TEXT,
    approval_username TEXT,
    approval_full_name TEXT,
    approval_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_folders (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    folder_path TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,
    location TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_certificates (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    issued_date TEXT,
    valid_until TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_measurements (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    measured_at TEXT NOT NULL,
    ndw REAL,
    ndw_uncertainty_pct REAL,
    ks REAL,
    kpol REAL,
    working_voltage_v REAL,
    beam_label TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);
"""


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)


# ------------------------------------------------------------------
# Helpers de (de)serialização
# ------------------------------------------------------------------
def _row_to_user(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "fullName": row["full_name"],
        "role": row["role"],
        "salt": row["salt"],
        "passwordHash": row["password_hash"],
        "createdAt": row["created_at"],
    }


def _row_to_equipment(row):
    return {
        "id": row["id"],
        "type": row["type"],
        "name": row["name"],
        "manufacturer": row["manufacturer"],
        "model": row["model"],
        "serialNumber": row["serial_number"],
        "location": row["location"],
        "notes": row["notes"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
    }


def _row_to_routine(row):
    return {
        "id": row["id"],
        "equipmentId": row["equipment_id"],
        "name": row["name"],
        "frequency": row["frequency"],
        "testType": row["test_type"],
        "moduleId": row["module_id"],
        "params": json.loads(row["params_json"] or "{}"),
        "metrics": json.loads(row["metrics_json"] or "[]"),
        "notes": row["notes"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
    }


def _row_to_result(row):
    approval = None
    if row["approval_user_id"]:
        approval = {
            "userId": row["approval_user_id"],
            "username": row["approval_username"],
            "fullName": row["approval_full_name"],
            "approvedAt": row["approval_at"],
        }
    return {
        "id": row["id"],
        "routineId": row["routine_id"],
        "date": row["date"],
        "performedByName": row["performed_by_name"],
        "values": json.loads(row["values_json"] or "{}"),
        "passOverride": None if row["pass_override"] is None else bool(row["pass_override"]),
        "notes": row["notes"],
        "analyzedWithPylinac": bool(row["analyzed_with_pylinac"]),
        "autoGenerated": bool(row["auto_generated"]),
        "rawMetrics": json.loads(row["raw_metrics_json"]) if row["raw_metrics_json"] else None,
        "sourceFiles": json.loads(row["source_files_json"]) if row["source_files_json"] else [],
        "approval": approval,
        "createdAt": row["created_at"],
    }


def _row_to_watch_folder(row):
    return {
        "id": row["id"],
        "routineId": row["routine_id"],
        "folderPath": row["folder_path"],
        "active": bool(row["active"]),
        "lastError": row["last_error"],
        "createdAt": row["created_at"],
    }


def _row_to_asset(row):
    return {
        "id": row["id"],
        "type": row["type"],
        "name": row["name"],
        "manufacturer": row["manufacturer"],
        "model": row["model"],
        "serialNumber": row["serial_number"],
        "location": row["location"],
        "notes": row["notes"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
    }


def _row_to_asset_certificate(row):
    return {
        "id": row["id"],
        "assetId": row["asset_id"],
        "filename": row["filename"],
        "storedName": row["stored_name"],
        "issuedDate": row["issued_date"],
        "validUntil": row["valid_until"],
        "notes": row["notes"],
        "createdAt": row["created_at"],
    }


def _row_to_asset_measurement(row):
    return {
        "id": row["id"],
        "assetId": row["asset_id"],
        "measuredAt": row["measured_at"],
        "ndw": row["ndw"],
        "ndwUncertaintyPct": row["ndw_uncertainty_pct"],
        "ks": row["ks"],
        "kpol": row["kpol"],
        "workingVoltageV": row["working_voltage_v"],
        "beamLabel": row["beam_label"],
        "notes": row["notes"],
        "createdAt": row["created_at"],
    }


# ------------------------------------------------------------------
# Usuários
# ------------------------------------------------------------------
def list_users():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()
        return [_row_to_user(r) for r in rows]


def get_user_by_username(username):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return _row_to_user(row) if row else None


def get_user_by_id(user_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _row_to_user(row) if row else None


def create_user(full_name, username, role, salt, password_hash):
    uid = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO users (id, username, full_name, role, salt, password_hash, created_at) VALUES (?,?,?,?,?,?,?)",
            (uid, username, full_name, role, salt, password_hash, now_iso()),
        )
    return uid


def update_user_password(user_id, salt, password_hash):
    with get_conn() as conn:
        conn.execute("UPDATE users SET salt = ?, password_hash = ? WHERE id = ?", (salt, password_hash, user_id))


def delete_user(user_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


# ------------------------------------------------------------------
# Sessões (tokens de autenticação por requisição)
# ------------------------------------------------------------------
def create_session(user_id):
    token = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)",
            (token, user_id, now_iso()),
        )
    return token


def get_user_by_token(token):
    if not token:
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
            (token,),
        ).fetchone()
        return _row_to_user(row) if row else None


def delete_session(token):
    with get_conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


# ------------------------------------------------------------------
# Equipamentos
# ------------------------------------------------------------------
def list_equipments():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM equipments ORDER BY created_at").fetchall()
        return [_row_to_equipment(r) for r in rows]


def create_equipment(data):
    eid = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO equipments (id,type,name,manufacturer,model,serial_number,location,notes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                eid,
                data["type"],
                data["name"],
                data.get("manufacturer"),
                data.get("model"),
                data.get("serialNumber"),
                data.get("location"),
                data.get("notes"),
                1 if data.get("active", True) else 0,
                now_iso(),
            ),
        )
    return eid


def update_equipment(eid, data):
    fields = {
        "type": data.get("type"),
        "name": data.get("name"),
        "manufacturer": data.get("manufacturer"),
        "model": data.get("model"),
        "serial_number": data.get("serialNumber"),
        "location": data.get("location"),
        "notes": data.get("notes"),
        "active": 1 if data.get("active", True) else 0,
    }
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with get_conn() as conn:
        conn.execute(f"UPDATE equipments SET {set_clause} WHERE id = ?", (*fields.values(), eid))


def delete_equipment(eid):
    with get_conn() as conn:
        conn.execute("DELETE FROM equipments WHERE id = ?", (eid,))


# ------------------------------------------------------------------
# Ativos (instrumentos de medição: câmaras de ionização, eletrômetros,
# barômetros, termômetros, termo-higrômetros, réguas, níveis)
# ------------------------------------------------------------------
def list_assets(asset_type=None):
    with get_conn() as conn:
        if asset_type:
            rows = conn.execute("SELECT * FROM assets WHERE type = ? ORDER BY created_at", (asset_type,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM assets ORDER BY created_at").fetchall()
        return [_row_to_asset(r) for r in rows]


def get_asset(aid):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id = ?", (aid,)).fetchone()
        return _row_to_asset(row) if row else None


def create_asset(data):
    aid = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO assets (id,type,name,manufacturer,model,serial_number,location,notes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                aid,
                data["type"],
                data["name"],
                data.get("manufacturer"),
                data.get("model"),
                data.get("serialNumber"),
                data.get("location"),
                data.get("notes"),
                1 if data.get("active", True) else 0,
                now_iso(),
            ),
        )
    return aid


def update_asset(aid, data):
    fields = {
        "type": data.get("type"),
        "name": data.get("name"),
        "manufacturer": data.get("manufacturer"),
        "model": data.get("model"),
        "serial_number": data.get("serialNumber"),
        "location": data.get("location"),
        "notes": data.get("notes"),
        "active": 1 if data.get("active", True) else 0,
    }
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with get_conn() as conn:
        conn.execute(f"UPDATE assets SET {set_clause} WHERE id = ?", (*fields.values(), aid))


def delete_asset(aid):
    with get_conn() as conn:
        conn.execute("DELETE FROM assets WHERE id = ?", (aid,))


def list_asset_certificates(asset_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM asset_certificates WHERE asset_id = ? ORDER BY created_at DESC", (asset_id,)
        ).fetchall()
        return [_row_to_asset_certificate(r) for r in rows]


def get_asset_certificate(cid):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM asset_certificates WHERE id = ?", (cid,)).fetchone()
        return _row_to_asset_certificate(row) if row else None


def create_asset_certificate(asset_id, filename, stored_name, issued_date, valid_until, notes):
    cid = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO asset_certificates (id,asset_id,filename,stored_name,issued_date,valid_until,notes,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (cid, asset_id, filename, stored_name, issued_date, valid_until, notes, now_iso()),
        )
    return cid


def delete_asset_certificate(cid):
    with get_conn() as conn:
        conn.execute("DELETE FROM asset_certificates WHERE id = ?", (cid,))


def list_asset_measurements(asset_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM asset_measurements WHERE asset_id = ? ORDER BY measured_at DESC, created_at DESC",
            (asset_id,),
        ).fetchall()
        return [_row_to_asset_measurement(r) for r in rows]


def get_asset_measurement(mid):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM asset_measurements WHERE id = ?", (mid,)).fetchone()
        return _row_to_asset_measurement(row) if row else None


def get_latest_asset_measurement(asset_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM asset_measurements WHERE asset_id = ? ORDER BY measured_at DESC, created_at DESC LIMIT 1",
            (asset_id,),
        ).fetchone()
        return _row_to_asset_measurement(row) if row else None


def get_latest_asset_measurement_field(asset_id, field):
    """Última medição da câmara em que aquele campo específico foi
    preenchido — usado porque Ndw (calibração externa, muda raramente) e
    Ks/Kpol (calculados a cada sessão de dosimetria, ver dosimetry_trs398.py)
    são atualizados em ritmos bem diferentes: pegar só "a linha mais
    recente" (get_latest_asset_measurement) erraria o Ndw sempre que a
    entrada mais nova for um lançamento automático de Ks/Kpol sem Ndw."""
    if field not in ("ndw", "ks", "kpol"):
        raise ValueError(f"Campo inválido: {field}")
    with get_conn() as conn:
        row = conn.execute(
            f"SELECT * FROM asset_measurements WHERE asset_id = ? AND {field} IS NOT NULL "
            "ORDER BY measured_at DESC, created_at DESC LIMIT 1",
            (asset_id,),
        ).fetchone()
        return _row_to_asset_measurement(row) if row else None


def create_asset_measurement(asset_id, data):
    mid = new_id()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO asset_measurements
            (id, asset_id, measured_at, ndw, ndw_uncertainty_pct, ks, kpol, working_voltage_v, beam_label, notes, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                mid,
                asset_id,
                data["measuredAt"],
                data.get("ndw"),
                data.get("ndwUncertaintyPct"),
                data.get("ks"),
                data.get("kpol"),
                data.get("workingVoltageV"),
                data.get("beamLabel"),
                data.get("notes"),
                now_iso(),
            ),
        )
    return mid


def delete_asset_measurement(mid):
    with get_conn() as conn:
        conn.execute("DELETE FROM asset_measurements WHERE id = ?", (mid,))


# ------------------------------------------------------------------
# Rotinas
# ------------------------------------------------------------------
def list_routines(equipment_id=None):
    with get_conn() as conn:
        if equipment_id:
            rows = conn.execute(
                "SELECT * FROM routines WHERE equipment_id = ? ORDER BY created_at", (equipment_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM routines ORDER BY created_at").fetchall()
        return [_row_to_routine(r) for r in rows]


def get_routine(rid):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM routines WHERE id = ?", (rid,)).fetchone()
        return _row_to_routine(row) if row else None


def create_routine(data):
    rid = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO routines (id,equipment_id,name,frequency,test_type,module_id,params_json,metrics_json,notes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                rid,
                data["equipmentId"],
                data["name"],
                data["frequency"],
                data["testType"],
                data.get("moduleId"),
                json.dumps(data.get("params") or {}),
                json.dumps(data.get("metrics") or []),
                data.get("notes"),
                1 if data.get("active", True) else 0,
                now_iso(),
            ),
        )
    return rid


def update_routine(rid, data):
    fields = {
        "name": data.get("name"),
        "frequency": data.get("frequency"),
        "test_type": data.get("testType"),
        "module_id": data.get("moduleId"),
        "params_json": json.dumps(data.get("params") or {}),
        "metrics_json": json.dumps(data.get("metrics") or []),
        "notes": data.get("notes"),
        "active": 1 if data.get("active", True) else 0,
    }
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with get_conn() as conn:
        conn.execute(f"UPDATE routines SET {set_clause} WHERE id = ?", (*fields.values(), rid))


def delete_routine(rid):
    with get_conn() as conn:
        conn.execute("DELETE FROM routines WHERE id = ?", (rid,))


# ------------------------------------------------------------------
# Resultados
# ------------------------------------------------------------------
def list_results(routine_id=None):
    with get_conn() as conn:
        if routine_id:
            rows = conn.execute(
                "SELECT * FROM results WHERE routine_id = ? ORDER BY date", (routine_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM results ORDER BY date").fetchall()
        return [_row_to_result(r) for r in rows]


def get_result(result_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM results WHERE id = ?", (result_id,)).fetchone()
        return _row_to_result(row) if row else None


def create_result(data):
    res_id = new_id()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO results
            (id, routine_id, date, performed_by_name, values_json, pass_override, notes,
             analyzed_with_pylinac, auto_generated, raw_metrics_json, source_files_json, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                res_id,
                data["routineId"],
                data["date"],
                data.get("performedByName"),
                json.dumps(data.get("values") or {}),
                None if data.get("passOverride") is None else (1 if data.get("passOverride") else 0),
                data.get("notes"),
                1 if data.get("analyzedWithPylinac") else 0,
                1 if data.get("autoGenerated") else 0,
                json.dumps(data["rawMetrics"]) if data.get("rawMetrics") is not None else None,
                json.dumps(data.get("sourceFiles") or []),
                now_iso(),
            ),
        )
    return res_id


def set_result_approval(result_id, approval):
    with get_conn() as conn:
        if approval is None:
            conn.execute(
                "UPDATE results SET approval_user_id=NULL, approval_username=NULL, approval_full_name=NULL, approval_at=NULL WHERE id=?",
                (result_id,),
            )
        else:
            conn.execute(
                "UPDATE results SET approval_user_id=?, approval_username=?, approval_full_name=?, approval_at=? WHERE id=?",
                (approval["userId"], approval["username"], approval["fullName"], approval["approvedAt"], result_id),
            )


def delete_result(result_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM results WHERE id = ?", (result_id,))


# ------------------------------------------------------------------
# Pastas observadas
# ------------------------------------------------------------------
def list_watch_folders(active_only=False):
    with get_conn() as conn:
        q = "SELECT * FROM watch_folders"
        if active_only:
            q += " WHERE active = 1"
        rows = conn.execute(q + " ORDER BY created_at").fetchall()
        return [_row_to_watch_folder(r) for r in rows]


def create_watch_folder(routine_id, folder_path):
    wid = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO watch_folders (id, routine_id, folder_path, active, created_at) VALUES (?,?,?,1,?)",
            (wid, routine_id, folder_path, now_iso()),
        )
    return wid


def set_watch_folder_active(wid, active):
    with get_conn() as conn:
        conn.execute("UPDATE watch_folders SET active = ? WHERE id = ?", (1 if active else 0, wid))


def set_watch_folder_error(wid, error):
    with get_conn() as conn:
        conn.execute("UPDATE watch_folders SET last_error = ? WHERE id = ?", (error, wid))


def delete_watch_folder(wid):
    with get_conn() as conn:
        conn.execute("DELETE FROM watch_folders WHERE id = ?", (wid,))


# ------------------------------------------------------------------
# Backup / restauração
# ------------------------------------------------------------------
def import_backup(data):
    """Substitui todo o conteúdo do banco pelos dados de um backup, de forma
    atômica (tudo ou nada, com rollback em caso de erro) e preservando os
    IDs originais de cada entidade — essencial para manter as referências
    entre equipamentos/rotinas/resultados intactas (usar create_* geraria
    IDs novos e quebraria essas ligações, violando as chaves estrangeiras)."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        with _lock:
            # As chaves estrangeiras ficam ATIVAS de propósito durante a
            # importação: se o arquivo referenciar uma rotina/equipamento
            # inexistente, a inserção falha e o rollback abaixo preserva os
            # dados atuais, em vez de aceitar registros órfãos.
            conn.execute("PRAGMA foreign_keys = ON")
            try:
                conn.execute("BEGIN")
                conn.execute("DELETE FROM sessions")
                conn.execute("DELETE FROM results")
                conn.execute("DELETE FROM watch_folders")
                conn.execute("DELETE FROM routines")
                conn.execute("DELETE FROM equipments")
                conn.execute("DELETE FROM asset_measurements")
                conn.execute("DELETE FROM asset_certificates")
                conn.execute("DELETE FROM assets")
                conn.execute("DELETE FROM users")

                for u in data.get("users", []):
                    conn.execute(
                        "INSERT INTO users (id, username, full_name, role, salt, password_hash, created_at) VALUES (?,?,?,?,?,?,?)",
                        (
                            u.get("id") or new_id(),
                            u["username"],
                            u["fullName"],
                            u.get("role", "tecnico"),
                            u["salt"],
                            u["passwordHash"],
                            u.get("createdAt") or now_iso(),
                        ),
                    )
                for e in data.get("equipments", []):
                    conn.execute(
                        "INSERT INTO equipments (id,type,name,manufacturer,model,serial_number,location,notes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            e.get("id") or new_id(),
                            e["type"],
                            e["name"],
                            e.get("manufacturer"),
                            e.get("model"),
                            e.get("serialNumber"),
                            e.get("location"),
                            e.get("notes"),
                            1 if e.get("active", True) else 0,
                            e.get("createdAt") or now_iso(),
                        ),
                    )
                for r in data.get("routines", []):
                    conn.execute(
                        "INSERT INTO routines (id,equipment_id,name,frequency,test_type,module_id,params_json,metrics_json,notes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            r.get("id") or new_id(),
                            r["equipmentId"],
                            r["name"],
                            r["frequency"],
                            r["testType"],
                            r.get("moduleId"),
                            json.dumps(r.get("params") or {}),
                            json.dumps(r.get("metrics") or []),
                            r.get("notes"),
                            1 if r.get("active", True) else 0,
                            r.get("createdAt") or now_iso(),
                        ),
                    )
                for res in data.get("results", []):
                    approval = res.get("approval") or {}
                    conn.execute(
                        """INSERT INTO results
                        (id, routine_id, date, performed_by_name, values_json, pass_override, notes,
                         analyzed_with_pylinac, auto_generated, raw_metrics_json, source_files_json,
                         approval_user_id, approval_username, approval_full_name, approval_at, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            res.get("id") or new_id(),
                            res["routineId"],
                            res["date"],
                            res.get("performedByName"),
                            json.dumps(res.get("values") or {}),
                            None if res.get("passOverride") is None else (1 if res.get("passOverride") else 0),
                            res.get("notes"),
                            1 if res.get("analyzedWithPylinac") else 0,
                            1 if res.get("autoGenerated") else 0,
                            json.dumps(res["rawMetrics"]) if res.get("rawMetrics") is not None else None,
                            json.dumps(res.get("sourceFiles") or []),
                            approval.get("userId"),
                            approval.get("username"),
                            approval.get("fullName"),
                            approval.get("approvedAt"),
                            res.get("createdAt") or now_iso(),
                        ),
                    )
                for wf in data.get("watchFolders", []):
                    conn.execute(
                        "INSERT INTO watch_folders (id, routine_id, folder_path, active, last_error, created_at) VALUES (?,?,?,?,?,?)",
                        (
                            wf.get("id") or new_id(),
                            wf["routineId"],
                            wf["folderPath"],
                            1 if wf.get("active", True) else 0,
                            wf.get("lastError"),
                            wf.get("createdAt") or now_iso(),
                        ),
                    )
                for a in data.get("assets", []):
                    conn.execute(
                        "INSERT INTO assets (id,type,name,manufacturer,model,serial_number,location,notes,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            a.get("id") or new_id(),
                            a["type"],
                            a["name"],
                            a.get("manufacturer"),
                            a.get("model"),
                            a.get("serialNumber"),
                            a.get("location"),
                            a.get("notes"),
                            1 if a.get("active", True) else 0,
                            a.get("createdAt") or now_iso(),
                        ),
                    )
                # Os certificados restaurados aqui são só os METADADOS (nome,
                # validade) — o arquivo em si fica em disco (pasta uploads/),
                # fora do rtqc.db de propósito (igual aos demais arquivos da
                # plataforma). Um backup/restore completo precisa copiar essa
                # pasta separadamente; ver README.md.
                for c in data.get("assetCertificates", []):
                    conn.execute(
                        "INSERT INTO asset_certificates (id,asset_id,filename,stored_name,issued_date,valid_until,notes,created_at) VALUES (?,?,?,?,?,?,?,?)",
                        (
                            c.get("id") or new_id(),
                            c["assetId"],
                            c["filename"],
                            c["storedName"],
                            c.get("issuedDate"),
                            c.get("validUntil"),
                            c.get("notes"),
                            c.get("createdAt") or now_iso(),
                        ),
                    )
                for m in data.get("assetMeasurements", []):
                    conn.execute(
                        """INSERT INTO asset_measurements
                        (id, asset_id, measured_at, ndw, ndw_uncertainty_pct, ks, kpol, working_voltage_v, beam_label, notes, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            m.get("id") or new_id(),
                            m["assetId"],
                            m["measuredAt"],
                            m.get("ndw"),
                            m.get("ndwUncertaintyPct"),
                            m.get("ks"),
                            m.get("kpol"),
                            m.get("workingVoltageV"),
                            m.get("beamLabel"),
                            m.get("notes"),
                            m.get("createdAt") or now_iso(),
                        ),
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    finally:
        conn.close()


# ------------------------------------------------------------------
# Backup automático de segurança
# ------------------------------------------------------------------
def _export_all():
    assets = list_assets()
    return {
        "version": 3,
        "users": list_users(),
        "equipments": list_equipments(),
        "routines": list_routines(),
        "results": list_results(),
        "watchFolders": list_watch_folders(),
        "assets": assets,
        "assetCertificates": [c for a in assets for c in list_asset_certificates(a["id"])],
        "assetMeasurements": [m for a in assets for m in list_asset_measurements(a["id"])],
    }


def write_auto_backup_now():
    """Grava (de forma atômica: escreve num .tmp e renomeia por cima) uma
    cópia JSON completa e atual do banco na pasta configurada, se houver
    uma configurada. Nunca levanta exceção — uma falha aqui não pode
    derrubar a operação que a disparou."""
    backup_dir = get_auto_backup_dir()
    if not backup_dir:
        return
    try:
        os.makedirs(backup_dir, exist_ok=True)
        target = os.path.join(backup_dir, AUTO_BACKUP_FILENAME)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_export_all(), f, ensure_ascii=False, indent=2, default=str)
        os.replace(tmp, target)
    except Exception:
        logger.exception("Falha ao gravar backup automático em %s", backup_dir)


def maybe_restore_from_auto_backup():
    """Chamado na inicialização do backend. Se houver uma pasta de backup
    automático configurada e um arquivo de backup presente nela, restaura
    os dados a partir dele — mas SOMENTE quando o banco atual está vazio
    (sem usuários nem equipamentos), para nunca sobrescrever dados atuais
    válidos com uma cópia potencialmente mais antiga."""
    backup_dir = get_auto_backup_dir()
    if not backup_dir:
        return
    target = os.path.join(backup_dir, AUTO_BACKUP_FILENAME)
    if not os.path.isfile(target):
        logger.info("Backup automático configurado (%s), mas nenhum arquivo encontrado ainda.", target)
        return
    if len(list_users()) > 0 or len(list_equipments()) > 0:
        logger.info("Banco já contém dados — restauração automática do backup ignorada.")
        return
    try:
        with open(target, "r", encoding="utf-8") as f:
            data = json.load(f)
        import_backup(data)
        logger.info("Dados restaurados automaticamente a partir de %s", target)
    except Exception:
        logger.exception("Falha ao restaurar backup automático de %s", target)
