// Editor de PDF - edita trechos de texto mantendo fonte, tamanho e cor.
// pdf.js mostra o PDF e acha os textos; pdf-lib grava o PDF novo.
{
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);

const estado = {
  bytes: null,        // PDF original
  nomeArquivo: "documento.pdf",
  pdf: null,          // documento do pdf.js
  paginas: [],        // {pagina, viewport, canvas, ctx, escala, itens:[...]}
  edicoes: new Map(), // chave "p:i" -> edicao
  atual: null,        // trecho aberto na folha de edicao
};

// ------------------------------------------------------------------
// Fontes do repositorio
// ------------------------------------------------------------------

const ESTILOS = ["bolditalic", "boldoblique", "semibold", "demibold", "extrabold", "ultrabold",
  "black", "heavy", "bold", "italic", "oblique", "regular", "roman", "book", "normal", "medium",
  "light", "thin", "condensed"];

// estilos que costumam vir grudados no nome (ex.: ArialBold)
const GRUDADOS = ["bolditalic", "boldoblique", "semibold", "demibold", "bold", "italic", "oblique", "regular"];

const limpar = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function separarNome(nomeFonte) {
  let nome = (nomeFonte || "").split("+").pop().replace(/,/g, "-");
  const partes = nome.split("-");
  let familia = limpar(partes[0]);
  let estilo = limpar(partes.slice(1).join(""));
  for (const suf of ["psmt", "mt", "ps"]) {
    if (familia.endsWith(suf) && familia.length > suf.length + 2) { familia = familia.slice(0, -suf.length); break; }
  }
  for (const p of GRUDADOS) {
    if (familia.endsWith(p) && familia.length > p.length + 2) { estilo = p + estilo; familia = familia.slice(0, -p.length); break; }
  }
  return {
    familia,
    negrito: /bold|black|heavy/.test(estilo),
    italico: /italic|oblique/.test(estilo),
  };
}

let indiceFontes = null, aliasFontes = null;
const cacheArquivos = new Map();

async function carregarIndices() {
  if (indiceFontes) return;
  indiceFontes = new Map();
  aliasFontes = {};
  try {
    const lista = await (await fetch("fontes/indice.json")).json();
    for (const f of lista) {
      const chave = `${f.familia}|${+f.negrito}|${+f.italico}`;
      if (!indiceFontes.has(chave)) indiceFontes.set(chave, f.arquivo);
    }
  } catch (e) { console.warn("Sem indice de fontes", e); }
  try {
    const dados = await (await fetch("fontes_alias.json")).json();
    for (const [k, v] of Object.entries(dados)) {
      if (!k.startsWith("_")) aliasFontes[limpar(k)] = v.map(limpar);
    }
  } catch (e) { console.warn("Sem alias de fontes", e); }
}

async function bytesDoArquivo(caminho) {
  if (!cacheArquivos.has(caminho)) {
    cacheArquivos.set(caminho, fetch(caminho).then((r) => {
      if (!r.ok) throw new Error(caminho);
      return r.arrayBuffer();
    }).then((b) => new Uint8Array(b)));
  }
  return cacheArquivos.get(caminho);
}

function temTodasAsLetras(fonte, texto) {
  for (const ch of texto) {
    if (/\s/.test(ch)) continue;
    if (!fonte.hasGlyphForCodePoint(ch.codePointAt(0))) return false;
  }
  return true;
}

// Fontes padrao do PDF (ultimo recurso)
function fontePadrao(serifa, mono, negrito, italico) {
  const S = PDFLib.StandardFonts;
  if (mono) return [S.Courier, S.CourierBold, S.CourierOblique, S.CourierBoldOblique][(+negrito) + 2 * (+italico)];
  if (serifa) return [S.TimesRoman, S.TimesRomanBold, S.TimesRomanItalic, S.TimesRomanBoldItalic][(+negrito) + 2 * (+italico)];
  return [S.Helvetica, S.HelveticaBold, S.HelveticaOblique, S.HelveticaBoldOblique][(+negrito) + 2 * (+italico)];
}

const cssPadrao = (serifa, mono) =>
  mono ? '"Courier New", monospace' : serifa ? '"Times New Roman", serif' : "Arial, Helvetica, sans-serif";

let contadorFace = 0;
const facesCriadas = new Map();
async function registrarFace(chave, bytes) {
  if (facesCriadas.has(chave)) return facesCriadas.get(chave);
  const nome = "FonteEd" + (++contadorFace);
  try {
    const face = new FontFace(nome, bytes);
    await face.load();
    document.fonts.add(face);
    facesCriadas.set(chave, `"${nome}"`);
  } catch (e) {
    facesCriadas.set(chave, null);
  }
  return facesCriadas.get(chave);
}

