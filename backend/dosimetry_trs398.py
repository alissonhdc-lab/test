"""
dosimetry_trs398.py — Dosimetria absoluta mensal, protocolo IAEA TRS-398.

Reimplementação fiel da planilha "DOSIMETRIA_FOTONS/ELETRONS_ITC_CG" (Excel,
usada localmente pela física médica antes deste módulo existir): mesmas
fórmulas, mesma ordem de cálculo, mesmos valores de saída — só trocando
células/abas do Excel por parâmetros de rotina (configuração do feixe e do
conjunto dosimétrico, alterada raramente) e campos de resultado (o que o
físico mede a cada sessão mensal).

Diferente dos módulos pylinac (backend/analysis.py): não há imagem/DICOM
nenhum aqui — é só matemática sobre os números que o físico digita. Por
isso este módulo não usa run_analysis()/MODULES; tem seu próprio endpoint
em main.py (/api/dosimetry/calculate).

Convenção geral do cálculo (idêntica à planilha — TRS-398, seção 3.2 "Basic
physics data" e seção 7 "Determination of absorbed dose to water"):
1. Ktp: fator de correção de pressão e temperatura (TRS-398, eq. 3.2),
   SEMPRE calculado a partir de P e T lançados na sessão — nunca um valor
   fixo/de referência.
2. Fótons: PDD20,10 = D20/D10, depois TPR20,10 = 1,2661×PDD20,10 − 0,0595
   (fórmula empírica do TRS-398, eq. 3.3, para converter PDD→TPR sem medir
   TPR diretamente). Elétrons: qualidade do feixe (R50) é um valor de
   referência já determinado na comissão do feixe, não remedido todo mês.
3. kQ: fótons, polinômio de Andreo (a+b×TPR+c×TPR²+d×TPR³, coeficientes
   por modelo de câmara cilíndrica, TRS-398 tabela 14); elétrons, valor
   tabelado fixo (câmaras de placas paralelas — a planilha usa uma
   tabela, não fórmula).
4. Ks (recombinação iônica, TRS-398 eq. 3.7/3.8, método de duas tensões
   de Boag para feixe pulsado) e Kpol (polaridade, TRS-398 eq. 3.6):
   SEMPRE calculados a partir das leituras M−/M+/M(V2) desta sessão —
   nunca um valor fixo/de referência. O histórico de Ks/Kpol de cada
   câmara em Ativos serve só de comparação/tendência (ver
   `last_known_ks`/`last_known_kpol` abaixo), não entra na conta.
5. Dose absorvida na água em Zref: M1(média) × Ktp × Ks × Kpol × ND,w × kQ
   (TRS-398, eq. 7.1 — grandezas em nC/cGy/(cGy·nC⁻¹), sem unidade extra).
6. Dose absorvida em Zmax (a grandeza que o físico quer conferir, já que
   o feixe é calibrado no máximo de dose): dose em Zref dividida por
   PDP(10x10,Zref)/100. O fator de calibração (rendimento, cGy/UM) é essa
   dose em Zmax dividida pelo número nominal de UM disparadas na sessão.
7. Comparação com os valores esperados (Fcal e qualidade do feixe),
   e, se um ajuste físico foi feito no acelerador, o mesmo cálculo
   reaplicado às leituras pós-ajuste.
"""

from statistics import mean


class DosimetryError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def _avg_maxmin(values):
    """Média e dispersão (%) de um grupo de leituras replicadas — mesmo
    par AVERAGE / 100*(1-MAX/MIN) que a planilha calcula ao lado de cada
    linha de leitura, como checagem rápida de repetibilidade."""
    nums = [float(v) for v in values if v not in (None, "")]
    if not nums:
        return None, None
    avg = mean(nums)
    spread = None
    if len(nums) > 1 and min(nums) != 0:
        spread = 100 * (1 - max(nums) / min(nums))
    return avg, spread


def _ktp(pressure_mbar, temperature_c):
    return (273.15 + temperature_c) / (273.15 + 20.0) * (1013.25 / pressure_mbar)


def _pdd_20_10(d20_avg, d10_avg):
    return d20_avg / d10_avg


def _tpr_20_10_from_pdd(pdd2010):
    return 1.2661 * pdd2010 - 0.0595


def _kq_photon(tpr2010, a, b, c, d):
    return a + b * tpr2010 + c * tpr2010**2 + d * tpr2010**3


def _ks_two_voltage(m1_avg, m2_avg):
    """Fórmula de Boag (duas tensões) para feixes pulsados/contínuos de
    acelerador linear — a mesma usada na planilha (2,337 - 3,636×razão +
    2,299×razão²), não a versão para feixes contínuos de Co-60."""
    ratio = m1_avg / m2_avg
    return 2.337 - 3.636 * ratio + 2.299 * ratio**2


def _kpol(m_plus_avg, m_minus_avg):
    return (abs(m_plus_avg) + abs(m_minus_avg)) / (2 * abs(m_minus_avg))


