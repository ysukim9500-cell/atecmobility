# vendor/

여기 있는 것은 우리가 쓴 코드가 아니다. **바꾸지 말 것.**

## pdf.js 4.10.38 (Mozilla · Apache-2.0)

- `pdf.min.mjs` · `pdf.worker.min.mjs` (ESM — `import()` 로 부른다)
- 받은 곳: https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/
- 받은 날: 2026-09-16 (3.11.174 → 4.10.38: CVE-2024-4367 — 악성 PDF 의 폰트로 JS 가 실행되는 취약점, 4.2.67 에서 수정. 그와 별개로 getDocument 에 isEvalSupported:false 를 늘 준다)

### 왜 CDN 을 안 쓰고 여기에 두나

증빙 스캔본(PDF)을 브라우저에서 이미지로 바꾸는 데 쓴다. 처음에는 cdnjs 에서
바로 불렀는데, **워커가 교차출처라 브라우저가 Worker 생성을 막고** pdf.js 가
메인 스레드 폴백으로 넘어가면서 화면이 통째로 멈췄다(타이머도 안 돌았다).
워커를 같은 출처에서 주면 그 문제가 없다.

영수증은 결재 서류에 <img> 로 그대로 박히므로, PDF 를 그대로 두면 그 자리가
빈다. 그래서 올리는 시점에 장마다 JPEG 로 바꿔서 저장한다.

### 올릴 때 같이 가야 하는 것

driving.html 은 `vendor/pdf.min.mjs` 를 필요할 때만 `import()` 한다. 배포 저장소
(atecmobility)에도 `vendor/` 를 통째로 올려야 한다.

## SheetJS CE 0.20.3 (SheetJS LLC · Apache-2.0)

- `xlsx.full.min.js` (UMD — 브라우저는 `window.XLSX`, Node 는 `require`) · 라이선스 원문 `LICENSE-SheetJS.txt`
- 받은 곳: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
- 받은 날: 2026-10-08 · sha256 `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`
- 쓰는 곳: 법인카드 지출결의 「ERP 엑셀 올리기」(drv-card.js 가 창을 열 때만 싣는다 — 약 1MB) · 웹 시험(web/test).
- 왜 cdnjs 판(0.18.5)이 아닌가: 0.18.5 에는 엑셀 파일을 읽을 때의 프로토타입 오염(CVE-2023-30533)과
  ReDoS(CVE-2024-22363)가 남아 있다. 직원이 올리는 파일을 읽는 데 쓰므로 고친 판을 둔다.
- 우리 `xlsx.js`(`window.Xlsx`, 소문자 lsx)와 이름이 다르다 — 둘이 함께 있어도 부딪히지 않는다.
