'use strict';

/**
 * TNREGINET location dropdowns (zones/districts → SROs → villages, and the
 * Revenue-dept taluks → villages). These use TNREGINET's own combo-load endpoints
 * (loadDistrictCombo / loadSroCombo / loadVillageCombo / loadRevenueTalukaCombo /
 * loadRevenueVillageCombo — see GOVERNMENT_ENDPOINTS.md §2), NOT the patta land
 * dropdowns. Cached in-memory. In test mode, canned data is returned.
 *
 * LIVE-TUNE: the combo endpoints return HTML <option> fragments; the exact parse +
 * whether they need a warmed session/CSRF must be confirmed against the live site.
 */
const config = require('./config');

// The 4 TNREGINET zones and their districts (registration-department grouping).
// LIVE-TUNE: confirm the full district→zone split against the portal; codes match
// the patta district codes (same state district numbering).
const ZONES = [
  { zoneId: '1', zoneName: 'Chennai', districts: [
    { districtId: '01', districtName: 'Chennai' }, { districtId: '02', districtName: 'Tiruvallur' },
    { districtId: '03', districtName: 'Kancheepuram' }, { districtId: '35', districtName: 'Chengalpattu' },
    { districtId: '04', districtName: 'Vellore' }, { districtId: '37', districtName: 'Ranipet' },
    { districtId: '36', districtName: 'Thirupathur' }, { districtId: '06', districtName: 'Tiruvannamalai' },
    { districtId: '07', districtName: 'Viluppuram' }, { districtId: '33', districtName: 'Kallakurichi' },
    { districtId: '05', districtName: 'Dharmapuri' }, { districtId: '31', districtName: 'Krishnagiri' },
  ] },
  { zoneId: '2', zoneName: 'Coimbatore', districts: [
    { districtId: '12', districtName: 'Coimbatore' }, { districtId: '32', districtName: 'Tiruppur' },
    { districtId: '10', districtName: 'Erode' }, { districtId: '08', districtName: 'Salem' },
    { districtId: '09', districtName: 'Namakkal' }, { districtId: '11', districtName: 'Nilgiris' },
  ] },
  { zoneId: '3', zoneName: 'Madurai', districts: [
    { districtId: '24', districtName: 'Madurai' }, { districtId: '25', districtName: 'Theni' },
    { districtId: '13', districtName: 'Dindigul' }, { districtId: '26', districtName: 'Virudhunagar' },
    { districtId: '27', districtName: 'Ramanathapuram' }, { districtId: '23', districtName: 'Sivagangai' },
    { districtId: '28', districtName: 'Thoothukkudi' }, { districtId: '29', districtName: 'Tirunelveli' },
    { districtId: '34', districtName: 'Tenkasi' }, { districtId: '30', districtName: 'Kanniyakumari' },
  ] },
  { zoneId: '4', zoneName: 'Trichy', districts: [
    { districtId: '15', districtName: 'Trichy' }, { districtId: '14', districtName: 'Karur' },
    { districtId: '16', districtName: 'Perambalur' }, { districtId: '17', districtName: 'Ariyalur' },
    { districtId: '22', districtName: 'Pudukkottai' }, { districtId: '21', districtName: 'Thanjavur' },
    { districtId: '20', districtName: 'Thiruvarur' }, { districtId: '19', districtName: 'Nagapattinam' },
    { districtId: '38', districtName: 'Mayiladuthurai' }, { districtId: '18', districtName: 'Cuddalore' },
  ] },
];

const _cache = new Map();
const cget = (k) => { const e = _cache.get(k); return e && Date.now() - e.at < e.ttl ? e.val : null; };
const cset = (k, v, ttl) => { _cache.set(k, { at: Date.now(), ttl, val: v }); return v; };

function getZones(zone) {
  if (zone) return ZONES.filter((z) => z.zoneId === String(zone));
  return ZONES;
}

// ── TNREGINET combo endpoints via a shared browser data-session ──────────────
// LIVE-TUNE: implement against tnreginet.gov.in. For now: canned in test mode,
// and a structured live path that returns [] until tuned (so the API never 500s).
async function _combo(kind, params, parse) {
  if (config.testMode) return _canned(kind, params);
  // LIVE-TUNE: drive TNREGINET's loadXxxCombo endpoint in a browser and parse the
  // <option> fragment. Until tuned, return [] so callers degrade gracefully.
  return [];
}

function _canned(kind) {
  if (kind === 'sros') return [{ sroId: '20051', sroName: 'Ariyalur Joint I' }, { sroId: '20053', sroName: 'Andimadam' }];
  if (kind === 'villages') return [{ villageCode: '63089', villageName: 'Alagiyamanavalam' }];
  if (kind === 'revTaluks') return [{ talukId: '01708', talukName: 'Andimadam' }];
  if (kind === 'revVillages') return [{ villageCode: '63089', villageName: 'Ayyur' }];
  return [];
}

async function getSros(districtId) {
  const ck = 'sro:' + districtId; const c = cget(ck); if (c) return c;
  return cset(ck, await _combo('sros', { districtId }), 60 * 60 * 1000);
}
async function getVillages(sroId) {
  const ck = 'vill:' + sroId; const c = cget(ck); if (c) return c;
  return cset(ck, await _combo('villages', { sroId }), 60 * 60 * 1000);
}
async function getRevTaluks(districtId) {
  const ck = 'rtlk:' + districtId; const c = cget(ck); if (c) return c;
  return cset(ck, await _combo('revTaluks', { districtId }), 60 * 60 * 1000);
}
async function getRevVillages(talukId) {
  const ck = 'rvill:' + talukId; const c = cget(ck); if (c) return c;
  return cset(ck, await _combo('revVillages', { talukId }), 60 * 60 * 1000);
}

module.exports = { getZones, getSros, getVillages, getRevTaluks, getRevVillages };
