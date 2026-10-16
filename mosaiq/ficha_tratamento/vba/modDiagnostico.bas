Attribute VB_Name = "modDiagnostico"
' Modulo TEMPORARIO: rode DiagnosticoBarras com uma ficha aberta pelo
' Mosaiq para confirmar o nome da barra e dos botoes OK/Cancelar.
' Depois de confirmar, pode remover este modulo.
Option Explicit

Sub DiagnosticoBarras()
    Dim cb As Office.CommandBar
    Dim ctl As Office.CommandBarControl
    Dim relatorio As String
    For Each cb In Application.CommandBars
        If cb.Visible Then
            For Each ctl In cb.Controls
                If ctl.Caption Like "*OK*" Or ctl.Caption Like "*Cancelar*" Then
                    relatorio = relatorio & "Barra: " & cb.Name & _
                        " | Botão: " & ctl.Caption & " | Index: " & ctl.Index & vbCrLf
                End If
            Next ctl
        End If
    Next cb
    MsgBox IIf(relatorio = "", "Nada encontrado.", relatorio)
End Sub
