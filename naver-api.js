'use strict';

/**
 * 네이버 검색광고 API 공용 클라이언트 모듈
 * - CLI(naver-ad.js)와 웹 서버(server.js)가 함께 사용.
 * - 인증/서명/호출 로직과 캠페인 효율 조회를 제공.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── .env 로더 (무의존성) ──────────────────────────────────
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const BASE = 'https://api.searchad.naver.com';
const API_KEY = process.env.NAVER_AD_API_KEY;
const SECRET = process.env.NAVER_AD_SECRET_KEY;
const CUSTOMER = process.env.NAVER_AD_CUSTOMER_ID;

function missingEnv() {
  const miss = [];
  if (!API_KEY) miss.push('NAVER_AD_API_KEY');
  if (!SECRET) miss.push('NAVER_AD_SECRET_KEY');
  if (!CUSTOMER) miss.push('NAVER_AD_CUSTOMER_ID');
  return miss;
}

// ── 서명: message = "{ts}.{method}.{uri}" → HMAC-SHA256 → base64 ──
function sign(ts, method, uri) {
  const miss = missingEnv();
  if (miss.length) throw new Error('네이버 환경변수 누락(' + miss.join(', ') + ') — .env 또는 Vercel 환경변수를 설정하세요.');
  return crypto.createHmac('sha256', SECRET).update(`${ts}.${method}.${uri}`).digest('base64');
}

function authHeaders(method, uri) {
  const ts = Date.now().toString();
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': ts,
    'X-API-KEY': API_KEY,
    'X-Customer': String(CUSTOMER),
    'X-Signature': sign(ts, method, uri),
  };
}

async function api(method, uri, { query, body } = {}) {
  let url = BASE + uri;
  if (query) url += '?' + new URLSearchParams(query).toString();
  const opt = { method, headers: authHeaders(method, uri) };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} ${method} ${uri}`);
    e.data = data;
    throw e;
  }
  return data;
}

// ── 동시성 제한 맵 (네이버 rate-limit 고려: 기본 5개씩) ──
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const dash = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

const FIELDS = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror'];

async function getCampaigns() {
  return api('GET', '/ncc/campaigns');
}

/**
 * 특정 일자(YYYYMMDD)의 캠페인별 효율을 조회.
 * @returns { date, rows: [...], totals: {...} }
 */
// 동시 호출 dedup: 같은 날짜 요청이 진행 중이면 같은 Promise 공유 (통합표+상세 중복 방지)
const _statsInflight = new Map();
async function getCampaignStats(dateStr) {
  if (_statsInflight.has(dateStr)) return _statsInflight.get(dateStr);
  const p = _computeCampaignStats(dateStr);
  _statsInflight.set(dateStr, p);
  try { return await p; } finally { _statsInflight.delete(dateStr); }
}

