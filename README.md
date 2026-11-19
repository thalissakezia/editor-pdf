# Editor de PDF com a mesma fonte

Script em Python que troca textos dentro de um PDF mantendo a mesma fonte, o mesmo tamanho e a mesma cor do original.

Inspirado no [PDFSmartEdit](https://github.com/BaseMax/PDFSmartEdit), com uma busca de fontes mais completa e fontes já incluídas no repositório.

O projeto tem duas partes:

- **Aplicativo (site)**: `index.html` e `app.js`. Roda no navegador do celular ou do computador e pode ser instalado no Android. O PDF não sai do aparelho.
- **Script em Python**: `editar_pdf.py`, para trocar textos pelo terminal.

As duas usam as mesmas fontes da pasta `fontes/`.

## Aplicativo

1. Abra o site e toque em **Abrir PDF**
2. Toque em qualquer texto, escreva o novo e toque em **Aplicar**
3. Para trocar o mesmo texto em várias partes, use **Trocar texto**
4. Toque em **Salvar**. No Android aparece a opção de compartilhar ou salvar o arquivo

O app mostra qual fonte foi usada em cada trecho e avisa quando o texto novo ficou mais largo que o original.

### Publicar no GitHub Pages

Cada repositório tem o próprio endereço, então isso não mexe em outro site que já esteja publicado.

1. Crie um repositório público chamado `editor-pdf`
2. Envie todos os arquivos deste projeto (o envio pelo navegador aceita até 100 arquivos por vez, então mande a pasta `fontes/` em duas partes, ou use o GitHub Desktop)
3. Vá em **Settings > Pages**, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)` e salve
4. Em alguns minutos o site fica em `https://SEU-USUARIO.github.io/editor-pdf/`

### Instalar no Android

Abra o endereço no Chrome, toque nos três pontinhos e em **Instalar app** (ou **Adicionar à tela inicial**). Depois da primeira vez, ele abre mesmo sem internet.

## Script em Python

## Como a fonte é escolhida

O script tenta nesta ordem:

1. A fonte que já está dentro do PDF, se ela tiver todas as letras do texto novo
2. As fontes da pasta `fontes/` deste repositório
3. Fontes instaladas no computador (opcional)
4. Fontes equivalentes do arquivo `fontes_alias.json` (ex.: Calibri → Carlito, Arial → Liberation Sans)
5. Fontes padrão do PDF (Helvetica, Times, Courier), respeitando negrito e itálico

Se o texto original estiver em negrito ou itálico e a fonte encontrada não tiver essa versão, o script simula o efeito: engrossa as letras (negrito) ou inclina (itálico). No terminal aparece quando isso acontece.

No terminal aparece qual fonte foi usada em cada troca.

## Fontes incluídas

Todas são livres para usar e distribuir. A licença de cada uma está na pasta dela. Cada família tem as versões normal, negrito, itálico e negrito itálico.

| Pasta | Substitui |
|---|---|
| liberation | Arial, Helvetica, Times New Roman, Courier New, Arial Narrow |
| carlito | Calibri |
| caladea | Cambria |
| gelasio | Georgia |
| tex-gyre | Helvetica, Times, Courier, Palatino, Bookman, Century Schoolbook, Avant Garde, Century Gothic, Zapf Chancery |
| dejavu | Verdana, Tahoma, Bitstream Vera |
| freefont | Fontes gerais com muitos acentos e símbolos |
| opensans | Open Sans, Segoe UI |
| roboto | Roboto |
| sourcesans3 | Source Sans, Myriad Pro |
| montserrat | Montserrat, Proxima Nova |
| inter | Inter, Aptos |
| firasans | Fira Sans, Trebuchet MS, Gill Sans, Frutiger |
| poppins | Poppins, Futura, Avenir |
| crimsontext | Garamond, Minion Pro, Baskerville |
| comicrelief | Comic Sans MS |

### Instalação

```
pip install -r requirements.txt
```

### Uso

Ver quais fontes o PDF usa:

```
python editar_pdf.py documento.pdf --listar-fontes
```

Trocar um texto:

```
python editar_pdf.py documento.pdf editado.pdf --trocar "11/10/2025=22/10/2025"
```

Várias trocas de uma vez (edite o `regras_exemplo.json`):

```
python editar_pdf.py documento.pdf editado.pdf --regras regras_exemplo.json
```

Usar só as fontes do repositório, sem olhar as do computador:

```
python editar_pdf.py documento.pdf editado.pdf --trocar "antigo=novo" --so-repositorio
```

`max_trocas` limita quantas vezes o mesmo texto é trocado.

## Adicionando mais fontes

- Coloque o `.ttf` ou `.otf` dentro da pasta `fontes/` (pode criar uma subpasta)
- Para ligar uma fonte a outra parecida, adicione uma linha no `fontes_alias.json`

## Limitações

- PDF escaneado (imagem) não tem texto para trocar
- No aplicativo, o texto antigo é coberto com a cor do fundo e o novo é escrito por cima. Visualmente fica igual, mas quem copiar o texto do PDF ainda pode encontrar o antigo por baixo. O script em Python apaga o texto antigo de verdade
- Texto girado é ignorado
- Se o texto novo for bem maior que o antigo, ele pode passar por cima do que vem depois. O script avisa quando isso acontece
