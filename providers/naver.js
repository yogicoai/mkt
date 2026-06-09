'use strict';

// 네이버 검색광고 어댑터 — 리포트와 동일하게 키워드/쇼핑/브랜드 3매체로 분리
// (전환·전환매출은 리포트 기준과 동일한 '총전환' = Stat API ccnt/convAmt)
const { getCampaignStats, getBizmoney, missingEnv } = require('../naver-api');

// 캠페인유형(campaignTp) → 표시 매체명
const BUCKET = { WEB_SITE: '네이버 키워드', SHOPPING: '네이버 쇼핑', BRAND_SEARCH: '네이버 브랜드' };
const ORDER = ['네이버 키워드', '네이버 쇼핑', '네이버 브랜드', '네이버 기타'];
const bucketOf = (tp) => BUCKET[tp] || '네이버 기타'; // POWER_CONTENTS/PLACE 등 → 기타

module.exports = {
  id: 'naver',
  label: '네이버 검색광고',
  bucketOf,
  enabled: () => missingEnv().length === 0,
  async getSummary(date) {
    const [stats, biz] = await Promise.all([
      getCampaignStats(date),
      getBizmoney().catch(() => null),
    ]);

    // 캠페인유형별 합산
    const agg = {};
    for (const r of (stats.rows || [])) {
      const k = bucketOf(r.tp);
      const a = agg[k] || (agg[k] = { spend: 0, conversions: 0, convValue: 0, imp: 0, clk: 0 });
      a.spend += r.salesAmt || 0; a.conversions += r.ccnt || 0; a.convValue += r.convAmt || 0;
      a.imp += r.impCnt || 0; a.clk += r.clkCnt || 0;
    }

    const out = [];
    let balShown = false;
    for (const name of ORDER) {
      const a = agg[name];
      if (!a) continue;
      if (name === '네이버 기타' && a.spend === 0 && a.conversions === 0 && a.imp === 0) continue;
      out.push({
        platform: name,
        spend: a.spend, conversions: a.conversions, convValue: a.convValue,
        // 잔액(비즈머니)은 계정 공통 → 첫 행에만 1회 표시(합계 중복 방지)
        balance: balShown ? null : (biz ? biz.bizmoney : null),
        currency: 'KRW',
        note: balShown ? '' : '비즈머니=네이버 공통잔액',
      });
      balShown = true;
    }
    // 활동 캠페인이 전혀 없으면 잔액 표시용 1행
    if (!out.length) {
      out.push({ platform: '네이버 검색광고', spend: 0, conversions: 0, convValue: 0, balance: biz ? biz.bizmoney : null, currency: 'KRW', note: '' });
    }
    return out;
  },
};
