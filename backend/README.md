# Backend de análise pylinac

Este é um serviço Python (FastAPI) que roda o [pylinac](https://pylinac.readthedocs.io/)
de verdade sobre os arquivos DICOM que você envia pela plataforma de CQ, e devolve
os resultados prontos para preencherem os gráficos de tendência.

O app principal (`index.html` na raiz do repositório) é só HTML/JS estático e
**não consegue rodar Python no navegador** — por isso esse backend precisa
rodar separadamente, em algum computador que o navegador consiga acessar
(o mais comum: o seu próprio computador, em `localhost`).

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

Deixe esse terminal aberto enquanto for usar a análise automática. Para
confirmar que subiu, acesse `http://localhost:8420/api/health` no navegador —
deve responder um JSON com a lista de testes suportados.

## 3. Conectar o app a este backend

1. Abra o app (index.html, local ou publicado no GitHub Pages).
2. Vá em **Backup → Servidor de Análise (pylinac)**.
3. Informe a URL (padrão `http://localhost:8420`) e clique em **Testar conexão**.

## Testes com análise automática

Picket Fence, Starshot, Winston-Lutz, VMAT (DRGS/DRMLC), Field Analysis
(Flatness/Symmetry), imagem planar (Leeds/QC-3/Las Vegas/Doselab/SNC),
CatPhan (CT), Quart DVT (CBCT) e Cheese/TomoCheese.

Testes que **não** têm análise automática (continuam com lançamento manual do
resultado, pois são calculadoras numéricas ou exigem configuração muito
específica do fantoma): TG-51/TRS-398, Winston-Lutz multi-alvo, DLG, ACR
CT/MRI e análise de log de trajetória. O app explica isso na tela de cada um
desses testes.

## Avisos importantes

- **HTTPS x HTTP (conteúdo misto):** se você abrir o app por `https://` (por
  exemplo, publicado no GitHub Pages) e o backend estiver em `http://localhost`,
  alguns navegadores podem bloquear a chamada por política de "conteúdo
  misto". Se isso acontecer, abra o app localmente (ex.:
  `python3 -m http.server` na raiz do repositório e acesse via `http://`) ao
  invés de usar a versão publicada, enquanto usa a análise automática.
- **CORS aberto por padrão:** por simplicidade, o backend aceita chamadas de
  qualquer origem. Isso é razoável para uso local/rede interna. Se for expor
  este serviço em uma rede maior, restrinja com a variável de ambiente
  `RTQC_ALLOWED_ORIGINS` (lista separada por vírgula) e proteja com uma chave
  de API via `RTQC_API_KEY` (o app enviaria essa chave no cabeçalho
  `X-API-Key" — ainda não há campo na interface para isso; peça se precisar).
- **Nenhum arquivo é retido:** os DICOM enviados ficam em uma pasta temporária
  apenas durante a análise e são apagados logo em seguida. O app guarda só os
  números do resultado (e, quando disponível, o relatório bruto retornado
  pelo pylinac).
- Isto roda em um único processo, sem fila de tarefas — arquivos grandes
  (séries de CT/CBCT completas) podem levar alguns segundos a mais de
   processamento; aguarde o botão voltar ao normal.

## Variáveis de ambiente opcionais

| Variável                 | Efeito                                                        |
|---------------------------|----------------------------------------------------------------|
| `RTQC_ALLOWED_ORIGINS`    | Lista de origens permitidas (CORS), separadas por vírgula.    |
| `RTQC_API_KEY`            | Se definida, exige o cabeçalho `X-API-Key` em `/api/analyze`. |
