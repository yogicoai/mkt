import { NextResponse } from 'next/server';

/**
 * 간단한 HTTP Basic 인증 게이트 — 회사 공유용 공개 URL 보호.
 * (Next 16: middleware → proxy 규칙)
 *   - 환경변수 DASHBOARD_PASS 가 설정되어 있을 때만 인증을 강제(미설정 시 로컬 개발 편의상 통과).
 *   - 아이디는 DASHBOARD_USER(기본 'yogibo'), 비밀번호는 DASHBOARD_PASS.
 *   - 페이지·정적파일·API 전부 보호(정적 _next 자산만 제외).
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export function proxy(req) {
  const pass = process.env.DASHBOARD_PASS;
  if (!pass) return NextResponse.next(); // 비밀번호 미설정 → 게이트 비활성

  const user = process.env.DASHBOARD_USER || 'yogibo';
  const header = req.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = atob(encoded); } catch (_) { decoded = ''; }
    const i = decoded.indexOf(':');
    const u = decoded.slice(0, i), p = decoded.slice(i + 1);
    if (u === user && p === pass) return NextResponse.next();
  }
  return new NextResponse('인증이 필요합니다.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="ad-dashboard", charset="UTF-8"' },
  });
}
