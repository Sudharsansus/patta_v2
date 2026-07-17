'use strict';

const axios = require('axios');
const { chromium } = require('playwright');
const { launchBrowser } = require('./browser-launcher');
const { insecureAgent } = require('./http-agent');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const A4 = [595.28, 841.89];
const FMB_HOST = 'collabland-tn.gov.in';
const MAX_FMB_BYTES = 25 * 1024 * 1024;

/**
 * Generate one PDF in production order: branded front page, Chromium-rendered
 * Chitta table, then the FMB sketch supplied by TNSERVICES.
 */
async function generateMergedPdf({
  chittaHtml,
  chittaPdf,
  fmbSketchUrl,
  brandName = process.env.PDF_BRAND_NAME || 'MyPropertyQR',
  brandTagline = process.env.PDF_BRAND_TAGLINE || 'Government of Tamil Nadu',
  district,
  taluk,
  village,
  surveyNo,
  subdivNo,
}) {
  // Kick off the FMB sketch fetch (up to ~15s on a slow tail) IMMEDIATELY so it
  // overlaps the front-page + chitta assembly below instead of running after them.
  // .catch is attached at creation so a sketch failure degrades to null (no
  // unhandled rejection) and never aborts the usable front+chitta PDF.
  const fmbPromise = fmbSketchUrl
    ? downloadFmbSketch(fmbSketchUrl).catch((error) => {
      console.warn('[pdf] failed to fetch FMB sketch:', error.message);
      return null;
    })
    : Promise.resolve(null);

  const renderedChitta = chittaPdf
    ? toBuffer(chittaPdf, 'chittaPdf')
    : await renderChittaHtmlToPdf(chittaHtml);

  const merged = await PDFDocument.create();
  const frontBytes = await generateFrontPagePdf({
    brandName,
    brandTagline,
    district,
    taluk,
    village,
    surveyNo,
    subdivNo,
  });

  await appendPdf(merged, frontBytes, 'front page');
  await appendPdf(merged, renderedChitta, 'Chitta document');

  const sketchBytes = await fmbPromise;
  if (sketchBytes) {
    try {
      await appendPdf(merged, sketchBytes, 'FMB sketch');
    } catch (error) {
      // Production treats a bad FMB embed as optional; preserve the usable
      // front-page + Chitta PDF while making the omission visible in logs.
      console.warn('[pdf] failed to merge FMB sketch:', error.message);
    }
  }

  const bytes = await merged.save();
  return Buffer.from(bytes);
}

