"""
Editor de texto em PDF mantendo a mesma fonte, tamanho e cor.

Inspirado no projeto PDFSmartEdit (github.com/BaseMax/PDFSmartEdit),
com uma busca de fontes mais completa.

Como a fonte é escolhida (nessa ordem):
  1. A propria fonte embutida no PDF, se ela tiver todas as letras do texto novo
  2. Fontes que ja vem no repositorio, na pasta "fontes/" (mais de 100 arquivos)
  3. Fontes instaladas no computador (opcional, desligue com --so-repositorio)
  4. Fontes equivalentes listadas em fontes_alias.json (ex.: Calibri -> Carlito)
  5. Fontes padrao do PDF (Helvetica, Times, Courier) respeitando negrito/italico

Uso:
  python editar_pdf.py entrada.pdf saida.pdf --trocar "11/10/2025=22/10/2025"
  python editar_pdf.py entrada.pdf saida.pdf --regras regras_exemplo.json
  python editar_pdf.py entrada.pdf --listar-fontes
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

try:
    import pymupdf  # versoes novas
except ImportError:
    import fitz as pymupdf  # versoes antigas

PASTA_PROJETO = Path(__file__).resolve().parent
PASTA_FONTES = PASTA_PROJETO / "fontes"
ARQUIVO_ALIAS = PASTA_PROJETO / "fontes_alias.json"
ARQUIVO_INDICE = PASTA_PROJETO / "indice_fontes.json"

EXTENSOES_FONTE = {".ttf", ".otf", ".ttc", ".pfb", ".pfa"}

# Pastas onde os sistemas guardam fontes
PASTAS_SISTEMA = [
    # Windows
    Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts",
    # macOS
    Path("/System/Library/Fonts"),
    Path("/Library/Fonts"),
    Path.home() / "Library" / "Fonts",
    # Linux
    Path("/usr/share/fonts"),
    Path("/usr/local/share/fonts"),
    Path.home() / ".fonts",
    Path.home() / ".local" / "share" / "fonts",
]

# Palavras que indicam estilo dentro do nome da fonte
PALAVRAS_ESTILO = [
    "bolditalic", "boldoblique", "semibold", "demibold", "extrabold",
    "ultrabold", "black", "heavy", "bold", "italic", "oblique", "regular",
    "roman", "book", "normal", "medium", "light", "thin", "condensed",
]

# Estilos que costumam vir grudados no nome (ex.: ArialBold)
GRUDADOS = ["bolditalic", "boldoblique", "semibold", "demibold", "bold", "italic", "oblique", "regular"]

# Fontes padrao do PDF: (serifa, mono, negrito, italico) -> nome interno
FONTES_BASE14 = {
    (False, False, False, False): "helv",
    (False, False, True, False): "hebo",
    (False, False, False, True): "heit",
    (False, False, True, True): "hebi",
    (True, False, False, False): "tiro",
    (True, False, True, False): "tibo",
    (True, False, False, True): "tiit",
    (True, False, True, True): "tibi",
    (False, True, False, False): "cour",
    (False, True, True, False): "cobo",
    (False, True, False, True): "coit",
    (False, True, True, True): "cobi",
}


# ---------------------------------------------------------------------------
# Nomes de fonte
# ---------------------------------------------------------------------------

def limpar(texto):
    """Deixa so letras e numeros em minusculo."""
    return re.sub(r"[^a-z0-9]", "", texto.lower())


def separar_nome(nome_fonte, flags=0):
    """
    Recebe um nome como 'ABCDEF+TimesNewRomanPS-BoldMT' e devolve
    ('timesnewroman', negrito, italico).
    """
    nome = nome_fonte.split("+", 1)[-1]          # tira prefixo de subconjunto
    nome = nome.replace(",", "-")
    partes = nome.split("-", 1)
    familia = limpar(partes[0])
    estilo = limpar(partes[1]) if len(partes) > 1 else ""

    # sufixos comuns de fontes Adobe/Microsoft
    for sufixo in ("psmt", "mt", "ps"):
        if familia.endswith(sufixo) and len(familia) > len(sufixo) + 2:
            familia = familia[: -len(sufixo)]
            break

    # estilo pode estar grudado na familia (ex.: 'ArialBold')
    for palavra in GRUDADOS:
        if familia.endswith(palavra) and len(familia) > len(palavra) + 2:
            estilo = palavra + estilo
            familia = familia[: -len(palavra)]
            break

    negrito = bool(flags & 16) or any(p in estilo for p in ("bold", "black", "heavy"))
    italico = bool(flags & 2) or any(p in estilo for p in ("italic", "oblique"))
    return familia, negrito, italico


# ---------------------------------------------------------------------------
# Indice de fontes do computador
# ---------------------------------------------------------------------------

def ler_info_fonte(caminho):
    """Abre o arquivo de fonte e devolve (familia, negrito, italico)."""
    try:
        fonte = pymupdf.Font(fontfile=str(caminho))
    except Exception:
        return None
    nome = fonte.name
    if "-" in nome:
        # nome no formato 'Arial-BoldMT'
        familia, negrito, italico = separar_nome(nome)
    else:
        # nome no formato 'Open Sans Bold Italic': tira as palavras de estilo do final
        palavras = nome.split()
        estilo = []
        while len(palavras) > 1 and limpar(palavras[-1]) in PALAVRAS_ESTILO:
            estilo.insert(0, limpar(palavras.pop()))
        familia = limpar("".join(palavras))
        negrito = any(p in ("bold", "semibold", "demibold", "extrabold", "black", "heavy") for p in estilo)
        italico = any(p in ("italic", "oblique") for p in estilo)
    negrito = negrito or bool(getattr(fonte, "is_bold", False))
    italico = italico or bool(getattr(fonte, "is_italic", False))
    return familia, negrito, italico


def indexar_pastas(pastas):
    indice = {}
    for pasta in pastas:
        if not pasta.is_dir():
            continue
        for caminho in sorted(pasta.rglob("*")):
            if caminho.suffix.lower() not in EXTENSOES_FONTE:
                continue
            info = ler_info_fonte(caminho)
            if not info:
                continue
            familia, negrito, italico = info
            indice.setdefault(f"{familia}|{int(negrito)}|{int(italico)}", str(caminho))
    return indice


def montar_indice(forcar=False, usar_sistema=True):
    """
    Junta as fontes do repositorio (pasta fontes/) com as do computador.
    As do repositorio sempre tem prioridade e sao lidas a cada execucao.
    As do computador ficam salvas em indice_fontes.json para ser mais rapido.
    """
    indice = indexar_pastas([PASTA_FONTES])

    if usar_sistema:
        if ARQUIVO_INDICE.exists() and not forcar:
            with open(ARQUIVO_INDICE, encoding="utf-8") as f:
                sistema = json.load(f)
        else:
            print("Procurando fontes do computador (so na primeira vez)...")
            sistema = indexar_pastas(PASTAS_SISTEMA)
            with open(ARQUIVO_INDICE, "w", encoding="utf-8") as f:
                json.dump(sistema, f, ensure_ascii=False, indent=1)
        for chave, caminho in sistema.items():
            indice.setdefault(chave, caminho)

    return indice


def carregar_alias():
    if not ARQUIVO_ALIAS.exists():
        return {}
    with open(ARQUIVO_ALIAS, encoding="utf-8") as f:
        dados = json.load(f)
    return {limpar(k): [limpar(x) for x in v] for k, v in dados.items() if not k.startswith("_")}


# ---------------------------------------------------------------------------
# Escolha da fonte
# ---------------------------------------------------------------------------

def tem_todas_as_letras(fonte, texto):
    return all(c.isspace() or fonte.has_glyph(ord(c)) for c in texto)


class BuscadorDeFontes:
    def __init__(self, doc, usar_sistema=True):
        self.doc = doc
        self.indice = montar_indice(usar_sistema=usar_sistema)
        self.alias = carregar_alias()
        self.embutidas = {}  # nome no PDF -> buffer da fonte

        for num_pagina in range(len(doc)):
            for xref, ext, _tipo, nome_base, *_ in doc.get_page_fonts(num_pagina, full=True):
                if ext in ("n/a", "") or nome_base in self.embutidas:
                    continue
                try:
                    _, _, _, buffer = doc.extract_font(xref)
                    if buffer:
                        self.embutidas[nome_base] = buffer
                except Exception:
                    pass

    def _embutida(self, nome_span):
        for nome_base, buffer in self.embutidas.items():
            if nome_base == nome_span or nome_base.split("+", 1)[-1] == nome_span.split("+", 1)[-1]:
                return buffer
        return None

    def escolher(self, nome_span, flags, texto):
        """
        Devolve um dicionario com a fonte escolhida:
          {"origem": ..., "buffer"/"arquivo"/"base14": ..., "nome": ...}
        """
        # 1. fonte embutida no PDF
        buffer = self._embutida(nome_span)
        if buffer:
            try:
                fonte = pymupdf.Font(fontbuffer=buffer)
                if tem_todas_as_letras(fonte, texto):
                    return {"origem": "embutida no PDF", "buffer": buffer, "nome": nome_span}
            except Exception:
                pass

        # 2 e 3. pasta fontes/ e fontes do computador (nome original e equivalentes)
        familia, negrito, italico = separar_nome(nome_span, flags)
        candidatas = [familia] + self.alias.get(familia, [])
        # primeiro procura o estilo exato em todas as candidatas;
        # so depois aceita uma versao sem negrito/italico (que sera simulado)
        for n, i in ((negrito, italico), (negrito, False), (False, italico), (False, False)):
            for cand in candidatas:
                caminho = self.indice.get(f"{cand}|{int(n)}|{int(i)}")
                if not caminho or not os.path.exists(caminho):
                    continue
                try:
                    fonte = pymupdf.Font(fontfile=caminho)
                except Exception:
                    continue
                if tem_todas_as_letras(fonte, texto):
                    origem = "equivalente" if cand != familia else "mesma familia"
                    return {
                        "origem": origem, "arquivo": caminho, "nome": Path(caminho).stem,
                        "simular_negrito": negrito and not n,
                        "simular_italico": italico and not i,
                    }

        # 5. fontes padrao do PDF
        serifa = bool(flags & 4) or any(s in familia for s in ("times", "serif", "roman", "georgia", "garamond"))
        mono = bool(flags & 8) or any(s in familia for s in ("courier", "mono", "consol"))
        base = FONTES_BASE14[(serifa and not mono, mono, negrito, italico)]
        return {"origem": "padrao do PDF (aproximada)", "base14": base, "nome": base}


# ---------------------------------------------------------------------------
# Edicao
# ---------------------------------------------------------------------------

def achar_span(pagina, retangulo):
    """Acha o trecho de texto (span) que mais se sobrepoe ao retangulo encontrado."""
    melhor, maior_area = None, 0
    for bloco in pagina.get_text("dict")["blocks"]:
        for linha in bloco.get("lines", []):
            for span in linha["spans"]:
                inter = pymupdf.Rect(span["bbox"]) & retangulo
                area = inter.get_area() if not inter.is_empty else 0
                if area > maior_area:
                    melhor, maior_area = dict(span, dir=linha["dir"]), area
    return melhor


def escrever_texto(pagina, item, nome_interno, fonte):
    """
    Escreve o texto novo. Quando a fonte encontrada nao tem a versao
    em negrito ou italico, o efeito e simulado:
      - negrito: o texto e escrito mais vezes, deslocado um pouquinho
      - italico: as letras sao inclinadas cerca de 12 graus
    """
    tamanho = item["tamanho"]
    ponto = item["ponto"]
    morph = None
    if fonte.get("simular_italico"):
        # inclina para a direita usando a linha de base como apoio
        morph = (ponto, pymupdf.Matrix(1, 0, -0.21, 1, 0, 0))

    deslocamentos = [0.0]
    if fonte.get("simular_negrito"):
        passo = tamanho * 0.018
        deslocamentos = [0.0, passo, passo * 2]

    for dx in deslocamentos:
        pagina.insert_text(
            pymupdf.Point(ponto.x + dx, ponto.y), item["novo"],
            fontname=nome_interno, fontsize=tamanho, color=item["cor"],
            morph=(pymupdf.Point(ponto.x + dx, ponto.y), morph[1]) if morph else None,
        )


def editar(entrada, saida, regras, usar_sistema=True):
    doc = pymupdf.open(entrada)
    buscador = BuscadorDeFontes(doc, usar_sistema=usar_sistema)
    total = 0

    for pagina in doc:
        insercoes = []

        for regra in regras:
            antigo, novo = regra["antigo"], regra["novo"]
            limite = regra.get("max_trocas")
            ja_feitas = sum(1 for i in insercoes if i["regra"] is regra)

            for retangulo in pagina.search_for(antigo):
                if limite is not None and ja_feitas >= limite:
                    break
                span = achar_span(pagina, retangulo)
                if not span:
                    continue
                if tuple(round(d, 2) for d in span["dir"]) != (1.0, 0.0):
                    print(f"  Pulei '{antigo}' na pagina {pagina.number + 1}: texto girado.")
                    continue

                fonte = buscador.escolher(span["font"], span["flags"], novo)
                insercoes.append({
                    "regra": regra,
                    "retangulo": retangulo,
                    "ponto": pymupdf.Point(retangulo.x0, span["origin"][1]),
                    "tamanho": span["size"],
                    "cor": pymupdf.sRGB_to_pdf(span["color"]),
                    "fonte": fonte,
                    "novo": novo,
                    "antigo": antigo,
                    "fonte_original": span["font"],
                })
                ja_feitas += 1

        if not insercoes:
            continue

        # apaga o texto antigo sem pintar fundo
        for item in insercoes:
            r = item["retangulo"]
            margem = r.height * 0.15
            pagina.add_redact_annot(pymupdf.Rect(r.x0, r.y0 + margem, r.x1, r.y1 - margem), fill=False)
        try:
            pagina.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_NONE,
                graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            )
        except (AttributeError, TypeError):
            pagina.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)

        # escreve o texto novo
        fontes_inseridas = {}
        for item in insercoes:
            f = item["fonte"]
            if "base14" in f:
                nome_interno = f["base14"]
                medidor = pymupdf.Font(nome_interno)
            else:
                chave = f.get("arquivo") or f["nome"]
                if chave not in fontes_inseridas:
                    nome_interno = f"FE{len(fontes_inseridas)}"
                    if "buffer" in f:
                        pagina.insert_font(fontname=nome_interno, fontbuffer=f["buffer"])
                        medidor = pymupdf.Font(fontbuffer=f["buffer"])
                    else:
                        pagina.insert_font(fontname=nome_interno, fontfile=f["arquivo"])
                        medidor = pymupdf.Font(fontfile=f["arquivo"])
                    fontes_inseridas[chave] = (nome_interno, medidor)
                nome_interno, medidor = fontes_inseridas[chave]

            escrever_texto(pagina, item, nome_interno, f)

            largura_nova = medidor.text_length(item["novo"], fontsize=item["tamanho"])
            aviso = ""
            if f.get("simular_negrito"):
                aviso += "  (negrito simulado)"
            if f.get("simular_italico"):
                aviso += "  (italico simulado)"
            if largura_nova > item["retangulo"].width * 1.05:
                aviso += "  (atencao: texto novo e mais largo que o antigo)"
            print(
                f"Pag. {pagina.number + 1}: '{item['antigo']}' -> '{item['novo']}' | "
                f"{item['fonte_original']} {item['tamanho']:.1f}pt | fonte usada: "
                f"{f['nome']} ({f['origem']}){aviso}"
            )
            total += 1

    doc.save(saida, garbage=3, deflate=True)
    print(f"\n{total} troca(s) feita(s). Arquivo salvo em: {saida}")


def listar_fontes(entrada):
    doc = pymupdf.open(entrada)
    vistos = set()
    print("Fontes usadas no PDF:\n")
    for pagina in doc:
        for bloco in pagina.get_text("dict")["blocks"]:
            for linha in bloco.get("lines", []):
                for span in linha["spans"]:
                    chave = (span["font"], round(span["size"], 1))
                    if chave in vistos:
                        continue
                    vistos.add(chave)
                    familia, n, i = separar_nome(span["font"], span["flags"])
                    estilo = ("negrito " if n else "") + ("italico" if i else "")
                    print(f"- {span['font']} | {span['size']:.1f}pt | familia: {familia} {estilo}")


def main():
    parser = argparse.ArgumentParser(description="Troca textos em PDF mantendo a fonte.")
    parser.add_argument("entrada", help="PDF original")
    parser.add_argument("saida", nargs="?", help="PDF editado")
    parser.add_argument("--trocar", action="append", default=[],
                        help='Troca no formato "antigo=novo". Pode repetir.')
    parser.add_argument("--regras", help="Arquivo JSON com a lista de trocas")
    parser.add_argument("--listar-fontes", action="store_true", help="Mostra as fontes do PDF")
    parser.add_argument("--reindexar", action="store_true", help="Refaz o indice de fontes do computador")
    parser.add_argument("--so-repositorio", action="store_true",
                        help="Usa so as fontes da pasta fontes/, ignorando as do computador")
    args = parser.parse_args()

    if args.reindexar and not args.so_repositorio:
        montar_indice(forcar=True)

    if args.listar_fontes:
        listar_fontes(args.entrada)
        return

    regras = []
    if args.regras:
        with open(args.regras, encoding="utf-8") as f:
            regras.extend(json.load(f))
    for troca in args.trocar:
        if "=" not in troca:
            sys.exit(f'Formato invalido: {troca}. Use "antigo=novo".')
        antigo, novo = troca.split("=", 1)
        regras.append({"antigo": antigo, "novo": novo})

    if not regras or not args.saida:
        parser.print_help()
        sys.exit(1)

    editar(args.entrada, args.saida, regras, usar_sistema=not args.so_repositorio)


if __name__ == "__main__":
    main()
