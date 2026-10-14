// A filled form (shared/forms.js) as a fillable PDF: text fields, checkboxes and real signature fields, so it can be
// completed and digitally signed in any PDF reader (the signature check then recognises the signers).
// pdf-lib is vendored (public/vendor) and loaded only here, on demand: nothing comes from third-party servers.
// ponytail: standard Helvetica only covers Western European letters (WinAnsi), others become their base letter or "?";
// embed a TTF via @pdf-lib/fontkit if names from other scripts show up.

const A4 = [595.28, 841.89];
const M = 56;              // side margin
const BOTTOM = 78;         // room for the footer
const GAP = 14;            // between two half-width fields

const hexColor = (rgb, s, fallback) => (/^#[0-9a-f]{6}$/i.test(s ?? '') ? rgb(...[1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255)) : fallback);

// form: a filled form (shared/forms.js) plus the workspace's look (accent "#rrggbb", logo as PNG/JPEG data URL),
// template name and date for the footer.
import { fieldNames } from './shared/forms.js';

export async function formPdf(form) {
  const { PDFDocument, PDFHexString, StandardFonts, rgb, setCharacterSpacing } = await import('./vendor/pdf-lib.esm.min.js');
  const doc = await PDFDocument.create();
  const [font, bold] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold)]);
  const pdfForm = doc.getForm();
  const C = {
    ink: rgb(0.11, 0.13, 0.16), muted: rgb(0.42, 0.45, 0.5), line: rgb(0.85, 0.87, 0.9), fill: rgb(0.953, 0.961, 0.969), white: rgb(1, 1, 1),
    accent: hexColor(rgb, form.accent, rgb(0.06, 0.43, 0.47)),
  };
  const [W, H] = A4, CW = W - 2 * M;

  // Text in what the standard font can show; wrapped to a width.
  const chars = new Set(font.getCharacterSet());
  const BASE = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', ı: 'i', Ħ: 'H', ħ: 'h' }; // letters without a decomposition
  const safe = s => [...String(s ?? '').normalize('NFC').replace(/\t/g, ' ')].map(ch => (ch === '\n' || chars.has(ch.codePointAt(0)) ? ch
    : BASE[ch] ?? [...ch.normalize('NFD')].find(c => chars.has(c.codePointAt(0))) ?? '?')).join('');
  const wrap = (text, f, size, width) => safe(text).split('\n').flatMap(par => {
    const lines = [];
    let line = '';
    for (const word of par.split(/ +/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (!line || f.widthOfTextAtSize(next, size) <= width) line = next;
      else { lines.push(line); line = word; }
    }
    return [...lines, line];
  });
  const fit = (text, f, size, width) => { let s = safe(text); while (s.length > 1 && f.widthOfTextAtSize(s, size) > width) s = `${s.slice(0, -2)}…`; return s; };

  const nameList = fieldNames(form);
  const names = new Map(form.items.map((it, i) => [it, nameList[i]]));
  let page, y;
  const pages = [];
  const text = (s, x, yy, { size = 9.5, f = font, color = C.ink, spacing = 0 } = {}) => {
    if (spacing) page.pushOperators(setCharacterSpacing(spacing));
    page.drawText(safe(s), { x, y: yy, size, font: f, color });
    if (spacing) page.pushOperators(setCharacterSpacing(0));
  };
  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: C.accent });
    if (pages.length > 1) {
      text(fit(form.title, bold, 8, CW), M, H - 34, { size: 8, f: bold, color: C.muted });
      y = H - 58;
    }
  };

  // Head of the first page: logo (top right), who issues it, title, subtitle. Text with letter spacing is that much wider.
  newPage();
  y = H - 40;
  let logo = null;
  const image = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(form.logo ?? '');
  try {
    const bytes = image && Uint8Array.from(atob(image[2]), c => c.charCodeAt(0));
    if (bytes) logo = image[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch (e) { console.warn('Logo nicht lesbar:', e); } // the form works without it
  if (logo) {
    const h = 46, w = Math.min(logo.width * (h / logo.height), CW * 0.62);
    page.drawImage(logo, { x: W - M - w, y: H - 30 - w * (logo.height / logo.width), width: w, height: w * (logo.height / logo.width) });
    y = H - 30 - h - 4;
  }
  const tpl = form.template && !logo ? fit(form.template, font, 7.5, CW * 0.3) : '';
  if (tpl) text(tpl, W - M - font.widthOfTextAtSize(tpl, 7.5), y, { size: 7.5, color: C.muted });
  if (form.header) {
    let h = safe(form.header).toUpperCase();
    const room = CW - font.widthOfTextAtSize(tpl, 7.5) - 20, wide = t => font.widthOfTextAtSize(t, 7.5) + 0.9 * t.length;
    while (h.length > 1 && wide(h) > room) h = `${h.slice(0, -2)}…`;
    text(h, M, y, { size: 7.5, color: C.muted, spacing: 0.9 });
  }
  y -= logo ? 40 : 36;
  for (const line of wrap(form.title, bold, 21, CW)) { text(line, M, y, { size: 21, f: bold }); y -= 25; }
  if (form.subtitle) { y += 4; for (const line of wrap(form.subtitle, font, 10, CW)) { text(line, M, y, { size: 10, color: C.muted }); y -= 14; } }
  y += 4;

  // Every block is drawn from y (its top) downwards and knows its height, so related blocks can be kept on one page.
  let section = 0;
  const HEADING = 40;
  const heading = it => {
    y -= 22;
    section += 1;
    page.drawCircle({ x: M + 8, y: y + 3.5, size: 8.5, color: C.accent });
    const n = String(section);
    text(n, M + 8 - bold.widthOfTextAtSize(n, 8.5) / 2, y + 0.6, { size: 8.5, f: bold, color: C.white });
    text(fit(it.heading.toUpperCase(), bold, 10, CW - 170), M + 25, y, { size: 10, f: bold, spacing: 0.6 });
    if (it.hint) {
      const h = fit(it.hint, font, 7, 150), w = font.widthOfTextAtSize(h, 7) + 14;
      page.drawRectangle({ x: W - M - w, y: y - 3.5, width: w, height: 14, color: C.fill, borderColor: C.line, borderWidth: 0.6 });
      text(h, W - M - w + 7, y + 0.6, { size: 7, color: C.muted });
    }
    y -= 10;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: C.line });
    y -= 8;
  };

  const paragraphLines = it => wrap(it.text, font, 9.5, CW);
  const paragraph = it => {
    paragraphLines(it).forEach((line, i) => text(line, M, y - 12 - i * 13.5, { size: 9.5 }));
    y -= paragraphLines(it).length * 13.5 + 8;
  };

  // A row of one or two cells: text fields (label above, a soft box with an accent rule below) or checkboxes.
  const boxHeight = it => ((it.lines ?? 1) > 1 ? it.lines * 13 + 8 : 22);
  const cellHeight = (it, width) => (it.check ? wrap(it.label, font, 9.5, width - 19).length * 13.5 + 12 : 22 + boxHeight(it) + 6);
  const underline = (x, by, width) => page.drawLine({ start: { x, y: by - 0.5 }, end: { x: x + width, y: by - 0.5 }, thickness: 1, color: C.ink });
  const field = (it, x, width, top) => {
    const h = boxHeight(it), by = top - 22 - h;
    text(fit(it.label, font, 7.5, width), x, top - 17, { size: 7.5, color: C.muted });
    const tf = pdfForm.createTextField(names.get(it).value);
    if ((it.lines ?? 1) > 1) tf.enableMultiline();
    tf.setText(safe(it.value ?? ''));
    tf.addToPage(page, { x, y: by, width, height: h, font, textColor: C.ink, backgroundColor: C.fill, borderWidth: 0 });
    tf.setFontSize(10);
    underline(x, by, width);
  };
  const checkbox = (it, x, width, top) => {
    const cb = pdfForm.createCheckBox(names.get(it).value);
    cb.addToPage(page, { x, y: top - 21, width: 11, height: 11, borderColor: C.muted, borderWidth: 0.8, backgroundColor: C.white, textColor: C.accent });
    if (it.checked) cb.check();
    wrap(it.label, font, 9.5, width - 19).forEach((line, i) => text(line, x + 19, top - 19 - i * 13.5, { size: 9.5 }));
  };
  const cellWidth = row => (row.length > 1 ? (CW - GAP) / 2 : CW);
  const cells = row => {
    row.forEach((it, i) => (it.check ? checkbox : field)(it, M + i * (cellWidth(row) + GAP), cellWidth(row), y));
    y -= Math.max(...row.map(it => cellHeight(it, cellWidth(row))));
  };

  // Place and date, a signature field that PDF readers offer for a digital signature (or print and sign by hand), and the
  // signer's name – a field too, like every value from the case, so it can be corrected.
  const SIGNATURE = 72;
  const signature = it => {
    const h = 38, dateW = 150, sigX = M + dateW + GAP, sigW = CW - dateW - GAP, by = y - 12 - h;
    const place = pdfForm.createTextField(names.get(it).place);
    place.setText(it.place ? safe(`${it.place}, `) : '');
    place.addToPage(page, { x: M, y: by, width: dateW, height: h, font, textColor: C.ink, backgroundColor: C.fill, borderWidth: 0 });
    place.setFontSize(10);
    page.drawRectangle({ x: sigX, y: by, width: sigW, height: h, color: C.fill });
    const sig = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFHexString.fromText(names.get(it).sign), F: 4, P: page.ref, Rect: [sigX, by, sigX + sigW, by + h],
    }));
    page.node.addAnnot(sig);
    pdfForm.acroForm.addField(sig);
    underline(M, by, dateW);
    underline(sigX, by, sigW);
    text('Ort, Datum', M, by - 12, { size: 7.5, color: C.muted });
    const label = fit(it.sign, font, 7.5, sigW * 0.55), lw = font.widthOfTextAtSize(label, 7.5);
    text(label, sigX, by - 12, { size: 7.5, color: C.muted });
    const who = pdfForm.createTextField(names.get(it).name);
    who.setText(safe(it.name ?? ''));
    who.addToPage(page, { x: sigX + lw + 4, y: by - 17, width: sigW - lw - 4, height: 14, font: bold, textColor: C.ink, backgroundColor: undefined, borderColor: undefined, borderWidth: 0 });
    who.setFontSize(7.5);
    y -= SIGNATURE;
  };

  // Items into rows (two half-width cells side by side), then each row with its height and how to draw it.
  const rows = [];
  for (let i = 0; i < form.items.length; i++) {
    const it = form.items[i], next = form.items[i + 1];
    rows.push(it.label && it.half && next?.label && next.half ? [it, form.items[++i]] : [it]);
  }
  const heightOf = ([it, ...rest]) => (it.heading ? HEADING : it.text ? paragraphLines(it).length * 13.5 + 8 : it.sign ? SIGNATURE
    : Math.max(...[it, ...rest].map(c => cellHeight(c, cellWidth([it, ...rest])))));
  const draw = row => (row[0].heading ? heading(row[0]) : row[0].text ? paragraph(row[0]) : row[0].sign ? signature(row[0]) : cells(row));
  // What has to stay on one page with row i: a heading with the block below it, a statement with the signature
  // that confirms it (up to two rows on). Groups taller than a page simply flow on.
  const groupEnd = i => {
    if (rows[i][0].heading) return i + 1 < rows.length ? groupEnd(i + 1) : i;
    const sign = rows.findIndex((r, k) => k >= i && k <= i + 2 && r[0].sign);
    return sign >= 0 && !rows.slice(i, sign).some(r => r[0].heading) ? sign : i;
  };
  rows.forEach((row, i) => {
    const height = rows.slice(i, groupEnd(i) + 1).reduce((sum, r) => sum + heightOf(r), 0);
    if (y - height < BOTTOM && height < H - 140 - BOTTOM) newPage();
    else if (y - heightOf(row) < BOTTOM) newPage();
    draw(row);
  });

  // Footer on every page: where the form comes from and what to do with it.
  pages.forEach((p, i) => {
    page = p;
    p.drawLine({ start: { x: M, y: 50 }, end: { x: W - M, y: 50 }, thickness: 0.6, color: C.line });
    const n = `Seite ${i + 1} von ${pages.length}`;
    text(n, W - M - font.widthOfTextAtSize(n, 7), 38, { size: 7, color: C.muted });
    if (form.template) text(fit(form.template, font, 7, CW - 80), M, 38, { size: 7, color: C.muted });
    text(`Erzeugt mit NomoCase${form.created ? ` am ${form.created}` : ''} – ausgefüllt und unterschrieben im Vorgang hochladen.`, M, 28, { size: 7, color: C.muted });
  });

  doc.setTitle(safe(form.title), { showInWindowTitleBar: true });
  doc.setCreator('NomoCase');
  doc.setProducer('NomoCase (pdf-lib)');
  doc.setLanguage('de-DE');
  return doc.save();
}

// Offers the bytes as a file download in the browser.
export function saveFile(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const formFilename = f => `${[f.title, f.case_title].filter(Boolean).join(' – ')}.pdf`.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 150);
