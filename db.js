'use strict';

// MongoDB 연결 (기존 클러스터에 별도 DB 'adboard'로 저장 → 기존 데이터 비침범)
require('./naver-api'); // .env 로드
const { MongoClient } = require('mongodb');

const URL = process.env.MONGODB_URI || process.env.MONGO_URL;
const DB_NAME = process.env.MONGO_DB || 'adboard';

let _client = null, _db = null;

function configured() { return !!URL; }

async function db() {
  if (_db) return _db;
  if (!URL) throw new Error('MONGO_URL 미설정 (.env에 추가하세요)');
  _client = new MongoClient(URL, { serverSelectionTimeoutMS: 8000 });
  await _client.connect();
  _db = _client.db(DB_NAME);
  await _db.collection('daily_stats').createIndex({ platform: 1, date: 1 }, { unique: true });
  return _db;
}

async function close() {
  if (_client) { await _client.close(); _client = null; _db = null; }
}

module.exports = { db, close, configured, DB_NAME };
