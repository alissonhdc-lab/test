Attribute VB_Name = "modFichaTecnica"
' Ficha Tecnica de Tratamento - Radioterapia
' Validacao de campos obrigatorios para MOSAIQ/eSCRIBE.
'
' Regras (nao mude sem testar no Mosaiq):
'  - NUNCA cancela DocumentBeforeSave: o eSCRIBE grava o documento
'    internamente varias vezes e um Save cancelado gera
'    "erro critico ao tentar gravar o documento".
'  - Ativa a validacao na hora (sem Application.OnTime).
'  - Bloqueia de verdade no botao OK da barra "eSCRIBE" (se existir)
'    e na impressao.
Option Explicit

Dim oEventos As New clsEventos
Public ValidacaoAtiva As Boolean

' Nome da barra de ferramentas do add-in. Confirme com DiagnosticoBarras.
Private Const NOME_BARRA As String = "eSCRIBE"

Sub AutoNew()
    EngatarValidacao
End Sub

Sub AutoOpen()
    EngatarValidacao
End Sub

Sub EngatarValidacao()
    Set oEventos.App = Word.Application
    ValidacaoAtiva = True
    VincularBotoes
End Sub

Sub VincularBotoes()
    Dim cb As Object, ctl As Object
    On Error Resume Next
    For Each cb In Application.CommandBars
        If cb.Name = NOME_BARRA Then
            For Each ctl In cb.Controls
                If ctl.Caption = "OK" Then
                    Set oEventos.BotaoOK = ctl
                ElseIf ctl.Caption = "Cancelar" Then
                    Set oEventos.BotaoCancelar = ctl
                End If
            Next ctl
        End If
    Next cb
    On Error GoTo 0
End Sub

Public Function FormularioValido(Doc As Document, Optional AvisarSemBloquear As Boolean = False) As Boolean
    Dim faltando As String
    Dim obrig As Variant
    Dim partes() As String
    Dim i As Long

    ' >>> "NomeDoCampo|Rotulo para o usuario" - edite aqui para mudar a lista <<<
    obrig = Array( _
        "MedicoResp|Médico(a) responsável", _
        "CID|CID-10", _
        "Localizacao|Localização", _
        "Intencao|Intenção do tratamento", _
        "Volume1|Prescrição: volume alvo (linha 1)", _
        "DoseFracao1|Prescrição: dose por fração (linha 1)", _
        "Fracoes1|Prescrição: nº de frações (linha 1)", _
        "Tecnica|Técnica", _
        "Energia|Energia", _
        "Posicionamento|Posicionamento", _
        "ModalidadeImagem|Modalidade de imagem (IGRT)", _
        "FrequenciaImagem|Frequência de imagem", _
        "DataPrescricao|Data da prescrição", _
        "DataInicio|Início previsto")

    faltando = ""
    For i = LBound(obrig) To UBound(obrig)
        partes = Split(obrig(i), "|")
        faltando = faltando & VerificaLista(Doc, partes(0), partes(1))
    Next i

    ' Linhas 2 a 4 da prescricao: se comecou a preencher, preencha a linha toda
    For i = 2 To 4
        faltando = faltando & VerificaLinhaPrescricao(Doc, i)
    Next i

    If Len(faltando) > 0 Then
        If Not AvisarSemBloquear Then
            MsgBox "Preencha os campos obrigatórios antes de continuar:" & vbCrLf & vbCrLf & faltando, _
                   vbExclamation, "Ficha Técnica de Tratamento"
        End If
        FormularioValido = False
    Else
        FormularioValido = True
    End If
End Function

' Valor "limpo" do campo; "" se vazio ou ainda no placeholder "(Selecione)".
' Retorna "#ERRO" se o campo nao existir (nome/bookmark errado).
Private Function ValorCampo(Doc As Document, indicador As String) As String
    Dim ff As FormField
    Dim valor As String
    On Error Resume Next
    Set ff = Doc.FormFields(indicador)
    On Error GoTo 0
    If ff Is Nothing Then
        ValorCampo = "#ERRO"
        Exit Function
    End If
    valor = ff.Result
    valor = Replace(valor, ChrW(8194), "")   ' espacos padrao de campo vazio
    valor = Replace(valor, ChrW(160), "")
    valor = Trim(valor)
    If Left(valor, 1) = "(" Then valor = ""
    If ff.Type = wdFieldFormTextInput Then
        If ff.TextInput.Type = wdNumberText Then
            If Val(Replace(valor, ",", ".")) <= 0 Then valor = ""
        End If
    End If
    ValorCampo = valor
End Function

Private Function VerificaLista(Doc As Document, indicador As String, rotulo As String) As String
    Select Case ValorCampo(Doc, indicador)
        Case "#ERRO"
            VerificaLista = "• [VERIFIQUE O NOME DO CAMPO: " & indicador & "]" & vbCrLf
        Case ""
            VerificaLista = "• " & rotulo & vbCrLf
    End Select
End Function

Private Function VerificaLinhaPrescricao(Doc As Document, n As Long) As String
    Dim v As String, d As String, f As String
    v = ValorCampo(Doc, "Volume" & n)
    d = ValorCampo(Doc, "DoseFracao" & n)
    f = ValorCampo(Doc, "Fracoes" & n)
    If v = "" And d = "" And f = "" Then Exit Function
    If v = "" Or d = "" Or f = "" Then
        VerificaLinhaPrescricao = "• Prescrição linha " & n & _
            ": preencha volume, dose por fração e nº de frações" & vbCrLf
    End If
End Function
