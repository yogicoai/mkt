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

module.exports = { configured, getDb, kvGet, kvSet };