async function _computeCampaignStats(dateStr) {
  const since = dash(dateStr);
  const camps = await getCampaigns();

  const rows = await mapLimit(camps, 5, async (c) => {
    let m = {};
    try {
      const out = await api('GET', '/stats', {
        query: {
          id: c.nccCampaignId,
          fields: JSON.stringify(FIELDS),
          timeRange: JSON.stringify({ since, until: since }),
        },
      });
      const arr = out && out.data ? out.data : Array.isArray(out) ? out : [];
      m = arr[0] || {};
    } catch (_) { /* 실패 캠페인은 0 처리 */ }
    return {
      id: c.nccCampaignId, name: c.name, tp: c.campaignTp, status: c.status,
      impCnt: +m.impCnt || 0, clkCnt: +m.clkCnt || 0, ctr: +m.ctr || 0,
      cpc: +m.cpc || 0, salesAmt: +m.salesAmt || 0, ccnt: +m.ccnt || 0,
      convAmt: +m.convAmt || 0, ror: +m.ror || 0,
    };
  });

  // 합계 (노출 발생분 기준)
  const active = rows.filter((r) => r.impCnt > 0);
  const sum = active.reduce((a, r) => ({
    impCnt: a.impCnt + r.impCnt, clkCnt: a.clkCnt + r.clkCnt, salesAmt: a.salesAmt + r.salesAmt,
    ccnt: a.ccnt + r.ccnt, convAmt: a.convAmt + r.convAmt,
  }), { impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
  const totals = {
    ...sum,
    ctr: sum.impCnt ? +(sum.clkCnt / sum.impCnt * 100).toFixed(2) : 0,
    cpc: sum.clkCnt ? Math.round(sum.salesAmt / sum.clkCnt) : 0,
    ror: sum.salesAmt ? Math.round(sum.convAmt / sum.salesAmt * 100) : 0,
    activeCount: active.length,
    totalCount: rows.length,
  };

  return { date: dateStr, rows, totals };
}

// 비즈머니(광고비 잔액) 조회
async function getBizmoney() {
  const d = await api('GET', '/billing/bizmoney');
  return { bizmoney: Math.floor(+d.bizmoney || 0), budgetLock: !!d.budgetLock, refundLock: !!d.refundLock };
}

// 장바구니(add_to_cart) 전환만 분리 — StatReport AD_CONVERSION 보고서
// 컬럼(헤더없는 TSV): [10]전환유형(문자열) [11]전환수 [12]전환매출
const CART_TTL = 10 * 60 * 1000; // 전환데이터는 자주 안 변하므로 10분 캐시
const _cartCache = new Map();
const _cartInflight = new Map();

async function _computeCart(date) {
  const job = await api('POST', '/stat-reports', { body: { reportTp: 'AD_CONVERSION', statDt: date } });
  let info = job, status = job.status, tries = 0;
  while (['REGIST', 'RUNNING', 'WAITING', 'AGGREGATING'].includes(status) && tries < 40) {
    await new Promise((r) => setTimeout(r, 2000));
    info = await api('GET', `/stat-reports/${job.reportJobId}`);
    status = info.status; tries++;
  }
  if (status !== 'BUILT') return { conversions: null, convValue: null, status };
  const res = await fetch(info.downloadUrl, { headers: authHeaders('GET', new URL(info.downloadUrl).pathname) });
  const tsv = await res.text();
  let cnt = 0, amt = 0;
  for (const line of tsv.split(/\r?\n/)) {
    if (!line) continue;
    const c = line.split('\t');
    if (c[10] === 'add_to_cart') { cnt += +c[11] || 0; amt += +c[12] || 0; }
  }
  return { conversions: cnt, convValue: amt, status: 'BUILT' };
}

async function getCartConversions(date) {
  const hit = _cartCache.get(date);
  if (hit && Date.now() - hit.at < CART_TTL) return hit.data;
  if (_cartInflight.has(date)) return _cartInflight.get(date);
  const p = _computeCart(date);
  _cartInflight.set(date, p);
  try {
    const d = await p;
    if (d.conversions != null) _cartCache.set(date, { at: Date.now(), data: d }); // 미완료(null)는 캐시 안 함
    return d;
  } finally { _cartInflight.delete(date); }
}

// 캠페인의 키워드별 효율 (adgroups→keywords→/stats). ids는 콤마구분.
async function getKeywordStats(campaignId, dateStr) {
  const since = dash(dateStr);
  const CAP = 3000; // 초대형 캠페인(세부키워드 등) 안전 상한
  const ags = await api('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } });
  const lists = await mapLimit(ags, 5, (ag) =>
    api('GET', '/ncc/keywords', { query: { nccAdgroupId: ag.nccAdgroupId } }).catch(() => []));
  let kws = [], truncated = false;
  for (const list of lists) {
    for (const k of list) {
      if (kws.length >= CAP) { truncated = true; break; }
      kws.push(k);
    }
    if (truncated) break;
  }

  const F = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror', 'avgRnk'];
  const batches = [];
  for (let i = 0; i < kws.length; i += 100) batches.push(kws.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    const ids = batch.map((k) => k.nccKeywordId).join(',');
    try {
      const out = await api('GET', '/stats', {
        query: { ids, fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until: since }) },
      });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 배치 실패 무시 */ }
  });

  const rows = kws.map((k) => {
    const s = stat[k.nccKeywordId] || {};
    return {
      keyword: k.keyword,
      impCnt: +s.impCnt || 0, clkCnt: +s.clkCnt || 0, ctr: +s.ctr || 0, cpc: +s.cpc || 0,
      salesAmt: +s.salesAmt || 0, ccnt: +s.ccnt || 0, convAmt: +s.convAmt || 0,
      ror: +s.ror || 0, avgRnk: +s.avgRnk || 0,
    };
  }).filter((r) => r.impCnt > 0).sort((a, b) => b.salesAmt - a.salesAmt);

  return { campaignId, date: dateStr, keywordCount: kws.length, activeCount: rows.length, truncated, rows };
}

