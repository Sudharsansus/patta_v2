'use strict';

/**
 * Register location dropdowns.
 *
 * Districts + revenue Taluks + revenue Villages come LIVE from the same government
 * source the patta service uses (bridge/tns-live.js → eservices.tn.gov.in), which
 * is already reverse-engineered and working. Only the SRO / registration-village
 * lists are TNREGINET-specific and remain stubbed until that portal is live-tuned.
 *
 * Cached in-memory (districts 6h, taluks/villages 1h).
 */
const config = require('./config');
const tnsLive = require('../bridge/tns-live');

// District → TNREGINET zone assignment (district NAMES come live; this only groups).
const ZONE_DEF = {
  1: { name: 'Chennai',    codes: ['01', '02', '03', '35', '04', '37', '36', '06', '07', '33', '05', '31'] },
  2: { name: 'Coimbatore', codes: ['12', '32', '10', '08', '09', '11'] },
  3: { name: 'Madurai',    codes: ['24', '25', '13', '26', '27', '23', '28', '29', '34', '30'] },
  4: { name: 'Trichy',     codes: ['15', '14', '16', '17', '22', '21', '20', '19', '38', '18'] },
};
const _zoneOf = {};
for (const [zid, z] of Object.entries(ZONE_DEF)) for (const c of z.codes) _zoneOf[c] = zid;
const pad2 = (c) => String(c == null ? '' : c).padStart(2, '0');

const _cache = new Map();
const cget = (k) => { const e = _cache.get(k); return e && Date.now() - e.at < e.ttl ? e.val : null; };
const cset = (k, v, ttl) => { _cache.set(k, { at: Date.now(), ttl, val: v }); return v; };

/** All 38 districts LIVE, grouped into the 4 zones. */
async function getZones(zoneFilter) {
  let zones = cget('zones');
  if (!zones) {
    let districts = [];
    try { districts = await tnsLive.getDistricts(); } catch (_) {}
    const byZone = { 1: [], 2: [], 3: [], 4: [] };
    for (const d of districts) {
      const zid = _zoneOf[pad2(d.code)];
      if (zid) byZone[zid].push({ districtId: d.code, districtName: d.name, tamil: d.tamil });
    }
    zones = Object.entries(ZONE_DEF).map(([zid, z]) => ({
      zoneId: zid, zoneName: z.name,
      districts: byZone[zid].sort((a, b) => a.districtName.localeCompare(b.districtName)),
    }));
    if (districts.length) zones = cset('zones', zones, 6 * 60 * 60 * 1000);
  }
  return zoneFilter ? zones.filter((z) => z.zoneId === String(zoneFilter)) : zones;
}

/** Flat "all districts" list (LIVE) — convenience for callers that don't want zones. */
async function getDistricts() {
  const zones = await getZones();
  return zones.flatMap((z) => z.districts.map((d) => ({ ...d, zoneId: z.zoneId, zoneName: z.zoneName })));
}

/** Revenue taluks for a district (LIVE). talukId encodes district+code+nflag. */
async function getRevTaluks(districtId) {
  const ck = 'rtlk:' + districtId; const c = cget(ck); if (c) return c;
  let taluks = [];
  try { taluks = await tnsLive.getTaluks(districtId); } catch (_) {}
  const out = taluks.map((t) => ({
    talukId: `${districtId}_${t.code}_${t.nflag || 'Y'}`, talukName: t.name, tamil: t.tamil, nflag: t.nflag || 'Y',
  }));
  return out.length ? cset(ck, out, 60 * 60 * 1000) : out;
}

/** Revenue villages for a taluk (LIVE). Decodes the districtId from talukId. */
async function getRevVillages(talukId) {
  const ck = 'rvill:' + talukId; const c = cget(ck); if (c) return c;
  const [districtId, talukCode] = String(talukId || '').split('_');
  if (!districtId || !talukCode) return [];
  let villages = [];
  try { villages = await tnsLive.getVillages(districtId, talukCode); } catch (_) {}
  const out = villages.map((v) => ({ villageCode: v.code, villageName: v.name, tamil: v.tamil }));
  return out.length ? cset(ck, out, 60 * 60 * 1000) : out;
}

// SRO + registration-village lists are TNREGINET-specific (not on eservices) —
// stubbed (canned in test mode) until the TNREGINET combos are live-tuned.
async function getSros(_districtId) { return config.testMode ? [{ sroId: '20051', sroName: 'Ariyalur Joint I' }, { sroId: '20053', sroName: 'Andimadam' }] : []; }
async function getVillages(_sroId) { return config.testMode ? [{ villageCode: '63089', villageName: 'Alagiyamanavalam' }] : []; }

module.exports = { getZones, getDistricts, getSros, getVillages, getRevTaluks, getRevVillages };
