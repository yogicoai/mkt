'use strict';

// 플랫폼 어댑터 레지스트리 — .env에 키가 있는 어댑터만 자동 활성화
const naver = require('./naver');
const meta = require('./meta');
const criteo = require('./criteo');
const gfa = require('./gfa');
const kakao = require('./kakao');

const ALL = [naver, meta, criteo, gfa, kakao];

// 결과 캐시(기간별 90초) — 재접근/새로고침 시 전 매체 재호출 없이 즉시 반환. 서버리스 warm 간 유지.
const _sumCache = globalThis.__adSumCache || (globalThis.__adSumCache = new Map());
const _sumInflight = globalThis.__adSumInflight || (globalThis.__adSumInflight = new Map());
const SUM_TTL = 90 * 1000;

async function getAllSummaries(start, end) {
  const key = String(start) + '_' + String(end || start);
  const hit = _sumCache.get(key);
  if (hit && Date.now() - hit.at < SUM_TTL) return hit.data;
  if (_sumInflight.has(key)) return _sumInflight.get(key); // 동시 요청은 한 번만 계산해 공유
  const p = (async () => {
    const on = ALL.filter((pr) => pr.enabled());
    const off = ALL.filter((pr) => !pr.enabled()).map((pr) => pr.label);
    const settled = await Promise.allSettled(on.map((pr) => pr.getSummary(start, end)));
    const rows = [], errors = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') rows.push(...(Array.isArray(r.value) ? r.value : [r.value]));
      else errors.push({ platform: on[i].label, error: r.reason.message });
    });
    return { date: start, start, end: end || start, rows, errors, disabled: off };
  })();
  _sumInflight.set(key, p);
  try { const data = await p; _sumCache.set(key, { at: Date.now(), data }); return data; }
  finally { _sumInflight.delete(key); }
}

module.exports = { getAllSummaries, providers: ALL };
