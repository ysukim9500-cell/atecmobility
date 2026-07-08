/* =====================================================================
 * diagengine.v3.js — 단말기 로그백업 현장조치 판정 엔진 v3
 * ---------------------------------------------------------------------
 * v2 대비: 오전 분석(부록C/D)에서 발굴된 14종 신호 전체 구현.
 *  +mqtt 브로커 경로   +이벤트코드 KB 90종(ASCII C1/G1/V/F + important 바이너리)
 *  +.evl 링크 플래핑(ms 타이밍: 접촉불량 vs 완전단선)  +gw GPS front/rear 안테나
 *  +156/155 승하차·정산 단말 진단(fare dmp·card_trace·거래백업)
 *  +install_os SW배제 근거   +sdr 백업 추세   +교차확증 신뢰도(confidence)
 *  +빈 백업 명시 판정(nodata) — 조용한 빈 결과 금지
 * 검증된 v2 규칙(ping·센터성공률·복구루프·미전송·gw timeout·워치독·부팅)은
 * 동일 임계값으로 보존 → 정답지 3대 회귀 없음.
 *
 * 입력 FileProvider: { path, size, text():string, bytes():Uint8Array(선택) }
 *  - .evl.tar.gz / *_sdr.log.*.tgz 는 호출측이 해제해 가상 provider로 추가
 *    (node: zlib / browser: DecompressionStream + DiagEngineV3.util.untar)
 * 출력: { sn, vehicleId, model, series, severity(core|warn|ok|nodata), swOk,
 *         findings:[{code,name,severity,confidence,sources,evidence,action,parts,note}], signals }
 * ===================================================================== */
