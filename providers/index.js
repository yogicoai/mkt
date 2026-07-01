'use strict';

// 플랫폼 어댑터 레지스트리 — .env에 키가 있는 어댑터만 자동 활성화
const naver = require('./naver');
const meta = require('./meta');
const criteo = require('./criteo');
const gfa = require('./gfa');
const kakao = require('./kakao');

const ALL = [naver, meta, criteo, gfa, kakao];

async function getAllSummaries(start, end) {
  const on = ALL.filter((p) => p.enabled());
  const off = ALL.filter((p) => !p.enabled()).map((p) => p.label);
  const settled = await Promise.allSettled(on.map((p) => p.getSummary(start, end)));

  const rows = [], errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') rows.push(...(Array.isArray(r.value) ? r.value : [r.value]));
    else errors.push({ platform: on[i].label, error: r.reason.message });
  });

  return { date: start, start, end: end || start, rows, errors, disabled: off };
}

module.exports = { getAllSummaries, providers: ALL };