async function generateFrontPagePdf({
  brandName,
  brandTagline,
  district,
  taluk,
  village,
  surveyNo,
  subdivNo,
}) {
  const document = await PDFDocument.create();
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage(A4);
  const { width, height } = page.getSize();

  page.drawRectangle({
    x: 0,
    y: height - 86,
    width,
    height: 86,
    color: rgb(0.06, 0.71, 0.83),
  });
  page.drawText(toPdfText(brandName), {
    x: 40,
    y: height - 51,
    size: 24,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(toPdfText(brandTagline), {
    x: 40,
    y: height - 72,
    size: 11,
    font: regular,
    color: rgb(1, 1, 1),
  });

  page.drawText('Patta / Chitta / FMB', {
    x: 40,
    y: height / 2 + 42,
    size: 31,
    font: bold,
    color: rgb(0.06, 0.36, 0.55),
  });
  page.drawText('Issued by Government of Tamil Nadu', {
    x: 40,
    y: height / 2 + 7,
    size: 14,
    font: regular,
    color: rgb(0.4, 0.4, 0.4),
  });

  const details = [
    ['District', district],
    ['Taluk', taluk],
    ['Village', village],
    ['Survey', `${surveyNo || '-'} / ${subdivNo || '-'}`],
  ];
  details.forEach(([label, value], index) => {
    page.drawText(`${label}: ${toPdfText(value || '-')}`, {
      x: 40,
      y: height / 2 - 58 - (index * 23),
      size: 12,
      font: regular,
      color: rgb(0.12, 0.12, 0.12),
    });
  });

  page.drawLine({
    start: { x: 40, y: 90 },
    end: { x: width - 40, y: 90 },
    thickness: 0.75,
    color: rgb(0.82, 0.86, 0.88),
  });
  page.drawText(`Generated on ${new Date().toISOString()}`, {
    x: 40,
    y: 62,
    size: 9,
    font: regular,
    color: rgb(0.5, 0.5, 0.5),
  });

  return Buffer.from(await document.save());
}

/** Render HTML with Chromium; no placeholder page is ever produced. */
async function renderChittaHtmlToPdf(chittaHtml) {
  if (!chittaHtml || typeof chittaHtml !== 'string') {
    throw new Error('chittaHtml or chittaPdf is required');
  }

  let browser;
  try {
    browser = await launchBrowser({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.setContent(chittaHtml, {
      waitUntil: 'load',
      timeout: Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 30000),
    });
    // Let long cells wrap instead of overflowing, and keep tables within the page.
    await page.addStyleTag({
      content: `
        @page { size: A4; margin: 8mm; }
        html, body { margin: 0; padding: 0; }
        table { border-collapse: collapse; max-width: 100%; }
        td, th { word-break: break-word; overflow-wrap: anywhere; }
        img, embed { max-width: 100%; height: auto; }
      `,
    });
    // Measure the content's natural width and SCALE the whole page to fit A4 —
    // the old fixed `zoom:0.6` was in @media print but emulateMedia('screen')
    // disabled it, so wide tables clipped the right-side words. Dynamic scale
    // guarantees the full width is captured (smaller text, but nothing cut off).
    const contentWidth = await page.evaluate(() => Math.max(
      document.body ? document.body.scrollWidth : 0,
      document.documentElement ? document.documentElement.scrollWidth : 0, 1,
    ));
    const A4_PRINTABLE_PX = 780; // ~A4 width (794px @96dpi) minus ~8mm*2 margins
    const scale = Math.max(0.1, Math.min(1, A4_PRINTABLE_PX / contentWidth));
    const pdf = await page.pdf({ format: 'A4', printBackground: true, scale, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function downloadFmbSketch(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== FMB_HOST) {
    throw new Error(`Untrusted FMB sketch URL host: ${url.hostname || '(none)'}`);
  }
  if (!/^\/CollabLandService\/ApprovedMap(?:\/[^/]+)*\/pdf\//i.test(url.pathname)) {
    throw new Error('Unexpected FMB sketch URL path');
  }

  const response = await axios.get(url.href, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: MAX_FMB_BYTES,
    maxBodyLength: MAX_FMB_BYTES,
    // Shared keep-alive agent, TLS verification off ONLY for this allow-listed
    // government sketch host (mirrors the production requests.get(..., verify=False)).
    httpsAgent: insecureAgent,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const bytes = Buffer.from(response.data);
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('FMB endpoint did not return a PDF');
  }
  return bytes;
}

async function appendPdf(target, bytes, label) {
  try {
    const source = await PDFDocument.load(toBuffer(bytes, label), { ignoreEncryption: true });
    const pages = await target.copyPages(source, source.getPageIndices());
    if (!pages.length) throw new Error('contains no pages');
    pages.forEach((page) => target.addPage(page));
  } catch (error) {
    throw new Error(`Invalid ${label} PDF: ${error.message}`);
  }
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError(`${label} must be a Buffer, Uint8Array, or ArrayBuffer`);
}

// StandardFonts use WinAnsi. Replacing unsupported code points prevents a
// Tamil/Unicode place name from aborting the whole document generation.
function toPdfText(value) {
  return String(value == null ? '' : value).replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

module.exports = {
  generateMergedPdf,
  generateFrontPagePdf,
  renderChittaHtmlToPdf,
  downloadFmbSketch,
};
