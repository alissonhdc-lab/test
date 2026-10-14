"""
dosimetry_import.py — Importa as planilhas de dosimetria mensal TRS-398
("DOSIMETRIA_FOTONS_*.xlsm" e "DOSIMETRIA_ELETRONS_*.xls") para dentro do app.

O que é lido de cada planilha (mesmo modelo nas duas):
- Feixes: catálogo de feixes (campo, UM, Zref, PDP, rendimento esperado,
  índice e valor da qualidade do feixe).
- ConjuntosDosimetricos: câmara + eletrômetro, certificado, tensão, ND,w.
- kq: coeficientes do polinômio (fótons, por câmara) e kQ tabelado
  (elétrons, por câmara × feixe).
- ks e kpol: Ks/Kpol de referência por feixe × conjunto.
- Dosimetria A–F: feixes ativos (e as leituras da última sessão).
- Abas por acelerador (Synergy, TrueBeam, ...): o histórico gravado pela
  macro GravarResultado — data, P, T, fantoma, conjunto, Fcal, dif(%),
  qualidade do feixe, dif(%), Ks, Kpol.

Cada planilha é a fonte "oficial" do seu tipo de feixe (a de fótons para os
feixes X, a de elétrons para os feixes E): as duas carregam cópias das
mesmas abas de referência, e a cópia do outro tipo costuma estar desatualizada.

parse_workbooks() só lê; apply_import() grava no banco (Ativos, rotinas,
resultados), sem duplicar nada que já exista — dá para reimportar.
"""

import re
from datetime import date, datetime
from pathlib import Path

DOSIMETRY_TABS = [f"Dosimetria {t}" for t in "ABCDEF"]
READING_COLS = range(15, 29)  # O..AB: até 6 réplicas por linha de leitura
HISTORY_FIELDS = ["fcal", "fcal_dev", "quality", "quality_dev", "ks", "kpol"]


class ImportError_(Exception):
    pass


# ------------------------------------------------------------------
# Leitura de células (.xlsm/.xlsx via openpyxl, .xls via xlrd)
# ------------------------------------------------------------------
class Book:
    def __init__(self, path):
        self.path = Path(path)
        self.name = self.path.name
        suffix = self.path.suffix.lower()
        if suffix == ".xls":
            import xlrd

            self._xl = xlrd.open_workbook(str(path))
            self._kind = "xls"
            self.sheet_names = self._xl.sheet_names()
        elif suffix in (".xlsx", ".xlsm"):
            import warnings

            import openpyxl

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                self._xl = openpyxl.load_workbook(str(path), data_only=True, read_only=False)
            self._kind = "xlsx"
            self.sheet_names = self._xl.sheetnames
        else:
            raise ImportError_(f"Formato não suportado: {self.path.name} (use .xls, .xlsx ou .xlsm)")

    def has(self, sheet):
        return sheet in self.sheet_names

    def dims(self, sheet):
        if self._kind == "xls":
            sh = self._xl.sheet_by_name(sheet)
            return sh.nrows, sh.ncols
        ws = self._xl[sheet]
        return ws.max_row, ws.max_column

    def get(self, sheet, row, col):
        """Valor normalizado (linha/coluna a partir de 1): números como float,
        datas como date, erros do Excel (#N/A, #DIV/0!...) e vazios como None."""
        if self._kind == "xls":
            import xlrd

            sh = self._xl.sheet_by_name(sheet)
            if row > sh.nrows or col > sh.ncols:
                return None
            cell = sh.cell(row - 1, col - 1)
            if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK, xlrd.XL_CELL_ERROR):
                return None
            if cell.ctype == xlrd.XL_CELL_DATE:
                return xlrd.xldate_as_datetime(cell.value, self._xl.datemode).date()
            if cell.ctype == xlrd.XL_CELL_BOOLEAN:
                return bool(cell.value)
            if cell.ctype == xlrd.XL_CELL_NUMBER:
                return float(cell.value)
            return _clean_str(cell.value)
        v = self._xl[sheet].cell(row, col).value
        if v is None:
            return None
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, date):
            return v
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)):
            return float(v)
        return _clean_str(v)

    def ref(self, sheet, a1):
        m = re.match(r"([A-Z]+)(\d+)$", a1)
        return self.get(sheet, int(m.group(2)), _col(m.group(1)))


def _clean_str(v):
    s = str(v).strip()
    if not s or s.startswith("#"):
        return None
    return s


