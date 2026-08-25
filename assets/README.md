# ATEC mobility CI 파일

회사 CI 원본(`ATEC mobility CI png`)에서 화면에 쓸 것만 가져왔습니다.

| 파일 | 원본 | 쓰는 곳 |
|---|---|---|
| `atec-logo.png` | ATEC mobility 가로형 | 모든 머리글·내비·로그인 창 (`.atec-mark`) |
| `atec-logo-stack.png` | ATEC mobility 세로형 | 단말기 화면의 원형 로딩 표시 |
| `atec-logo-en.png` | ATEC 영문_기본형 | 예비 (지금은 쓰는 곳 없음) |
| `atec-logo-sm.png` | 가로형을 880px 폭으로 줄인 것 | PDF 서식 머리글. `form-common.js` 의 `FC.LOGO` 에 그대로 박아 두었습니다 |

## 전용색

원본 PNG 에서 그대로 뽑은 값입니다.

- 레드 `#D60051` — 강조·버튼·머리글
- 그레이 `#5A6771` — 보조 글자

짙은 단계(`#A00040`, `#6E002C`)는 레드의 명도만 낮춰 만든 것으로, CI 규정색은
아닙니다. 그러데이션과 큰 면적에만 씁니다.

## 쓰는 법

`assets/atec-ci.css` 를 연결하고 `<img class="atec-mark">` 를 쓰면 됩니다.
어두운 바탕에서는 `on-dark` 를 함께 붙입니다 — 두 가지 색을 그대로 얹으면
레드가 묻히므로 흰색 한 가지로 반전합니다.

```html
<link rel="stylesheet" href="assets/atec-ci.css">
<img src="assets/atec-logo.png" alt="ATEC 에이텍모빌리티" class="atec-mark on-dark">
```

## 로고를 다시 받았을 때

`atec-logo.png` 만 바꾸면 모든 화면이 함께 바뀝니다. 다만 PDF 서식은
`form-common.js` 안에 박아 둔 값을 쓰므로, `atec-logo-sm.png` 를 새로 만들어
base64 로 바꾼 뒤 `FC.LOGO` 도 함께 고쳐야 합니다.
