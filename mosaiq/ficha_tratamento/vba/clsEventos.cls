VERSION 1.0 CLASS
BEGIN
  MultiUse = -1  'True
END
Attribute VB_Name = "clsEventos"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = False
Attribute VB_Exposed = False
Option Explicit

Public WithEvents App As Word.Application
Public WithEvents BotaoOK As Office.CommandBarButton
Public WithEvents BotaoCancelar As Office.CommandBarButton

Private Sub App_DocumentBeforeSave(ByVal Doc As Document, SaveAsUI As Boolean, Cancel As Boolean)
    ' NUNCA cancela aqui (o eSCRIBE grava internamente). Nao avisa nada.
End Sub

Private Sub App_DocumentBeforePrint(ByVal Doc As Document, Cancel As Boolean)
    If ValidacaoAtiva Then
        If Not FormularioValido(Doc) Then Cancel = True
    End If
End Sub

' Os dois botoes caem no mesmo tratamento: decide-se SEMPRE pela legenda
' do botao clicado (Ctrl.Caption), porque o add-in pode recriar os
' controles e a variavel WithEvents "grudar" no botao errado.
Private Sub BotaoOK_Click(ByVal Ctrl As Office.CommandBarButton, CancelDefault As Boolean)
    ValidarSeForOK Ctrl, CancelDefault
End Sub

Private Sub BotaoCancelar_Click(ByVal Ctrl As Office.CommandBarButton, CancelDefault As Boolean)
    ValidarSeForOK Ctrl, CancelDefault
End Sub

Private Sub ValidarSeForOK(ByVal Ctrl As Office.CommandBarButton, CancelDefault As Boolean)
    If Ctrl.Caption <> "OK" Then Exit Sub
    If ValidacaoAtiva Then
        If Not FormularioValido(ActiveDocument) Then CancelDefault = True
    End If
End Sub
