'use strict';

/**
 * Mongo KV 저장소 — Vercel(서버리스)에서는 파일시스템 쓰기가 사라지므로
 * 기존 *.json 파일 저장을 MongoDB로 대체한다.
 *   - 기존 'adboard' DB에 'kv' 컬렉션을 "신설"(daily_stats 등 기존 데이터 비침범).
 *   - 키 단위 문서: { _id: <key>, value: <object>, updatedAt }.
 *   - 서버리스 콜드스타트 간 커넥션 재사용을 위해 연결 Promise를 globalThis에 캐시.
 */
require('./naver-api'); // 로컬에서 .env 로드(서버리스에선 no-op)
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI || process.env.MONGO_URL;
const DB_NAME = process.env.MONGO_DB || 'adboard';

function configured() { return !!URI; }

async function getDb() {
  if (!URI) throw new Error('MONGODB_URI 미설정 (.env / Vercel 환경변수)');
  if (!globalThis.__adboardMongoPromise) {
    globalThis.__adboardMongoPromise = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 }).connect();
  }
  const client = await globalThis.__adboardMongoPromise;
  return client.db(DB_NAME);
}

async function kvGet(key, dflt) {
  const db = await getDb();
  const doc = await db.collection('kv').findOne({ _id: key });
  return doc ? doc.value : (dflt === undefined ? {} : dflt);
}

async function kvSet(key, value) {
  const db = await getDb();
  await db.collection('kv').updateOne(
    { _id: key },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true },
  );
  return value;
}

// 일자별 추이 자동 적재 — 통합표 rows를 daily_stats에 upsert(매체+날짜 단위).
// backfill(naver/meta)와 매체명이 일치해 중복 없이 dedupe되고, 카카오 등은 신규 적재.
// 누가 조회할 때마다 그 날짜가 채워져 backfill 수동실행 없이도 매일 쌓임(서버리스 친화).
async function saveDaily(date, rows) {
  if (!URI || !Array.isArray(rows) || !rows.length) return;
  const dt = String(date).replace(/-/g, '');
  if (!/^\d{8}$/.test(dt)) return;
  const db = await getDb();
  const ops = rows
    .filter((r) => r && r.platform && ((+r.spend || 0) || (+r.convValue || 0) || (+r.conversions || 0) || (+r.imp || 0) || (+r.clk || 0)))
    .map((r) => ({
      updateOne: {
        filter: { platform: r.platform, date: dt },
        update: { $set: {
          platform: r.platform, date: dt,
          spend: Math.round(+r.spend || 0), conv: Math.round(+r.conversions || 0), convValue: Math.round(+r.convValue || 0),
          imp: Math.round(+r.imp || 0), clk: Math.round(+r.clk || 0), src: 'live', updatedAt: new Date(),
        } },
        upsert: true,
      },
    }));
  if (ops.length) await db.collection('daily_stats').bulkWrite(ops, { ordered: false });
}

module.exports = { configured, getDb, kvGet, kvSet, saveDaily };
