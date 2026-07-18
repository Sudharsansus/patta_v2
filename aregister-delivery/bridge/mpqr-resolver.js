/**
 * MPQR → TNS Code Resolver
 * ─────────────────────────
 * Resolves MyPropertyQR's UUID identifiers to TNSERVICES codes
 * (district: 2-digit, taluk: 2-digit + /Y suffix, village: 3-digit).
 *
 * Input: MyPropertyQR payload with:
 *   districtId: "0197f00f-8939-7d6e-ae45-0349bad53258"
 *   districtName: "Salem"
 *   talukId: "0197f013-9f49-769b-80dd-7d8c2f138489"
 *   talukName: "Edappady"
 *   villageId: "0197f01c-f2c0-71aa-9644-47e3ed10b889"
 *   villageName: "Pulampatti"
 *
 * Output:
 *   districtCode: "08"
 *   talukCode: "07"  (with /Y added by tns-client)
 *   villageCode: "010"
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Load CSV at module load
let csvData = null;
function loadCSV() {
  if (csvData) return csvData;
  const csvPath = path.join(__dirname, '..', 'data', 'tn-districts.csv');
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const header = lines[0].split(',');
  csvData = lines.slice(1).map(l => {
    const cols = l.split(',');
    return {
      district: cols[0]?.trim(),
      districtName: cols[1]?.trim(),
      taluk: cols[2]?.trim(),
      talukName: cols[3]?.trim(),
      village: cols[4]?.trim(),
      villageName: cols[5]?.trim(),
    };
  });
  return csvData;
}

// Simple lookup by name (faster than UUID reverse-lookup)
function lookupByNames(districtName, talukName, villageName) {
  const rows = loadCSV();
  const districtNameLower = (districtName || '').toLowerCase();
  const talukNameLower = (talukName || '').toLowerCase();
  const villageNameLower = (villageName || '').toLowerCase();

  // First pass: exact match
  for (const r of rows) {
    if (r.districtName.toLowerCase() === districtNameLower &&
        r.talukName.toLowerCase() === talukNameLower &&
        r.villageName.toLowerCase() === villageNameLower) {
      return r;
    }
  }
  // Second pass: village + taluk match (district-name might be a variant)
  for (const r of rows) {
    if (r.talukName.toLowerCase() === talukNameLower &&
        r.villageName.toLowerCase() === villageNameLower) {
      return r;
    }
  }
  return null;
}

// Build a nested district → taluk → village tree for dashboard dropdowns.
function getDistrictsTree() {
  const rows = loadCSV();
  const districts = new Map();
  for (const r of rows) {
    if (!r.district) continue;
    if (!districts.has(r.district)) {
      districts.set(r.district, { code: r.district, name: r.districtName, taluks: new Map() });
    }
    const d = districts.get(r.district);
    if (!d.taluks.has(r.taluk)) {
      d.taluks.set(r.taluk, { code: r.taluk, name: r.talukName, villages: new Map() });
    }
    const t = d.taluks.get(r.taluk);
    if (!t.villages.has(r.village)) {
      t.villages.set(r.village, { code: r.village, name: r.villageName });
    }
  }
  return [...districts.values()]
    .map(d => ({
      code: d.code,
      name: d.name,
      taluks: [...d.taluks.values()].map(t => ({
        code: t.code,
        name: t.name,
        villages: [...t.villages.values()],
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resolveMPQR(payload = {}) {
  if (payload.districtCode || payload.talukCode || payload.villageCode) {
    const survey = {
      districtCode: payload.districtCode,
      talukCode: payload.talukCode,
      villageCode: payload.villageCode,
      surveyNo: payload.surveyNo || payload.surveyNumber,
      subDivNo: payload.subDivNo || payload.subDivisionNumber || '1',
      landType: payload.landType || 'R',
      viewOpt: payload.viewOpt || 'sur',
      nflag: payload.nflag || 'Y',
      mobile: payload.mobile,
    };

    if (payload.districtCode && payload.talukCode && payload.villageCode) {
      return survey;
    }

    if (payload.districtCode && payload.talukCode) {
      return survey;
    }

    if (payload.districtCode) {
      return survey;
    }
  }

  // Prefer name-based lookup (CSV is the source of truth)
  const row = lookupByNames(
    payload.districtName,
    payload.talukName,
    payload.villageName
  );
  if (!row) {
    throw new Error(
      'Cannot resolve: ' + payload.districtName + ' / ' +
      payload.talukName + ' / ' + payload.villageName
    );
  }
  return {
    districtCode: row.district,
    talukCode: row.taluk,
    villageCode: row.village,
    surveyNo: payload.surveyNumber || payload.surveyNo,
    subDivNo: payload.subDivisionNumber || payload.subDivNo || '1',
    landType: payload.landType || 'R',
    viewOpt: payload.viewOpt || 'sur',
    nflag: payload.nflag || 'Y',
    mobile: payload.mobile,
  };
}

module.exports = { resolveMPQR, lookupByNames, getDistrictsTree };
