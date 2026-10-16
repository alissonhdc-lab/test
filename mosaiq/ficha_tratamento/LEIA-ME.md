# Ficha Técnica de Tratamento — Radioterapia (modelo MOSAIQ/eSCRIBE)

| Arquivo | O que é |
|---|---|
| `FichaTecnicaTratamento_RT.dotm` | O modelo do Word, pronto para cadastrar no eSCRIBE |
| `vba/modFichaTecnica.bas` | Módulo VBA: validação dos campos obrigatórios |
| `vba/clsEventos.cls` | Classe VBA: eventos de impressão e dos botões OK/Cancelar |
| `vba/modDiagnostico.bas` | Módulo temporário para descobrir o nome da barra do eSCRIBE |
| `build_ficha.py` | Gerador do `.dotm`. Para mudar campos ou layout, edite e rode `python3 build_ficha.py` |

## Estrutura da ficha (1 página A4)

1. **Cabeçalho** com `{Patient.NameFL@U}` e `{Ident.IDA@U}`. São textos que o eSCRIBE
   substitui sozinho, não campos do Word.
2. **Identificação:** data de nascimento, convênio, médico(a)\*, CRM, físico(a), equipamento.
3. **Diagnóstico:** CID-10\*, localização\*, histologia, TNM, intenção\*, tratamento
   associado, RT prévia, alertas (marcapasso/gestação/prótese).
4. **Prescrição:** 4 linhas com volume, fase, dose/fração (cGy), nº de frações e **dose
   total calculada automaticamente** (`DoseTotalN = DoseFracaoN × FracoesN`, recalcula ao
   sair do campo). A linha 1 é obrigatória. Abaixo: frações/semana e normalização.
5. **Técnica e posicionamento:** técnica\*, energia\*, posicionamento\*, orientação,
   imobilização, bolus, controle respiratório, preparo, referência de setup, data da simulação.
6. **IGRT:** modalidade\* e frequência\* de imagem, mais 5 linhas de órgão de risco e restrição.
7. **Observações** e **Datas/assinaturas:** data da prescrição\*, início previsto\*,
   conferência da física (caixa de seleção + data) e linhas de assinatura.

\* = obrigatório (asterisco vermelho na ficha).

**Nomes dos campos** (bookmark = nome no diálogo "Opções do campo de formulário"):
`DataNasc, Convenio, MedicoResp, CRM, FisicoResp, Equipamento, CID, Localizacao,
Histologia, Estadiamento, Intencao, TratConcomitante, RTPrevia, Alertas,
Volume1-4, Fase1-4, DoseFracao1-4, Fracoes1-4, DoseTotal1-4, FracSemana, Normalizacao,
Tecnica, Energia, Posicionamento, Orientacao, Imobilizacao, Bolus, Respiratorio,
Preparo, RefSetup, DataSimulacao, ModalidadeImagem, FrequenciaImagem, OAR1-5,
Restricao1-5, Observacoes, DataPrescricao, DataInicio, ConferidoFisica, DataConferencia`.

### Proteção do documento

O modelo vem com **Restringir edição → Preenchimento de formulários, sem senha**. Sem essa
proteção as listas suspensas não abrem com um clique. A proteção vale só a partir de
"1. Identificação". O título e a linha Paciente/Prontuário ficam numa seção desprotegida,
para o eSCRIBE conseguir substituir `{Patient.NameFL@U}` e `{Ident.IDA@U}`.

Se no teste o eSCRIBE **não preencher nome/prontuário**, desligue a proteção (Revisão →
Restringir edição → Parar proteção) e salve o modelo de novo.

### Ajustes que provavelmente você vai querer fazer

- **Equipamento:** os itens "Acelerador linear 1/2/3" são genéricos. Troque pelos nomes
  das máquinas em `build_ficha.py` (procure `"Equipamento"`) e gere o modelo de novo. Também
  dá para editar no Word: Desenvolvedor → Modo de design → duplo clique no campo.
- **Mais dados do paciente** (nascimento, convênio, médico): se o seu eSCRIBE tem códigos
  para eles (copie de outro modelo da instituição que já funciona), troque os campos
  `DataNasc`/`Convenio`/`MedicoResp` por esses textos `{...}`. Se trocar `MedicoResp`,
  tire-o também da lista `obrig` no VBA.
