#!/usr/bin/env python3
"""Gera o modelo MOSAIQ/eSCRIBE "Ficha Técnica de Tratamento — Radioterapia"
(.dotm) do zero, com campos de formulário legados do Word
(FORMTEXT / FORMDROPDOWN / FORMCHECKBOX), cada um com nome + bookmark.

O arquivo sai SEM macros (sem vbaProject.bin): o código VBA de validação
fica em vba/*.bas e vba/*.cls e é importado no editor VBA (Alt+F11) —
ver LEIA-ME.md.

Uso:  python3 build_ficha.py [saida.dotm]
"""
import sys
import zipfile
from xml.sax.saxutils import escape

FONTE = "Arial"
VAZIO = " " * 5          # resultado padrão do Word para FORMTEXT vazio
SELECIONE = "(Selecione)"
LARGURA = 10488               # largura útil A4 com margens de 1,5 cm (twips)

_bm_id = [0]
_nomes = set()


def _novo_id():
    _bm_id[0] += 1
    return _bm_id[0]


def _registra(nome):
    assert len(nome) <= 20, f"nome de campo > 20 caracteres: {nome}"
    assert nome not in _nomes, f"nome de campo duplicado: {nome}"
    _nomes.add(nome)


# ---------------------------------------------------------------- runs ---

def rpr(bold=False, size=18, color=None):
    s = f'<w:rFonts w:ascii="{FONTE}" w:hAnsi="{FONTE}" w:cs="{FONTE}"/>'
    if bold:
        s += "<w:b/><w:bCs/>"
    if color:
        s += f'<w:color w:val="{color}"/>'
    s += f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>'
    return f"<w:rPr>{s}</w:rPr>"


def run(texto, **kw):
    return (f'<w:r>{rpr(**kw)}<w:t xml:space="preserve">'
            f"{escape(texto)}</w:t></w:r>")


def rotulo(texto, obrigatorio=False):
    s = run(texto, bold=True)
    if obrigatorio:
        s += run(" *", bold=True, color="C00000")
    return s + run(" ")


def _campo(nome, ffdata_interno, instr, resultado=None, aninhado=""):
    """Campo legado completo, envolvido por bookmark de mesmo nome."""
    _registra(nome)
    i = _novo_id()
    r = rpr()
    s = (f'<w:bookmarkStart w:id="{i}" w:name="{nome}"/>'
         f'<w:r>{r}<w:fldChar w:fldCharType="begin"><w:ffData>'
         f'<w:name w:val="{nome}"/>{ffdata_interno}</w:ffData></w:fldChar></w:r>'
         f'<w:r>{r}<w:instrText xml:space="preserve"> {instr} </w:instrText></w:r>'
         + aninhado)
    if resultado is not None:
        s += (f'<w:r>{r}<w:fldChar w:fldCharType="separate"/></w:r>'
              f'<w:r>{r}<w:t xml:space="preserve">{escape(resultado)}</w:t></w:r>')
    s += (f'<w:r>{r}<w:fldChar w:fldCharType="end"/></w:r>'
          f'<w:bookmarkEnd w:id="{i}"/>')
    return s


def texto(nome, maxlen=0, calc=False):
    t = '<w:textInput>' + (f'<w:maxLength w:val="{maxlen}"/>' if maxlen else '') + '</w:textInput>'
    return _campo(nome, f'<w:enabled/><w:calcOnExit w:val="{int(calc)}"/>{t}',
                  "FORMTEXT", VAZIO)


def numero(nome, maxlen=6, fmt="0"):
    # calcOnExit=1: ao sair do campo o Word recalcula os campos de Dose Total
    t = (f'<w:textInput><w:type w:val="number"/><w:maxLength w:val="{maxlen}"/>'
         f'<w:format w:val="{fmt}"/></w:textInput>')
    return _campo(nome, f'<w:enabled/><w:calcOnExit w:val="1"/>{t}', "FORMTEXT", VAZIO)


def data(nome):
    t = ('<w:textInput><w:type w:val="date"/><w:maxLength w:val="10"/>'
         '<w:format w:val="dd/MM/yyyy"/></w:textInput>')
    return _campo(nome, f'<w:enabled/><w:calcOnExit w:val="0"/>{t}', "FORMTEXT", VAZIO)