// 파워링크(요기보 검색광고) 키워드 기간합산 — 여러 WEB_SITE 캠페인(샐리필 제외) 통합.
// /stats timeRange(시작≠끝, timeIncrement 없음)로 기간 합산값을 키워드당 1행 반환(검증됨).
// 캠페인 간 동일 키워드는 정규화 텍스트로 합산. since/until: YYYY-MM-DD 또는 YYYYMMDD.
const normKw = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').trim();
async function getPowerlinkKeywordsRange(sinceStr, untilStr) {
  const since = dash(String(sinceStr).replace(/-/g, '')), until = dash(String(untilStr).replace(/-/g, ''));
  const camps = await getCampaigns();
  const targets = camps.filter((c) => c.campaignTp === 'WEB_SITE' && !/샐리필/.test(c.name || ''));
  const F = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt', 'avgRnk'];
  const agg = {};
  await mapLimit(targets, 3, async (c) => {
    const ags = await api('GET', '/ncc/adgroups', { query: { nccCampaignId: c.nccCampaignId } }).catch(() => []);
    const lists = await mapLimit(ags, 5, (ag) =>
      api('GET', '/ncc/keywords', { query: { nccAdgroupId: ag.nccAdgroupId } }).catch(() => []));
    const kws = lists.flat();
    const idToKw = {};
    kws.forEach((k) => { idToKw[k.nccKeywordId] = k.keyword; });
    const batches = [];
    for (let i = 0; i < kws.length; i += 100) batches.push(kws.slice(i, i + 100));
    await mapLimit(batches, 5, async (batch) => {
      const ids = batch.map((k) => k.nccKeywordId).join(',');
      if (!ids) return;
      try {
        const out = await api('GET', '/stats', { query: { ids, fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until }) } });
        (out.data || []).forEach((s) => {
          const kw = idToKw[s.id]; if (kw == null) return;
          const n = normKw(kw);
          const o = agg[n] || (agg[n] = { keyword: kw, norm: n, impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
          o.impCnt += +s.impCnt || 0; o.clkCnt += +s.clkCnt || 0; o.salesAmt += +s.salesAmt || 0;
          o.ccnt += +s.ccnt || 0; o.convAmt += +s.convAmt || 0;
        });
      } catch (_) { /* 배치 실패 무시 */ }
    });
  });
  const rows = Object.values(agg)
    .filter((r) => r.impCnt > 0 || r.salesAmt > 0)
    .map((r) => ({ ...r, ctr: r.impCnt ? +(r.clkCnt / r.impCnt * 100).toFixed(2) : 0, cpc: r.clkCnt ? Math.round(r.salesAmt / r.clkCnt) : 0, ror: r.salesAmt ? Math.round(r.convAmt / r.salesAmt * 100) : 0 }))
    .sort((a, b) => b.salesAmt - a.salesAmt);
  return { since: since, until: until, campaignCount: targets.length, rows };
}

// 네이버 매체버킷(검색/쇼핑/기타)별 기간합산 광고비·전환매출 — 통합 진짜 ROAS용.
// 검색=WEB_SITE(파워링크)+BRAND_SEARCH(브랜드검색) → Cafe24 medium=Naver 와 매칭. 쇼핑=SHOPPING → medium=shopping.
async function getNaverBucketRange(sinceStr, untilStr) {
  const since = dash(String(sinceStr).replace(/-/g, '')), until = dash(String(untilStr).replace(/-/g, ''));
  const camps = await getCampaigns();
  const bucketOf = (tp) => tp === 'SHOPPING' ? '쇼핑' : (tp === 'WEB_SITE' || tp === 'BRAND_SEARCH') ? '검색' : '기타';
  const agg = { 검색: { spend: 0, convAmt: 0, ccnt: 0 }, 쇼핑: { spend: 0, convAmt: 0, ccnt: 0 }, 기타: { spend: 0, convAmt: 0, ccnt: 0 } };
  await mapLimit(camps, 5, async (c) => {
    try {
      // 캠페인 /stats는 timeRange만으로는 합산이 안 됨 → timeIncrement='1'(일별) 후 합산 (backfill 검증 방식)
      const out = await api('GET', '/stats', { query: { id: c.nccCampaignId, fields: JSON.stringify(['salesAmt', 'convAmt', 'ccnt']), timeRange: JSON.stringify({ since, until }), timeIncrement: '1' } });
      const arr = (out && out.data) || [];
      const b = agg[bucketOf(c.campaignTp)];
      for (const m of arr) { b.spend += +m.salesAmt || 0; b.convAmt += +m.convAmt || 0; b.ccnt += +m.ccnt || 0; }
    } catch (_) { /* 캠페인 실패 무시 */ }
  });
  return agg;
}

