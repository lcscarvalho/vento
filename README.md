# Vento

Web app para montar álbuns de foto e baixar cada folha em **300 dpi**, pronta para a gráfica.

**Abrir:** https://lcscarvalho.github.io/vento/

## O que faz

- **Formato da folha** — tamanhos prontos (10 × 15, 15 × 21, A4, 30 × 30, 10 × 50…) ou qualquer medida em cm, na vertical ou na horizontal.
- **Várias folhas** lado a lado ou empilhadas. Uma foto pode atravessar de uma folha para a outra: na exportação ela sai cortada em cada folha, na posição exata.
- **Fundo** escolhido numa roda de cores (padrão: branco), com as cores da marca à mão.
- **Imagens em alta resolução** — o arquivo original nunca é recomprimido. Na tela o app usa uma prévia leve; na exportação desenha a partir do original.
- **Manter proporção** ou **proporção livre**: com a trava solta, a moldura corta a foto (sem distorcer) e um duplo clique permite enquadrar.
- **dpi efetivo** de cada imagem no tamanho escolhido, para saber se ela vai imprimir nítida.
- **Baixar** em JPG (qualidade 95) ou PNG, com 300 dpi gravados no arquivo. Mais de uma folha vem num `.zip`.
- O álbum fica salvo no próprio navegador (IndexedDB) — nada é enviado para servidor nenhum.

## Atalhos

| Tecla | Ação |
| --- | --- |
| `Delete` | exclui a imagem |
| `⌘D` | duplica |
| `⌘Z` / `⇧⌘Z` | desfaz / refaz |
| setas | movem 1 mm (`⇧` 10 mm) |
| `⇧` ao redimensionar | inverte a trava de proporção |
| `⌥` ao arrastar | desliga o ímã de alinhamento |
| `⌘` + rolagem | zoom |
| duplo clique | enquadrar (com proporção livre) |
| `L` | trava/destrava a proporção |
| `[` `]` | envia para trás / traz para frente |

## Desenvolvimento

Sem build: HTML, CSS e JavaScript puro (módulos ES). Para rodar localmente:

```bash
python3 -m http.server 8000
```

e abrir http://localhost:8000.
