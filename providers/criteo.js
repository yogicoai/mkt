'use strict';

// Criteo Marketing Solutions API 어댑터
// 광고비/전환/전환매출 = statistics/report, 잔액 = (Retail Media 연동시) balances
const { dash } = require('../naver-api'); // .env 로드 보장 + dash

const ID = process.env.CRITEO_CLIENT_ID;
const SECRET = process.env.CRITEO_CLIENT_SECRET;
const ADV = process.env.CRITEO_ADVERTISER_ID;
const RETAIL = process.env.CRITEO_RETAIL_ACCOUNT_ID;       // 선택: Retail Media 잔액용
const V = process.env.CRITEO_API_VERSION || '2026-01';
const VR = process.env.CRITEO_RETAIL_VERSION || '2025-07';

function enabled() { return !!ID && !!SECRET; } // 광고주ID(ADV)는 승인 후 자동조회 → 키만 있으면 활성

// fetch에 타임아웃(AbortController) — 크리테오 stall 시 무한 대기 방지
async function fetchT(url, opts, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  catch (e) { if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) throw new Error(`크리테오 응답 지연(timeout ${Math.round(ms / 1000)}s)`); throw e; }
  finally { clearTimeout(t); }
}
const _sumCache = new Map(); const SUM_TTL = 90 * 1000; // 요약 90초 캐시(재접근·자동갱신 시 재호출 방지)

let _tok = null, _exp = 0;
async function token() {
  if (_tok && Date.now() < _exp) return _tok;
  const res = await fetchT('https://api.criteo.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ID, client_secret: SECRET }),
  }, 12000);
  const j = await res.json();
  if (!j.access_token) throw new Error('크리테오 토큰 실패: ' + JSON.stringify(j));
  _tok = j.access_token;
  _exp = Date.now() + ((j.expires_in || 900) - 60) * 1000; // 15분 만료 - 여유 60s
  return _tok;
}

// 광고주 ID: env(CRITEO_ADVERTISER_ID)에 있으면 그걸, 없으면 승인된 광고주를 자동 조회.
// → 앱(App 25299)을 광고주에 연결(승인)만 하면 별도 설정 없이 통계가 잡힘.
//   (검증 2026-06: 승인 전엔 GET /{V}/advertisers/me 가 {"data":[]} 반환)
let _advCache = ADV ? (Array.isArray(ADV) ? ADV.join(',') : String(ADV)) : null;
async function advertiserIds(tok) {
  if (_advCache) return _advCache;
  const res = await fetchT(`https://api.criteo.com/${V}/advertisers/me`, { headers: { Authorization: `Bearer ${tok}` } }, 12000);
  let j = null; try { j = await res.json(); } catch (_) {}
  const arr = (j && j.data) || [];
  const ids = (Array.isArray(arr) ? arr : [arr]).map((a) => a && (a.id != null ? a.id : (a.attributes && a.attributes.id))).filter(Boolean);
  if (!ids.length) throw new Error('크리테오 접근 가능한 광고주가 없습니다 — 앱(App 25299)을 Yogibo 광고주에 연결(승인)했는지 확인하세요(승인되면 자동 인식).');
  _advCache = ids.join(',');
  return _advCache;
}

async function balance(tok) {
  if (!RETAIL) return null;
  try {
    const res = await fetchT(`https://api.criteo.com/${VR}/retail-media/accounts/${RETAIL}/balances?pageSize=100`, {
      headers: { Authorization: `Bearer ${tok}` },
    }, 10000);
    const j = await res.json();
    const data = j.data || [];
    let dep = 0, sp = 0, rem = 0, hasRem = false;
    for (const b of data) {
      const at = b.attributes || b;
      dep += +at.deposited || 0;
      sp += +at.spent || 0;
      if (at.remaining != null) { rem += +at.remaining; hasRem = true; }
    }
    return hasRem ? Math.round(rem) : Math.round(dep - sp);
  } catch (_) { return null; }
}

