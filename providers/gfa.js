'use strict';

// 네이버 GFA(성과형 디스플레이광고) 어댑터
// ⚠️ openapi.naver.com OAuth2 Bearer. 베타·파트너 승인 한정. 잔액 API 없음(콘솔 확인).
const { dash } = require('../naver-api'); // .env 로드 보장 + dash

const TOKEN = process.env.GFA_ACCESS_TOKEN;
const ACC = process.env.GFA_AD_ACCOUNT_NO;
const BASE = 'https://openapi.naver.com/v1/ad-api/1.0';

function enabled() { return !!TOKEN && !!ACC; }

module.exports = {
  id: 'gfa',
  label: 'GFA(성과형DA)',
  enabled,
  async getSummary(date) {
    const d = dash(date);
    const url = `${BASE}/adAccounts/${ACC}/performance/past/campaigns?startDate=${d}&endDate=${d}&timeUnit=daily`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = text; }
    if (!res.ok) throw new Error('GFA 실패: ' + (typeof j === 'string' ? j.slice(0, 200) : JSON.stringify(j)));

    const rows = j.data || j.result || j.performance || (Array.isArray(j) ? j : []);
    let spend = 0, conv = 0, rev = 0;
    for (const r of rows) {
      spend += +(r.sales || 0);       // sales = 광고비(지출)
      conv += +(r.convCount || 0);
      rev += +(r.convSales || 0);     // convSales = 전환매출
    }
    return [{
      platform: 'GFA', spend: Math.round(spend), conversions: Math.round(conv), convValue: Math.round(rev),
      balance: null, currency: 'KRW', note: '잔액 API 없음(콘솔확인)',
    }];
  },
};