// Decide qual fonte usar para um trecho com o texto novo
async function escolherFonte(item, texto) {
  await carregarIndices();
  const info = item.fonteInfo;
  const { familia, negrito, italico } = info;

  // 1. fonte embutida no PDF
  if (info.dados) {
    try {
      const fk = fontkit.create(info.dados);
      if (temTodasAsLetras(fk, texto)) {
        return { origem: "a mesma do PDF", bytes: info.dados, chave: "pdf:" + info.nome,
          nome: info.nomeCurto, simularNegrito: false, simularItalico: false,
          css: await registrarFace("pdf:" + info.nome, info.dados) };
      }
    } catch (e) { /* fonte que nao da para reaproveitar */ }
  }

  // 2. fontes do repositorio, mesma familia ou equivalentes
  const candidatas = [familia, ...(aliasFontes[familia] || [])];
  const ordem = [[negrito, italico], [negrito, false], [false, italico], [false, false]];
  for (const [n, i] of ordem) {
    for (const cand of candidatas) {
      const caminho = indiceFontes.get(`${cand}|${+n}|${+i}`);
      if (!caminho) continue;
      try {
        const bytes = await bytesDoArquivo(caminho);
        const fk = fontkit.create(bytes);
        if (!temTodasAsLetras(fk, texto)) continue;
        return {
          origem: cand === familia ? "mesma familia" : "equivalente",
          bytes, chave: caminho, nome: caminho.split("/").pop().replace(/\.(ttf|otf)$/i, ""),
          simularNegrito: negrito && !n, simularItalico: italico && !i,
          css: await registrarFace(caminho, bytes),
        };
      } catch (e) { /* arquivo com problema, tenta o proximo */ }
    }
  }

  // 3. fontes padrao do PDF
  return {
    origem: "padrao (aproximada)", padrao: fontePadrao(info.serifa, info.mono, negrito, italico),
    chave: "padrao", nome: "padrao", simularNegrito: false, simularItalico: false,
    css: cssPadrao(info.serifa, info.mono),
  };
}

// ------------------------------------------------------------------
// Abrir e desenhar o PDF
// ------------------------------------------------------------------

async function abrir(arquivo) {
  estado.nomeArquivo = arquivo.name || "documento.pdf";
  estado.bytes = new Uint8Array(await arquivo.arrayBuffer());
  estado.edicoes.clear();
  estado.paginas = [];
  $("vazio").hidden = true;
  const folhas = $("folhas");
  folhas.innerHTML = '<p class="carregando">Abrindo o PDF...</p>';

  try {
    estado.pdf = await pdfjsLib.getDocument({ data: estado.bytes.slice(), fontExtraProperties: true }).promise;
  } catch (e) {
    folhas.innerHTML = '<p class="carregando">Não consegui abrir esse arquivo. Ele pode estar protegido por senha ou danificado.</p>';
    return;
  }
  folhas.innerHTML = "";
  const largura = Math.min(folhas.clientWidth - 16, 980);
  for (let p = 1; p <= estado.pdf.numPages; p++) {
    await desenharPagina(p, largura);
  }
  $("bTrocar").disabled = false;
  atualizarBotaoSalvar();
  const total = estado.paginas.reduce((s, pg) => s + pg.itens.length, 0);
  if (!total) dica("Esse PDF não tem texto editável (pode ser uma imagem escaneada).", 5000);
  else dica("Toque em um texto para editar.");
}