def _col(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", "."))
        except ValueError:
            return None
    return None


def _serial(v):
    """Números de série vêm como "7212", 7212 ou 7212.0 conforme a planilha."""
    if v is None:
        return None
    n = _num(v)
    if n is not None and n == int(n):
        return str(int(n))
    return str(v).strip()


def _beam_type(energy):
    e = (energy or "").strip().upper()
    if e.startswith("X"):
        return "fotons"
    if e.startswith("E"):
        return "eletrons"
    return None


def _beam_type_of_id(beam_id):
    """"SynergyX6" -> fotons, "TrueBeamE6HDTS" -> eletrons."""
    m = re.search(r"([XE])\d+[A-Z]*$", beam_id or "")
    return _beam_type(m.group(1)) if m else None


def _chamber_key(model, serial):
    """Mesma câmara aparece como "TW30013" numa planilha e "TN30013" na
    outra: identifica pelo número do modelo (5 dígitos) + série."""
    m = re.search(r"(\d{5})", model or "")
    return f"{m.group(1) if m else (model or '').strip().upper()}#{serial}"


def _electrometer_parts(name):
    name = (name or "").strip()
    m = re.match(r"(.*?)\s*(\S+)$", name)
    if not m or not m.group(1):
        return name, None
    return m.group(1).strip(), m.group(2)


# ------------------------------------------------------------------
# Leitura das abas
# ------------------------------------------------------------------
def _workbook_kind(book):
    kinds = [_beam_type(book.ref(tab, "H10")) for tab in DOSIMETRY_TABS if book.has(tab)]
    kinds = [k for k in kinds if k]
    if not kinds:
        return None
    return max(set(kinds), key=kinds.count)


def _read_beams(book):
    sheet = "Feixes"
    if not book.has(sheet):
        return {}
    rows, cols = book.dims(sheet)
    header_row = None
    for r in range(1, min(rows, 30) + 1):
        if any(book.get(sheet, r, c) == "Energia" for c in range(1, cols + 1)):
            header_row = r
            break
    if header_row is None:
        return {}
    col = {}
    for c in range(1, cols + 1):
        h = book.get(sheet, header_row, c) or ""
        for key, prefix in [
            ("machine", "Acelerador Linear"),
            ("energy", "Energia"),
            ("beam_id", "ID"),
            ("field", "Cpo Refer"),
            ("um", "UM"),
            ("zref", "Prof. Refer"),
            ("pdp", "PDP"),
            ("rendimento", "(cGy/UM)"),
            ("quality_index", "Indice"),
            ("quality_value", "Valor"),
        ]:
            if h.startswith(prefix) and key not in col:
                col[key] = c
    beams = {}
    for r in range(header_row + 1, rows + 1):
        machine = book.get(sheet, r, col.get("machine", 3))
        energy = book.get(sheet, r, col.get("energy", 4))
        if not machine or not energy:
            continue
        beam_id = book.get(sheet, r, col.get("beam_id", 5)) or f"{machine}{energy}"
        beams[beam_id] = {
            "beamId": beam_id,
            "machine": machine,
            "energy": energy,
            "beamType": _beam_type(energy),
            "number": _num(book.get(sheet, r, 2)),
            "referenceField": book.get(sheet, r, col.get("field", 6)),
            "um": _num(book.get(sheet, r, col.get("um", 7))),
            "zrefCm": _num(book.get(sheet, r, col.get("zref", 8))),
            "pdp": _num(book.get(sheet, r, col.get("pdp", 9))),
            "rendimento": _num(book.get(sheet, r, col.get("rendimento", 10))),
            "qualityIndex": book.get(sheet, r, col.get("quality_index", 11)),
            "qualityValue": _num(book.get(sheet, r, col.get("quality_value", 12))),
        }
    return beams


def _read_sets(book):
    sheet = "ConjuntosDosimetricos"
    if not book.has(sheet):
        return {}
    rows, _ = book.dims(sheet)
    sets = {}
    for r in range(5, rows + 1):
        numref = _num(book.get(sheet, r, 1))
        model = book.get(sheet, r, 2)
        if numref is None or not model:
            continue
        serial = _serial(book.get(sheet, r, 3))
        electrometer = book.get(sheet, r, 5)
        name = book.get(sheet, r, 13) or f"{model}-{serial} e {electrometer}"
        d = book.get(sheet, r, 11)
        sets[int(numref)] = {
            "numref": int(numref),
            "name": name,
            "chamberModel": model,
            "chamberSerial": serial,
            "chamberType": book.get(sheet, r, 4),
            "chamberKey": _chamber_key(model, serial),
            "electrometer": electrometer,
            "certificate": book.get(sheet, r, 6),
            "voltage": _num(book.get(sheet, r, 7)),
            "ndw": _num(book.get(sheet, r, 8)),
            "ndwUncertaintyPct": _num(book.get(sheet, r, 9)),
            "updatedBy": book.get(sheet, r, 10),
            "date": d.isoformat() if isinstance(d, date) else None,
            "notes": book.get(sheet, r, 12),
            "source": book.name,
        }
    return sets


def _read_kq(book):
    """Coeficientes a,b,c,d por conjunto (A=NumRef, C..F) e kQ tabelado
    por conjunto (coluna I) × feixe (IDs na linha 13, a partir da coluna K)."""
    sheet = "kq"
    coefficients, table = {}, {}
    if not book.has(sheet):
        return coefficients, table
    rows, cols = book.dims(sheet)
    for r in range(14, rows + 1):
        numref = _num(book.get(sheet, r, 1))
        a, b, c, d = (_num(book.get(sheet, r, k)) for k in range(3, 7))
        if numref is not None and None not in (a, b, c, d):
            coefficients[int(numref)] = (a, b, c, d)
        set_ref = _num(book.get(sheet, r, 9))
        if set_ref is None:
            continue
        for c_ in range(11, cols + 1):
            beam_id = book.get(sheet, 13, c_)
            kq = _num(book.get(sheet, r, c_))
            if beam_id and kq is not None:
                table[(int(set_ref), beam_id)] = kq
    return coefficients, table


def _read_ks_kpol(book):
    """Ks (colunas C..Q) e Kpol (V..AJ) por feixe (linhas a partir da 15,
    ID na coluna B) × conjunto (NumRef na linha 13)."""
    sheet = "ks e kpol"
    out = {}
    if not book.has(sheet):
        return out
    rows, _ = book.dims(sheet)
    for field, first, last, id_col in [("ks", 3, 17, 2), ("kpol", 22, 36, 21)]:
        for r in range(15, rows + 1):
            beam_id = book.get(sheet, r, id_col)
            if not beam_id:
                continue
            for c in range(first, last + 1):
                set_ref = _num(book.get(sheet, 13, c))
                v = _num(book.get(sheet, r, c))
                if set_ref is not None and v:
                    out.setdefault((beam_id, int(set_ref)), {})[field] = v
    return out


def _readings(book, sheet, row, cols=READING_COLS):
    vals = [_num(book.get(sheet, row, c)) for c in cols]
    return [v for v in vals if v is not None]


def _read_active_tabs(book):
    tabs = []
    for tab in DOSIMETRY_TABS:
        if not book.has(tab):
            continue
        machine, energy = book.ref(tab, "H8"), book.ref(tab, "H10")
        if not machine or not energy:
            continue
        d = book.ref(tab, "AE5")
        tabs.append(
            {
                "tab": tab,
                "machine": machine,
                "energy": energy,
                "beamId": f"{machine}{energy}",
                "setName": book.ref(tab, "K14"),
                "date": d.isoformat() if isinstance(d, date) else None,
                "pressure": _num(book.ref(tab, "F19")),
                "temperature": _num(book.ref(tab, "F20")),
                "m1": _readings(book, tab, 26),
                "mPlus": _readings(book, tab, 27),
                "m2": _readings(book, tab, 28),
                "d20": _readings(book, tab, 29),
                "adjusted": book.ref(tab, "AG54") == "Sim",
                "postAdjustment": _readings(book, tab, 59, range(11, 28)),
                "source": book.name,
            }
        )
    return tabs


def _read_history(book):
    """Abas de histórico: linha 2 com o ID do feixe no início de cada bloco
    de 6 colunas (Fcal, Dif Fcal, qualidade, Dif qualidade, Ks, Kpol) e
    linha 3 com "Data" na coluna A."""
    entries = []
    for sheet in book.sheet_names:
        if book.get(sheet, 3, 1) != "Data" or book.get(sheet, 3, 5) is None:
            continue
        rows, cols = book.dims(sheet)
        blocks = []
        for c in range(6, cols + 1):
            beam_id = book.get(sheet, 2, c)
            if beam_id and (book.get(sheet, 3, c) or "").startswith("Fcal"):
                blocks.append((beam_id, c))
        for r in range(4, rows + 1):
            d = book.get(sheet, r, 1)
            if not isinstance(d, date):
                continue
            for beam_id, c in blocks:
                values = {f: _num(book.get(sheet, r, c + i)) for i, f in enumerate(HISTORY_FIELDS)}
                if values["fcal"] is None:
                    continue
                entries.append(
                    {
                        "machine": sheet,
                        "beamId": beam_id,
                        "energy": beam_id[len(sheet):] if beam_id.startswith(sheet) else beam_id,
                        "date": d.isoformat(),
                        "pressure": _num(book.get(sheet, r, 2)),
                        "temperature": _num(book.get(sheet, r, 3)),
                        "phantom": book.get(sheet, r, 4),
                        "setName": book.get(sheet, r, 5),
                        "source": f"{book.name} › {sheet}, linha {r}",
                        **values,
                    }
                )
    return entries


# ------------------------------------------------------------------
# Junta as planilhas
# ------------------------------------------------------------------
def parse_workbooks(paths):
    books = [Book(p) for p in paths]
    data = {
        "beams": {},
        "sets": {},  # chamberKey+electrometer -> lista de registros (um por planilha/certificado)
        "kqCoefficientsBySet": {},  # nome do conjunto -> (a,b,c,d)
        "kqTableBySet": {},  # (nome do conjunto, beamId) -> kQ
        "ksKpolBySet": {},  # (beamId, nome do conjunto) -> {ks, kpol}
        "activeTabs": [],
        "history": [],
        "warnings": [],
        "files": [],
    }
    seen_history = set()
    for book in books:
        kind = _workbook_kind(book)
        data["files"].append({"name": book.name, "kind": kind})
        beams = _read_beams(book)
        for beam_id, beam in beams.items():
            # A planilha do mesmo tipo do feixe é a fonte oficial.
            current = data["beams"].get(beam_id)
            if current is None or (beam["beamType"] == kind and current.get("_kind") != kind):
                data["beams"][beam_id] = {**beam, "_kind": kind}
        sets = _read_sets(book)
        for s in sets.values():
            data["sets"].setdefault(s["name"], []).append(s)
        coefficients, kq_table = _read_kq(book)
        for numref, coef in coefficients.items():
            s = sets.get(numref)
            if s and (kind == "fotons" or s["name"] not in data["kqCoefficientsBySet"]):
                data["kqCoefficientsBySet"][s["name"]] = coef
        for (set_ref, beam_id), kq in kq_table.items():
            s = sets.get(set_ref)
            if s and (kind == "eletrons" or (s["name"], beam_id) not in data["kqTableBySet"]):
                data["kqTableBySet"][(s["name"], beam_id)] = kq
        for (beam_id, set_ref), vals in _read_ks_kpol(book).items():
            s = sets.get(set_ref)
            if not s:
                continue
            key = (beam_id, s["name"])
            if key not in data["ksKpolBySet"] or _beam_type_of_id(beam_id) == kind:
                data["ksKpolBySet"][key] = vals
        data["activeTabs"].extend(_read_active_tabs(book))
        for entry in _read_history(book):
            key = (entry["machine"], entry["beamId"], entry["date"], round(entry["fcal"], 9))
            if key in seen_history:
                continue
            seen_history.add(key)
            data["history"].append(entry)
    return data


def summarize(data):
    """Resumo para a tela de pré-visualização: por acelerador, os feixes com
    histórico e/ou aba ativa, e os conjuntos dosimétricos encontrados."""
    machines = {}
    active = {t["beamId"]: t for t in data["activeTabs"]}
    for entry in data["history"]:
        m = machines.setdefault(entry["machine"], {})
        b = m.setdefault(entry["beamId"], {"beamId": entry["beamId"], "energy": entry["energy"], "dates": []})
        b["dates"].append(entry["date"])
    for t in data["activeTabs"]:
        m = machines.setdefault(t["machine"], {})
        m.setdefault(t["beamId"], {"beamId": t["beamId"], "energy": t["energy"], "dates": []})
    out = []
    for machine, beams in machines.items():
        rows = []
        for beam_id, b in beams.items():
            ref = data["beams"].get(beam_id) or {}
            rows.append(
                {
                    "beamId": beam_id,
                    "energy": b["energy"],
                    "beamType": ref.get("beamType") or _beam_type(b["energy"]),
                    "active": beam_id in active,
                    "setName": (active.get(beam_id) or {}).get("setName"),
                    "historyCount": len(b["dates"]),
                    "firstDate": min(b["dates"]) if b["dates"] else None,
                    "lastDate": max(b["dates"]) if b["dates"] else None,
                    "hasReference": bool(ref),
                }
            )
        rows.sort(key=lambda r: (not r["active"], r["beamType"] or "", r["energy"]))
        out.append({"name": machine, "beams": rows})
    out.sort(key=lambda m: (not any(b["active"] for b in m["beams"]), m["name"]))
    sets = []
    for name, records in data["sets"].items():
        latest = max(records, key=lambda s: s["date"] or "")
        sets.append(
            {
                "name": name,
                "chamber": f"{latest['chamberModel']} #{latest['chamberSerial']}",
                "electrometer": latest["electrometer"],
                "ndw": latest["ndw"],
                "certificate": latest["certificate"],
                "date": latest["date"],
            }
        )
    return {"files": data["files"], "machines": out, "sets": sets, "warnings": data["warnings"]}


# ------------------------------------------------------------------
# Gravação no banco
# ------------------------------------------------------------------
_PTW_MODEL = re.compile(r"^(TN|TW|PinPoint|Roos|Unidos)", re.IGNORECASE)


def _close(a, b, tol=1e-9):
    return a is not None and b is not None and abs(a - b) <= tol * max(1.0, abs(a), abs(b))


def _find_or_create_chamber(db, records, stats):
    latest = max(records, key=lambda s: s["date"] or "")
    serial, key = latest["chamberSerial"], latest["chamberKey"]
    for a in db.list_assets("ionization_chamber"):
        if a.get("serialNumber") == serial and _chamber_key(a.get("model") or a.get("name"), serial) == key:
            return a["id"]
    aid = db.create_asset(
        {
            "type": "ionization_chamber",
            "name": f"{latest['chamberModel']} #{serial}",
            "manufacturer": "PTW" if _PTW_MODEL.match(latest["chamberModel"] or "") else None,
            "model": latest["chamberModel"],
            "serialNumber": serial,
            "notes": f"Tipo: {latest['chamberType'] or '—'}. Cadastrada a partir da planilha de dosimetria ({latest['source']}).",
        }
    )
    stats["assetsCreated"] += 1
    return aid


def _find_or_create_electrometer(db, name, source, stats):
    if not name:
        return None
    model, serial = _electrometer_parts(name)
    for a in db.list_assets("electrometer"):
        if (serial and a.get("serialNumber") == serial) or a.get("name") == name:
            return a["id"]
    aid = db.create_asset(
        {
            "type": "electrometer",
            "name": name,
            "manufacturer": "PTW" if _PTW_MODEL.match(model or "") else None,
            "model": model,
            "serialNumber": serial,
            "notes": f"Cadastrado a partir da planilha de dosimetria ({source}).",
        }
    )
    stats["assetsCreated"] += 1
    return aid


def _add_measurement_once(db, asset_id, entry, stats):
    """Não duplica: mesma câmara + mesmo feixe + mesmos valores já
    cadastrados (ex.: reimportar a planilha) não geram outra linha."""
    for m in db.list_asset_measurements(asset_id):
        same_ndw = entry.get("ndw") is None or (_close(m.get("ndw"), entry["ndw"]) and m.get("measuredAt") == entry["measuredAt"])
        same_ks = entry.get("ks") is None or _close(m.get("ks"), entry["ks"])
        same_kpol = entry.get("kpol") is None or _close(m.get("kpol"), entry["kpol"])
        if (m.get("beamLabel") or None) == (entry.get("beamLabel") or None) and same_ndw and same_ks and same_kpol:
            return False
    db.create_asset_measurement(asset_id, entry)
    stats["measurementsCreated"] += 1
    return True


def _routine_params(data, beam_id, set_name, chamber_id, electrometer_id, warnings):
    ref = data["beams"].get(beam_id) or {}
    energy = ref.get("energy") or beam_id
    beam_type = ref.get("beamType") or _beam_type_of_id(beam_id)
    params = {
        "beam_type": beam_type,
        "beam_id": beam_id,
        "reference_field": ref.get("referenceField") or "10x10",
        "ssd_cm": 100,
        "zref_cm": ref.get("zrefCm"),
        "um_nominal": ref.get("um"),
        "pdp_reference": ref.get("pdp"),
        "expected_calibration_factor": ref.get("rendimento") or 1,
        "expected_beam_quality": ref.get("qualityValue"),
        "chamber_asset_id": chamber_id,
        "electrometer_asset_id": electrometer_id,
    }
    if not ref:
        warnings.append(f"{beam_id}: não está na aba Feixes — PDP, Zref, UM e rendimento ficaram em branco na rotina.")
    if beam_type == "fotons":
        coef = data["kqCoefficientsBySet"].get(set_name)
        if coef:
            params.update(kq_a=coef[0], kq_b=coef[1], kq_c=coef[2], kq_d=coef[3])
        if energy.upper() == "X2":
            params["kq_fixed"] = 1  # a planilha força kQ = 1 para o X2
    else:
        kq = data["kqTableBySet"].get((set_name, beam_id))
        if kq is not None:
            params["kq_fixed"] = kq
        else:
            warnings.append(f"{beam_id}: sem kQ tabelado para o conjunto \"{set_name}\" — preencha na rotina.")
    if not chamber_id:
        warnings.append(f"{beam_id}: conjunto \"{set_name or '—'}\" não está em ConjuntosDosimetricos — escolha a câmara na rotina.")
    return params


def _history_values(entry, beam_type):
    values = {
        "final_calibration_factor_cgy_um": entry["fcal"],
        "final_calibration_factor_deviation_pct": entry["fcal_dev"],
        "pressure_mbar": entry["pressure"],
        "temperature_c": entry["temperature"],
    }
    if beam_type == "fotons":
        # A coluna "PDD20,10" do histórico guarda o TPR20,10 (AC34 da aba
        # de dosimetria), que é o que a planilha compara com a referência.
        values["tpr_20_10"] = entry["quality"]
        values["beam_quality_deviation_pct"] = entry["quality_dev"]
    if entry["ks"] is not None:
        values["ks"] = entry["ks"]
    if entry["kpol"] is not None:
        values["kpol"] = entry["kpol"]
    return {k: v for k, v in values.items() if v is not None}


def apply_import(db, data, equipment_id, machine, beam_ids, metrics_template, approver=None):
    """Grava no banco o que parse_workbooks() leu, para UM acelerador da
    planilha (machine) -> UM equipamento do app (equipment_id), só os
    feixes escolhidos. Devolve contagens e avisos."""
    stats = {
        "assetsCreated": 0,
        "measurementsCreated": 0,
        "routinesCreated": 0,
        "routinesReused": 0,
        "resultsCreated": 0,
        "resultsSkipped": 0,
        "warnings": list(data["warnings"]),
    }
    today = date.today().isoformat()
    beam_ids = list(dict.fromkeys(beam_ids))

    with db.deferred_auto_backup():
        # 1) Câmaras e eletrômetros (todos os conjuntos da planilha) + Ndw.
        chamber_by_set, electrometer_by_set = {}, {}
        by_chamber = {}
        for set_name, records in data["sets"].items():
            for rec in records:
                by_chamber.setdefault(rec["chamberKey"], []).append(rec)
        chamber_ids = {key: _find_or_create_chamber(db, recs, stats) for key, recs in by_chamber.items()}
        for set_name, records in data["sets"].items():
            latest = max(records, key=lambda s: s["date"] or "")
            chamber_by_set[set_name] = chamber_ids[latest["chamberKey"]]
            electrometer_by_set[set_name] = _find_or_create_electrometer(db, latest["electrometer"], latest["source"], stats)
            for rec in records:
                if rec["ndw"] is None:
                    continue
                notes = " · ".join(
                    x
                    for x in [
                        f"Certificado: {rec['certificate']}" if rec["certificate"] else None,
                        f"Conjunto: {rec['name']}",
                        f"Atualizado por: {rec['updatedBy']}" if rec["updatedBy"] else None,
                        rec["notes"],
                        f"Importado de {rec['source']}",
                    ]
                    if x
                )
                _add_measurement_once(
                    db,
                    chamber_by_set[set_name],
                    {
                        "measuredAt": rec["date"] or today,
                        "ndw": rec["ndw"],
                        "ndwUncertaintyPct": rec["ndwUncertaintyPct"],
                        "workingVoltageV": rec["voltage"],
                        "notes": notes,
                    },
                    stats,
                )

        # 2) Ks/Kpol de referência por feixe (aba "ks e kpol").
        for (beam_id, set_name), vals in data["ksKpolBySet"].items():
            if beam_id not in beam_ids or set_name not in chamber_by_set:
                continue
            _add_measurement_once(
                db,
                chamber_by_set[set_name],
                {
                    "measuredAt": today,
                    "ks": vals.get("ks"),
                    "kpol": vals.get("kpol"),
                    "beamLabel": beam_id,
                    "notes": f"Referência de Ks/Kpol importada da planilha (aba \"ks e kpol\", conjunto {set_name}).",
                },
                stats,
            )

        # 3) Rotinas (uma por feixe) e 4) histórico como resultados.
        active = {t["beamId"]: t for t in data["activeTabs"] if t["machine"] == machine}
        existing = {
            (r.get("params") or {}).get("beam_id"): r
            for r in db.list_routines(equipment_id)
            if r.get("testType") == "trs398" and (r.get("params") or {}).get("beam_id")
        }
        history = [h for h in data["history"] if h["machine"] == machine and h["beamId"] in beam_ids]
        for beam_id in beam_ids:
            entries = sorted((h for h in history if h["beamId"] == beam_id), key=lambda h: h["date"])
            tab = active.get(beam_id)
            set_name = (tab or {}).get("setName") or (entries[-1]["setName"] if entries else None)
            ref = data["beams"].get(beam_id) or {}
            beam_type = ref.get("beamType") or _beam_type_of_id(beam_id)
            energy = ref.get("energy") or (tab or {}).get("energy") or beam_id

            routine = existing.get(beam_id)
            if routine:
                stats["routinesReused"] += 1
                routine_id = routine["id"]
            else:
                params = _routine_params(
                    data, beam_id, set_name, chamber_by_set.get(set_name), electrometer_by_set.get(set_name), stats["warnings"]
                )
                routine_id = db.create_routine(
                    {
                        "equipmentId": equipment_id,
                        "name": f"Dosimetria Mensal TRS-398 — {energy}",
                        "frequency": "mensal",
                        "testType": "trs398",
                        "params": params,
                        "metrics": metrics_template,
                        "notes": "Configurada a partir da planilha de dosimetria (abas Feixes, ConjuntosDosimetricos e kq).",
                        "active": tab is not None,
                    }
                )
                stats["routinesCreated"] += 1

            seen = {(r["date"], round(float((r.get("values") or {}).get("final_calibration_factor_cgy_um") or 0), 9)) for r in db.list_results(routine_id)}
            last = entries[-1] if entries else None
            for entry in entries:
                key = (entry["date"], round(entry["fcal"], 9))
                if key in seen:
                    stats["resultsSkipped"] += 1
                    continue
                seen.add(key)
                values = _history_values(entry, beam_type)
                raw = {**values, "imported": True, "source": entry["source"], "phantom": entry["phantom"], "set_name": entry["setName"]}
                # A sessão que ainda está na aba de dosimetria é a última do
                # histórico: guarda junto as leituras originais dela.
                if entry is last and tab and _close(tab["pressure"], entry["pressure"]) and _close(tab["temperature"], entry["temperature"]):
                    raw.update(
                        m1_readings=tab["m1"],
                        m_plus_readings=tab["mPlus"],
                        m2_readings=tab["m2"],
                        d20_readings=tab["d20"],
                        adjustment_made=tab["adjusted"],
                        post_adjustment_readings=tab["postAdjustment"] if tab["adjusted"] else [],
                    )
                result_id = db.create_result(
                    {
                        "routineId": routine_id,
                        "date": entry["date"],
                        "performedByName": "Planilha de dosimetria (histórico)",
                        "values": values,
                        "notes": f"Histórico importado ({entry['source']}). Fantoma: {entry['phantom'] or '—'}. Conjunto dosimétrico: {entry['setName'] or '—'}.",
                        "rawMetrics": raw,
                        "sourceFiles": [entry["source"].split(" › ")[0]],
                    }
                )
                if approver:
                    db.set_result_approval(
                        result_id,
                        {
                            "userId": approver["id"],
                            "username": approver["username"],
                            "fullName": approver["fullName"],
                            "approvedAt": db.now_iso(),
                        },
                    )
                stats["resultsCreated"] += 1
    return stats