def _dose_water_zref(m1_avg, ktp_val, ks_val, kpol_val, ndw, kq_val):
    """TRS-398, eq. 7.1: D_w,Qref = M_Qref × N_D,w,Qo × k_Q — a dose
    absorvida na água em Zref (M_Qref já é a leitura corrigida por
    Ktp/Ks/Kpol, o "M1(média) × Ktp × Ks × Kpol" de antes deste produto)."""
    return m1_avg * ktp_val * ks_val * kpol_val * ndw * kq_val


def _dose_at_zmax(dose_at_zref, pdp_percent):
    """Retropropaga a dose de Zref para Zmax usando a porcentagem de dose
    profunda (PDP) do campo de referência: dose absorvida que o físico
    realmente quer conferir contra o rendimento nominal do feixe."""
    return dose_at_zref / (pdp_percent / 100.0)


def _calibration_factor(dose_at_zmax, um_nominal):
    """Fator de calibração (rendimento) em cGy/UM: dose em Zmax dividida
    pelo número nominal de UM disparadas na sessão."""
    return dose_at_zmax / um_nominal


def calculate(params, session):
    """params: configuração do feixe/conjunto dosimétrico (routine.params).
    session: valores lançados pelo físico nesta sessão (result.values +
    campos extras enviados só para o cálculo, ex.: réplicas de leitura).
    Devolve um dict achatado, no mesmo formato que os módulos pylinac
    devolvem (pronto para virar rawMetrics/values de um resultado)."""
    beam_type = (params.get("beam_type") or "fotons").strip().lower()
    is_photon = beam_type == "fotons"

    try:
        pressure = float(session["pressure_mbar"])
        temperature = float(session["temperature_c"])
    except (KeyError, TypeError, ValueError):
        raise DosimetryError("Pressão e temperatura são obrigatórias.")

    m1_readings = session.get("m1_readings") or []
    m_plus_readings = session.get("m_plus_readings") or []
    m2_readings = session.get("m2_readings") or []
    d20_readings = session.get("d20_readings") or []

    m1_avg, m1_spread = _avg_maxmin(m1_readings)
    if m1_avg is None:
        raise DosimetryError("É preciso lançar ao menos uma leitura M1 (M-).")
    mplus_avg, mplus_spread = _avg_maxmin(m_plus_readings)
    m2_avg, m2_spread = _avg_maxmin(m2_readings)
    d20_avg, d20_spread = _avg_maxmin(d20_readings)

    flat = {
        "m1_avg_nc": m1_avg,
        "m1_spread_pct": m1_spread,
        "m_plus_avg_nc": mplus_avg,
        "m_plus_spread_pct": mplus_spread,
        "m2_avg_nc": m2_avg,
        "m2_spread_pct": m2_spread,
    }

    ktp_val = _ktp(pressure, temperature)
    flat["ktp"] = ktp_val

    # 1 - Qualidade do feixe
    pdd2010 = tpr2010 = None
    if is_photon:
        if d20_avg is None:
            raise DosimetryError("Fótons: é preciso lançar as leituras D20 (a 20cm de profundidade) para calcular PDD20,10/TPR20,10.")
        flat["d20_avg_nc"] = d20_avg
        flat["d20_spread_pct"] = d20_spread
        pdd2010 = _pdd_20_10(d20_avg, m1_avg)
        tpr2010 = _tpr_20_10_from_pdd(pdd2010)
        flat["pdd_20_10"] = pdd2010
        flat["tpr_20_10"] = tpr2010
        # A planilha original compara TPR20,10 (não PDD20,10) contra o
        # valor de referência da qualidade do feixe, apesar dos rótulos
        # dizendo "PDD20,10"/"PDP20,10" nas duas pontas (célula N54 usa
        # AC34, que é o TPR — confirmado comparando com os números reais
        # da planilha). Mantido assim de propósito, para bater com o
        # histórico já registrado pela física — ver validação numérica
        # completa no commit desta funcionalidade.
        beam_quality_measured = tpr2010
    else:
        # Elétrons: R50 é valor de referência (comissionamento), não
        # remedido na dosimetria mensal — usado só para conferência.
        beam_quality_measured = None

    # 2 - kQ
    if is_photon:
        try:
            a = float(params["kq_a"])
            b = float(params["kq_b"])
            c = float(params["kq_c"])
            d = float(params["kq_d"])
        except (KeyError, TypeError, ValueError):
            raise DosimetryError("Fótons: coeficientes kQ (a,b,c,d) precisam estar configurados na rotina.")
        kq_val = _kq_photon(tpr2010, a, b, c, d)
    else:
        try:
            kq_val = float(params["kq_fixed"])
        except (KeyError, TypeError, ValueError):
            raise DosimetryError("Elétrons: o valor de kQ (tabelado) precisa estar configurado na rotina.")
    flat["kq"] = kq_val

    # 3 - Ks (recombinação iônica, TRS-398 eq. 3.7/3.8 — duas tensões,
    # feixe pulsado) — sempre calculado a partir de M1 (tensão nominal) e
    # M2 (meia tensão) desta sessão, nunca um valor fixo.
    if m2_avg is None:
        raise DosimetryError("É preciso lançar as leituras M2 (meia tensão) para calcular Ks (recombinação iônica).")
    ks_val = _ks_two_voltage(m1_avg, m2_avg)
    flat["ks"] = ks_val

    # 4 - Kpol (polaridade, TRS-398 eq. 3.6) — sempre calculado a partir
    # de M1 (tensão nominal, polaridade normal) e M+ (polaridade
    # invertida) desta sessão, nunca um valor fixo.
    if mplus_avg is None:
        raise DosimetryError("É preciso lançar as leituras M+ (polaridade invertida) para calcular Kpol.")
    kpol_val = _kpol(mplus_avg, m1_avg)
    flat["kpol"] = kpol_val

    # Comparação informativa com a última medição conhecida da câmara em
    # Ativos (histórico de Ks/Kpol) — não entra na conta, só sinaliza
    # deriva do conjunto dosimétrico ao longo do tempo. main.py preenche
    # esses dois parâmetros a partir do histórico do ativo, quando existe.
    last_known_ks = params.get("last_known_ks")
    last_known_kpol = params.get("last_known_kpol")
    try:
        last_known_ks = float(last_known_ks) if last_known_ks not in (None, "") else None
    except (TypeError, ValueError):
        last_known_ks = None
    try:
        last_known_kpol = float(last_known_kpol) if last_known_kpol not in (None, "") else None
    except (TypeError, ValueError):
        last_known_kpol = None
    if last_known_ks is not None:
        flat["ks_deviation_pct"] = (1 - ks_val / last_known_ks) * 100
    if last_known_kpol is not None:
        flat["kpol_deviation_pct"] = (1 - kpol_val / last_known_kpol) * 100

    # 5 - Dose medida (em Zref) e 6 - Fator de calibração (em Zmax)
    try:
        ndw = float(params["ndw"])
        pdp_percent = float(params["pdp_reference"])
        um_nominal = float(params["um_nominal"])
    except (KeyError, TypeError, ValueError):
        raise DosimetryError("ND,w, PDP de referência e UM nominal precisam estar configurados na rotina.")

    dose_zref = _dose_water_zref(m1_avg, ktp_val, ks_val, kpol_val, ndw, kq_val)
    flat["dose_zref_cgy"] = dose_zref
    dose_zmax = _dose_at_zmax(dose_zref, pdp_percent)
    flat["dose_zmax_cgy"] = dose_zmax
    fcal = _calibration_factor(dose_zmax, um_nominal)
    flat["calibration_factor_cgy_um"] = fcal

    # 7 - Comparação com valores esperados
    expected_fcal = params.get("expected_calibration_factor")
    try:
        expected_fcal = float(expected_fcal) if expected_fcal not in (None, "") else 1.0
    except (TypeError, ValueError):
        expected_fcal = 1.0
    flat["calibration_factor_deviation_pct"] = (fcal / expected_fcal - 1) * 100

    if is_photon:
        expected_quality = params.get("expected_beam_quality")
        try:
            expected_quality = float(expected_quality) if expected_quality not in (None, "") else None
        except (TypeError, ValueError):
            expected_quality = None
        if expected_quality is not None:
            flat["beam_quality_deviation_pct"] = (beam_quality_measured / expected_quality - 1) * 100

    # 8 - Ajuste (opcional): mesmas contas, com a média das leituras pós-ajuste
    adjustment_made = bool(session.get("adjustment_made"))
    if adjustment_made:
        post_readings = session.get("post_adjustment_readings") or []
        post_avg, post_spread = _avg_maxmin(post_readings)
        if post_avg is None:
            raise DosimetryError("Marcado 'ajuste feito', mas nenhuma leitura pós-ajuste foi lançada.")
        flat["post_adjustment_avg_nc"] = post_avg
        flat["post_adjustment_spread_pct"] = post_spread
        post_dose_zref = _dose_water_zref(post_avg, ktp_val, ks_val, kpol_val, ndw, kq_val)
        post_dose_zmax = _dose_at_zmax(post_dose_zref, pdp_percent)
        flat["post_adjustment_dose_zmax_cgy"] = post_dose_zmax
        post_fcal = _calibration_factor(post_dose_zmax, um_nominal)
        flat["post_adjustment_calibration_factor_cgy_um"] = post_fcal
        flat["post_adjustment_deviation_pct"] = (post_fcal / expected_fcal - 1) * 100
        # O resultado final (o que efetivamente vale para o mês) passa a
        # ser o pós-ajuste — mesma convenção da planilha (AG54 = "Sim").
        flat["final_dose_zmax_cgy"] = post_dose_zmax
        flat["final_calibration_factor_cgy_um"] = post_fcal
        flat["final_calibration_factor_deviation_pct"] = flat["post_adjustment_deviation_pct"]
    else:
        flat["final_dose_zmax_cgy"] = dose_zmax
        flat["final_calibration_factor_cgy_um"] = fcal
        flat["final_calibration_factor_deviation_pct"] = flat["calibration_factor_deviation_pct"]

    return {"metrics": flat, "warnings": []}