async function desenharPagina(numero, largura) {
  const pagina = await estado.pdf.getPage(numero);
  const base = pagina.getViewport({ scale: 1 });
  const escala = largura / base.width;
  const viewport = pagina.getViewport({ scale: escala });
  const dpr = window.devicePixelRatio || 1;

  const caixa = document.createElement("div");
  caixa.className = "pagina";
  caixa.style.width = viewport.width + "px";
  caixa.style.height = viewport.height + "px";
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  const camada = document.createElement("div");
  camada.className = "camada";
  caixa.append(canvas, camada);
  $("folhas").append(caixa);

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  await pagina.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;

  const conteudo = await pagina.getTextContent();
  const registro = { numero, pagina, viewport, canvas, ctx, dpr, escala, itens: [] };
  estado.paginas.push(registro);

  conteudo.items.forEach((it) => {
    if (!it.str || !it.str.trim()) return;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) return; // so texto reto
    const tamanho = Math.hypot(a, b);
    const [vx, vy] = viewport.convertToViewportPoint(e, f);
    const item = {
      indice: registro.itens.length,
      texto: it.str, x: e, y: f, tamanho, largura: it.width,
      tela: { x: vx, y: vy, w: it.width * escala, t: tamanho * escala },
      fonteInfo: lerInfoFonte(pagina, it.fontName, conteudo.styles[it.fontName]),
    };
    registro.itens.push(item);

    const el = document.createElement("span");
    el.className = "trecho";
    el.tabIndex = 0;
    el.style.left = vx + "px";
    el.style.top = vy - item.tela.t * 0.9 + "px";
    el.style.width = Math.max(item.tela.w, 6) + "px";
    el.style.height = item.tela.t * 1.15 + "px";
    el.addEventListener("click", () => abrirEdicao(registro, item, el));
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") abrirEdicao(registro, item, el); });
    item.el = el;
    camada.append(el);
  });
}

function lerInfoFonte(pagina, idFonte, estilo) {
  let obj = null;
  try { obj = pagina.commonObjs.get(idFonte); } catch (e) { /* ainda nao carregada */ }
  const nome = (obj && obj.name) || (estilo && estilo.fontFamily) || "";
  const sep = separarNome(nome);
  const familiaCss = (estilo && estilo.fontFamily) || "";
  return {
    nome,
    nomeCurto: nome.split("+").pop() || "desconhecida",
    familia: sep.familia,
    negrito: sep.negrito || !!(obj && (obj.bold || obj.black)),
    italico: sep.italico || !!(obj && obj.italic),
    serifa: !!(obj && obj.isSerifFont) || /serif/.test(familiaCss) && !/sans/.test(familiaCss),
    mono: !!(obj && obj.isMonospace) || /monospace/.test(familiaCss),
    dados: obj && obj.data ? new Uint8Array(obj.data) : null,
  };
}

// ------------------------------------------------------------------
// Cores: olha os pixels em volta e dentro do trecho
// ------------------------------------------------------------------

