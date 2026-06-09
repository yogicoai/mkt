// App Router 루트 레이아웃 (프레임워크 요구). 실제 화면은 public/index.html(정적)이
// '/' 로 rewrite 되어 표시되므로 이 레이아웃은 페이지가 없을 때 빌드 충족용.
export const metadata = {
  title: '광고효율 대시보드',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
