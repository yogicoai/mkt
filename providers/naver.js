'use strict';

// 네이버 검색광고 어댑터 — 리포트와 동일하게 키워드/쇼핑/브랜드 3매체로 분리
// (전환·전환매출은 리포트 기준과 동일한 '총전환' = Stat API ccnt/convAmt)
const { getCampaignStats, getBizmoney, missingEnv, getConversionBreakdown, getConversionBreakdownRange } = require('../naver-api');

// 캠페인유형(campaignTp) → 표시 매체명
const BUCKET = { WEB_SITE: '네이버 키워드', SHOPPING: '네이버 쇼핑', BRAND_SEARCH: '네이버 브랜드' };
const ORDER = ['네이버 키워드', '네이버 쇼핑', '네이버 브랜드', '네이버 기타'];
const bucketOf = (tp) => BUCKET[tp] || '네이버 기타'; // POWER_CONTENTS/PLACE 등 → 기타

module.exports = {
  id: 'naver',
  label: '네이버 검색광고',
  bucketOf,
  enabled: () => missingEnv().length === 0,
  async getSummary(start, end) {
    const s = start, e = end || start;
    const single = String(s).replace(/-/g, '') === String(e).replace(/-/g, '');
    // 분해 리포트 빌드가 길어지면 요약 전체가 지연/실패(총구매매출 미표시) → 타임아웃에서 포기.
    // 포기해도 백그라운드 빌드는 캐시되어 다음 조회 땐 즉시 반영됨.
    const breakdown = Promise.race([
      (single ? getConversionBreakdown(s) : getConversionBreakdownRange(s, e)).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), single ? 12000 : 30000)),
    ]);
    const [stats, biz, conv] = await Promise.all([
      getCampaignStats(s, e),
      getBizmoney().catch(() => null),
      breakdown,
    ]);
    const byCamp = (conv && conv.byCampaign) || {};

    // 캠페인유형별 합산 (+ 캠페인별 구매/장바구니 분해 병합)
    const agg = {};
    for (const r of (stats.rows || [])) {
      const k = bucketOf(r.tp);
      const a = agg[k] || (agg[k] = { spend: 0, conversions: 0, convValue: 0, imp: 0, clk: 0, buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 });
      a.spend += r.salesAmt || 0; a.conversions += r.ccnt || 0; a.convValue += r.convAmt || 0;
      a.imp += r.impCnt || 0; a.clk += r.clkCnt || 0;
      const b = byCamp[r.id];
      if (b) { a.buyCnt += b.buyCnt || 0; a.buyVal += b.buyVal || 0; a.cartCnt += b.cartCnt || 0; a.cartVal += b.cartVal || 0; }
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
        buyCnt: a.buyCnt, buyVal: a.buyVal, cartCnt: a.cartCnt, cartVal: a.cartVal,
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