def calculado(nome, expr):
    t = (f'<w:textInput><w:type w:val="calculated"/>'
         f'<w:default w:val="={expr}"/><w:format w:val="0"/></w:textInput>')
    r = rpr()
    aninhado = (f'<w:r>{r}<w:fldChar w:fldCharType="begin"/></w:r>'
                f'<w:r>{r}<w:instrText xml:space="preserve"> ={expr} \\# "0" </w:instrText></w:r>'
                f'<w:r>{r}<w:fldChar w:fldCharType="separate"/></w:r>'
                f'<w:r>{r}<w:t>0</w:t></w:r>'
                f'<w:r>{r}<w:fldChar w:fldCharType="end"/></w:r>')
    return _campo(nome, f'<w:calcOnExit w:val="0"/>{t}', "FORMTEXT", "0", aninhado)


def lista(nome, opcoes):
    opcoes = [SELECIONE] + opcoes
    assert len(opcoes) <= 25, f"{nome}: dropdown legado aceita no máximo 25 itens"
    itens = "".join(f'<w:listEntry w:val="{escape(o)}"/>' for o in opcoes)
    return _campo(nome, f'<w:enabled/><w:calcOnExit w:val="0"/>'
                        f'<w:ddList><w:result w:val="0"/>{itens}</w:ddList>',
                  "FORMDROPDOWN")


def caixa(nome):
    return _campo(nome, '<w:enabled/><w:calcOnExit w:val="0"/>'
                        '<w:checkBox><w:sizeAuto/><w:default w:val="0"/></w:checkBox>',
                  "FORMCHECKBOX")


# --------------------------------------------------------- parágrafos ---

def par(conteudo="", align=None, antes=0, depois=60, sombra=None, keep=False):
    # ordem exigida pelo schema: keepNext, shd, spacing, jc
    ppr = "<w:keepNext/>" if keep else ""
    if sombra:
        ppr += f'<w:shd w:val="clear" w:color="auto" w:fill="{sombra}"/>'
    ppr += f'<w:spacing w:before="{antes}" w:after="{depois}"/>'
    if align:
        ppr += f'<w:jc w:val="{align}"/>'
    return f"<w:p><w:pPr>{ppr}</w:pPr>{conteudo}</w:p>"


def titulo_secao(texto_):
    # tabela de 1 célula para alinhar exatamente com as tabelas de campos
    cab = par(run(texto_, bold=True, size=20, color="FFFFFF"), depois=0, keep=True)
    return (par(antes=0, depois=50)
            + tabela([LARGURA], [[(cab, "1F4E79")]]).replace("8C8C8C", "1F4E79")
            + SEPARADOR)


# parágrafo de 1 pt entre tabelas: sem ele o Word funde tabelas vizinhas
SEPARADOR = ('<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" '
             'w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>')


def celula(conteudo, largura, sombra=None, span=1):
    tcpr = f'<w:tcW w:w="{largura}" w:type="dxa"/>'
    if span > 1:
        tcpr += f'<w:gridSpan w:val="{span}"/>'
    if sombra:
        tcpr += f'<w:shd w:val="clear" w:color="auto" w:fill="{sombra}"/>'
    tcpr += '<w:vAlign w:val="center"/>'
    if not conteudo.startswith("<w:p>"):
        conteudo = par(conteudo, depois=0)
    return f"<w:tc><w:tcPr>{tcpr}</w:tcPr>{conteudo}</w:tc>"


def tabela(larguras, linhas):
    """linhas: lista de listas de (conteudo, sombra|None[, span])."""
    bordas = "".join(f'<w:{b} w:val="single" w:sz="4" w:space="0" w:color="8C8C8C"/>'
                     for b in ("top", "left", "bottom", "right", "insideH", "insideV"))
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in larguras)
    corpo = ""
    for linha in linhas:
        cels, col = "", 0
        for item in linha:
            cont, sombra = item[0], item[1]
            span = item[2] if len(item) > 2 else 1
            w = sum(larguras[col:col + span])
            cels += celula(cont, w, sombra, span)
            col += span
        corpo += f'<w:tr><w:trPr><w:cantSplit/></w:trPr>{cels}</w:tr>'
    return (f'<w:tbl><w:tblPr><w:tblW w:w="{sum(larguras)}" w:type="dxa"/>'
            f'<w:tblBorders>{bordas}</w:tblBorders><w:tblLayout w:type="fixed"/>'
            f'<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>'
            f'<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>'
            f'</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{corpo}</w:tbl>')