(function (root) {
  'use strict';

  // ---------------- CONFIG — 전 임계값 현장 튜닝 지점 ----------------
  var CONFIG = {
    // v2 보존(정답지 3대 검증 완료 값 — 변경 시 회귀테스트 필수)
    ping_loss_pct_bms_down: 100,
    bms_unreach_core:       100,
    center_success_min_pct:  70,
    recover_total_warn:     500,
    recover_total_core:    1500,
    recover_per_day_core:   600,
    gw_timeout_per_day_warn:1000,
    period_reset_warn:      300,
    reboot_rapid_min_sec:   300,
    reboot_rapid_core:        3,
    reboot_abnormal_warn:     2,
    net_backlog_warn:         5,  // 1→5 상향(불량반납 66대 분포: 1~4건은 평시 잔량)
    net_backlog_core:        30,
    omission_bytes_warn:   4096,
    read_cap_bytes:    12000000,
    // v3 신규
    center_zero_core_min_try: 10,  // 성공 0% && 시도 ≥ → 서버연결 핵심
    mqtt_conn_fail_min_try:    5,  // 브로커 연결시도 ≥ && 성공 0 → MQTT 경로 이상
    mqtt_disc_per_day_warn:    5,  // 브로커 끊김 일평균 ≥ → 주의
    evt_core_group_warn:      10,  // 핵심이상 이벤트 그룹 합계 ≥ → 주의
    evt_gps_invalid_warn:     50,  // 93G2 ≥ → GPS 경고
    evl_flap_gap_ms:       60000,  // 재연결 간격 ≤ 1분 = 플래핑 1회
    evl_flap_warn:             5,  // 플래핑 ≥ → 접촉불량 의심
    card_err_per_day_warn:  1000,  // fare 카드오류 일평균 ≥ → 카드리더 점검
    sdr_trend_days_warn:       2,  // rapid 발생일수 ≥ → 전원 열화 추세
    gps_ant_min_samples:      20,  // 안테나 판정 최소 샘플
    gps_ant_zero_pct:         95,  // 한쪽만 무신호 ≥ → 해당 안테나 이상
    evl_cut_min_disc:          2,  // 단선 의심 최소 단절 횟수(오탐 방지)
    seungha_selfloss_warn:     3,  // 승하차 자체끊김 ≥ → 격리판정 발동(오탐 방지)
    sdr_trend_min_rapid:       5   // 전원열화 추세 최소 rapid 총횟수(소량 노이즈 오탐 방지)
  };

  // ------- 이벤트코드 지식베이스: 제조사 공식 전체표(226종, 2026-07-08 반영) -------
  // ⚠ 정정: 5202는 "통신 연결 됨"(정상) — 구KB의 "끊김 감지"는 오류였음
  var LOG_CODES={"3339":["구후불카드 Read 실패","요금처리부","거래/카드","이상"],"3347":["신선불카드 Write 실패","요금처리부","거래/카드","이상"],"3346":["신선불카드 Read 실패","요금처리부","거래/카드","이상"],"7333":["TOPIS 기준 장비 이상 검지 (타코/GPS/도어)","BMS","GPS/위치","이상"],"7338":["KSCC 기준 장비 이상 검지 (타코/GPS)","BMS","GPS/위치","이상"],"3366":["정기권 쓰기 에러","요금처리부","거래/카드","이상"],"3368":["모바일 정기권 쓰기 에러","요금처리부","거래/카드","이상"],"333A":["구후불카드 Write 실패","요금처리부","거래/카드","이상"],"93G5":["GPS 정류장 순차적 인식 오류","운전자단말","GPS/위치","핵심이상"],"3357":["신후불카드 Write 실패","요금처리부","거래/카드","이상"],"3367":["모바일 정기권 읽기 에러","요금처리부","거래/카드","이상"],"3365":["정기권 읽기 에러","요금처리부","거래/카드","이상"],"3312":["CSAM 통신 오류","요금처리부","통신","핵심이상"],"150Q":["운행 중 운전자와 승하차간 통신 연결 30초 이상 끊어짐 (하차2 단말기)","운전자단말","통신","이상"],"3313":["PSAM 통신 오류","요금처리부","통신","핵심이상"],"150P":["운행 중 운전자와 승하차간 통신 연결 30초 이상 끊어짐 (하차1 단말기)","운전자단말","통신","핵심이상"],"7601":["모뎀 상태 정보 5회 이상 수신 실패","BMS","통신","핵심이상"],"3703":["G/W와 요금처리부간 통신 연결 끊어짐","요금처리부","통신","핵심이상"],"5203":["운전자와 승하차간 통신 연결 끊어짐","승하차조작부","통신","이상"],"3356":["신후불카드 Read 실패","요금처리부","거래/카드","이상"],"1A05":["AFC와 HMI간 통신 연결 연속 끊어짐 (30초마다)","운전자단말","통신","이상"],"9802":["G/W와 단말센터 클라우드간 통신 연결 끊어짐","운전자단말","통신","이상"],"150M":["운행 중 운전자와 승하차간 통신 연결 2분 이상 끊어짐 (하차2 단말기)","운전자단말","통신","핵심이상"],"1852":["운전자와 수집 센터간 통신 연결 끊어짐","운전자단말","통신","이상"],"1859":["수집 센터 수신 메시지 응답 시간 초과","운전자단말","통신","이상"],"150O":["운행 중 운전자와 승하차간 통신 연결 30초 이상 끊어짐 (승차 단말기)","운전자단말","통신","핵심이상"],"150L":["운행 중 운전자와 승하차간 통신 연결 2분 이상 끊어짐 (하차1 단말기)","운전자단말","통신","핵심이상"],"7339":["첫번째 정류장 승차인원 대비 하차인원 초과","BMS","GPS/위치","이상"],"1A03":["AFC와 HMI간 통신 연결 끊어짐","운전자단말","통신","핵심이상"],"3306":["거래 성공/ sign3 미수신","요금처리부","거래/카드","이상"],"150U":["운행 중 운전자와 승하차간 통신 연결 5분 이상 끊어짐 (하차2 단말기)","운전자단말","통신","이상"],"9A03":["G/W와 HMI간 통신 모듈 연결 끊어짐","운전자단말","통신","이상"],"5205":["운전자와 승하차간 통신 연결 끊어짐에 대한 AP 상태 확인- 승하차 단말기 기준","승하차조작부","통신","이상"],"150T":["운행 중 운전자와 승하차간 통신 연결 5분 이상 끊어짐 (하차1 단말기)","운전자단말","통신","이상"],"3513":["거래 파일 운전자에 전송 실패","요금처리부","거래/카드","이상"],"9231":["DTG 에서 10초 이상 응답 없음","운전자단말","기타","이상"],"150K":["운행 중 운전자와 승하차간 통신 연결 2분 이상 끊어짐 (승차 단말기)","운전자단말","통신","핵심이상"],"9605":["G/W와 요금처리부간 통신 연결 끊어짐 (요금처리부 2번 단말기)","운전자단말","통신","핵심이상"],"1505":["운전자와 승하차간 통신 연결 끊어짐 (하차1 단말기)","운전자단말","통신","이상"],"150Y":["운행 중 운전자와 승하차간 통신 연결 10분 이상 끊어짐 (하차2 단말기)","운전자단말","통신","이상"],"9607":["G/W와 요금처리부간 통신 연결 끊어짐 (요금처리부 3번 단말기)","운전자단말","통신","핵심이상"],"1507":["운전자와 승하차간 통신 연결 끊어짐 (하차2 단말기)","운전자단말","통신","이상"],"3512":["거래 검증 실패로 운전자에 거래 파일 전송","요금처리부","거래/카드","이상"],"150X":["운행 중 운전자와 승하차간 통신 연결 10분 이상 끊어짐 (하차1 단말기)","운전자단말","통신","이상"],"7803":["G/W와 BMS간 통신 연결 끊어짐","BMS","통신","핵심이상"],"9403":["G/W와 BMS간 통신 연결 끊어짐","운전자단말","통신","이상"],"1503":["운전자와 승하차간 통신 연결 끊어짐 (승차 단말기)","운전자단말","통신","이상"],"3220":["EBCSAM 초기화 에러","요금처리부","펌웨어/OS","이상"],"1213":["거래 검증 타임아웃 발생","운전자단말","거래/카드","이상"],"3305":["5회 재시도 했으나 카드 읽기 실패","요금처리부","거래/카드","핵심이상"],"5401":["운행 중 일정 시간 이상 연결 끊어짐으로 인한 카드 처리 비활성화","승하차조작부","통신","이상"],"150D":["운행 중 운전자와 승하차간 통신 연결 끊어짐 (승차 단말기)","운전자단말","통신","이상"],"150H":["운행 중 운전자와 승하차간 통신 연결 끊어짐 (하차2 단말기)","운전자단말","통신","이상"],"1901":["일정시간 동안 BMS 통신 상태 이상으로 인한 Reset","운전자단말","통신","핵심이상"],"9603":["G/W와 요금처리부간 통신 연결 끊어짐 (요금처리부 1번 단말기)","운전자단말","통신","핵심이상"],"150F":["운행 중 운전자와 승하차간 통신 연결 끊어짐 (하차1 단말기)","운전자단말","통신","이상"],"1205":["거래 파일 검증 실패","운전자단말","거래/카드","이상"],"150S":["운행 중 운전자와 승하차간 통신 연결 5분 이상 끊어짐 (승차 단말기)","운전자단말","통신","이상"],"1330":["일부 승하차 운행 시작 실패된 상태로 운행 시작","운전자단말","운행","이상"],"7602":["단말기 부팅 후 2분 이상 모뎀 연결 안됨","BMS","통신","핵심이상"],"13Y0":["일부 승하차 운행 종료 실패된 상태로 운행 종료","운전자단말","운행","이상"],"5303":["승하차와 요금처리부간 통신 연결 끊어짐","승하차조작부","통신","이상"],"3230":["CSAM 초기화 에러","요금처리부","펌웨어/OS","핵심이상"],"150W":["운행 중 운전자와 승하차간 통신 연결 10분 이상 끊어짐 (승차 단말기)","운전자단말","통신","이상"],"3349":["신선불카드 전자지갑 유효성 체크 실패","요금처리부","거래/카드","이상"],"3603":["승하차와 요금처리부간 통신 연결 끊어짐","요금처리부","통신","이상"],"9320":["G/W 운영정보 파일 로드/적용 실패","운전자단말","통신","이상"],"7402":["BMS와 운전자간 통신 모듈 연결 끊어짐","BMS","통신","이상"],"3326":["구선불카드 Read 실패","요금처리부","거래/카드","이상"],"3302":["카드 환승파일기록 실패/잔액차감성공(0원제외)","요금처리부","거래/카드","이상"],"7907":["BMS와 TOPIS간 통신 모듈의 모뎀 연결 실패","BMS","통신","핵심이상"],"9330":["단말 센터로부터 파일 수신 에러","운전자단말","통신","이상"],"9503":["운전자와 G/W간 통신 연결 끊어짐","운전자단말","통신","이상"],"3327":["구선불카드 Write 실패","요금처리부","거래/카드","이상"],"120A":["거래 파일 merge 시간 5min 이상 10min 미만","운전자단말","거래/카드","이상"],"1010":["운전자 어플리케이션 초기화 실패","운전자단말","펌웨어/OS","이상"],"1020":["운전자 일련번호(IH)가 존재하지 않음","운전자단말","운행","이상"],"9A81":["설치실패(Management)","TMGR","펌웨어/OS","이상"],"9AB1":["설치실패(Diagnostic)","TMGR","펌웨어/OS","이상"],"9AD1":["설치실패(apk_install)","TMGR","펌웨어/OS","이상"],"1000":["운전자 프로세스 시작","운전자단말","운행","정상"],"1060":["운전자 펌웨어 업그레이드","운전자단말","펌웨어/OS","정상"],"1090":["AFC OS 업그레이드","운전자단말","펌웨어/OS","정상"],"1170":["외부 표시기 연결됨","운전자단말","통신","정상"],"1201":["거래 모듈 시작","운전자단말","거래/카드","정상"],"1204":["거래 파일 길이 오류","운전자단말","거래/카드","이상"],"1211":["거래 복구 파일 승하차로부터 수신","운전자단말","거래/카드","정상"],"1300":["운행 시작","운전자단말","운행","정상"],"1302":["운전자 CPU LOAD 3.00 이상","운전자단말","전원/HW","이상"],"1303":["운전자 CPU LOAD 4.00 이상","운전자단말","전원/HW","이상"],"1305":["운전자 거래 파일 일련번호 존재함 (최초 설치 진행함)","운전자단말","거래/카드","정상"],"1310":["운행 중 재시작","운전자단말","전원/HW","정상"],"1502":["운전자와 승하차간 통신 연결 됨 (승차 단말기)","운전자단말","통신","정상"],"1504":["운전자와 승하차간 통신 연결 됨 (하차1 단말기)","운전자단말","통신","정상"],"1506":["운전자와 승하차간 통신 연결 됨 (하차2 단말기)","운전자단말","통신","정상"],"1601":["운전자와 G/W간 통신 모듈 시작","운전자단말","통신","정상"],"1602":["운전자와 G/W간 통신 연결 됨","운전자단말","통신","정상"],"1603":["운전자와 G/W간 통신 연결 끊어짐","운전자단말","통신","이상"],"1851":["운전자와 수집 센터간 통신 연결 됨","운전자단말","통신","정상"],"3000":["요금처리부 프로세스 시작","요금처리부","운행","정상"],"3060":["요금처리부 펌웨어 업그레이드","요금처리부","펌웨어/OS","정상"],"3240":["CSAM 키값 없음","요금처리부","기타","핵심정상"],"3303":["카드 환승파일 읽었으나 깨짐","요금처리부","거래/카드","정상"],"3307":["SAM 수신 데이터 크기 0","요금처리부","기타","정상"],"3317":["SAM에 키셋 정보 없음","요금처리부","기타","정상"],"3335":["구후불카드 PL 체크 결과 NL","요금처리부","거래/카드","정상"],"3345":["신선불카드 PL 체크 결과 NL","요금처리부","거래/카드","정상"],"3355":["신후불카드 PL 체크 결과 NL","요금처리부","거래/카드","정상"],"3361":["정기권 사용일 체크","요금처리부","거래/카드","정상"],"3362":["정기권 잔액 0원","요금처리부","거래/카드","정상"],"3363":["정기권 사용 24시간 차단","요금처리부","거래/카드","정상"],"3369":["기후동행카드 3분 추가 재승차 금지","요금처리부","거래/카드","정상"],"3400":["운행 시작","요금처리부","운행","정상"],"3401":["다인승 입력 처리","요금처리부","기타","정상"],"3402":["현금 입력 처리","요금처리부","기타","정상"],"3404":["운행 시작 취소","요금처리부","운행","정상"],"3440":["요금처리부 운영정보 파일 로드/적용","요금처리부","기타","정상"],"3501":["거래 모듈 시작","요금처리부","거래/카드","정상"],"3505":["거래내역 기록시 1초 이상","요금처리부","거래/카드","이상"],"3506":["거래내역 기록시 500ms 이상 1초 미만","요금처리부","거래/카드","이상"],"3511":["거래 복구 파일 운전자에 전송","요금처리부","거래/카드","정상"],"3702":["G/W와 요금처리부간 통신 연결 됨","요금처리부","통신","정상"],"5000":["승하차 조작부 프로세스 시작","승하차조작부","운행","정상"],"5060":["승하차 펌웨어 업그레이드","요금처리부","펌웨어/OS","정상"],"5171":["ethernet chip 설정 변경(static)","승하차조작부","설정","정상"],"5202":["운전자와 승하차간 통신 연결 됨","승하차조작부","통신","정상"],"5403":["운전자 CPU LOAD 4.00 이상","승하차조작부","전원/HW","핵심이상"],"5404":["운전자 CPU LOAD 5.00 이상","승하차조작부","전원/HW","핵심이상"],"7000":["BMS 프로세스 시작","BMS","운행","정상"],"7050":["BMS 펌웨어 업그레이드","BMS","펌웨어/OS","정상"],"7300":["운행 시작","BMS","운행","정상"],"7301":["BMS CPU LOAD 3.00 이상","BMS","전원/HW","핵심이상"],"7310":["운행 중 재시작","BMS","전원/HW","정상"],"7331":["BMS 센터로 opcode 전송에 대한 ACK/NAK 수신율","BMS","통신","정상"],"7335":["TOPIS로부터 센터 관련 메시지 수신 (opcode: 0x8XXX)","BMS","통신","정상"],"7336":["노선 변경","BMS","기타","정상"],"7337":["차량 정보 변경","BMS","기타","정상"],"7401":["BMS와 운전자간 통신 모듈 연결 됨","BMS","통신","정상"],"7405":["운전자와 시간 동기화","BMS","운행","정상"],"7604":["모뎀 상태 - 비접속중","BMS","통신","핵심정상"],"7605":["모뎀 상태 - 접속 시도 중","BMS","통신","핵심정상"],"7606":["모뎀 상태 - 접속 됨","BMS","통신","정상"],"7801":["G/W와 BMS간 통신 모듈 시작","BMS","통신","정상"],"7802":["G/W와 BMS간 통신 연결 됨","BMS","통신","정상"],"7901":["BMS와 TOPIS간 통신 모듈 시작","BMS","통신","정상"],"7902":["BMS와 TOPIS간 통신 모듈의 모뎀 연결 됨","BMS","통신","정상"],"7903":["BMS와 TOPIS간 통신 모듈의 모뎀 연결 끊어짐","BMS","통신","핵심이상"],"7904":["BMS와 TOPIS간 통신 모듈의 센터 연결 됨","BMS","통신","정상"],"7905":["BMS와 TOPIS간 통신 모듈의 센터 연결 끊어짐","BMS","통신","핵심이상"],"9000":["G/W 프로세스 시작","운전자단말","통신","정상"],"9050":["G/W 펌웨어 업그레이드","운전자단말","통신","정상"],"9240":["운행 중 DTG CAN 신호 값 변화 없음","운전자단말","운행","핵심정상"],"9300":["운행 시작","운전자단말","운행","핵심정상"],"9323":["GPS 정류장 로그 생성 실패","운전자단말","GPS/위치","이상"],"9325":["-","운전자단말","기타","정상"],"9350":["운행 중 개폐 센서 변화 없음","운전자단말","운행","정상"],"9401":["G/W와 BMS간 통신 모듈 시작","운전자단말","통신","정상"],"9402":["G/W와 BMS간 통신 모듈 시작","운전자단말","통신","정상"],"9501":["운전자와 G/W간 통신 모듈 시작","운전자단말","통신","정상"],"9502":["운전자와 G/W간 통신 연결 됨","운전자단말","통신","정상"],"9602":["G/W와 요금처리부간 통신 연결 됨 (요금처리부 1번 단말기)","운전자단말","통신","정상"],"9604":["G/W와 요금처리부간 통신 연결 됨 (요금처리부 2번 단말기)","운전자단말","통신","정상"],"9606":["G/W와 요금처리부간 통신 연결 됨 (요금처리부 3번 단말기)","운전자단말","통신","정상"],"9801":["G/W와 단말센터 클라우드간 통신 연결 됨","운전자단말","통신","정상"],"9803":["클라우드와 시간 동기화","운전자단말","기타","정상"],"10R0":["eMMC 상태 정보","운전자단말","전원/HW","정상"],"13S1":["음량 설정","운전자단말","설정","정상"],"13S2":["밝기 설정","운전자단말","설정","정상"],"13S4":["정류장 보정","운전자단말","GPS/위치","정상"],"13S6":["센터 시스템 정보 설정","운전자단말","통신","정상"],"13V3":["재설치 (승하차 수 3)","운전자단말","거래/카드","정상"],"13V7":["초기설치 (승하차 수 3)","운전자단말","거래/카드","정상"],"13Z0":["운행 종료","운전자단말","운행","정상"],"150C":["운행 중 운전자와 승하차간 통신 연결 됨 (승차 단말기)","운전자단말","통신","정상"],"150E":["운행 중 운전자와 승하차간 통신 연결 됨 (하차1 단말기)","운전자단말","통신","정상"],"150G":["운행 중 운전자와 승하차간 통신 연결 됨 (하차2 단말기)","운전자단말","통신","정상"],"185A":["수집 센터로 파일 업로드 성공","운전자단말","통신","정상"],"1A01":["AFC와 HMI간 통신 모듈 시작","운전자단말","통신","정상"],"1A02":["AFC와 HMI간 통신 연결 됨","운전자단말","통신","정상"],"1B01":["AFC 보드 전원 Off","운전자단말","전원/HW","정상"],"1D20":["dmesg Corrupt filesystem 발생","운전자단말","기타","정상"],"1D30":["dmesg EXT4-fs error 발생","운전자단말","기타","정상"],"1H00":["HMI에서 운행 재시작 요청 받음","운전자단말","전원/HW","정상"],"1P00":["ping 모니터링 결과","운전자단말","기타","정상"],"330E":["미사용 할인코드 발생","요금처리부","기타","정상"],"34Z1":["카드처리 불가상태에서 태그","요금처리부","거래/카드","정상"],"3A07":["승계 페널티 환승영역 데이터 수집","요금처리부","기타","정상"],"3A08":["승계 페널티 카드번호 수집","요금처리부","거래/카드","정상"],"54S1":["단말기 설정","승하차조작부","설정","정상"],"70R0":["eMMC 상태 정보","BMS","전원/HW","정상"],"73Z0":["운행 종료","BMS","운행","정상"],"760D":["모뎀 망 변경됨","BMS","통신","정상"],"760E":["모뎀 신호 세기 2 이하 (max: 5)","BMS","통신","핵심정상"],"7B01":["BMS 보드 전원 Off","BMS","전원/HW","정상"],"7D30":["dmesg EXT4-fs error 발생","BMS","기타","정상"],"7P00":["ping 모니터링 결과","BMS","기타","정상"],"93G2":["GPS 비정상 (Invalid)","운전자단말","GPS/위치","핵심정상"],"93Z0":["운행 종료","운전자단말","운행","핵심정상"],"9A00":["TMGR 시작","TMGR","운행","정상"],"9A01":["G/W와 HMI간 통신 모듈 시작","운전자단말","통신","정상"],"9A02":["G/W와 HMI간 통신 모듈 연결 됨","운전자단말","통신","정상"],"9A50":["설치시작","TMGR","펌웨어/OS","정상"],"9B00":["표출장치의 정보제공 서버에 Tmgr Client 연결","TMGR","통신","정상"],"9B01":["AFC 보드 전원 Off","운전자단말","전원/HW","정상"],"9B10":["표출장치의 파일제공 서버에 Tmgr Client 연결","TMGR","통신","정상"],"9B20":["Tmgr의 정보제공 서버에 표출장치 Client 연결","TMGR","통신","정상"],"9B30":["Tmgr의 파일제공 서버에 표출장치 Client 연결","TMGR","통신","정상"],"A000":["AFC App 시작","TMGR","운행","정상"],"A101":["Admin Login","TMGR","기타","정상"],"A111":["TMGR App 시작 (on AFC App)","TMGR","운행","정상"],"A112":["IFCONFIG RESET","TMGR","전원/HW","정상"],"A200":["비상 운행모드로 운행 시작","TMGR","운행","정상"],"AC00":["시간 동기화","TMGR","기타","정상"],"F000":["FCM 프로세스 시작","운전자단말","운행","정상"],"F001":["Fan 상태 변화","운전자단말","기타","정상"],"F010":["Fan Error","운전자단말","기타","정상"],"G000":["-","TMGR","기타","정상"],"G020":["-","TMGR","기타","정상"],"G201":["-","TMGR","기타","정상"],"G202":["-","TMGR","기타","정상"],"G203":["-","TMGR","기타","정상"],"G204":["-","TMGR","기타","정상"],"G211":["-","TMGR","기타","정상"],"G212":["-","TMGR","기타","정상"],"G213":["-","TMGR","기타","정상"],"G214":["-","TMGR","기타","정상"]};
  var BMS_EVT   = {"7907":1,"7601":1,"7602":1,"7903":1,"7905":1,"7803":1,"9403":1,"7402":1,"1901":1};
  var CENTER_EVT= {"9802":1,"1852":1,"1859":1};
  var SEUNGHA_UNIT_CODES={"승차":["1503","150D","150K","150O","150S","150W"],
                          "하차1":["1505","150F","150L","150P","150T","150X"],
                          "하차2":["1507","150H","150M","150Q","150U","150Y"]};
  var SEUNGHA_SELF=["5203","5205"];
  function unitBreakdown(codes){ var out=[];
    Object.keys(SEUNGHA_UNIT_CODES).forEach(function(u){ var n=0;
      SEUNGHA_UNIT_CODES[u].forEach(function(c){ n+=codes[c]||0; });
      if(n>0) out.push(u+' '+n+'회'); });
    return out.join('·'); }

  function evtGroupOf(code){
    var e=LOG_CODES[code]; if(!e) return null;
    var d=e[0], part=e[1], cat=e[2];
    if(/승하차/.test(d)&&cat==='통신') return '승하차통신';
    if(/HMI/.test(d)) return '표출기통신';
    if(part==='BMS'||/모뎀|BMS/.test(d)) return '모뎀BMS통신';
    if(cat==='거래/카드'||/SAM/.test(d)) return '카드SAM';
    if(cat==='GPS/위치') return 'GPS위치';
    if(/센터|클라우드/.test(d)) return '센터통신';
    if(/G\/W/.test(d)) return 'GW통신';
    if(cat==='운행') return '운행';
    if(cat==='전원/HW') return '전원HW';
    if(cat==='펌웨어/OS') return '펌웨어';
    return '기타';
  }

  // ------- 장애유형 → 조치가이드 (2026 상반기 접수 15,451건 실증 통계 반영) -------
  // 각 조치의 %는 동일 증상 접수에서 실제 그 조치로 해결(완료)된 비율. n=통계 모수.
  var ACTION_KB = {
    BMS_DOWN:      { name:'BMS 통신 단절',   steps:['모뎀 USIM 탈거→접점 세척→재삽입 (현장 해결률 42%·모뎀계열 접수 1,476건)','외장 LTE 모뎀 교체 (39%)','지속 시 통합단말기(BMS B/D) 교체 (BMS불량 접수의 77%가 통합 교체로 종결)'], parts:['외장 LTE 모뎀','통합단말기(BMS B/D)'], note:'⚠ B700/B710/B800 외장모뎀 혼용 금지 · 교체 전 거래백업' },
    BMS_WARN:      { name:'BMS 통신 이상',   steps:['모뎀 USIM 세척·재삽입 (현장 42%)','외장 LTE 모뎀 LED/커넥터 점검'], parts:['외장 LTE 모뎀'] },
    MQTT_PATH:     { name:'BMS↔TOPIS MQTT 경로 이상', steps:['모뎀 USIM 세척·재삽입 (현장 42%)','브로커(14.33.246.7:1883) 도달성 확인','외장 LTE 모뎀 교체 (39%)'], parts:['외장 LTE 모뎀'] },
    SERVER_CONN:   { name:'서버연결 불량',   steps:['통합단말기 교체 검토 (서버연결대기 접수 466건의 81%가 통합 교체로 종결)','표출기 LTE 감도·수집센터 IP 설정 확인'], parts:['통합단말기','외장 LTE 모뎀'] },
    SERVER_DEAD:   { name:'서버연결 전면 실패', steps:['거래내역 백업 선행(유실 방지)','통합단말기 교체 (현장 81%·n=466)','안 되면 표출단말기 교체 (13%)'], parts:['통합단말기','표출단말기(HMI)'], note:'미전송 유실 위험 — 백업 우선' },
    TRANS_BACKLOG: { name:'거래 미전송 누적', steps:['거래내역 백업 선행(유실 방지)','통신 복구(모뎀 USIM 세척→모뎀 점검)','통합단말기 교체 검토'], parts:['통합단말기'], note:'지속 시 수리센터 입고' },
    TRANS_WARN:    { name:'거래 미전송 조짐', steps:['거래백업 상태 확인','통신 점검(USIM 세척 포함)'], parts:[] },
    NET_BACKLOG_CORE:{ name:'센터 미전송 대량', steps:['미전송 즉시 백업 보존','통신 복구 후 재전송 확인'], parts:[], note:'유실위험' },
    NET_BACKLOG:   { name:'센터 미전송 잔량', steps:['미전송 보존 후 통신 복구'], parts:[] },
    COMM_QUALITY:  { name:'통신품질 저하',   steps:['모뎀 USIM 세척·재삽입 (현장 42%)','모뎀 신호감도·안테나 체결 확인','외장 LTE 모뎀 교체 (39%)'], parts:['외장 LTE 모뎀','안테나'] },
    WATCHDOG:      { name:'워치독 과다리셋', steps:['모듈 안정성 점검','통합단말기 점검'], parts:['통합단말기'] },
    REBOOT_LOOP:   { name:'연속재부팅',     steps:['차량 Fuse 확인·교체 (전원계열 접수 117건 중 1위 27%)','통합단말기 전원 케이블 재연결 (24%)','케이블 결선작업 (9%)','통합단말기 교체 (8%)'], parts:['차량 퓨즈','전원 케이블','통합단말기'] },
    POWER_ABN:     { name:'비정상 전원차단', steps:['차량 Fuse 확인 (현장 27%)','전원 케이블 재연결 (24%)','전원부 점검'], parts:['차량 퓨즈','전원 케이블'] },
    POWER_TREND:   { name:'전원/재부팅 열화 추세', steps:['차량 Fuse·전원 케이블 우선 점검 (전원계열 현장 조치 1·2위)','다일간 재부팅 추세 확인','전원부·배선 점검'], parts:['차량 퓨즈','전원 케이블'] },
    GPS_WARN:      { name:'GPS 수신 불량',   steps:['GPS 안테나 위치 변경(시야 확보) (현장 47%·GPS 접수 1,071건)','GPS 안테나 교체 (24%)','GPS 커넥터 재연결 (14%)'], parts:['GPS 안테나'] },
    GPS_ANT:       { name:'GPS 안테나 이상(편측)', steps:['해당(앞/뒤) 안테나 커넥터 재연결 (현장 14%)','안테나 위치 변경 (47%)','안테나 교체 (24%)'], parts:['GPS 안테나'] },
    DATA_LOSS:     { name:'데이터 유실(누락)', steps:['전송/저장 경로 점검'], parts:[] },
    LINK_FLAPPING: { name:'모듈 링크 플래핑(접촉불량 의심)', steps:['해당 링크 커넥터 재체결','케이블 교체','승하차 링크면 위치 맞교체로 격리 확인'], parts:['연결 케이블'], note:'짧은 주기 반복 단절 → 접촉불량 패턴' },
    LINK_CUT:      { name:'모듈 링크 단선 의심', steps:['케이블 단선 확인','모듈 전원 확인'], parts:['연결 케이블','해당 모듈'] },
    EVT_GROUP:     { name:'이벤트 경고',     steps:['해당 부위 점검(코드 상세 참조)'], parts:[] },
    CARD_READER:   { name:'카드리더 오류 과다', steps:['해당 단말기 교체 (카드무감 접수 202건: 승차 39%·하차1 28%·하차2 21%)','SAM 세척·재삽입','카드리더 접점 청소'], parts:['승하차 단말기'] }
  };
  // 이벤트 그룹별 실증 조치 (EVT_GROUP 발화 시 그룹에 맞는 가이드로 대체)
  var EVT_GROUP_ACTIONS = {
    '승하차통신': { steps:['해당 유닛 단말기 교체 (하차통신 접수 1,629건: 하차1 23%·하차2 18%)','승하차 위치 맞교체로 격리 확인 (15%)','통신 케이블 교체 (11%)'], parts:['승하차 단말기','통신 케이블'] },
    '표출기통신': { steps:['표출단말기 교체 (화면·부팅계열 접수의 95~97%)','표출기 케이블 재연결'], parts:['표출단말기(HMI)'] },
    '카드SAM':   { steps:['해당 단말기 교체 (카드무감: 승차 39%·하차1 28%·하차2 21%)','SAM 세척·재삽입'], parts:['승하차 단말기'] },
    'GW통신':    { steps:['통합단말기 교체 검토 (CITS불량 접수 469건의 91%)','케이블 재연결'], parts:['통합단말기'] },
    '전원HW':    { steps:['차량 Fuse 확인 (현장 27%)','전원 케이블 재연결 (24%)'], parts:['차량 퓨즈','전원 케이블'] },
    '펌웨어':    { steps:['F/W·OS 재적용 (펌웨어 접수 310건 중 13%)','지속 시 표출(36%)/통합(25%) 교체'], parts:[] },
    '운행':      { steps:['통합단말기 교체 (운행시작안됨 접수 209건의 67%)','표출단말기 교체 (20%)'], parts:['통합단말기','표출단말기(HMI)'] }
  };

  // ---------------- 유틸 ----------------
  function txt(f){
    if(f.__t!==undefined) return f.__t;
    var t=''; try{ t=f.text?(f.text()||''):''; }catch(e){ t=''; }
    if(t.length>CONFIG.read_cap_bytes) t=t.slice(0,CONFIG.read_cap_bytes);
    f.__t=t; return t;
  }
  function bts(f){ try{ return f.bytes?f.bytes():null; }catch(e){ return null; } }
  function occ(hay,sub){ if(!hay) return 0; var n=0,p=0; while((p=hay.indexOf(sub,p))!==-1){ n++; p+=sub.length; } return n; }
  function daysOf(files,re){ re=re||/(?:log|ping|trlog|gps)_(\d{8})/; var s={},k;
    for(var i=0;i<files.length;i++){ var m=re.exec(files[i].path); if(m) s[m[1]]=1; }
    k=Object.keys(s).length; return k||1; }
  function sel(files,re,extra){ return files.filter(function(f){ return re.test(f.path)&&(!extra||extra(f)); }); }
  function notBak(f){ return !/\.bak$/.test(f.path); }
  function top(obj,n){ return Object.keys(obj).sort(function(a,b){return obj[b]-obj[a];}).slice(0,n)
      .map(function(k){ return k+'×'+obj[k]; }).join(', '); }

  // 최소 tar 파서 (gunzip 후 사용; browser/node 공용)
  function untar(u8){
    var out=[], off=0;
    function str(a,b){ var s=''; for(var i=a;i<b;i++){ if(!u8[i]) break; s+=String.fromCharCode(u8[i]); } return s; }
    while(off+512<=u8.length){
      var name=str(off,off+100); if(!name) break;
      var size=parseInt(str(off+124,off+136).trim(),8)||0;
      var type=String.fromCharCode(u8[off+156]||48);
      var data=u8.subarray(off+512,off+512+size);
      if(type==='0'||type===' '||type==='') out.push({name:name,data:data});
      off+=512+Math.ceil(size/512)*512;
    }
    return out;
  }

  // ---------------- 경로 판별 ----------------
  var P = {
    ping:    /\/bms\/ping_\d+\.log$/i,
    busDmp:  /\/bus\/logs\/debug\/log_\d+\.dmp$/i,
    gwDmp:   /\/gw\/logs\/debug\/log_\d+\.dmp$/i,
    mqttDmp: /\/mqtt\/logs\/log_\d+\.dmp$/i,
    fareDmp: /\/fare\/logs\/debug\/log_\d+\.dmp$/i,
    trlog:   /\/card_trace\/trlog_\d+\.log$/i,
    sdr:     /_sdr\.log$/i,
    netUp:   /\/net\/c2s\/upload\/[^/]*\.trn$/i,
    impEvt:  /\/event\/important\/[^/]*\.evt$/i,
    ascEvt:  /\/event\/EVENT_\d{8}_([A-Z]\d)_\d+\.evt$/i,
    omis:    /\/event\/omission\/[^/]*\.evt$/i,
    evl:     /\.evl$/i,
    gwGps:   /\/gw\/logs\/gps\/gps_\d+\.log$/i,
    fw:      /\/install_os\.log$/i,
    tinfo:   /\/file_backup\/term_c_info\.dat$/i,
    dayTrn:  /\/trans\/backup\/day_\d{8}_\d+\.trn\.tar\.gz$/i
  };

  // ---------------- 신호 추출 ----------------
  function sigPing(files){
    var fs=sel(files,P.ping); if(!fs.length) return null;
    var un=0,ok=0; fs.forEach(function(f){ var t=txt(f); un+=occ(t,'Unreachable'); ok+=occ(t,'bytes from'); });
    var tot=un+ok, loss=tot?Math.round(100*un/tot):(un?100:0);
    return { files:fs.length, unreach:un, ok:ok, loss_pct:loss };
  }

  function sigComm(files){
    var bus=sel(files,P.busDmp,notBak), gw=sel(files,P.gwDmp,notBak);
    if(!bus.length&&!gw.length) return null;
    var R={ recover:0,period_reset:0,gw_timeout:0,gw_fail:0,heartbeat:0,bms_dl_fail:0,
            bus_days:daysOf(bus), gw_days:daysOf(gw), ep:{} };
    function cloud(t){
      var re=/Connect(ing|ed) To Cloud[^(\n]*\(([A-Z_]+)\)/g, m;
      while((m=re.exec(t))){ var tag=m[2]; var e=R.ep[tag]||(R.ep[tag]={try:0,ok:0});
        if(m[1]==='ing') e.try++; else e.ok++; }
    }
    bus.forEach(function(f){ var t=txt(f);
      R.recover+=occ(t,'복구 파일 존재 여부 확인 요청');
      R.period_reset+=occ(t,'PERIOD_RESET');
      R.bms_dl_fail+=occ(t,'DOWNLOAD FAIL');
      cloud(t); });
    gw.forEach(function(f){ var t=txt(f);
      R.gw_timeout+=occ(t,'timeout'); R.gw_fail+=occ(t,'FAIL'); R.heartbeat+=occ(t,'heartbeat');
      cloud(t); });
    var tr=0, ok=0; Object.keys(R.ep).forEach(function(k){ tr+=R.ep[k].try; ok+=R.ep[k].ok; });
    R.connecting=tr; R.connected=ok;
    R.success_pct = tr?Math.round(100*ok/tr):null;
    R.per_day = R.bus_days?Math.round(R.recover/R.bus_days):0;
    return R;
  }

  function sigBoot(files){
    var cur=sel(files,P.sdr,function(f){ return !/\/backup\//.test(f.path)&&f.path.indexOf('#')<0; });
    var bak=sel(files,P.sdr,function(f){ return /\/backup\//.test(f.path)||f.path.indexOf('#')>=0; });
    if(!cur.length&&!bak.length) return null;
    function scan(fs){
      var starts=[];
      fs.forEach(function(f){ var lastShut=true;
        txt(f).split(/\r?\n/).forEach(function(line){
          var m=/\[(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*\|[^\]]*\]\s*(.*)/.exec(line);
          if(!m) return; var desc=m[7];
          var dt=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])/1000;
          if(desc.indexOf('프로그램 시작')>=0){ starts.push([dt,lastShut]); lastShut=false; }
          else if(desc.indexOf('운행 종료')>=0){ lastShut=true; }
        });
      });
      starts.sort(function(a,b){return a[0]-b[0];});
      var rapid=0,abn=0,rapidDays={};
      for(var i=1;i<starts.length;i++){ var gap=starts[i][0]-starts[i-1][0];
        if(gap<CONFIG.reboot_rapid_min_sec){ rapid++;
          rapidDays[new Date(starts[i][0]*1000).toISOString().slice(0,10)]=1; }
        else if(!starts[i][1]) abn++; }
      return { reboots:starts.length, rapid:rapid, abnormal:abn, rapidDays:Object.keys(rapidDays).length };
    }
    var c=scan(cur), b=bak.length?scan(bak):null;
    return { cur:c, bak:b };
  }

  function sigNet(files){ var fs=sel(files,P.netUp); return fs.length?{backlog:fs.length}:null; }

  function sigOmission(files){ var fs=sel(files,P.omis); if(!fs.length) return null;
    var b=0; fs.forEach(function(f){ b+=(f.size||0); }); return {bytes:b}; }

  function sigMqtt(files){
    var fs=sel(files,P.mqttDmp,notBak); if(!fs.length) return null;
    var R={try:0,ok:0,disc:0,starts:0,days:daysOf(fs),vehicleId:null,bizId:null};
    fs.forEach(function(f){ var t=txt(f);
      R.try+=occ(t,'mosquitto connect...');
      R.ok+=occ(t,'on_connected()');
      R.disc+=occ(t,'on_disconnected(');
      R.starts+=occ(t,'program start');
      if(!R.vehicleId){ var m=/vehicle_id:(\d+)/.exec(t); if(m) R.vehicleId=m[1]; }
      if(!R.bizId){ var b=/trans_biz_id:(\d+)/.exec(t); if(b) R.bizId=b[1]; }
    });
    R.disc_per_day=Math.round(R.disc/R.days*10)/10;
    return R;
  }

  function sigEvents(files){
    var asc=sel(files,P.ascEvt), imp=sel(files,P.impEvt);
    if(!asc.length&&!imp.length) return null;
    var codes={}, channels={}, vehicleId=null;
    asc.forEach(function(f){
      var ch=(P.ascEvt.exec(f.path)||[])[1]||'?';
      txt(f).split(/\r?\n/).forEach(function(L){
        if(L.length<47||!/^\d{9}/.test(L)) return;
        var code=L.slice(43,47);
        if(!LOG_CODES[code]) return;
        codes[code]=(codes[code]||0)+1;
        channels[ch]=(channels[ch]||0)+1;
        if(!vehicleId){ var v=L.slice(23,32); if(/^\d{9}$/.test(v)) vehicleId=v; }
      });
    });
    imp.forEach(function(f){
      var u=bts(f); if(!u) return;
      for(var o=0;o+8<=u.length;o+=8){
        var code=String.fromCharCode(u[o],u[o+1],u[o+2],u[o+3]);
        var cnt=u[o+4]|(u[o+5]<<8)|(u[o+6]<<16)|(u[o+7]<<24);
        if(cnt>0&&cnt<100000&&LOG_CODES[code]) codes[code]=(codes[code]||0)+cnt;
      }
    });
    var groups={};
    Object.keys(codes).forEach(function(c){
      if(LOG_CODES[c][3].indexOf('정상')>=0) return; // 정상/핵심정상 코드는 장애 집계 제외
      var g=evtGroupOf(c); if(!g) return;
      var G=groups[g]||(groups[g]={total:0,core:0,codes:{}});
      G.total+=codes[c]; G.codes[c]=codes[c];
      if(LOG_CODES[c][3]==='핵심이상') G.core+=codes[c];
    });
    return { codes:codes, groups:groups, channels:channels, vehicleId:vehicleId, gps_invalid:codes['93G2']||0 };
  }

  function sigEvl(files){
    var fs=sel(files,P.evl); if(!fs.length) return null;
    var links={};
    fs.forEach(function(f){
      var lm=/\d{8}_([a-z0-9]+_[a-z0-9]+)/i.exec(f.path.split('/').pop());
      var link=lm?lm[1]:'link';
      var L=links[link]||(links[link]={conn:0,disc:0,flaps:0,lastState:null});
      var lastDiscMs=null;
      txt(f).split(/\r?\n/).forEach(function(line){
        var m=/^\[(\d{2}):(\d{2}):(\d{2}):(\d{3})\].*\[M:(DISCONNECTED|CONNECTED)\]/.exec(line);
        if(!m) return;
        var ms=((+m[1])*3600+(+m[2])*60+(+m[3]))*1000+(+m[4]);
        if(m[5]==='DISCONNECTED'){ L.disc++; lastDiscMs=ms; L.lastState='disc'; }
        else { L.conn++;
          if(lastDiscMs!==null && ms-lastDiscMs>=0 && ms-lastDiscMs<=CONFIG.evl_flap_gap_ms) L.flaps++;
          lastDiscMs=null; L.lastState='conn'; }
      });
    });
    return links;
  }

  function sigGwGps(files){
    var fs=sel(files,P.gwGps); if(!fs.length) return null;
    var n=0,fz=0,rz=0;
    fs.forEach(function(f){
      txt(f).split(/\r?\n/).forEach(function(line){
        var m=/front\[([^\]]*)\]\s*-\s*rear\[([^\]]*)\]/.exec(line); if(!m) return;
        n++;
        var fv=(m[1].match(/\d+/g)||[]).some(function(x){return +x>0;});
        var rv=(m[2].match(/\d+/g)||[]).some(function(x){return +x>0;});
        if(!fv) fz++; if(!rv) rz++;
      });
    });
    if(!n) return null;
    return { samples:n, front_zero_pct:Math.round(100*fz/n), rear_zero_pct:Math.round(100*rz/n) };
  }

  function sigFw(files){
    var fs=sel(files,P.fw); if(!fs.length) return null;
    var t=txt(fs[0]);
    var noNeed=occ(t,'no need to update');
    var m=/Uboot:v(\d+), Kernel:v(\d+), RootFS:v(\d+)/.exec(t);
    return { sw_ok:noNeed>=3, versions:m?('U'+m[1]+'/K'+m[2]+'/R'+m[3]):null };
  }

  function sigFare(files){
    var dmp=sel(files,P.fareDmp,notBak), tr=sel(files,P.trlog), day=sel(files,P.dayTrn);
    if(!dmp.length&&!tr.length&&!day.length) return null;
    var R={ card_err:0, fail_info:0, dmp_days:daysOf(dmp), trlog_records:0, trlog_days:daysOf(tr),
            backup_days:day.length };
    dmp.forEach(function(f){ var t=txt(f);
      R.card_err+=occ(t,'card_err'); R.fail_info+=occ(t,'fail info cnt'); });
    tr.forEach(function(f){ R.trlog_records+=occ(txt(f),'\nTS'); });
    R.card_err_per_day=Math.round(R.card_err/R.dmp_days);
    return R;
  }

  // 승하차 debug의 통합 연결 직접증거 → 격리 신호 (장애유형별_판단근거 PDF의 격리표 이식)
  function sigSeungha(files,e,fa){
    var dmp=sel(files,P.fareDmp,notBak);
    var hasV=e&&e.channels&&Object.keys(e.channels).some(function(ch){return /^V/.test(ch);});
    if(!dmp.length&&!hasV) return null;
    var connected=0,send=0,tryConn=0,onConn=0;
    dmp.forEach(function(f){ var t=txt(f);
      connected+=occ(t,'] : connected'); send+=occ(t,'] : send');
      tryConn+=occ(t,'try_conn'); onConn+=occ(t,'on_connected'); });
    var everConnected=connected>0||onConn>0, sentData=send>0;
    var state=(everConnected&&sentData)?'active':(tryConn>0?'tryingNoConn':'booted');
    var selfLoss=0; if(e) SEUNGHA_SELF.forEach(function(c){ selfLoss+=e.codes[c]||0; });
    var alive=!!(fa&&(fa.backup_days>0||fa.trlog_records>0))||!!e||everConnected||sentData||tryConn>0;
    return { link:{state:state,connected:connected,send:send,tryConn:tryConn,reconnects:onConn},
             selfLoss:selfLoss, alive:alive, hasDebug:dmp.length>0, dmp_days:daysOf(dmp) };
  }

  function vehId(files,mqtt,evt){
    var fs=sel(files,P.tinfo);
    if(fs.length){ var m=/\d{6,}/.exec(txt(fs[0])); if(m) return m[0]; }
    if(mqtt&&mqtt.vehicleId) return mqtt.vehicleId;
    if(evt&&evt.vehicleId) return evt.vehicleId;
    return null;
  }

  var SN_RE=/(465\d{6}|460\d{6}|46\d{7}|570\d{6}|590\d{6}|59\d{7}|445\d{6}|44\d{7}|15[56]\d{6})/g;
  function snOf(files){
    var cand={}, pri={'465':1,'460':1,'570':1,'590':2,'155':3,'156':3,'445':4,'440':4};
    files.forEach(function(f){ var m; SN_RE.lastIndex=0;
      while((m=SN_RE.exec(f.path))) cand[m[1]]=Math.min(cand[m[1]]||9, pri[m[1].slice(0,3)]||9); });
    var ks=Object.keys(cand); if(!ks.length) return null;
    ks.sort(function(a,b){ return cand[a]-cand[b]; });
    return ks[0];
  }
  function modelOf(sn){ if(!sn) return '-'; var p=sn.slice(0,3);
    return {'460':'B700','465':'B710','570':'B800','590':'승하차/정산','155':'승하차/정산','156':'승하차/정산'}[p]||p; }
  function seriesOf(sn){ if(!sn) return '-';
    return /^(59|15)/.test(sn)?'승하차/정산':'통합단말'; }

  // ---------------- 판정 (교차확증 신뢰도 포함) ----------------
  function judge(S, model){
    var F=[];
    function add(code,sv,evidence,sources,extra){
      var kb=ACTION_KB[code];
      F.push({ code:code, name:(extra&&extra.name)||kb.name, severity:sv,
        confidence:(sources.length>=2||(extra&&extra.definitive))?'high':'medium',
        sources:sources.slice(), evidence:evidence.join(' · '),
        action:(extra&&extra.action)||kb.steps.join(' → '), parts:(extra&&extra.parts)||kb.parts,
        note:(extra&&extra.note)||kb.note||'' });
    }
    var p=S.ping,m=S.comm,n=S.net,b=S.boot,o=S.omission,q=S.mqtt,e=S.events,v=S.evl,g=S.gwgps,fw=S.fw,fa=S.fare,sg=S.seungha;

    // ---- BMS (ping 1차 + mqtt·이벤트 교차확증) ----
    var bmsEvid=[], bmsSrc=[];
    if(e){ var bc=0,bl=[]; Object.keys(BMS_EVT).forEach(function(c){ if(e.codes[c]){ bc+=e.codes[c]; bl.push(c+'×'+e.codes[c]); } });
      if(bc>0){ bmsEvid.push('이벤트 '+bl.join(',')); bmsSrc.push('event'); } }
    var mqttDead = q&&q.try>=CONFIG.mqtt_conn_fail_min_try&&q.ok===0;
    if(mqttDead){ bmsEvid.push('MQTT 브로커 연결 0/'+q.try); bmsSrc.push('mqtt'); }
    if(m&&m.bms_dl_fail>0){ bmsEvid.push('BMS DOWNLOAD FAIL '+m.bms_dl_fail); bmsSrc.push('dmp'); }
    if(p&&p.loss_pct>=CONFIG.ping_loss_pct_bms_down){
      var core=p.unreach>=CONFIG.bms_unreach_core;
      add(core?'BMS_DOWN':'BMS_WARN', core?'core':'warn',
        ['BMS ping 손실 '+p.loss_pct+'% (Unreach '+p.unreach+')'].concat(bmsEvid),
        ['ping'].concat(bmsSrc), {definitive:core});
    } else if(p&&p.files>0&&p.ok===0){
      add('BMS_WARN','warn',['ping 정상응답 0 (로그 존재 자체가 이상)'].concat(bmsEvid),['ping'].concat(bmsSrc));
    } else if(!p&&mqttDead){
      add('MQTT_PATH','warn',['MQTT 브로커 연결 실패 '+q.try+'회(성공 0)'].concat(bmsEvid),['mqtt'].concat(bmsSrc));
    } else if(q&&q.disc_per_day>=CONFIG.mqtt_disc_per_day_warn){
      add('MQTT_PATH','warn',['MQTT 끊김 일평균 '+q.disc_per_day+' (총 '+q.disc+')'],['mqtt']);
    }

    // ---- 서버연결 (엔드포인트별 + 이벤트 교차) ----
    if(m&&m.success_pct!==null){
      var cSrc=['dmp'], cEvid=['센터 연결 성공률 '+m.success_pct+'% ('+m.connected+'/'+m.connecting+')'];
      Object.keys(m.ep).forEach(function(tag){ var x=m.ep[tag];
        if(x.try>=3&&x.ok===0) cEvid.push(tag+' 전면실패(0/'+x.try+')'); });
      if(e){ var cc=0,cl=[]; Object.keys(CENTER_EVT).forEach(function(c){ if(e.codes[c]){ cc+=e.codes[c]; cl.push(c+'×'+e.codes[c]); } });
        if(cc>0){ cEvid.push('이벤트 '+cl.join(',')); cSrc.push('event'); } }
      if(m.success_pct===0&&m.connecting>=CONFIG.center_zero_core_min_try)
        add('SERVER_DEAD','core',cEvid,cSrc,{definitive:true});
      else if(m.success_pct<CONFIG.center_success_min_pct)
        add('SERVER_CONN','warn',cEvid,cSrc);
    }

    // ---- 거래 미전송 (총량 단독으로는 core 금지 — B800 평시 복구루프 일평균 ~146 반영) ----
    var transCross = (n&&n.backlog>=CONFIG.net_backlog_core) || (m&&m.success_pct===0&&m.connecting>=CONFIG.center_zero_core_min_try);
    if(m&&(m.per_day>=CONFIG.recover_per_day_core||(m.recover>=CONFIG.recover_total_core&&transCross)))
      add('TRANS_BACKLOG','core',['복구요청 총 '+m.recover+'회 (일평균 '+m.per_day+')'].concat(transCross?['미전송 잔량/서버실패 교차확인'] : []),['dmp'].concat(transCross?['fs']:[]),{definitive:true});
    else if(m&&(m.recover>=CONFIG.recover_total_warn))
      add('TRANS_WARN','warn',['복구요청 총 '+m.recover+'회 (일평균 '+m.per_day+')'],['dmp'],
        m.recover>=CONFIG.recover_total_core?{note:'총량은 많으나 계열 평시 rate 범위·교차근거 없음 — 미전송 잔량 확인 권장'}:undefined);
    if(n&&n.backlog>=CONFIG.net_backlog_core) add('NET_BACKLOG_CORE','core',['upload 대기 '+n.backlog+'건 (유실위험)'],['fs'],{definitive:true});
    else if(n&&n.backlog>=CONFIG.net_backlog_warn) add('NET_BACKLOG','warn',['upload 대기 '+n.backlog+'건'],['fs']);

    // ---- gw 통신품질 / 워치독 (v2 보존) ----
    if(m&&m.gw_timeout/Math.max(1,m.gw_days)>=CONFIG.gw_timeout_per_day_warn){
      var perDay=Math.round(m.gw_timeout/Math.max(1,m.gw_days));
      var qEv=['gw timeout 일평균 '+perDay+' (총 '+m.gw_timeout+')'], qSrc=['gw'];
      if(e&&e.codes['760E']){ qEv.push('모뎀 신호세기 2 이하(760E) '+e.codes['760E']+'회'); qSrc.push('event'); }
      var qNote=(model==='B800'&&perDay<=3500)?'B800 계열 공통 수준(불량반납 24대 중앙값 ~2,600/일)과 유사 — 개별 단말 원인이 아닐 수 있음':'';
      add('COMM_QUALITY','warn',qEv,qSrc,qNote?{note:qNote}:undefined);
    }
    if(m&&m.period_reset>=CONFIG.period_reset_warn)
      add('WATCHDOG','warn',['PERIOD_RESET '+m.period_reset+'회'],['dmp']);

    // ---- 부팅/전원 (v2 보존 + 백업 추세) ----
    if(b&&b.cur){
      if(b.cur.rapid>=CONFIG.reboot_rapid_core){
        var ev=['5분내 재시작 '+b.cur.rapid+'회'], src=['sdr'];
        if(b.bak&&b.bak.rapid>0){ ev.push('과거 백업에도 rapid '+b.bak.rapid+'회'); src.push('sdr_backup'); }
        add('REBOOT_LOOP','core',ev,src,{definitive:true});
      } else if(b.cur.abnormal>=CONFIG.reboot_abnormal_warn){
        add('POWER_ABN','warn',['정상종료 없는 재시작 '+b.cur.abnormal+'회'],['sdr']);
      } else if(b.bak&&(b.cur.rapidDays+(b.bak.rapidDays||0))>=CONFIG.sdr_trend_days_warn&&(b.cur.rapid+b.bak.rapid)>=CONFIG.sdr_trend_min_rapid){
        add('POWER_TREND','warn',['rapid 발생일수 '+(b.cur.rapidDays+b.bak.rapidDays)+'일 (현재 '+b.cur.rapid+'·과거 '+b.bak.rapid+')'],['sdr','sdr_backup']);
      }
    }

    // ---- GPS: 이벤트 93G2 + gw 안테나 편측 ----
    if(e&&e.gps_invalid>=CONFIG.evt_gps_invalid_warn)
      add('GPS_WARN','warn',['GPS Invalid(93G2) '+e.gps_invalid+'회'],['event']);
    if(g&&g.samples>=CONFIG.gps_ant_min_samples){
      if(g.front_zero_pct>=CONFIG.gps_ant_zero_pct&&g.rear_zero_pct<50)
        add('GPS_ANT','warn',['front 안테나 무신호 '+g.front_zero_pct+'% (rear 정상, '+g.samples+'샘플)'],['gw_gps'],{name:'GPS 앞(front) 안테나 이상'});
      else if(g.rear_zero_pct>=CONFIG.gps_ant_zero_pct&&g.front_zero_pct<50)
        add('GPS_ANT','warn',['rear 안테나 무신호 '+g.rear_zero_pct+'% (front 정상, '+g.samples+'샘플)'],['gw_gps'],{name:'GPS 뒤(rear) 안테나 이상'});
      // 양측 0은 차고지 보관 가능성 → 판정 보류(오탐 방지)
    }

    // ---- 누락 이벤트 ----
    if(o&&o.bytes>=CONFIG.omission_bytes_warn) add('DATA_LOSS','warn',['누락 '+o.bytes+' bytes'],['fs']);

    // ---- .evl 링크 플래핑/단선 ----
    if(v){
      Object.keys(v).forEach(function(link){ var L=v[link];
        if(L.flaps>=CONFIG.evl_flap_warn)
          add('LINK_FLAPPING','warn',[link+' 링크: 1분내 재연결 '+L.flaps+'회 (단절 '+L.disc+'/연결 '+L.conn+')'],['evl'],{name:'링크 플래핑('+link+') — 접촉불량 의심'});
        else if(L.disc>=CONFIG.evl_cut_min_disc&&L.conn===0)
          add('LINK_CUT','warn',[link+' 링크: 단절 '+L.disc+'회 후 재연결 없음'],['evl'],{name:'링크 단선 의심('+link+')'});
      });
    }

    // ---- 이벤트 그룹 경고 (위 판정과 중복되지 않는 그룹만) ----
    if(e){
      var covered={'모뎀BMS통신':F.some(function(x){return /^BMS|MQTT/.test(x.code);}),
                   '센터통신':F.some(function(x){return /^SERVER/.test(x.code);}),
                   'GPS위치':F.some(function(x){return /^GPS/.test(x.code);})};
      Object.keys(e.groups).forEach(function(gname){
        var G=e.groups[gname];
        if(covered[gname]) return;
        if(G.core>=CONFIG.evt_core_group_warn){
          var ev2=[gname+' 핵심이상 이벤트 '+G.core+'회 ('+top(G.codes,3)+')'];
          if(gname==='승하차통신'){ var ub=unitBreakdown(e.codes); if(ub) ev2.push('유닛별: '+ub); }
          var ga=EVT_GROUP_ACTIONS[gname];
          add('EVT_GROUP','warn',ev2,['event'],
            ga?{name:'이벤트 경고: '+gname, action:ga.steps.join(' → '), parts:ga.parts}:{name:'이벤트 경고: '+gname});
        }
      });
    }

    // ---- fare(156/155) 카드리더 ----
    if(fa&&fa.card_err_per_day>=CONFIG.card_err_per_day_warn)
      add('CARD_READER','warn',['card_err 일평균 '+fa.card_err_per_day+' (총 '+fa.card_err+', fail_info '+fa.fail_info+')'],['fare_dmp']);

    // ---- 승하차 격리판정 (fare debug 직접증거 — 단독 백업 기준) ----
    if(sg&&sg.link){
      var L2=sg.link, iso=null;
      if(sg.hasDebug&&L2.state==='tryingNoConn'){
        var multiDay=sg.dmp_days>=2; // 하루치뿐이면 백업 직후 벤치 부팅 로그일 가능성(오탐 방지)
        iso={ sv:(multiDay?'core':'warn'), conf:(multiDay?'high':'medium'), name:'격리판정: 케이블 단선/통합 포트 불량',
              evid:'연결시도 '+L2.tryConn+'회, 통합 연결 성공 0 — 통합에 도달조차 못함(직접증거, 로그 '+sg.dmp_days+'일치)',
              act:'통신 케이블 단선·커넥터 탈락 확인(임시 가설교체 TEST) → 통합단말 해당 포트를 예비포트(sp)로 이동 → 그래도 안 되면 통합 포트/본체 점검',
              parts:['통신 케이블'],
              extraNote:(multiDay?'':'로그가 1일치뿐 — 백업 직후 벤치 부팅 기록일 수 있음, 차량 장착 상태에서 재확인 권장') };
      }
      else if(sg.selfLoss>=CONFIG.seungha_selfloss_warn)
        iso={ sv:'warn', conf:(L2.state==='active'?'high':'medium'),
              name:'격리판정: 케이블/커넥터'+(L2.state==='active'?' (간헐 접촉불량)':''),
              evid:'자체 통신끊김 '+sg.selfLoss+'회'+(L2.state==='active'?' + 통합 연결·송신 '+L2.send+'회 기록 → 본체 정상인데 붙었다 끊김(직접증거)':''),
              act:'커넥터 재체결 → 임시 케이블 교체 TEST → 통합단말 포트 예비포트(sp) 이동 → 회복되면 케이블/커넥터 확정',
              parts:['연결 케이블','커넥터'] };
      if(iso) F.push({ code:'SEUNGHA_ISO', name:iso.name, severity:iso.sv, confidence:iso.conf,
        sources:['fare_dmp'].concat(sg.selfLoss?['event']:[]), evidence:iso.evid, action:iso.act,
        parts:iso.parts, note:(iso.extraNote?iso.extraNote+' / ':'')+'통합단말 백업을 함께 분석하면 격리 정확도가 더 올라감' });
    }

    // ---- SW 배제 근거 주석 ----
    if(fw&&fw.sw_ok){
      F.forEach(function(x){ if(x.severity==='core')
        x.note=(x.note?x.note+' / ':'')+'OS 최신('+(fw.versions||'')+') → SW 재설치로 해결 가능성 낮음, HW/통신 경로 우선'; });
    }
    return F;
  }

  // ---------------- 진입점 ----------------
  function diagnose(files){
    var sn=snOf(files);
    var q=sigMqtt(files), e=sigEvents(files), fa=sigFare(files);
    var S={ ping:sigPing(files), comm:sigComm(files), net:sigNet(files), boot:sigBoot(files),
            omission:sigOmission(files), mqtt:q, events:e, evl:sigEvl(files),
            gwgps:sigGwGps(files), fw:sigFw(files), fare:fa, seungha:sigSeungha(files,e,fa) };
    // 판독가능 신호가 하나도 없으면 "정상"이 아니라 "백업 없음/판독불가"로 명시
    var hasSignal=Object.keys(S).some(function(k){ return S[k]!==null&&S[k]!==undefined; });
    if(!hasSignal){
      return { sn:sn, vehicleId:null, model:modelOf(sn), series:seriesOf(sn),
               severity:'nodata', swOk:false, findings:[], signals:S,
               note:'백업에 판독 가능한 로그 없음 — 백업 절차 또는 단말 저장장치 확인 필요' };
    }
    var F=judge(S, modelOf(sn));
    var sev=F.some(function(x){return x.severity==='core';})?'core':(F.length?'warn':'ok');
    return { sn:sn, vehicleId:vehId(files,q,e), model:modelOf(sn), series:seriesOf(sn),
             severity:sev, swOk:!!(S.fw&&S.fw.sw_ok), findings:F, signals:S };
  }

  var API={ diagnose:diagnose, CONFIG:CONFIG, ACTION_KB:ACTION_KB, LOG_CODES:LOG_CODES,
            util:{ untar:untar }, _judge:judge };
  if(typeof module!=='undefined'&&module.exports) module.exports=API;
  root.DiagEngineV3=API;
})(typeof self!=='undefined'?self:this);
