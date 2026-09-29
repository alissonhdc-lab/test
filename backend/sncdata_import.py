"""
sncdata_import.py — Importação do teste diário do Sun Nuclear Daily QA 3 /
Atlas (Sncdata.fdb) para dentro da plataforma de CQ.

Lê o banco Firebird ODS-10 diretamente via sncdata_reader.FDB (sem servidor
Firebird — ver esse módulo para o porquê e como). Este módulo só normaliza
os dados já decodificados: não sabe nada sobre rotinas/resultados do nosso
banco (rtqc.db) — isso fica a cargo de quem chama (main.py/snc_watcher.py),
do mesmo jeito que dosimetry_trs398.py não sabe nada sobre o resto da app.

Convenção de mapeamento (tabela DQA3_TREND):
  RESULTS_* é o valor medido bruto (ex.: dose em % do nominal, simetria em
  %). REL_DIFF_* é o desvio dessa medição contra a última calibração/
  baseline ativa do conjunto dosimétrico — e é ISSO que o Atlas compara
  contra as tolerâncias WARN (nível de ação) / LIM (tolerância) do
  template, não RESULTS_* nem ABS_DIFF_* (confirmado comparando, em vários
  registros reais, REL_DIFF_* dentro de WARN/LIM sempre que ACCEPTED='Y').

Energia: fótons preenchem RESULTS_XENERGY/REL_DIFF_XENERGY (e o template
usa ENERGY_WARN/LIM); elétrons preenchem RESULTS_EENERGY/REL_DIFF_EENERGY
(e o template usa PENERGY_WARN/LIM — "P" de "practical range", a grandeza
usada para conferir energia de elétrons). Tamanho/deslocamento de campo
(FSIZE/FSHIFT) só existem para fótons neste conjunto de templates — nos
templates de elétrons os campos correspondentes vêm sempre zerados (não
nulos) pelo Atlas, então são omitidos aqui para não aparecer um "0,0"
enganoso onde não existe medição.

Filtro por FLAGS=4: a coluna DQA3_TREND.ACCEPTED é sempre 'Y' neste banco
(não serve como sinal de aprovação/reprovação real). Em compensação,
DQA3_TREND.FLAGS diferencia a medição OFICIAL do dia (FLAGS=4 — ~99% dos
dias têm exatamente uma) de sessões extras/manuais (FLAGS=5/6, tipicamente
sequências de poucos minutos com valores fisicamente implausíveis —
provavelmente testes feitos durante ajuste/troubleshooting do acelerador,
não a medição de rotina). Só as com FLAGS=4 são importadas.
"""
from sncdata_reader import FDB

OFFICIAL_FLAGS = 4


def _is_photon(template):
    return (template.get("BEAMTYPE") or "").strip().lower() == "photon"


def list_active_templates(fdb_path, mach_key=None):
    """Lista os templates ativos (ACTIVE_TEMPLATE='Y') do banco. Se mach_key
    não for informado, restringe automaticamente à(s) máquina(s) cuja sala
    está ativa (ROOM.ACTIVE_ROOM='Y') — evita listar templates de salas ou
    equipamentos antigos que não estão mais em uso no Atlas."""
    db = FDB(fdb_path)
    rooms = {r["ROOM_KEY"]: r for r in db.rows("ROOM")}
    machines = {m["MACH_KEY"]: m for m in db.rows("DQA3_MACHINE")}
    if mach_key is None:
        active_rooms = {rk for rk, r in rooms.items() if r.get("ACTIVE_ROOM") == "Y"}
        allowed_machines = {mk for mk, m in machines.items() if m.get("ROOM_KEY") in active_rooms}
    else:
        allowed_machines = {mach_key}

    out = []
    for t in db.rows("DQA3_TEMPLATE"):
        if t.get("ACTIVE_TEMPLATE") != "Y" or t.get("MACH_KEY") not in allowed_machines:
            continue
        machine = machines.get(t.get("MACH_KEY")) or {}
        room = rooms.get(machine.get("ROOM_KEY")) or {}
        photon = _is_photon(t)
        out.append(
            {
                "setKey": t["SET_KEY"],
                "machKey": t["MACH_KEY"],
                "templateName": t.get("TREE_NAME"),
                "beamType": t.get("BEAMTYPE"),
                "beamEnergy": t.get("BEAMENERGY"),
                "machineName": machine.get("TREE_NAME"),
                "roomName": room.get("TREE_NAME"),
                "isPhoton": photon,
                "tolerances": {
                    "dose": {"warn": t.get("CADOSE_WARN"), "lim": t.get("CADOSE_LIM")},
                    "axialSymmetry": {"warn": t.get("AXSYM_WARN"), "lim": t.get("AXSYM_LIM")},
                    "transverseSymmetry": {"warn": t.get("TRSYM_WARN"), "lim": t.get("TRSYM_LIM")},
                    "flatness": {"warn": t.get("QAFLAT_WARN"), "lim": t.get("QAFLAT_LIM")},
                    "energy": (
                        {"warn": t.get("ENERGY_WARN"), "lim": t.get("ENERGY_LIM")}
                        if photon
                        else {"warn": t.get("PENERGY_WARN"), "lim": t.get("PENERGY_LIM")}
                    ),
                    "fieldSize": {"warn": t.get("FSIZE_WARN"), "lim": t.get("FSIZE_LIM")},
                    "fieldShift": {"warn": t.get("FSHIFT_WARN"), "lim": t.get("FSHIFT_LIM")},
                },
            }
        )
    out.sort(key=lambda x: x["setKey"])
    return out


