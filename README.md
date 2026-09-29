# CQ Radioterapia

Plataforma local de **Controle de Qualidade em Radioterapia**: cadastro de
equipamentos e rotinas de CQ, execução/registro de resultados (manual, via
upload de DICOM analisado automaticamente pelo `pylinac`, ou 100%
automático a partir de outros sistemas), gráficos de tendência, aprovação
com assinatura eletrônica e backup — tudo rodando localmente (ou num
servidor da rede da instituição), sem depender de nenhum serviço externo
na nuvem.

O frontend é HTML/JS/CSS estático (sem build, sem framework) e o backend é
um servidor Python (FastAPI) que guarda todos os dados em SQLite e roda o
`pylinac` de verdade sobre os arquivos DICOM enviados.

## Principais funcionalidades

- **Equipamentos e rotinas de CQ** — Acelerador Linear, Tomógrafo (CT/
  CBCT), Braquiterapia, Ortovoltagem ou outro; frequências diária,
  semanal, mensal, trimestral, semestral ou anual, com aviso de
  vencimento no painel.
- **Acervo de testes vinculados ao `pylinac`** (análise automática a
  partir de DICOM enviado, com imagem analisada e gráficos no detalhe do
  resultado): Picket Fence, Starshot, Winston-Lutz (padrão e
  multi-alvo/multi-campo), Field Analysis (Flatness & Symmetry),
  IsoAlign (campo luminoso × radiação), VMAT DRGS/DRMLC, imagem planar
  (Leeds TOR, QC-3, Las Vegas, Doselab kV/MV, SNC kV/MV), CatPhan (CT),
  Quart DVT (CBCT), Cheese Phantom/TomoCheese, DLG, ACR CT/MRI, análise
  de log de trajetória, e calibração TG-51/TRS-398 (fótons/elétrons).
- **Teste manual/genérico** — para qualquer rotina sem módulo `pylinac`
  correspondente, com métricas e tolerâncias definidas livremente.
- **Dosimetria Absoluta Mensal (TRS-398)** — calculadora completa (Ktp,
  Ks, Kpol, kQ, dose em Zref/Zmax) a partir das leituras da sessão,
  substituindo a planilha usada anteriormente; ver seção "Dosimetria
  Absoluta Mensal (TRS-398)" em [`backend/README.md`](backend/README.md).
- **Ativos** — cadastro de câmaras de ionização, eletrômetros,
  barômetros, termômetros, termo-higrômetros, réguas e níveis, com
  upload de certificados de calibração e histórico de Ndw/Ks/Kpol; ver
  seção "Ativos" em [`backend/README.md`](backend/README.md).
- **Teste Diário — importação automática (Sun Nuclear Daily QA3/Atlas)**
  — lê o banco `Sncdata.fdb` do Daily QA3 diretamente (sem servidor
  Firebird) e importa os resultados sozinho sempre que o arquivo é
  atualizado; ver seção "Teste Diário (Sun Nuclear Daily QA3 / Atlas)"
  em [`backend/README.md`](backend/README.md).
- **Pasta observada** — análise 100% automática: o backend fica de olho
  em pastas configuradas e analisa sozinho qualquer arquivo DICOM novo,
  sem precisar abrir o navegador.
- **Gráficos de tendência** (SVG, sem biblioteca externa) por métrica,
  com filtros por conformidade, período, gantry/colimador, e bandas de
  tolerância/nível de ação desenhadas no próprio gráfico.
- **Aprovação com assinatura eletrônica** — todo resultado registrado
  fica "pendente de aprovação" até um administrador aprovar com
  usuário e senha, carimbando data/hora e responsável.
- **Usuários e permissões** — perfis administrador/técnico; técnicos só
  registram resultados e excluem os ainda não aprovados, o resto
  (cadastros, aprovação, backup) é restrito a administradores.
- **Backup** — exportar/importar tudo em JSON, backup automático
  contínuo para uma pasta local/de rede (com restauração automática se
  o banco for perdido), e configuração do servidor de análise.

## Arquitetura

```
├── index.html, css/, js/   → frontend estático (sem build/framework)
└── backend/                → servidor Python (FastAPI + SQLite)
```

- **Frontend**: abre direto no navegador (`index.html`) ou publicado como
  site estático (ex.: GitHub Pages). Não guarda dado nenhum sozinho —
  tudo passa pela API do backend.
- **Backend**: fonte de verdade de todos os dados (`backend/rtqc.db`,
  SQLite) e responsável por rodar o `pylinac` de verdade, observar pastas
  e o `Sncdata.fdb` em segundo plano, e servir a API REST que o frontend
  consome. Veja **[`backend/README.md`](backend/README.md)** para
  instalação, execução (inclusive passo a passo no Windows) e o
  detalhamento técnico de cada funcionalidade automática.

### Estrutura do repositório

| Caminho                     | Conteúdo                                                        |
|------------------------------|------------------------------------------------------------------|
| `index.html`                 | Ponto de entrada do frontend                                    |
| `css/styles.css`              | Estilos da aplicação                                             |
| `js/catalog.js`               | Catálogo de tipos de equipamento, frequências, testes `pylinac`, TRS-398, Ativos, Teste Diário |
| `js/store.js`                 | Cliente da API do backend                                       |
| `js/auth.js`                  | Sessão/autenticação no navegador                                 |
| `js/ui.js`                    | Renderização das telas (HTML gerado em JS puro)                 |
| `js/app.js`                   | Roteamento (hash), eventos e ligação UI↔backend                 |
| `js/svgchart.js`, `js/wlchart.js` | Gráficos SVG (tendência e painel Winston-Lutz)               |
| `js/modal.js`                 | Modal/toast genéricos                                            |
| `backend/main.py`             | API REST (FastAPI) e ponto de entrada                           |
| `backend/db.py`               | Schema SQLite e funções de CRUD                                 |
| `backend/analysis.py`, `backend/modules_config.py`, `backend/wl_custom.py` | Execução do `pylinac` e mapeamento dos módulos do catálogo |
| `backend/dosimetry_trs398.py` | Cálculo da dosimetria absoluta mensal (TRS-398)                 |
| `backend/sncdata_reader.py`, `backend/sncdata_import.py` | Leitura/normalização do `Sncdata.fdb` (Sun Nuclear Daily QA3) |
| `backend/watcher.py`, `backend/snc_watcher.py` | Observadores em segundo plano (pastas DICOM e `Sncdata.fdb`) |
| `backend/auth.py`             | Hash/verificação de senha, criação de usuário                   |

## Como rodar

1. Suba o backend — veja **[`backend/README.md`](backend/README.md)**
   (inclui passo a passo detalhado, inclusive para Windows).
2. Abra `index.html` no navegador (local ou publicado como site
   estático). Na primeira vez, ele pede para criar o usuário
   administrador — já falando com o backend em `http://localhost:8420`
   por padrão (troque em **Backup → Servidor (backend)**, se precisar).

## Avisos importantes

- Feito para uso **local/rede interna confiável** — não há autenticação
  de rede além do login da aplicação; não exponha o backend diretamente
  à internet. Veja mais detalhes e variáveis de ambiente de
  segurança/CORS em [`backend/README.md`](backend/README.md#avisos-importantes).
- Faça backups regulares (tela **Backup**, ou configure o backup
  automático) — todos os dados vivem só no `backend/rtqc.db` deste
  servidor.