def grade_rotulos(pares, colunas=2):
    """Tabela de pares rótulo/campo em N colunas."""
    lw = LARGURA // colunas
    larg = [int(lw * 0.47), lw - int(lw * 0.47)] * colunas
    larg[-1] += LARGURA - sum(larg)
    linhas = []
    for i in range(0, len(pares), colunas):
        linha = []
        for rot, campo, obrig in pares[i:i + colunas]:
            linha += [(rotulo(rot, obrig), "EAF1F8"), (campo, None)]
        while len(linha) < 2 * colunas:
            linha += [("", "EAF1F8"), ("", None)]
        linhas.append(linha)
    return tabela(larg, linhas)


# ------------------------------------------------------------ conteúdo ---

def corpo_documento():
    H = "D9E2F3"  # cabeçalho de tabela
    b = []

    # ---- Seção 1 (NÃO protegida): título + dados que o eSCRIBE substitui ----
    b.append(par(run("FICHA TÉCNICA DE TRATAMENTO — RADIOTERAPIA", bold=True, size=28,
                     color="1F4E79"), align="center", depois=40))
    b.append(par(run("Serviço de Radioterapia", size=18, color="595959"),
                 align="center", depois=120))
    b.append(tabela([2000, 5244, 1500, 1744], [[
        (rotulo("Paciente:"), "EAF1F8"), (run("{Patient.NameFL@U}"), None),
        (rotulo("Prontuário:"), "EAF1F8"), (run("{Ident.IDA@U}"), None)]]))
    # quebra de seção contínua: o que vem acima fica livre para o eSCRIBE
    b.append('<w:p><w:pPr><w:spacing w:after="0"/><w:sectPr>'
             '<w:footerReference w:type="default" r:id="rIdFooter"/><w:type w:val="continuous"/>'
             '<w:pgSz w:w="11906" w:h="16838"/>'
             '<w:pgMar w:top="680" w:right="850" w:bottom="680" w:left="850" '
             'w:header="340" w:footer="340" w:gutter="0"/>'
             '<w:formProt w:val="false"/>'
             '</w:sectPr></w:pPr></w:p>')

    # ---- Seção 2 (protegida para formulário) ----
    b.append(titulo_secao("1. IDENTIFICAÇÃO"))
    b.append(grade_rotulos([
        ("Data de nascimento:", data("DataNasc"), False),
        ("Convênio:", texto("Convenio", 60), False),
        ("Médico(a) responsável:", texto("MedicoResp", 80), True),
        ("CRM:", texto("CRM", 20), False),
        ("Físico(a) responsável:", texto("FisicoResp", 80), False),
        ("Equipamento:", lista("Equipamento", [
            "Acelerador linear 1", "Acelerador linear 2", "Acelerador linear 3",
            "Braquiterapia HDR", "Ortovoltagem", "Outro"]), False),
    ]))

    b.append(titulo_secao("2. DIAGNÓSTICO"))
    b.append(grade_rotulos([
        ("CID-10:", texto("CID", 10), True),
        ("Localização:", texto("Localizacao", 80), True),
        ("Histologia:", texto("Histologia", 80), False),
        ("Estadiamento (TNM):", texto("Estadiamento", 30), False),
        ("Intenção:", lista("Intencao", [
            "Curativa / radical", "Adjuvante", "Neoadjuvante", "Paliativa",
            "Profilática"]), True),
        ("Tratamento associado:", lista("TratConcomitante", [
            "Nenhum", "Quimioterapia concomitante", "Quimioterapia sequencial",
            "Hormonioterapia", "Imunoterapia / alvo", "Outro"]), False),
        ("Radioterapia prévia:", lista("RTPrevia", ["Não", "Sim — ver observações"]), False),
        ("Gestação / marcapasso:", lista("Alertas", [
            "Nenhum", "Marcapasso / CDI", "Gestante", "Prótese metálica",
            "Outro — ver observações"]), False),
    ]))

    b.append(titulo_secao("3. PRESCRIÇÃO"))
    larg = [700, 3288, 1700, 1600, 1500, 1700]
    linhas = [[(run(h, bold=True), H) for h in (
        "#", "Volume alvo (PTV/CTV)", "Fase", "Dose/fração (cGy)", "Nº frações",
        "Dose total (cGy)")]]
    for i in range(1, 5):
        ob = i == 1
        linhas.append([
            (run(str(i), bold=True), H),
            (texto(f"Volume{i}", 40) + (run(" *", bold=True, color="C00000") if ob else ""), None),
            (lista(f"Fase{i}", ["Fase única", "Fase 1", "Fase 2", "Fase 3", "Boost",
                                "SIB (integrado)"]), None),
            (numero(f"DoseFracao{i}", 5), None),
            (numero(f"Fracoes{i}", 3), None),
            (calculado(f"DoseTotal{i}", f"DoseFracao{i}*Fracoes{i}"), "F2F2F2"),
        ])
    b.append(tabela(larg, linhas))
    b.append(par(run("Dose total calculada automaticamente (dose/fração × nº de frações) "
                     "ao sair dos campos. Linha 1 obrigatória.", size=15, color="595959"),
                 depois=40))
    b.append(grade_rotulos([
        ("Frações por semana:", lista("FracSemana", ["5", "4", "3", "2", "1",
                                                      "2× ao dia (hiperfracionado)"]), False),
        ("Normalização / prescrição:", lista("Normalizacao", [
            "Isocentro", "Média do PTV", "D95% ≥ 100%", "Isodose de 80%",
            "Isodose de 90%", "Dmax (elétrons)", "Outro"]), False),
    ]))

    b.append(titulo_secao("4. TÉCNICA E POSICIONAMENTO"))
    b.append(grade_rotulos([
        ("Técnica:", lista("Tecnica", [
            "3D conformacional", "IMRT", "VMAT", "SBRT", "SRS / radiocirurgia",
            "Elétrons", "2D / convencional", "Braquiterapia"]), True),
        ("Energia:", lista("Energia", [
            "6 MV", "6 MV FFF", "10 MV", "10 MV FFF", "15 MV", "18 MV",
            "Fótons mistos", "Elétrons 6 MeV", "Elétrons 9 MeV", "Elétrons 12 MeV",
            "Elétrons 15 MeV", "Elétrons 18 MeV"]), True),
        ("Posicionamento:", lista("Posicionamento", [
            "Decúbito dorsal", "Decúbito ventral", "Decúbito lateral direito",
            "Decúbito lateral esquerdo", "Sentado"]), True),
        ("Orientação:", lista("Orientacao", ["Cabeça para o gantry", "Pés para o gantry"]), False),
        ("Imobilização:", lista("Imobilizacao", [
            "Máscara termoplástica (cabeça)", "Máscara termoplástica (cabeça e ombros)",
            "Breast board", "Colchão a vácuo", "Wing board", "Knee fix / foot fix",
            "Belly board", "Sem acessório", "Outro — ver observações"]), False),
        ("Bolus:", lista("Bolus", ["Não", "0,5 cm", "1,0 cm", "Outro"]), False),
        ("Controle respiratório:", lista("Respiratorio", [
            "Livre", "DIBH (inspiração profunda)", "Gating", "4D-CT / ITV",
            "Compressão abdominal"]), False),
        ("Preparo:", lista("Preparo", [
            "Nenhum", "Bexiga cheia", "Reto vazio", "Bexiga cheia + reto vazio", "Jejum",
            "Outro"]), False),
        ("Referência de setup:", texto("RefSetup", 80), False),
        ("Data da simulação:", data("DataSimulacao"), False),
    ]))

    b.append(titulo_secao("5. IMAGEM (IGRT) E RESTRIÇÕES"))
    b.append(grade_rotulos([
        ("Modalidade de imagem:", lista("ModalidadeImagem", [
            "kV-kV ortogonal", "CBCT", "MV portal", "Superfície (SGRT)", "kV + CBCT",
            "Nenhuma"]), True),
        ("Frequência:", lista("FrequenciaImagem", [
            "Diária", "3 primeiras frações + semanal", "Semanal", "Somente 1ª fração"]), True),
    ]))
    b.append(SEPARADOR)
    larg = [700, 3500, 6288]
    linhas = [[(run(h, bold=True), H) for h in ("#", "Órgão de risco", "Restrição de dose")]]
    for i in range(1, 6):
        linhas.append([(run(str(i), bold=True), H), (texto(f"OAR{i}", 40), None),
                       (texto(f"Restricao{i}", 80), None)])
    b.append(tabela(larg, linhas))

    b.append(titulo_secao("6. OBSERVAÇÕES"))
    b.append(tabela([LARGURA], [[(texto("Observacoes", 0), None)]]))

    b.append(titulo_secao("7. DATAS E ASSINATURAS"))
    b.append(grade_rotulos([
        ("Data da prescrição:", data("DataPrescricao"), True),
        ("Início previsto:", data("DataInicio"), True),
        ("Conferido pela física:", caixa("ConferidoFisica"), False),
        ("Data da conferência:", data("DataConferencia"), False),
    ]))
    b.append(par(antes=80, depois=0))
    assin = lambda t: (par(run("_" * 38), align="center", depois=0)
                       + par(run(t, size=16), align="center", depois=0))
    b.append(tabela([LARGURA // 2, LARGURA - LARGURA // 2], [[
        (assin("Médico(a) responsável — assinatura e CRM"), None),
        (assin("Física médica — assinatura"), None)]])
        .replace('w:val="single"', 'w:val="nil"'))
    b.append(par(run("* Campos obrigatórios", size=15, color="C00000"), antes=120))

    sect = ('<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/>'
            '<w:type w:val="continuous"/>'
            '<w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="680" w:right="850" w:bottom="680" w:left="850" '
            'w:header="340" w:footer="340" w:gutter="0"/></w:sectPr>')
    return "".join(b) + sect