// 기간 + 광고세트(Adset)별 분해 — 크리테오 탭용.
// 검증(2026-06): dimensions=['AdsetId','Adset'], metrics=AdvertiserCost/Displays/Clicks/SalesPc30dPv24h/RevenueGeneratedPc30dPv24h → {Total, Rows} 반환.
async function getBreakdown(startStr, endStr) {
  const tok = await token();
  const advIds = await advertiserIds(tok);
  const sd = dash(String(startStr).replace(/-/g, ''));
  const ed = dash(String(endStr || startStr).replace(/-/g, ''));
  const body = {
    advertiserIds: advIds, currency: 'KRW',
    dimensions: ['AdsetId', 'Adset'],
    metrics: ['AdvertiserCost', 'Displays', 'Clicks', 'SalesPc30dPv24h', 'RevenueGeneratedPc30dPv24h'],
    startDate: sd, endDate: ed, format: 'json', timezone: 'Asia/Seoul',
  };
  const res = await fetch(`https://api.criteo.com/${V}/statistics/report`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  if (!res.ok) throw new Error('크리테오 통계 실패: ' + (typeof j === 'string' ? j.slice(0, 200) : JSON.stringify(j).slice(0, 300)));
  const num = (v) => +v || 0;
  const raw = j.Rows || j.rows || j.data || [];
  const adsets = raw.map((r) => {
    const spend = Math.round(num(r.AdvertiserCost)), imp = Math.round(num(r.Displays)), clk = Math.round(num(r.Clicks));
    const conv = Math.round(num(r.SalesPc30dPv24h)), rev = Math.round(num(r.RevenueGeneratedPc30dPv24h));
    return {
      id: r.AdsetId, name: r.Adset || '(이름없음)', spend, imp, clk,
      ctr: imp ? +(clk / imp * 100).toFixed(2) : 0, cpc: clk ? Math.round(spend / clk) : 0,
      conv, convValue: rev, roas: spend ? Math.round(rev / spend * 100) : 0,
    };
  }).filter((a) => a.spend > 0 || a.imp > 0).sort((a, b) => b.spend - a.spend);
  const T = j.Total || {};
  const sum = (k) => adsets.reduce((a, r) => a + r[k], 0);
  const totals = {
    spend: T.AdvertiserCost != null ? Math.round(num(T.AdvertiserCost)) : sum('spend'),
    imp: T.Displays != null ? Math.round(num(T.Displays)) : sum('imp'),
    clk: T.Clicks != null ? Math.round(num(T.Clicks)) : sum('clk'),
    conv: T.SalesPc30dPv24h != null ? Math.round(num(T.SalesPc30dPv24h)) : sum('conv'),
    convValue: T.RevenueGeneratedPc30dPv24h != null ? Math.round(num(T.RevenueGeneratedPc30dPv24h)) : sum('convValue'),
  };
  totals.ctr = totals.imp ? +(totals.clk / totals.imp * 100).toFixed(2) : 0;
  totals.cpc = totals.clk ? Math.round(totals.spend / totals.clk) : 0;
  totals.roas = totals.spend ? Math.round(totals.convValue / totals.spend * 100) : 0;
  let bal = null; try { bal = await balance(tok); } catch (_) { /* 잔액 실패 무시 */ }
  return { start: sd, end: ed, advertiser: advIds, totals, adsets, balance: bal };
}

module.exports = {
  id: 'criteo',
  label: '크리테오',
  enabled,
  getBreakdown,
  async getSummary(start, end) {
    const ck = String(start) + '_' + String(end || start);
    const hit = _sumCache.get(ck);
    if (hit && Date.now() - hit.at < SUM_TTL) return hit.data;
    const tok = await token();
    const advIds = await advertiserIds(tok);
    const sd = dash(start), ed = dash(end || start); // 기간이면 일별 반환 → 아래서 합산
    const body = {
      advertiserIds: advIds,
      currency: 'KRW',
      dimensions: ['Day'],
      metrics: ['AdvertiserCost', 'SalesPc30dPv24h', 'RevenueGeneratedPc30dPv24h'],
      startDate: sd, endDate: ed, format: 'json', timezone: 'Asia/Seoul',
    };
    const res = await fetchT(`https://api.criteo.com/${V}/statistics/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 25000);
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = text; }
    if (!res.ok) throw new Error('크리테오 통계 실패: ' + (typeof j === 'string' ? j.slice(0, 200) : JSON.stringify(j)));

    let spend = 0, conv = 0, rev = 0;
    if (j && Array.isArray(j.columns) && Array.isArray(j.data)) {
      // 컬럼형 응답: { columns:[지표명], data:[[행값,...]], rows:행수 }
      const idx = {};
      j.columns.forEach((c, i) => { idx[String(c).toLowerCase()] = i; });
      const get = (row, name) => { const i = idx[name.toLowerCase()]; return i == null ? 0 : +row[i] || 0; };
      for (const row of (j.data || [])) {
        spend += get(row, 'AdvertiserCost');
        conv += get(row, 'SalesPc30dPv24h');
        rev += get(row, 'RevenueGeneratedPc30dPv24h');
      }
    } else {
      // 폴백: 객체배열 형태(format/버전에 따라)
      const rows = j.Rows || j.rows || j.data || (Array.isArray(j) ? j : []);
      for (const r of rows) {
        spend += +(r.AdvertiserCost ?? r.advertiserCost ?? 0);
        conv += +(r.SalesPc30dPv24h ?? r.salesPc30dPv24h ?? 0);
        rev += +(r.RevenueGeneratedPc30dPv24h ?? r.revenueGeneratedPc30dPv24h ?? 0);
      }
    }
    const bal = await balance(tok);
    const data = [{
      platform: '크리테오',
      spend: Math.round(spend), conversions: Math.round(conv), convValue: Math.round(rev),
      buyCnt: Math.round(conv), buyVal: Math.round(rev), cartCnt: 0, cartVal: 0, // 크리테오 sales=구매, 장바구니 별도 미제공
      balance: bal, currency: 'KRW', note: bal == null ? '잔액=Retail Media 연동시' : '',
    }];
    _sumCache.set(ck, { at: Date.now(), data });
    return data;
  },
};