function amostrarCores(reg, item) {
  const { ctx, dpr, canvas } = reg;
  const x0 = Math.max(0, Math.floor((item.tela.x - 2) * dpr));
  const x1 = Math.min(canvas.width - 1, Math.ceil((item.tela.x + item.tela.w + 2) * dpr));
  const yTopo = Math.max(0, Math.floor((item.tela.y - item.tela.t * 1.05) * dpr));
  const yBase = Math.min(canvas.height - 1, Math.ceil((item.tela.y + item.tela.t * 0.35) * dpr));
  const w = Math.max(1, x1 - x0), h = Math.max(1, yBase - yTopo);
  const px = ctx.getImageData(x0, yTopo, w, h).data;

  // fundo: cor mais comum na borda da caixa
  const contagem = new Map();
  const somar = (i) => {
    const k = (px[i] >> 3) + "," + (px[i + 1] >> 3) + "," + (px[i + 2] >> 3);
    const atual = contagem.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    atual.n++; atual.r += px[i]; atual.g += px[i + 1]; atual.b += px[i + 2];
    contagem.set(k, atual);
  };
  for (let x = 0; x < w; x++) { somar(x * 4); somar(((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y++) { somar(y * w * 4); somar((y * w + w - 1) * 4); }
  let fundo = { n: 0, r: 255, g: 255, b: 255 };
  for (const v of contagem.values()) if (v.n > fundo.n) fundo = v;
  const bg = fundo.n ? [fundo.r / fundo.n, fundo.g / fundo.n, fundo.b / fundo.n] : [255, 255, 255];

  // texto: pixel mais diferente do fundo
  let melhor = 0, tinta = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    const dist = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
    if (dist > melhor) { melhor = dist; tinta = [px[i], px[i + 1], px[i + 2]]; }
  }
  return { fundo: bg.map((v) => v / 255), tinta: tinta.map((v) => v / 255) };
}

// ------------------------------------------------------------------
// Edicao
// ------------------------------------------------------------------

function abrirEdicao(reg, item, el) {
  const chave = `${reg.numero}:${item.indice}`;
  const ed = estado.edicoes.get(chave);
  estado.atual = { reg, item, el, chave };
  $("tEdicao").value = ed ? ed.novo : item.texto;
  const f = item.fonteInfo;
  const estilo = [f.negrito && "negrito", f.italico && "itálico"].filter(Boolean).join(", ");
  $("infoFonte").textContent =
    `Fonte: ${f.nomeCurto} · ${item.tamanho.toFixed(1).replace(".", ",")} pt${estilo ? " · " + estilo : ""}`;
  $("bDesfazer").hidden = !ed;
  $("fundo").classList.add("on");
  $("edicao").classList.add("on");
  setTimeout(() => $("tEdicao").focus(), 50);
}

function fecharEdicao() {
  $("fundo").classList.remove("on");
  $("edicao").classList.remove("on");
  estado.atual = null;
}

async function aplicarTexto(reg, item, novo) {
  const chave = `${reg.numero}:${item.indice}`;
  let ed = estado.edicoes.get(chave);
  if (!ed) {
    ed = { reg, item, cores: amostrarCores(reg, item), larguraCoberta: item.tela.w };
    estado.edicoes.set(chave, ed);
  }
  ed.novo = novo;
  ed.fonte = await escolherFonte(item, novo);
  desenharPrevia(ed);
  item.el.classList.add("editado");
  atualizarBotaoSalvar();
  return ed;
}

// Mostra a troca na tela (o PDF final e gerado so ao salvar)
function desenharPrevia(ed) {
  const { reg, item, cores, fonte } = ed;
  const { ctx, dpr } = reg;
  const t = item.tela.t;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = fonte.css || cssPadrao(item.fonteInfo.serifa, item.fonteInfo.mono);
  const peso = item.fonteInfo.negrito ? "bold" : "normal";
  const inclin = item.fonteInfo.italico ? "italic" : "normal";
  ctx.font = `${inclin} ${peso} ${t}px ${css}`;
  const larguraNova = ctx.measureText(ed.novo).width;
  ed.larguraCoberta = Math.max(ed.larguraCoberta, larguraNova, item.tela.w);
  ctx.fillStyle = rgbCss(cores.fundo);
  ctx.fillRect(item.tela.x - t * 0.05, item.tela.y - t * 0.95, ed.larguraCoberta + t * 0.15, t * 1.25);
  ctx.fillStyle = rgbCss(cores.tinta);
  ctx.textBaseline = "alphabetic";
  ctx.fillText(ed.novo, item.tela.x, item.tela.y);
  ctx.restore();
  item.el.style.width = Math.max(ed.larguraCoberta, 6) + "px";
  ed.passouLargura = larguraNova > item.tela.w * 1.05;
}

const rgbCss = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;

async function desfazer(reg, item) {
  const chave = `${reg.numero}:${item.indice}`;
  if (!estado.edicoes.has(chave)) return;
  estado.edicoes.delete(chave);
  item.el.classList.remove("editado");
  item.el.style.width = Math.max(item.tela.w, 6) + "px";
  // redesenha a pagina original e reaplica as outras trocas dela
  const { pagina, viewport, ctx, dpr, canvas } = reg;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  await pagina.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
  for (const ed of estado.edicoes.values()) if (ed.reg === reg) desenharPrevia(ed);
  atualizarBotaoSalvar();
}

async function trocarEmTudo(antigo, novo) {
  if (!antigo) return dica("Escreva o texto atual.");
  let n = 0;
  for (const reg of estado.paginas) {
    for (const item of reg.itens) {
      const chave = `${reg.numero}:${item.indice}`;
      const atual = estado.edicoes.has(chave) ? estado.edicoes.get(chave).novo : item.texto;
      if (!atual.includes(antigo)) continue;
      await aplicarTexto(reg, item, atual.split(antigo).join(novo));
      n++;
    }
  }
  dica(n ? `${n} trecho(s) trocado(s).` : "Não encontrei esse texto. Confira maiúsculas e espaços.");
}

function atualizarBotaoSalvar() {
  $("bSalvar").disabled = estado.edicoes.size === 0;
  $("bSalvar").textContent = estado.edicoes.size ? `Salvar (${estado.edicoes.size})` : "Salvar";
}

// ------------------------------------------------------------------
// Salvar o PDF novo
// ------------------------------------------------------------------

async function salvar() {
  if (!estado.edicoes.size) return;
  $("bSalvar").disabled = true;
  dica("Gerando o PDF...", 60000);
  try {
    const { PDFDocument, rgb, degrees } = PDFLib;
    const doc = await PDFDocument.load(estado.bytes, { ignoreEncryption: true });
    doc.registerFontkit(fontkit);
    const embutidas = new Map();
    const pegarFonte = async (fonte) => {
      const chave = fonte.padrao || fonte.chave;
      if (!embutidas.has(chave)) {
        embutidas.set(chave, fonte.padrao
          ? doc.embedFont(fonte.padrao)
          : doc.embedFont(fonte.bytes, { subset: true }));
      }
      return embutidas.get(chave);
    };

    const paginasPdf = doc.getPages();
    let simuladas = 0, largas = 0;
    for (const ed of estado.edicoes.values()) {
      const { item, cores, fonte } = ed;
      const pagina = paginasPdf[ed.reg.numero - 1];
      let font;
      try {
        font = await pegarFonte(fonte);
      } catch (e) {
        // se a fonte nao puder ser gravada, usa a padrao parecida
        const i = item.fonteInfo;
        font = await pegarFonte({ padrao: fontePadrao(i.serifa, i.mono, i.negrito, i.italico) });
      }
      const s = item.tamanho;
      const larguraNova = font.widthOfTextAtSize(ed.novo, s);
      const largura = Math.max(item.largura, larguraNova, ed.larguraCoberta / ed.reg.escala);

      pagina.drawRectangle({
        x: item.x - s * 0.05, y: item.y - s * 0.3,
        width: largura + s * 0.15, height: s * 1.25,
        color: rgb(...cores.fundo), borderWidth: 0,
      });

      const passos = fonte.simularNegrito ? [0, s * 0.018, s * 0.036] : [0];
      for (const dx of passos) {
        pagina.drawText(ed.novo, {
          x: item.x + dx, y: item.y, size: s, font,
          color: rgb(...cores.tinta),
          xSkew: fonte.simularItalico ? degrees(12) : undefined,
        });
      }
      if (fonte.simularNegrito || fonte.simularItalico) simuladas++;
      if (larguraNova > item.largura * 1.05) largas++;
    }

    const saida = await doc.save();
    const nome = estado.nomeArquivo.replace(/\.pdf$/i, "") + "-editado.pdf";
    entregar(new Blob([saida], { type: "application/pdf" }), nome);
    const avisos = [];
    if (simuladas) avisos.push(`${simuladas} com negrito/itálico simulado`);
    if (largas) avisos.push(`${largas} ficou(aram) mais largo(s) que o original`);
    dica("PDF salvo." + (avisos.length ? " " + avisos.join("; ") + "." : ""), 5000);
  } catch (e) {
    console.error(e);
    dica("Não consegui gerar o PDF: " + (e.message || e), 6000);
  } finally {
    atualizarBotaoSalvar();
  }
}

async function entregar(blob, nome) {
  const arquivo = new File([blob], nome, { type: "application/pdf" });
  // no Android, oferece compartilhar (WhatsApp, Drive, e-mail...)
  if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
    try { await navigator.share({ files: [arquivo], title: nome }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ------------------------------------------------------------------
// Interface
// ------------------------------------------------------------------

let timerDica;
function dica(texto, ms = 2500) {
  const el = $("dica");
  el.textContent = texto;
  el.classList.add("on");
  clearTimeout(timerDica);
  timerDica = setTimeout(() => el.classList.remove("on"), ms);
}

$("bAbrir").addEventListener("click", () => $("arquivo").click());
$("bAbrir2").addEventListener("click", () => $("arquivo").click());
$("arquivo").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) abrir(f);
  e.target.value = "";
});
$("bTrocar").addEventListener("click", () => {
  $("barraTrocar").classList.toggle("on");
  if ($("barraTrocar").classList.contains("on")) $("tAntigo").focus();
});
$("bTrocarTudo").addEventListener("click", () => trocarEmTudo($("tAntigo").value, $("tNovo").value));
$("bSalvar").addEventListener("click", salvar);
$("bCancelar").addEventListener("click", fecharEdicao);
$("fundo").addEventListener("click", fecharEdicao);
$("bAplicar").addEventListener("click", async () => {
  const a = estado.atual;
  if (!a) return;
  fecharEdicao();
  const ed = await aplicarTexto(a.reg, a.item, $("tEdicao").value);
  const f = ed.fonte;
  let msg = `Fonte usada: ${f.nome} (${f.origem})`;
  if (f.simularNegrito) msg += ", negrito simulado";
  if (f.simularItalico) msg += ", itálico simulado";
  if (ed.passouLargura) msg += ". Atenção: ficou mais largo";
  dica(msg, 4000);
});
$("bDesfazer").addEventListener("click", async () => {
  const a = estado.atual;
  fecharEdicao();
  if (a) await desfazer(a.reg, a.item);
});
$("tEdicao").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("bAplicar").click(); }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
}
