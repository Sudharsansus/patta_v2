'use strict';

/**
 * PDF storage for the register module. Local dir by DEFAULT (LOCAL_PDF_DIR);
 * S3 only if S3_BUCKET + creds are set AND @aws-sdk/client-s3 is installed.
 * Key: register/<refId>.pdf.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

let _s3 = null; // null=unknown, false=unavailable, {client,lib}=ready
function _s3client() {
  if (_s3 !== null) return _s3;
  const { bucket, accessKey, secretKey } = config.s3;
  if (!bucket || !accessKey || !secretKey) { _s3 = false; return false; }
  try {
    const lib = require('@aws-sdk/client-s3');
    _s3 = {
      lib,
      client: new lib.S3Client({
        region: config.s3.region,
        endpoint: config.s3.endpoint,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      }),
    };
    return _s3;
  } catch (e) {
    console.warn('[register] S3 configured but @aws-sdk/client-s3 not installed — using local store');
    _s3 = false;
    return false;
  }
}

function _ensureLocalDir() {
  try { fs.mkdirSync(config.localPdfDir, { recursive: true }); return true; } catch (_) { return false; }
}

async function _streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Store the PDF; returns { url, storage }. `origin` is the request base for the local URL. */
async function putPdf(refId, buffer, origin = '') {
  const key = `register/${refId}.pdf`;
  const s3 = _s3client();
  if (s3) {
    await s3.client.send(new s3.lib.PutObjectCommand({
      Bucket: config.s3.bucket, Key: key, Body: buffer, ContentType: 'application/pdf',
    }));
    const base = config.s3.publicUrlBase || `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`;
    return { url: `${base}/${key}`, storage: 's3' };
  }
  if (!_ensureLocalDir()) throw new Error('storage unavailable');
  fs.writeFileSync(path.join(config.localPdfDir, `${refId}.pdf`), buffer);
  return { url: `${origin}/api/register/download/${refId}`, storage: 'local' };
}

/** Fetch a stored PDF buffer, or null. */
async function getPdf(refId) {
  const s3 = _s3client();
  if (s3) {
    try {
      const r = await s3.client.send(new s3.lib.GetObjectCommand({ Bucket: config.s3.bucket, Key: `register/${refId}.pdf` }));
      return await _streamToBuffer(r.Body);
    } catch (_) { return null; }
  }
  try { return fs.readFileSync(path.join(config.localPdfDir, `${refId}.pdf`)); } catch (_) { return null; }
}

/** True if we can persist a PDF at all (S3 ready, or local dir writable). */
function available() {
  if (_s3client()) return true;
  return _ensureLocalDir();
}

function backend() { return _s3client() ? 's3' : 'local'; }

module.exports = { putPdf, getPdf, available, backend };
