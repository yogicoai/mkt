'use strict';
require('./naver-api'); // .env 로드
const ID = process.env.CRITEO_CLIENT_ID, SECRET = process.env.CRITEO_CLIENT_SECRET;
const ADV = process.env.CRITEO_ADVERTISER_ID;
const V = process.env.CRITEO_API_VERSION || '2026-01';

if (!ID || !SECRET) { console.log('❌ CRITEO_CLIENT_ID/SECRET 미입력'); process.exit(1); }
console.log(`키 확인: ID ${ID.slice(0, 6)}…(${ID.length}자), SECRET …(${SECRET.length}자), 버전 ${V}\n`);

(async () => {
  // 1) 토큰
  const tr = await fetch('https://api.criteo.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ID, client_secret: SECRET }),
  });
  const tj = await tr.json();
  if (!tj.access_token) { console.log('❌ 토큰 실패 (' + tr.status + '):', JSON.stringify(tj)); process.exit(1); }
  console.log('① ✅ 토큰 발급 OK (만료', tj.expires_in, '초)');
  const tok = tj.access_token;

  // 2) advertisers/me — advertiser_id 자동조회
  const mr = await fetch(`https://api.criteo.com/${V}/advertisers/me`, { headers: { Authorization: `Bearer ${tok}` } });
  const mt = await mr.text(); let mj; try { mj = JSON.parse(mt); } catch { mj = mt; }
  console.log('\n② /advertisers/me (' + mr.status + '):');
  console.log(typeof mj === 'string' ? mt.slice(0, 500) : JSON.stringify(mj, null, 2).slice(0, 900));
  let advId = ADV;
  const arr = mj && (mj.data || (Array.isArray(mj) ? mj : null));
  if (!advId && Array.isArray(arr) && arr.length) advId = arr[0].id || (arr[0].attributes && arr[0].attributes.id);
  console.log('\n→ 사용할 advertiserId:', advId || '(못 찾음 — 위 응답 확인)');
  if (!advId) process.exit(0);

  // 3) statistics/report (데이터 있는 날: 2026-06-04)
  const d = '2026-06-04';
  const body = {
    advertiserIds: String(advId), currency: 'KRW', dimensions: ['Day'],
    metrics: ['AdvertiserCost', 'SalesPc30dPv24h', 'RevenueGeneratedPc30dPv24h'],
    startDate: d, endDate: d, format: 'json', timezone: 'Asia/Seoul',
  };
  const rr = await fetch(`https://api.criteo.com/${V}/statistics/report`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rt = await rr.text(); let rj; try { rj = JSON.parse(rt); } catch { rj = rt; }
  console.log('\n③ statistics/report ' + d + ' (' + rr.status + '):');
  console.log(typeof rj === 'string' ? rt.slice(0, 700) : JSON.stringify(rj, null, 2).slice(0, 900));
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
