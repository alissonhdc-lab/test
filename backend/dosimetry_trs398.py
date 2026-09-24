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

Convenção geral do cálculo (idêntica à planilha):
1. Ktp: fator de correção de pressão e temperatura.
2. Fótons: PDD20,10 = D20/D10, depois TPR20,10 = 1,2661×PDD20,10 − 0,0595
   (fórmula empírica do TRS-398 para conversão PDD→TPR sem medir TPR
   diretamente). Elétrons: qualidade do feixe (R50) é um valor de
   referência já determinado na comissão do feixe, não remedido todo mês.
2. kQ: fótons, polinômio de Andreo (a+b×TPR+c×TPR²+d×TPR³, coeficientes
   por modelo de câmara cilíndrica); elétrons, valor tabelado fixo
   (câmaras de placas paralelas — a planilha usa uma tabela, não fórmula).
3. Ks (recombinação iônica): método de duas tensões (fórmula de Boag) se
   medido neste mês, senão valor de referência já estabelecido.
4. Kpol (polaridade): (|M+|+|M−|)/(2×|M−|) se medido, senão referência.
5. Dose absorvida na água em Zref: M1(média) × Ktp × Ks × Kpol × ND,w × kQ.
6. Normalização para Zmax (fator de calibração cGy/UM): dose em Zref
   dividida por PDP(10x10,Zref)/100, dividida pelo número nominal de UM.
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
    return m1_avg * ktp_val * ks_val * kpol_val * ndw * kq_val


def _calibration_factor(dose_at_zref, pdp_percent, um_nominal):
    """Normaliza a dose medida em Zref para o fator de calibração em
    cGy/UM no Zmax — mesma conta que a planilha faz em duas etapas
    (primeiro dose/[(PDP/100)], depois esse valor / UM nominal)."""
    dose_at_zmax = dose_at_zref / (pdp_percent / 100.0)
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

    # 3 - Ks (recombinação iônica)
    measure_ks_kpol = bool(session.get("measure_ks_kpol"))
    ref_ks = params.get("reference_ks")
    ref_kpol = params.get("reference_kpol")
    try:
        ref_ks = float(ref_ks) if ref_ks not in (None, "") else None
    except (TypeError, ValueError):
        ref_ks = None
    try:
        ref_kpol = float(ref_kpol) if ref_kpol not in (None, "") else None
    except (TypeError, ValueError):
        ref_kpol = None

    ks_measured = _ks_two_voltage(m1_avg, m2_avg) if m2_avg else None
    if ks_measured is not None:
        flat["ks_measured"] = ks_measured
    if measure_ks_kpol:
        if ks_measured is None:
            raise DosimetryError("Para medir Ks este mês é preciso lançar as leituras M2 (meia tensão).")
        ks_val = ks_measured
    else:
        if ref_ks is None:
            raise DosimetryError("Ks de referência não configurado na rotina (ou marque 'medir Ks/Kpol este mês').")
        ks_val = ref_ks
    flat["ks"] = ks_val
    if ks_measured is not None and ref_ks is not None:
        flat["ks_deviation_pct"] = (1 - ks_measured / ref_ks) * 100

    # 4 - Kpol (polaridade)
    kpol_measured = _kpol(mplus_avg, m1_avg) if mplus_avg is not None else None
    if kpol_measured is not None:
        flat["kpol_measured"] = kpol_measured
    if measure_ks_kpol:
        if kpol_measured is None:
            raise DosimetryError("Para medir Kpol este mês é preciso lançar as leituras M+ (polaridade invertida).")
        kpol_val = kpol_measured
    else:
        if ref_kpol is None:
            raise DosimetryError("Kpol de referência não configurado na rotina (ou marque 'medir Ks/Kpol este mês').")
        kpol_val = ref_kpol
    flat["kpol"] = kpol_val
    if kpol_measured is not None and ref_kpol is not None:
        flat["kpol_deviation_pct"] = (1 - kpol_measured / ref_kpol) * 100

    # 5 - Dose medida (em Zref) e 6 - Fator de calibração (em Zmax)
    try:
        ndw = float(params["ndw"])
        pdp_percent = float(params["pdp_reference"])
        um_nominal = float(params["um_nominal"])
    except (KeyError, TypeError, ValueError):
        raise DosimetryError("ND,w, PDP de referência e UM nominal precisam estar configurados na rotina.")

    dose_zref = _dose_water_zref(m1_avg, ktp_val, ks_val, kpol_val, ndw, kq_val)
    flat["dose_zref_cgy"] = dose_zref
    fcal = _calibration_factor(dose_zref, pdp_percent, um_nominal)
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
        post_fcal = _calibration_factor(post_dose_zref, pdp_percent, um_nominal)
        flat["post_adjustment_calibration_factor_cgy_um"] = post_fcal
        flat["post_adjustment_deviation_pct"] = (post_fcal / expected_fcal - 1) * 100
        # O resultado final (o que efetivamente vale para o mês) passa a
        # ser o pós-ajuste — mesma convenção da planilha (AG54 = "Sim").
        flat["final_calibration_factor_cgy_um"] = post_fcal
        flat["final_calibration_factor_deviation_pct"] = flat["post_adjustment_deviation_pct"]
    else:
        flat["final_calibration_factor_cgy_um"] = fcal
        flat["final_calibration_factor_deviation_pct"] = flat["calibration_factor_deviation_pct"]

    return {"metrics": flat, "warnings": []}
