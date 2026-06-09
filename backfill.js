'use strict';

/**
 * 과거 광고 데이터를 API에서 끌어와 MongoDB(daily_stats)에 적재.
 *   node backfill.js                 # 2024-09-01 ~ 어제 (최초 1회 백필)
 *   node backfill.js 20260601        # 그 날짜 ~ 어제
 *   node backfill.js 20260607 20260607  # 특정 구간 (매일 증분용)
 *
 * 저장 단위: {platform, date, spend, conv, convValue, imp, clk}  (platform+date 유니크)
 */

const crypto = require('crypto');
const { db, close, configured } = require('./db');
const { api, dash } = require('./naver-api');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
function addDays(s, n) {
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function chunks(since, until, size) {
  const out = []; let s = since;
  while (s <= until) { let e = addDays(s, size - 1); if (e > until) e = until; out.push([s, e]); s = addDays(e, 1); }
  return out;
}

// ── 네이버: 캠페인별 일자 통계(timeIncrement=1)를 [매체×일자] 단위로 합산 ──
// 통합표와 동일하게 캠페인유형으로 키워드/쇼핑/브랜드 분리 저장
const NV_FIELDS = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt'];
const NV_BUCKET = { WEB_SITE: '네이버 키워드', SHOPPING: '네이버 쇼핑', BRAND_SEARCH: '네이버 브랜드' };
const nvBucket = (tp) => NV_BUCKET[tp] || '네이버 기타';
async function naverDaily(since, until) {
  const camps = await api('GET', '/ncc/campaigns');
  const byKey = {}; // "매체\t날짜" → 지표
  let done = 0;
  for (const c of camps) {
    const platform = nvBucket(c.campaignTp);
    for (const [cs, ce] of chunks(since, until, 90)) {
      try {
        const out = await api('GET', '/stats', {
          query: {
            id: c.nccCampaignId, fields: JSON.stringify(NV_FIELDS),
            timeRange: JSON.stringify({ since: dash(cs), until: dash(ce) }), timeIncrement: '1',
          },
        });
        for (const r of (out.data || [])) {
          const dt = (r.dateStart || '').replace(/-/g, '');
          if (!dt) continue;
          const key = platform + '\t' + dt;
          const a = byKey[key] || (byKey[key] = { imp: 0, clk: 0, spend: 0, conv: 0, convValue: 0 });
          a.imp += +r.impCnt || 0; a.clk += +r.clkCnt || 0; a.spend += +r.salesAmt || 0;
          a.conv += +r.ccnt || 0; a.convValue += +r.convAmt || 0;
        }
      } catch (e) { console.error(`  ⚠ 네이버 ${c.name} ${cs}: ${e.message}`); }
    }
    process.stdout.write(`\r  네이버 캠페인 ${++done}/${camps.length}   `);
  }
  console.log('');
  return Object.entries(byKey).map(([key, m]) => { const [platform, date] = key.split('\t'); return { platform, date, ...m }; });
}

// ── META: 계정별 insights(time_increment=1), 페이지네이션 처리 ──
const META_V = process.env.META_API_VERSION || 'v24.0';
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_SECRET = process.env.META_APP_SECRET;
const META_PURCHASE = process.env.META_PURCHASE_ACTION || 'add_to_cart';
const META_ACCOUNTS = [
  { platform: 'META 요기보', id: process.env.META_AD_ACCOUNT_YOGIBO },
  { platform: 'META 샐리필', id: process.env.META_AD_ACCOUNT_SALLYFILL },
].filter((a) => a.id);

function metaProof() { return META_SECRET ? crypto.createHmac('sha256', META_SECRET).update(META_TOKEN).digest('hex') : null; }
function pick(arr, type) {
  if (!Array.isArray(arr)) return 0;
  const h = arr.find((a) => a.action_type === type) || arr.find((a) => a.action_type === 'purchase');
  return h ? +h.value || 0 : 0;
}

async function metaDaily(since, until) {
  if (!META_TOKEN || !META_ACCOUNTS.length) { console.log('  (META 미설정 — 건너뜀)'); return []; }
  const rows = [];
  for (const acc of META_ACCOUNTS) {
    const id = String(acc.id).replace(/^act_/, '');
    const u = new URL(`https://graph.facebook.com/${META_V}/act_${id}/insights`);
    u.searchParams.set('level', 'account');
    u.searchParams.set('time_increment', '1');
    u.searchParams.set('time_range', JSON.stringify({ since: dash(since), until: dash(until) }));
    u.searchParams.set('fields', 'spend,impressions,clicks,actions,action_values');
    u.searchParams.set('limit', '500');
    u.searchParams.set('access_token', META_TOKEN);
    const p = metaProof(); if (p) u.searchParams.set('appsecret_proof', p);
    let next = u.toString(), n = 0;
    while (next) {
      const j = await (await fetch(next)).json();
      if (j.error) { console.error(`  ⚠ META ${acc.platform}: ${j.error.message}`); break; }
      for (const r of (j.data || [])) {
        rows.push({
          platform: acc.platform, date: (r.date_start || '').replace(/-/g, ''),
          imp: Math.round(+r.impressions || 0), clk: Math.round(+r.clicks || 0),
          spend: Math.round(+r.spend || 0),
          conv: Math.round(pick(r.actions, META_PURCHASE)), convValue: Math.round(pick(r.action_values, META_PURCHASE)),
        });
        n++;
      }
      next = (j.paging && j.paging.next) ? j.paging.next : null;
    }
    console.log(`  META ${acc.platform}: ${n}일`);
  }
  return rows;
}

async function upsert(rows) {
  if (!rows.length) return;
  const d = await db();
  const ops = rows.filter((r) => r.date).map((r) => ({
    updateOne: { filter: { platform: r.platform, date: r.date }, update: { $set: r }, upsert: true },
  }));
  await d.collection('daily_stats').bulkWrite(ops, { ordered: false });
}

(async () => {
  if (!configured()) { console.error('❌ MONGODB_URI 미설정'); process.exit(1); }
  const today = ymd(new Date());
  const since = process.argv[2] || '20240901';
  const until = process.argv[3] || addDays(today, -1);
  console.log(`백필 ${since} ~ ${until}\n네이버 수집 중...`);
  const nv = await naverDaily(since, until); await upsert(nv);
  console.log(`  → 네이버 ${nv.length}일 저장`);
  console.log('META 수집 중...');
  const mt = await metaDaily(since, until); await upsert(mt);
  console.log(`  → META ${mt.length}건 저장`);
  await close();
  console.log('✅ 완료');
})().catch((e) => { console.error('실패', e); process.exit(1); });