// 쇼핑검색광고: 캠페인의 상품(소재)별 효율. adgroups→ads(소재)→/stats(ids=콤마구분)
// 소재 referenceData.productTitle = 상품명, imageUrl = 썸네일. 상품 단위로 합산.
async function getProductStats(campaignId, dateStr) {
  const since = dash(dateStr);
  const CAP = 3000;
  const ags = await api('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } });
  const adLists = await mapLimit(ags, 5, (ag) =>
    api('GET', '/ncc/ads', { query: { nccAdgroupId: ag.nccAdgroupId } }).catch(() => []));

  const meta = {}; // nccAdId → {key,title,image,price,url}
  let adIds = [], truncated = false;
  for (const list of adLists) {
    for (const a of list) {
      if (adIds.length >= CAP) { truncated = true; break; }
      const rd = a.referenceData || {};
      meta[a.nccAdId] = {
        key: rd.id || rd.mallProductId || a.nccAdId,
        title: rd.productTitle || '(상품명 없음)',
        image: rd.imageUrl || '',
        price: +rd.lowPrice || 0,
        url: rd.mallProductUrl || '',
      };
      adIds.push(a.nccAdId);
    }
    if (truncated) break;
  }

  const F = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt'];
  const batches = [];
  for (let i = 0; i < adIds.length; i += 100) batches.push(adIds.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    try {
      const out = await api('GET', '/stats', {
        query: { ids: batch.join(','), fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until: since }) },
      });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 배치 실패 무시 */ }
  });

  // 상품(referenceKey) 단위 합산
  const prod = {};
  for (const adId of adIds) {
    const s = stat[adId]; if (!s) continue;
    const m = meta[adId];
    const p = prod[m.key] || (prod[m.key] = { product: m.title, image: m.image, price: m.price, url: m.url, impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
    p.impCnt += +s.impCnt || 0; p.clkCnt += +s.clkCnt || 0; p.salesAmt += +s.salesAmt || 0;
    p.ccnt += +s.ccnt || 0; p.convAmt += +s.convAmt || 0;
  }
  const rows = Object.values(prod)
    .map((p) => ({ ...p, ror: p.salesAmt > 0 ? p.convAmt / p.salesAmt * 100 : 0 }))
    .filter((r) => r.impCnt > 0)
    .sort((a, b) => b.salesAmt - a.salesAmt);

  return { campaignId, date: dateStr, productCount: adIds.length, activeCount: rows.length, truncated, rows };
}

// 단일 광고그룹의 상품(소재)별 효율 (쇼핑 계층 2단계)
async function getProductStatsForAdgroup(adgroupId, dateStr) {
  const since = dash(dateStr);
  const ads = await api('GET', '/ncc/ads', { query: { nccAdgroupId: adgroupId } });
  const meta = {}; const adIds = [];
  for (const a of ads) {
    const rd = a.referenceData || {};
    meta[a.nccAdId] = { key: rd.id || rd.mallProductId || a.nccAdId, title: rd.productTitle || '(상품명 없음)', image: rd.imageUrl || '', price: +rd.lowPrice || 0, url: rd.mallProductUrl || '' };
    adIds.push(a.nccAdId);
  }
  const F = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt'];
  const batches = [];
  for (let i = 0; i < adIds.length; i += 100) batches.push(adIds.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    try {
      const out = await api('GET', '/stats', { query: { ids: batch.join(','), fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until: since }) } });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 무시 */ }
  });
  const prod = {};
  for (const adId of adIds) {
    const s = stat[adId]; if (!s) continue;
    const m = meta[adId];
    const p = prod[m.key] || (prod[m.key] = { product: m.title, image: m.image, price: m.price, url: m.url, impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
    p.impCnt += +s.impCnt || 0; p.clkCnt += +s.clkCnt || 0; p.salesAmt += +s.salesAmt || 0; p.ccnt += +s.ccnt || 0; p.convAmt += +s.convAmt || 0;
  }
  const rows = Object.values(prod).map((p) => ({ ...p, ror: p.salesAmt > 0 ? p.convAmt / p.salesAmt * 100 : 0 }))
    .filter((r) => r.impCnt > 0).sort((a, b) => b.salesAmt - a.salesAmt);
  return { adgroupId, date: dateStr, productCount: adIds.length, activeCount: rows.length, rows };
}

// 캠페인의 광고그룹별 효율 (계층형 드릴다운 1단계). 입찰가·연결채널(URL) 포함.
async function getAdgroupStats(campaignId, dateStr) {
  const since = dash(dateStr);
  const [ags, channels] = await Promise.all([
    api('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } }),
    api('GET', '/ncc/channels').catch(() => []),
  ]);
  const chMap = {};
  for (const c of (channels || [])) chMap[c.nccBusinessChannelId] = c.channelKey || (c.businessInfo && c.businessInfo.site) || c.name || '';

  const F = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror'];
  const ids = ags.map((a) => a.nccAdgroupId);
  const batches = [];
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    try {
      const out = await api('GET', '/stats', { query: { ids: batch.join(','), fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until: since }) } });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 무시 */ }
  });

  const rows = ags.map((a) => {
    const s = stat[a.nccAdgroupId] || {};
    return {
      adgroupId: a.nccAdgroupId, name: a.name, status: a.status, bidAmt: +a.bidAmt || 0,
      channel: chMap[a.pcChannelId] || chMap[a.mobileChannelId] || '',
      impCnt: +s.impCnt || 0, clkCnt: +s.clkCnt || 0, ctr: +s.ctr || 0, cpc: +s.cpc || 0,
      salesAmt: +s.salesAmt || 0, ccnt: +s.ccnt || 0, convAmt: +s.convAmt || 0, ror: +s.ror || 0,
    };
  }).sort((a, b) => b.salesAmt - a.salesAmt);

  return { campaignId, date: dateStr, count: rows.length, rows };
}

