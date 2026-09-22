# Backend — CQ Radioterapia

Este é o servidor Python (FastAPI + SQLite) da plataforma de Controle de
Qualidade em Radioterapia. Desde esta versão, ele é a **fonte de dados de
toda a aplicação** — não só da análise pylinac: usuários, equipamentos,
rotinas e resultados ficam salvos aqui (arquivo `rtqc.db`), não mais no
navegador. Isso é o que permite a **análise automática de pastas
observadas** funcionar mesmo sem nenhum navegador aberto.

O app principal (`index.html` na raiz do repositório) é só HTML/JS estático
e depende deste backend estar rodando para tudo: login, cadastro de
equipamentos/rotinas, histórico de resultados e análise de DICOM.

## 1. Instalar

Requer Python 3.10+.

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Rodar

```bash
uvicorn main:app --host 0.0.0.0 --port 8420
```

Deixe esse terminal aberto — o backend precisa continuar rodando enquanto
o app for usado (inclusive para observar pastas em segundo plano). Para
confirmar que subiu, acesse `http://localhost:8420/api/health`.

Na primeira vez que rodar, ele cria automaticamente o arquivo `rtqc.db`
(SQLite) nesta pasta com o esquema do banco.

## 3. Conectar o app a este backend

1. Abra o app (`index.html`, local ou publicado no GitHub Pages).
2. Se ainda não houver usuários, a própria tela inicial já pede para criar
   o administrador — nesse ponto o app já está falando com o backend
   configurado em `http://localhost:8420` (padrão).
3. Para trocar o endereço, vá em **Backup → Servidor (backend)**.

## Testes com análise automática (upload manual)

Picket Fence, Starshot, Winston-Lutz, VMAT (DRGS/DRMLC), Field Analysis
(Flatness/Symmetry), imagem planar (Leeds/QC-3/Las Vegas/Doselab/SNC),
CatPhan (CT), Quart DVT (CBCT) e Cheese/TomoCheese.

Testes que **não** têm análise automática (continuam com lançamento manual
do resultado): TG-51/TRS-398, Winston-Lutz multi-alvo, DLG, ACR CT/MRI e
análise de log de trajetória. O app explica isso na tela de cada um desses
testes.

## Pasta observada — análise 100% automática

Para os testes com upload de arquivo, cada rotina pode ter uma ou mais
**pastas observadas**: o backend fica de olho nelas (varredura a cada 10s)
e, a cada arquivo novo, analisa sozinho com o pylinac e grava o resultado
direto no banco — sem precisar abrir nenhum navegador. Configure isso na
tela da própria rotina, seção "Pasta observada (análise automática)".

Detalhes de funcionamento:

- Usa varredura por *polling*, não eventos de sistema de arquivos — isso é
  proposital, porque pastas de rede mapeadas (ex.: um drive `Z:\` do
  Windows/SMB) frequentemente não disparam notificações de mudança de
  forma confiável.
- Um arquivo só é processado depois de ficar com o mesmo tamanho em duas
  varreduras seguidas (evita processar um arquivo ainda sendo copiado).
- Depois de processado, o arquivo é movido para uma subpasta
  `processado_cq` (ou `falha_cq`, se a análise der erro) dentro da própria
  pasta observada, para não ser analisado de novo.
- Resultados gerados assim aparecem marcados como "⚙ Automático" no
  histórico e ainda precisam da aprovação manual (usuário + senha) — a
  automação cobre a análise, não a validação clínica.
- Data do resultado: quando possível, é lida da tag DICOM `StudyDate` da
  própria imagem; senão usa a data do processamento.

## Estrutura do código

| Arquivo              | Responsabilidade                                             |
|-----------------------|----------------------------------------------------------------|
| `db.py`               | Schema SQLite e funções de CRUD                               |
| `auth.py`              | Hash/verificação de senha, criação de usuário                 |
| `analysis.py`          | Lógica de execução do pylinac (usada por `/api/analyze` e pelo observador) |
| `modules_config.py`    | Mapeamento de cada teste do catálogo para a classe pylinac real, parâmetros e métricas |
| `watcher.py`           | Observador de pastas em segundo plano                         |
| `main.py`              | API REST (FastAPI) e ponto de entrada                          |

## Backup e restauração

Os endpoints `/api/backup/export` e `/api/backup/import` (usados pela tela
**Backup** do app) fazem um dump/restauração completos do banco. Para uma
cópia de segurança "crua", também dá para simplesmente copiar o arquivo
`rtqc.db` desta pasta.

### Backup automático de segurança

Além do export/import manual, a tela **Backup** tem um campo para
configurar uma **pasta de backup automático**. Uma vez configurada:

- Toda vez que qualquer dado for criado, alterado ou apagado (por qualquer
  caminho — pela interface, pelo `/api/analyze`, ou pelo observador de
  pastas), o backend grava sozinho uma cópia JSON atualizada em
  `<pasta>/rtqc_backup.json` (gravação atômica: escreve num `.tmp` e troca
  por cima do arquivo final, então nunca fica um arquivo pela metade).
- Ao iniciar, o backend verifica: se essa pasta está configurada, o arquivo
  existe, **e o banco atual está vazio** (sem nenhum usuário/equipamento —
  o cenário de "perdi o `rtqc.db`"), ele restaura os dados sozinho a partir
  desse JSON antes de aceitar requisições. Se o banco já tem dados, a
  restauração automática é **ignorada** — isso é proposital, para nunca
  sobrescrever dados atuais válidos com uma cópia mais antiga.
- A configuração da pasta (`rtqc_config.json`) fica **fora** do banco
  `rtqc.db` de propósito: se o próprio banco for perdido, ainda sabemos
  onde procurar a última cópia para restaurar.
- Use uma pasta de rede/nuvem sincronizada (ex.: um drive mapeado que
  também é copiado para outro lugar) para essa proteção cobrir também a
  perda do disco/computador inteiro, não só do arquivo `rtqc.db`.

## Avisos importantes

- **HTTPS x HTTP (conteúdo misto):** se você abrir o app por `https://`
  (ex.: publicado no GitHub Pages) e o backend estiver em
  `http://localhost`, alguns navegadores podem bloquear a chamada por
  política de "conteúdo misto". Se isso acontecer, abra o app localmente
  (ex.: `python3 -m http.server` na raiz do repositório e acesse via
  `http://`) em vez de usar a versão publicada.
- **CORS aberto por padrão:** por simplicidade, o backend aceita chamadas
  de qualquer origem. Restrinja com `RTQC_ALLOWED_ORIGINS` (lista separada
  por vírgula) se for expor este serviço numa rede maior, e proteja com uma
  chave de API via `RTQC_API_KEY` (cabeçalho `X-API-Key`, hoje usado só em
  `/api/analyze`).
- **Sem autenticação de rede:** qualquer pessoa que alcance a porta do
  backend consegue ler/gravar todos os dados via API. Isso é adequado para
  uso local/rede interna confiável — não exponha esta porta diretamente à
  internet.
- Isto roda em um único processo, sem fila de tarefas — arquivos grandes
  (séries de CT/CBCT completas) podem levar alguns segundos a mais de
  processamento.

## Variáveis de ambiente opcionais

| Variável                 | Efeito                                                        |
|---------------------------|----------------------------------------------------------------|
| `RTQC_DB_PATH`            | Caminho do arquivo SQLite (padrão: `backend/rtqc.db`).         |
| `RTQC_ALLOWED_ORIGINS`    | Lista de origens permitidas (CORS), separadas por vírgula.    |
| `RTQC_API_KEY`            | Se definida, exige o cabeçalho `X-API-Key` em `/api/analyze`. |