# ---------------------------------------------------------- pacote OOXML ---

NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def arquivos():
    doc = f"{XML}<w:document {NS}><w:body>{corpo_documento()}</w:body></w:document>"
    pg = rpr(size=14, color="7F7F7F")
    rodape = (f'{XML}<w:ftr {NS}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>'
              f'{run("Ficha Técnica de Tratamento — RT   |   Página ", size=14, color="7F7F7F")}'
              f'<w:r>{pg}<w:fldChar w:fldCharType="begin"/></w:r>'
              f'<w:r>{pg}<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
              f'<w:r>{pg}<w:fldChar w:fldCharType="separate"/></w:r>'
              f'<w:r>{pg}<w:t>1</w:t></w:r>'
              f'<w:r>{pg}<w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>')
    return {
        "[Content_Types].xml": XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.template.macroEnabledTemplate.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        '</Types>',
        "_rels/.rels": XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        '</Relationships>',
        "word/_rels/document.xml.rels": XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
        '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
        '</Relationships>',
        "word/document.xml": doc,
        "word/footer1.xml": rodape,
        "word/styles.xml": XML +
        f'<w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr>'
        f'<w:rFonts w:ascii="{FONTE}" w:hAnsi="{FONTE}" w:cs="{FONTE}" w:eastAsia="{FONTE}"/>'
        '<w:sz w:val="18"/><w:szCs w:val="18"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
        '</w:pPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>'
        '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/>'
        '<w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>'
        '</w:tblCellMar></w:tblPr></w:style></w:styles>',
        # Proteção "preenchimento de formulários" SEM senha. A 1ª seção
        # (título + {Patient...}/{Ident...}) tem formProt=false e fica livre.
        "word/settings.xml": XML +
        f'<w:settings {NS}>'
        '<w:documentProtection w:edit="forms" w:enforcement="1"/>'
        '<w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/>'
        '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
        '</w:settings>',
        "docProps/core.xml": XML +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:title>Ficha Técnica de Tratamento — Radioterapia</dc:title>'
        '<dc:creator>Serviço de Radioterapia</dc:creator></cp:coreProperties>',
        "docProps/app.xml": XML +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
        '<Application>Microsoft Office Word</Application></Properties>',
    }


def main():
    saida = sys.argv[1] if len(sys.argv) > 1 else "FichaTecnicaTratamento_RT.dotm"
    with zipfile.ZipFile(saida, "w", zipfile.ZIP_DEFLATED) as z:
        for nome, conteudo in arquivos().items():
            z.writestr(nome, conteudo)
    print(f"{saida}: {len(_nomes)} campos de formulário")


if __name__ == "__main__":
    main()