// 단일 광고그룹의 키워드별 효율 (계층형 드릴다운 2단계)
async function getKeywordStatsForAdgroup(adgroupId, dateStr) {
  const since = dash(dateStr);
  const kws = await api('GET', '/ncc/keywords', { query: { nccAdgroupId: adgroupId } });
  const F = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror', 'avgRnk'];
  const batches = [];
  for (let i = 0; i < kws.length; i += 100) batches.push(kws.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    const ids = batch.map((k) => k.nccKeywordId).join(',');
    try {
      const out = await api('GET', '/stats', { query: { ids, fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until: since }) } });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 무시 */ }
  });
  const rows = kws.map((k) => {
    const s = stat[k.nccKeywordId] || {};
    return {
      keyword: k.keyword, impCnt: +s.impCnt || 0, clkCnt: +s.clkCnt || 0, ctr: +s.ctr || 0, cpc: +s.cpc || 0,
      salesAmt: +s.salesAmt || 0, ccnt: +s.ccnt || 0, convAmt: +s.convAmt || 0, ror: +s.ror || 0, avgRnk: +s.avgRnk || 0,
    };
  }).filter((r) => r.impCnt > 0).sort((a, b) => b.salesAmt - a.salesAmt);
  return { adgroupId, date: dateStr, keywordCount: kws.length, activeCount: rows.length, rows };
}

// 어제 (로컬=KST 기준) YYYYMMDD
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

module.exports = {
  BASE, CUSTOMER, FIELDS,
  missingEnv, authHeaders, api, getCampaigns, getCampaignStats, getBizmoney, getCartConversions, getKeywordStats, getPowerlinkKeywordsRange, getNaverBucketRange, normKw, getProductStats, getProductStatsForAdgroup, getAdgroupStats, getKeywordStatsForAdgroup, yesterday, dash,
};
