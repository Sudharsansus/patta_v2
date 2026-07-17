/**
 * FMB Extractor — extract FMB Map URL from chitta HTML
 * ──────────────────────────────────────────────────────
 * TNSERVICES chitta HTML embeds the FMB map as:
 *   <embed src="https://collabland-tn.gov.in/CollabLandService/ApprovedMap/ViewMap/pdf/-FbwxwoWxr8SiupYntng0A">
 *
 * This module extracts that URL and returns a clean FMB object:
 *   { fmbUrl, fmbHash, canEmbed: true }
 *
 * Hashes are unique per chitta. Examples:
 *   Ariyalur 597 Survey 1/1A: -FbwxwoWxr8SiupYntng0A
 *   Andimadam 2689 Survey 1/2: 0vZg0vAGQzTzq3hhddSYsA
 *
 * Usage:
 *   const { extractFmb } = require('./fmb-extractor');
 *   const fmb = extractFmb(chittaHtml);
 *   if (fmb) embedInApp(fmb.fmbUrl);
 */

'use strict';

const FMB_PATTERNS = [
  /<embed[^>]+src=["'](https?:\/\/collabland-tn\.gov\.in\/[^"']+?pdf\/([^"'/?#]+))["']/i,
  /<iframe[^>]+src=["'](https?:\/\/collabland-tn\.gov\.in\/[^"']+?pdf\/([^"'/?#]+))["']/i,
  /<img[^>]+src=["'](https?:\/\/collabland-tn\.gov\.in\/[^"']+?pdf\/([^"'/?#]+))["']/i,
  /(https?:\/\/collabland-tn\.gov\.in\/CollabLandService\/ApprovedMap\/[^"'\s<>]+?pdf\/([^"'/?#\s<>]+))/i,
];

function extractFmb(html) {
  if (!html || typeof html !== 'string') return null;
  for (const re of FMB_PATTERNS) {
    const m = html.match(re);
    if (m) {
      const [, fmbUrl, fmbHash] = m;
      return { fmbUrl, fmbHash, canEmbed: true };
    }
  }
  return null;
}

function extractRnoFromChitta(html) {
  if (!html) return null;
  const m = html.match(/<input[^>]+name=["']?chkrno["']?[^>]+value=["']([^"']+)["']/i)
         || html.match(/var\s+chkrno\s*=\s*["']([^"']+)["']/i)
         || html.match(/chkrno\s*[:=]\s*["']([A-Za-z0-9+/=]+)["']/i);
  return m ? m[1] : null;
}

function extractRefId(html) {
  if (!html) return null;
  const m = html.match(/S\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  return m ? { district: m[1], taluk: m[2], village: m[3], patta: m[4], unique: m[5] } : null;
}

function extractOwners(html) {
  // Tamil owner rows from the chitta table
  if (!html) return [];
  const owners = [];
  const re = /<tr[^>]*>\s*<td[^>]*>(\d+)\.\s*<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    owners.push({
      index: m[1],
      name: m[2].trim(),
      relation: m[3].trim(),
      fatherOrHusbandName: m[4].trim(),
    });
  }
  return owners;
}

module.exports = { extractFmb, extractRnoFromChitta, extractRefId, extractOwners };