- Dropdowns legados aceitam **no máximo 25 itens** (o gerador confere isso).

## Instalar a validação (VBA), cerca de 5 minutos

O `.dotm` foi gerado **sem macros**: código VBA compilado não pode ser criado nem editado
por script com segurança. A importação é manual e só se faz uma vez:

1. Abra o **modelo** no Word: botão direito em `FichaTecnicaTratamento_RT.dotm` → **Abrir**.
   Dois cliques criariam um documento novo em vez de abrir o modelo.
2. **Alt+F11** abre o editor VBA. No painel de projetos, selecione
   **TemplateProject (FichaTecnicaTratamento_RT)**.
3. **Arquivo → Importar arquivo…** e importe os três arquivos da pasta `vba/`:
   `modFichaTecnica.bas`, `clsEventos.cls` e `modDiagnostico.bas`.
   Confira que `clsEventos` aparece em **Módulos de classe**. Se aparecer como módulo comum,
   o arquivo foi copiado com quebras de linha erradas: baixe de novo do GitHub pelo botão "Raw".
4. **Ferramentas → Referências:** confirme que **Microsoft Office xx.0 Object Library** está
   marcada (necessária para `Office.CommandBarButton`).
5. **Depurar → Compilar TemplateProject**. Não deve aparecer erro.
6. Feche o editor e **salve** o modelo (Ctrl+S, mantendo o formato `.dotm`).

### Descobrir a barra do eSCRIBE (uma vez)

1. Abra uma ficha **de paciente teste** pelo Mosaiq.
2. Alt+F11 → execute `DiagnosticoBarras` (cursor dentro da sub → F5).
3. Se o nome da barra **não** for `eSCRIBE`, ou os botões não forem exatamente `OK` /
   `Cancelar`, ajuste a constante `NOME_BARRA` (ou as legendas em `VincularBotoes`) em
   `modFichaTecnica` dentro do modelo.
4. Se "Nada encontrado": não há barra de add-in. A validação continua funcionando ao
   **imprimir**.

Depois de confirmar, o `modDiagnostico` pode ser removido.

## Como a validação se comporta

| Ação | Resultado |
|---|---|
| Clicar em **OK** na barra do eSCRIBE com campo obrigatório vazio | Bloqueia e lista o que falta |
| Clicar em **Cancelar** | Sai sempre, sem validar |
| **Imprimir** com campo obrigatório vazio | Bloqueia e lista o que falta |
| **Salvar** (inclusive gravações internas do eSCRIBE) | Nunca bloqueia, para evitar "erro crítico ao gravar o documento" |
| Linha 2–4 da prescrição preenchida pela metade | Bloqueia e pede a linha completa |
| Mensagem `[VERIFIQUE O NOME DO CAMPO: X]` | O campo X foi renomeado ou apagado no Word. Corrija o nome ou a lista `obrig` |

Considera-se **vazio**: campo de texto em branco, lista ainda em `(Selecione)` e
dose/frações iguais a zero.

**Limitação conhecida:** fechar o Word pelo **X** da janela não passa pela validação. O
fluxo normal pelos botões da barra está coberto.

Para mudar a lista de obrigatórios, edite o `Array(...)` em `FormularioValido`
(`"NomeDoCampo|Rótulo"`) e, se quiser, os asteriscos em `build_ficha.py` (`True`/`False`
no terceiro item de cada campo).

## Antes de usar com pacientes

Teste com um **paciente de teste no Mosaiq**:

- [ ] Nome e prontuário aparecem no cabeçalho.
- [ ] As listas abrem e os campos aceitam digitação.
- [ ] A dose total calcula ao sair dos campos de dose/frações.
- [ ] OK com campo vazio bloqueia; Cancelar sai sem aviso.
- [ ] O documento grava sem "erro crítico".
- [ ] A impressão ou PDF sai em uma página.

O comportamento da automação do eSCRIBE (momento dos eventos, barra de add-in) só se
confirma no ambiente real. Se algo divergir no primeiro teste, isso é esperado: ajuste e
teste de novo.
