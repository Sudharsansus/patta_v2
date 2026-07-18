'use strict';

/**
 * Register location dropdowns.
 *
 * Districts are STATIC (the 38 TN districts grouped into the 4 TNREGINET zones —
 * reference data that never changes, so no fetch, instant + reliable).
 *
 * Revenue Taluks + Villages come from the PATTA service's already-live, cached
 * /api/live/* endpoints over HTTP — so the register process runs NO government
 * browser of its own (it was cold/flaky on the small register VM). Cached here too.
 *
 * SRO + registration-village lists are TNREGINET-specific and remain stubbed until
 * that portal is live-tuned.
 */
const axios = require('axios');
const config = require('./config');

const PATTA_URL = (process.env.PATTA_LIVE_URL || 'https://mpqr-pat-bot.fly.dev').replace(/\/$/, '');
const PATTA_KEY = process.env.PATTA_API_KEY || process.env.MPQR_API_KEY || '';

// 38 districts, grouped into the 4 TNREGINET zones. codes = TN district numbers.
const ZONES = [
  { zoneId: '1', zoneName: 'Chennai', districts: [
    ['01', 'Chennai'], ['02', 'Tiruvallur'], ['03', 'Kancheepuram'], ['35', 'Chengalpattu'],
    ['04', 'Vellore'], ['37', 'Ranipet'], ['36', 'Thirupathur'], ['06', 'Tiruvannamalai'],
    ['07', 'Viluppuram'], ['33', 'Kallakurichi'], ['05', 'Dharmapuri'], ['31', 'Krishnagiri'],
  ] },
  { zoneId: '2', zoneName: 'Coimbatore', districts: [
    ['12', 'Coimbatore'], ['32', 'Tiruppur'], ['10', 'Erode'], ['08', 'Salem'], ['09', 'Namakkal'], ['11', 'Nilgiris'],
  ] },
  { zoneId: '3', zoneName: 'Madurai', districts: [
    ['24', 'Madurai'], ['25', 'Theni'], ['13', 'Dindigul'], ['26', 'Virudhunagar'], ['27', 'Ramanathapuram'],
    ['23', 'Sivagangai'], ['28', 'Thoothukkudi'], ['29', 'Tirunelveli'], ['34', 'Tenkasi'], ['30', 'Kanniyakumari'],
  ] },
  { zoneId: '4', zoneName: 'Trichy', districts: [
    ['15', 'Trichy'], ['14', 'Karur'], ['16', 'Perambalur'], ['17', 'Ariyalur'], ['22', 'Pudukkottai'],
    ['21', 'Thanjavur'], ['20', 'Thiruvarur'], ['19', 'Nagapattinam'], ['38', 'Mayiladuthurai'], ['18', 'Cuddalore'],
  ] },
].map((z) => ({
  zoneId: z.zoneId, zoneName: z.zoneName,
  districts: z.districts.map(([districtId, districtName]) => ({ districtId, districtName }))
    .sort((a, b) => a.districtName.localeCompare(b.districtName)),
}));

const _cache = new Map();
const cget = (k) => { const e = _cache.get(k); return e && Date.now() - e.at < e.ttl ? e.val : null; };
const cset = (k, v, ttl) => { _cache.set(k, { at: Date.now(), ttl, val: v }); return v; };

async function _pattaLive(path) {
  const r = await axios.get(PATTA_URL + path, {
    headers: { 'X-API-Key': PATTA_KEY }, timeout: 60000, validateStatus: () => true,
  });
  return r.data || {};
}

// Static — instant, reliable.
async function getZones(zoneFilter) {
  return zoneFilter ? ZONES.filter((z) => z.zoneId === String(zoneFilter)) : ZONES;
}
async function getDistricts() {
  return ZONES.flatMap((z) => z.districts.map((d) => ({ ...d, zoneId: z.zoneId, zoneName: z.zoneName })));
}

// Revenue taluks — LIVE via the patta service. talukId encodes district+code+nflag.
async function getRevTaluks(districtId) {
  const ck = 'rtlk:' + districtId; const c = cget(ck); if (c) return c;
  let taluks = [];
  try { taluks = (await _pattaLive('/api/live/taluks?district=' + encodeURIComponent(districtId))).taluks || []; } catch (_) {}
  const out = taluks.map((t) => ({
    talukId: `${districtId}_${t.code}_${t.nflag || 'Y'}`, talukName: t.name, tamil: t.tamil, nflag: t.nflag || 'Y',
  }));
  return out.length ? cset(ck, out, 60 * 60 * 1000) : out;
}

// Revenue villages — LIVE via the patta service.
async function getRevVillages(talukId) {
  const ck = 'rvill:' + talukId; const c = cget(ck); if (c) return c;
  const [districtId, talukCode] = String(talukId || '').split('_');
  if (!districtId || !talukCode) return [];
  let villages = [];
  try { villages = (await _pattaLive(`/api/live/villages?district=${encodeURIComponent(districtId)}&taluk=${encodeURIComponent(talukCode)}`)).villages || []; } catch (_) {}
  const out = villages.map((v) => ({ villageCode: v.code, villageName: v.name, tamil: v.tamil }));
  return out.length ? cset(ck, out, 60 * 60 * 1000) : out;
}

// SRO + registration-village lists are TNREGINET-specific — stubbed until tuned.
async function getSros(_districtId) { return config.testMode ? [{ sroId: '20051', sroName: 'Ariyalur Joint I' }, { sroId: '20053', sroName: 'Andimadam' }] : []; }
async function getVillages(_sroId) { return config.testMode ? [{ villageCode: '63089', villageName: 'Alagiyamanavalam' }] : []; }

module.exports = { getZones, getDistricts, getSros, getVillages, getRevTaluks, getRevVillages };