def read_results(fdb_path, set_key, since_data_key=None):
    """Lê os resultados do teste diário (DQA3_TREND) de um SET_KEY (modelo/
    energia do Atlas), já normalizados nas chaves de métrica da app. Quando
    since_data_key é informado, só devolve DATA_KEY maiores que ele — é
    assim que a sincronização incremental nunca reimporta o que já foi
    trazido antes (ver snc_watcher.py)."""
    db = FDB(fdb_path)
    template = next((t for t in db.rows("DQA3_TEMPLATE") if t["SET_KEY"] == set_key), None)
    if not template:
        raise ValueError(f"SET_KEY {set_key} não encontrado (ou não é mais um template válido) no banco do Atlas.")
    photon = _is_photon(template)

    out = []
    for tr in db.rows("DQA3_TREND"):
        if tr.get("SET_KEY") != set_key:
            continue
        if tr.get("FLAGS") != OFFICIAL_FLAGS:
            continue
        data_key = tr.get("DATA_KEY")
        measured = tr.get("MEASURED_DATETIME")
        if data_key is None or not measured:
            continue
        if since_data_key is not None and data_key <= since_data_key:
            continue

        metrics = {
            "dose_pct": tr.get("RESULTS_DOSE"),
            "dose_deviation_pct": tr.get("REL_DIFF_DOSE"),
            "axial_symmetry_pct": tr.get("RESULTS_AXSYM"),
            "axial_symmetry_deviation_pct": tr.get("REL_DIFF_AXSYM"),
            "transverse_symmetry_pct": tr.get("RESULTS_TRSYM"),
            "transverse_symmetry_deviation_pct": tr.get("REL_DIFF_TRSYM"),
            "flatness_pct": tr.get("RESULTS_QAFLAT"),
            "flatness_deviation_pct": tr.get("REL_DIFF_QAFLAT"),
            "energy_deviation_pct": tr.get("REL_DIFF_XENERGY") if photon else tr.get("REL_DIFF_EENERGY"),
            "accepted_by_atlas": tr.get("ACCEPTED") == "Y",
        }
        if photon:
            metrics["field_size_x_deviation_cm"] = tr.get("REL_DIFF_XSIZE")
            metrics["field_shift_x_deviation_cm"] = tr.get("REL_DIFF_XSHIFT")
            metrics["field_size_y_deviation_cm"] = tr.get("REL_DIFF_YSIZE")
            metrics["field_shift_y_deviation_cm"] = tr.get("REL_DIFF_YSHIFT")
        metrics = {k: v for k, v in metrics.items() if v is not None}

        out.append(
            {
                "dataKey": data_key,
                "setKey": set_key,
                "measuredDatetime": measured,
                "date": measured.split(" ")[0],
                "acceptedBy": tr.get("ACCEPTED_BY"),
                "signature": tr.get("SIGNATURE"),
                "metrics": metrics,
            }
        )
    out.sort(key=lambda r: r["dataKey"])
    return out
