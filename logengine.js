/* ============================================================
   logengine.js — 단말기 로그백업 분석 엔진 (브라우저 전용)
   terminal.html에서 <script src="logengine.js"></script> 로 로드.
   - 업로드한 로그백업(폴더 또는 zip)을 휴대폰 안에서 직접 분석(원본 저장 X)
   - important.evt(중요장애 카운트) + ASCII EVENT(127자, 코드 44~47자리) 디코딩
   - 신호등 + 초보자 점검 가이드 → 처리유형/오류유형 기록 → Supabase 누적(재불량 추적)
   참조 전역(terminal.html 정의): SB_URL, SB_KEY
   ============================================================ */
const LOG_CODES={"3339":["구후불카드 Read 실패","요금처리부","거래/카드","이상"],"3347":["신선불카드 Write 실패","요금처리부","거래/카드","이상"],"7333":["TOPIS 기준 장비 이상 검지(타코/GPS/도어)","BMS","GPS/위치","이상"],"7338":["KSCC 기준 장비 이상 검지(타코/GPS)","BMS","GPS/위치","이상"],"3346":["신선불카드 Read 실패","요금처리부","거래/카드","이상"],"7907":["BMS와 TOPIS간 통신 모듈의 모뎀 연결 실패","BMS","통신","핵심이상"],"3366":["정기권 쓰기 에러","요금처리부","거래/카드","이상"],"93G5":["GPS 정류장 순차적 인식 오류","운전자단말","GPS/위치","핵심이상"],"3368":["모바일 정기권 쓰기 에러","요금처리부","거래/카드","이상"],"333A":["구후불카드 Write 실패","요금처리부","거래/카드","이상"],"7601":["모뎀 상태 정보 5회 이상 수신 실패","BMS","통신","핵심이상"],"150P":["운전자-승하차 통신 30초이상 끊김(승하차2번)","운전자단말","통신","핵심이상"],"150Q":["운전자-승하차 통신 30초이상 끊김(승하차3번)","운전자단말","통신","이상"],"3357":["신후불카드 Write 실패","요금처리부","거래/카드","이상"],"3367":["모바일 정기권 읽기 에러","요금처리부","거래/카드","이상"],"3365":["정기권 읽기 에러","요금처리부","거래/카드","이상"],"1A05":["AFC와 HMI간 통신 연속 끊어짐(30초마다)","운전자단말","통신","이상"],"5203":["운전자-승하차 통신 끊어짐","승하차조작부","통신","이상"],"3703":["G/W와 요금처리부간 통신 끊어짐","요금처리부","통신","핵심이상"],"3356":["신후불카드 Read 실패","요금처리부","거래/카드","이상"],"3312":["CSAM 통신 오류","요금처리부","통신","핵심이상"],"3313":["PSAM 통신 오류","요금처리부","통신","핵심이상"],"9802":["G/W와 단말센터 클라우드간 통신 끊어짐","운전자단말","통신","이상"],"150L":["운전자-승하차 통신 2분이상 끊김(승하차2번)","운전자단말","통신","핵심이상"],"150M":["운전자-승하차 통신 2분이상 끊김(승하차3번)","운전자단말","통신","핵심이상"],"1852":["운전자-수집센터 통신 끊어짐","운전자단말","통신","이상"],"1859":["수집센터 수신메시지 응답시간 초과","운전자단말","통신","이상"],"150O":["운전자-승하차 통신 30초이상 끊김(승하차1번)","운전자단말","통신","핵심이상"],"1A03":["AFC와 HMI간 통신 끊어짐","운전자단말","통신","핵심이상"],"7339":["첫정류장 승차인원 대비 하차인원 초과","BMS","GPS/위치","이상"],"3306":["거래성공/sign3 미수신","요금처리부","거래/카드","이상"],"5205":["승하차 통신끊김 AP상태확인(승하차기준)","승하차조작부","통신","이상"],"5202":["승하차 자체 통신 끊김 감지(AP)","승하차조작부","통신","이상"],"9A03":["G/W와 HMI간 통신모듈 끊어짐","운전자단말","통신","이상"],"150T":["운전자-승하차 통신 5분이상 끊김(승하차2번)","운전자단말","통신","이상"],"150U":["운전자-승하차 통신 5분이상 끊김(승하차3번)","운전자단말","통신","이상"],"9605":["G/W-요금처리부 통신끊김(요금2번)","운전자단말","통신","핵심이상"],"3513":["거래파일 운전자 전송 실패","요금처리부","거래/카드","이상"],"1505":["운전자-승하차 통신 끊어짐(승하차2번)","운전자단말","통신","이상"],"7803":["G/W와 BMS간 통신 끊어짐","BMS","통신","핵심이상"],"1901":["BMS 통신상태 이상으로 인한 Reset","운전자단말","통신","핵심이상"],"9403":["G/W와 BMS간 통신 끊어짐","운전자단말","통신","이상"],"9607":["G/W-요금처리부 통신끊김(요금3번)","운전자단말","통신","핵심이상"],"9231":["DTG 10초이상 응답없음","운전자단말","기타","이상"],"150F":["운전자-승하차 통신 끊어짐(승하차2번)","운전자단말","통신","이상"],"7602":["부팅후 2분이상 모뎀 연결안됨","BMS","통신","핵심이상"],"150K":["운전자-승하차 통신 2분이상 끊김(승하차1번)","운전자단말","통신","핵심이상"],"150Y":["운전자-승하차 통신 10분이상 끊김(승하차3번)","운전자단말","통신","이상"],"150X":["운전자-승하차 통신 10분이상 끊김(승하차2번)","운전자단말","통신","이상"],"1507":["운전자-승하차 통신 끊어짐(승하차3번)","운전자단말","통신","이상"],"1213":["거래검증 타임아웃","운전자단말","거래/카드","이상"],"7905":["BMS-TOPIS 통신모듈 센터연결 끊어짐","BMS","통신","핵심이상"],"9603":["G/W-요금처리부 통신끊김(요금1번)","운전자단말","통신","핵심이상"],"1503":["운전자-승하차 통신 끊어짐(승하차1번)","운전자단말","통신","이상"],"7903":["BMS-TOPIS 통신모듈 모뎀연결 끊어짐","BMS","통신","핵심이상"],"3512":["거래검증실패로 운전자에 거래파일 전송","요금처리부","거래/카드","이상"],"150H":["운전자-승하차 통신 끊어짐(승하차3번)","운전자단말","통신","이상"],"1205":["거래파일 검증 실패","운전자단말","거래/카드","이상"],"5401":["연결끊김으로 카드처리 비활성화","승하차조작부","통신","이상"],"150D":["운전자-승하차 통신 끊어짐(승하차1번)","운전자단말","통신","이상"],"150S":["운전자-승하차 통신 5분이상 끊김(승하차1번)","운전자단말","통신","이상"],"7402":["BMS-운전자 통신모듈 끊어짐","BMS","통신","이상"],"3220":["EBCSAM 초기화 에러","요금처리부","펌웨어/OS","이상"],"3305":["5회 재시도 카드읽기 실패","요금처리부","거래/카드","핵심이상"],"1330":["일부 승하차 운행시작 실패상태로 시작","운전자단말","운행","이상"],"13Y0":["일부 승하차 운행종료 실패상태로 종료","운전자단말","운행","이상"],"9503":["운전자-G/W 통신 끊어짐","운전자단말","통신","이상"],"150W":["운전자-승하차 통신 10분이상 끊김(승하차1번)","운전자단말","통신","이상"],"5303":["승하차-요금처리부 통신 끊어짐","승하차조작부","통신","이상"],"3603":["승하차-요금처리부 통신 끊어짐","요금처리부","통신","이상"],"3230":["CSAM 초기화 에러","요금처리부","펌웨어/OS","핵심이상"],"5404":["운전자 CPU LOAD 5.00 이상","승하차조작부","전원/HW","핵심이상"],"1010":["운전자 어플리케이션 초기화 실패","운전자단말","펌웨어/OS","이상"],"1303":["운전자 CPU LOAD 4.00 이상","운전자단말","전원/HW","이상"],"1302":["운전자 CPU LOAD 3.00 이상","운전자단말","전원/HW","이상"],"1020":["운전자 일련번호(IH) 존재안함","운전자단말","운행","이상"],"9A81":["설치실패(Management)","TMGR","펌웨어/OS","이상"],"9AB1":["설치실패(Diagnostic)","TMGR","펌웨어/OS","이상"],"9AD1":["설치실패(apk_install)","TMGR","펌웨어/OS","이상"],"7301":["BMS CPU LOAD 3.00 이상","BMS","전원/HW","핵심이상"],"9323":["GPS 정류장 로그 생성 실패","운전자단말","GPS/위치","이상"],"93G2":["GPS 비정상(Invalid)","운전자단말","GPS/위치","핵심정상"]};

const IMP7=new Set(["1A05","150M","150L","150K","150D","150H","150F","150O","150P","150Q","150S","150T","150U","150W","150X","150Y"]);

/* 코드 → 장애 그룹(부위 단위) — desc 기반 */
function logGroupOf(code){
  const e=LOG_CODES[code]; if(!e) return null;
  const d=e[0], part=e[1], cat=e[2];
  if(/승하차/.test(d) && cat==="통신"){
    const m=d.match(/승하차([123])번/); return "승하차"+(m?m[1]:"")+"통신";
  }
  if(/HMI/.test(d)) return "표출기통신";
  if(part==="BMS" || /모뎀|BMS/.test(d)) return "모뎀BMS통신";
  if(cat==="거래/카드" || /SAM/.test(d)) return "카드SAM";
  if(cat==="GPS/위치") return "GPS위치";
  if(/센터|클라우드/.test(d)) return "센터통신";
  if(/G\/W/.test(d)) return "GW통신";
  if(cat==="운행") return "운행";
  if(cat==="전원/HW") return "전원HW";
  if(cat==="펌웨어/OS") return "펌웨어";
  return "기타통신";
}
/* 그룹 → 초보자 점검 가이드 */
const LOG_GUIDE={
 "승하차1통신":{t:"승하차 1번(승차) 단말기 통신 단절",steps:["승차 단말기 커넥터 체결 확인","승차 케이블 임시 가설로 교체 TEST","통합단말기 포트 Val→sp 이동 점검","재발 시 승차 단말기 → 통합단말기 순 교체"],parts:["승차 케이블","승차 단말기","통합단말기"]},
 "승하차2통신":{t:"승하차 2번(하차1) 단말기 통신 단절",steps:["하차1 단말기 커넥터 체결 확인","하차1 케이블 임시 가설로 교체 TEST","통합단말기 포트 Val→sp 이동 점검","재발 시 하차1 단말기 → 통합단말기 순 교체"],parts:["하차1 케이블","하차1 단말기","통합단말기"]},
 "승하차3통신":{t:"승하차 3번(하차2) 단말기 통신 단절",steps:["하차2 단말기 커넥터 체결 확인","하차2 케이블 임시 가설로 교체 TEST","통합단말기 포트 Val→sp 이동 점검","재발 시 하차2 단말기 → 통합단말기 순 교체"],parts:["하차2 케이블","하차2 단말기","통합단말기"]},
 "승하차통신":{t:"승하차 단말기 통신 단절",steps:["해당 승하차 단말기 커넥터 체결 확인","케이블 임시 가설로 교체 TEST","통합단말기 포트 Val→sp 이동 점검","재발 시 단말기 → 통합단말기 순 교체"],parts:["승하차 케이블","승하차 단말기","통합단말기"]},
 "표출기통신":{t:"표출기(운전자 화면) 통신 불안정",steps:["표출기↔통합단말기 케이블 접점·삽입 점검","표출기 재부팅","지속 시 표출단말기 교체"],parts:["표출기 케이블","표출단말기"]},
 "모뎀BMS통신":{t:"외장 LTE 모뎀 / BMS 통신 실패",steps:["외장모뎀 전원 LED(ST1/ST2/Pow/LTE) 확인","커넥터 흔들어 접촉·USIM 점검","외장모뎀 교체 → LTE 케이블 → 통합단말기 순","⚠ B600/B700/B710 외장모뎀 혼용 금지"],parts:["외장 LTE 모뎀","LTE 케이블","통합단말기"]},
 "카드SAM":{t:"카드 인식 / PSAM(SAM) 오류",steps:["PSAM 세척·소켓 접촉 상태 확인","재인식 후에도 지속 시 승하차 단말기 교체(1:1 권장)"],parts:["PSAM","승하차 단말기"]},
 "GPS위치":{t:"GPS / 측위 이상",steps:["GPS 안테나 체결·시야(하늘) 확보 확인","안테나 케이블 흔들어 접촉 점검","안테나 교체 → 통합단말기 순"],parts:["GPS 안테나","통합단말기"]},
 "센터통신":{t:"센터 / 클라우드 통신 불량",steps:["외장모뎀 신호·안테나 점검","수집/단말 센터 IP 설정 확인(재설치 메뉴)"],parts:["외장모뎀","안테나"]},
 "GW통신":{t:"내부 G/W 통신 단절",steps:["해당 보드 커넥터·케이블 점검","지속 시 통합단말기 교체 검토"],parts:["케이블","통합단말기"]},
 "운행":{t:"운행 시작/종료 이상",steps:["승하차 통신 상태 확인","타코메타 설정·표출기 점검"],parts:["표출단말기","타코메타"]},
 "전원HW":{t:"CPU 과부하 / 전원·HW 이상",steps:["단말기 재부팅","지속 시 해당 단말기 교체"],parts:["해당 단말기"]},
 "펌웨어":{t:"펌웨어/설치 오류",steps:["재설치(USB) 또는 초기화 후 재등록","복구 실패 시 본체 교체"],parts:["설치 USB","CPU B/D"]},
 "기타통신":{t:"통신 이상",steps:["연결 케이블·커넥터 점검"],parts:["케이블"]},
 "부팅전원":{t:"부팅/전원 불량 (비정상 재시작·전원차단)",steps:["차량 메인 전원·Fuse, 통합단말기 전원 케이블 체결 확인","전원 케이블 임시 교체 TEST","지속 시 통합단말기 전원부/본체 교체 검토","연속 재부팅이면 부팅불량 — 본체 우선 점검"],parts:["전원 케이블","차량 Fuse","통합단말기"]},
 "GPS측위":{t:"GPS / 측위 이상",steps:["GPS 안테나 체결·하늘 시야 확보 확인","안테나 케이블 접촉 점검 → 안테나 교체 → 통합단말기 순","타코/도어 센서 동반 이상 시 함께 점검"],parts:["GPS 안테나","타코/도어 센서","통합단말기"]}
};
function logGuide(g){ return LOG_GUIDE[g] || LOG_GUIDE[(''+g).replace(/[123]/,'')] || {t:g,steps:["현장 점검"],parts:[]}; }

/* 오류유형 / 처리유형 드롭다운 옵션 */
const ERROR_TYPES=["BMS 데이터 이상(앞뒤차 간격)","GPS 수신이상","LTE모뎀불량","SAM통신오류","기구물파손","기타","다인승불량","단말기 테스트","단말기고정불량","단말기백업","단말기사용문의","단말기위치조정","단말기정보불일치","단말기파손","대폐차(증차/감차) 작업","메모리불량","미승인카드","부저불량","비콘 외부안테나 이상","비콘 이상","승차통신불량","승하차 음성 불량","승하차부팅불량","승하차전원불량","승하차터치불량","승하차화면불량","시간이상","예방점검","운수사방문요청","운영정보이상","운행시작/종료안됨","음성불량","장기미통신","전원불량(전체)","차량 고장","초기화실패","카드다시","카드무감","키버튼불량(승하차)","키버튼불량(운전자)","타사장비 장애접수","타코/개폐센서이상","태그리스 FW 이상","통합단말기 BMS불량","통합단말기 CITS불량","통합단말기 FAN 불량","통합단말기 모뎀불량(ST1)","통합단말기 서버연결대기중","통합단말기 승하차 전체통신불량","통합단말기 전원불량","통합단말기 케이블불량","통합단말기 포트불량","통합연결대기중","펌웨어오류","표출 단말기 음성 불량","표출 단말기 키패드불량","표출 단말기?히든버튼 불량","표출단말기 미인증 표시","표출단말기 부팅불량","표출단말기 전원불량","표출단말기 전원스위치 불량","표출단말기 케이블불량","표출단말기 터치불량","표출단말기 화면불량","하차1WI-FI통신불량","하차2WI-FI통신불량","하차유선통신불량"];
const ACTION_TYPES=["DTG커넥터 재연결","DTG커넥터 탈거","F/W, OS 적용","GPS안테나교체","GPS위치변경","GPS커넥터재연결","LCD패널교체","LTE 안테나 교체","LTE 안테나 재연결","LTE모뎀교체","LTE커넥터 재연결","LTE케이블교체","LTE케이블재연결","SAM세척&재삽입","USIM 세척","고정작업","기처리건","기타","단말기 재등록","단말기 초기화","단말기사용안내","단말기위치조정","단말기전원 On/Off","단말기커버교체","대폐차(증차/감차) 완료","메인 전원ON/OFF","모니터링","모뎀USIM세척","볼륨조정","브라켓교체","비콘 교체","사용 안내","설정값 변경","승차 케이블 교체","승차단말기교체","승차단말기재등록","승차전원케이블교체","승차전원케이블재연결","승차통신케이블교체","승차통신케이블재연결","승하차 위치 맞교체","운수사 방문","원인분석","이상없음","전화응대","접수취소","차량Fuse교체","차량메인 스위치 On/Off","케이블 교체","케이블 재결선(케이블 결선작업)","케이블 재연결","타사장비 간섭(이관)","타사장비 커넥터 탈거","타코메타설정값변경","타코메타케이블교체","타코메타케이블재연결","태그리스 FW 재설치","태그리스 비콘 교체","태그리스 설정 활성화","태그리스 외부안테나 교체","태그리스 케이블 교체","태그리스 허브교체","통합단말기 교체","통합단말기 전원 케이블교체","통합단말기 전원 케이블재연결","통합단말기 초기화","통합단말기재등록","통합단말기전원케이블교체","통합단말기전원케이블재연결","포트변경","표출기 케이블교체","표출기 케이블재연결","표출단말기 교체","하차 케이블 교체","하차 케이블 재연결","하차1단말기교체","하차2단말기교체","허브보드 교체"];
const GROUP_TO_ERRTYPE={"승하차1통신":"승차통신불량","승하차2통신":"하차유선통신불량","승하차3통신":"하차유선통신불량","승하차통신":"통합단말기 승하차 전체통신불량","표출기통신":"표출단말기 케이블불량","모뎀BMS통신":"통합단말기 모뎀불량(ST1)","센터통신":"통합단말기 서버연결대기중","GW통신":"통합단말기 케이블불량","카드SAM":"SAM통신오류","GPS위치":"GPS 수신이상","운행":"운행시작/종료안됨","전원HW":"기타","펌웨어":"펌웨어오류","기타통신":"기타","부팅전원":"통합단말기 전원불량","GPS측위":"GPS 수신이상"};

function logEsc(t){ return (''+t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function logModelOf(sn){
  var p3=(''+sn).slice(0,3), p4=(''+sn).slice(0,4);
  if(p4==='1553') return 'B710 승하차';
  if(p4==='1560') return 'B700/B800 승하차';
  return ({"460":"B700","465":"B710","570":"B800"})[p3] || "단말기";
}
/* 백업 유형: 통합단말기 vs 승하차(조작) 단말기 */
function isSeunghaSn(sn){ var p4=(''+sn).slice(0,4); return p4==='1553'||p4==='1560'; }
/* 승하차 위치코드(1/2/3) → 라벨 */
function seunghaPosLabel(pos){ return ({"1":"승차","2":"하차1","3":"하차2"})[(''+pos).trim()] || ('위치'+pos); }
/* set_term_info.dat 파싱: "차량ID \0 위치 \0 사업자ID" */
function parseSetTermInfo(text){
  var toks=(''+text).match(/\d+/g)||[];
  var vehicleId=toks[0]||'', pos='', bizId='';
  for(var i=1;i<toks.length;i++){ if(toks[i].length===1 && !pos){ pos=toks[i]; } else if(toks[i].length>=6 && !bizId){ bizId=toks[i]; } }
  if(!pos && toks[1]) pos=toks[1];
  if(toks.length<2) return null;
  return { vehicleId:vehicleId, pos:pos, posLabel:seunghaPosLabel(pos), bizId:bizId };
}

/* ===== 파서 ===== */
function parseImportantEvt(u8){
  const o={};
  for(let i=0;i+8<=u8.length;i+=8){
    const code=String.fromCharCode(u8[i],u8[i+1],u8[i+2],u8[i+3]);
    const cnt=(u8[i+4]|(u8[i+5]<<8)|(u8[i+6]<<16)|(u8[i+7]<<24))>>>0;
    if(cnt>0 && cnt<100000 && LOG_CODES[code]) o[code]=(o[code]||0)+cnt;
  }
  return o;
}
function parseAsciiEvt(text){
  const o={};
  const lines=text.split(/\r?\n/);
  for(const line of lines){
    if(line.length>=47){
      const code=line.slice(43,47);
      if(LOG_CODES[code] && !IMP7.has(code)) o[code]=(o[code]||0)+1;
    }
  }
  return o;
}

/* ===== 진단 ===== */
function diagnoseCounts(sn, counts){
  const model=logModelOf(sn);
  const groups={};
  for(const code in counts){
    const e=LOG_CODES[code]; if(!e) continue;
    const sev=e[3]; if(sev!=="이상" && sev!=="핵심이상") continue;
    const g=logGroupOf(code); if(!g) continue;
    if(!groups[g]) groups[g]={n:0,core:false,codes:[]};
    groups[g].n+=counts[code];
    groups[g].codes.push([code,counts[code]]);
    if(sev==="핵심이상") groups[g].core=true;
  }
  const ranked=Object.entries(groups).map(function(kv){ const g=kv[0],v=kv[1]; return {group:g,n:v.n,core:v.core,codes:v.codes.sort(function(a,b){return b[1]-a[1];})}; })
    .sort(function(a,b){ return (b.core-a.core)||(b.n-a.n); });
  return {sn:sn,model:model,findings:ranked};
}

/* ===== 부팅/전원 분석 (sdr.log 텍스트) =====
   - "프로그램 시작" = 재시작 마커
   - 정상 종료 시퀀스(운행 종료 (5/5)/완료) 없이 재시작 → 비정상 전원차단 의심
   - 5분 미만 간격 연속 재시작 → 부팅 반복(부팅불량/전원 불안정) */
function bpFmt(d){ var p=function(n){return ('0'+n).slice(-2);}; return p(d.getMonth()+1)+'/'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
function parseSdrEvents(text){
  var out=[]; var lines=(''+text).split(/\r?\n/);
  var re=/\[(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*\|[^\]]*\]\s*(.*)$/;
  for(var i=0;i<lines.length;i++){
    var m=lines[i].match(re); if(!m) continue;
    var t=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]); var desc=m[7];
    if(/프로그램 시작/.test(desc)) out.push({t:t,k:'start'});
    else if(/운행 종료 - \(5\/5\)/.test(desc) || /운행 종료 처리 완료 확인/.test(desc) || /운행 종료 - 완료/.test(desc)) out.push({t:t,k:'shutdown'});
  }
  return out;
}
function analyzeBootPower(sdrTexts){
  if(!sdrTexts || !sdrTexts.length) return null;
  var ev=[]; for(var i=0;i<sdrTexts.length;i++) ev=ev.concat(parseSdrEvents(sdrTexts[i]));
  if(!ev.length) return null;
  ev.sort(function(a,b){ return a.t-b.t; });
  var starts=ev.filter(function(e){ return e.k==='start'; });
  var abnormal=0, rapid=0, abnTimes=[], rapTimes=[];
  for(var j=1;j<starts.length;j++){
    var cur=starts[j], prev=starts[j-1].t;
    var gapMin=(cur.t-prev)/60000;
    if(gapMin<5){ rapid++; rapTimes.push(bpFmt(cur.t)+' (+'+gapMin.toFixed(1)+'분)'); }
    else { var hadShut=ev.some(function(e){ return e.k==='shutdown' && e.t>prev && e.t<cur.t; });
      if(!hadShut){ abnormal++; abnTimes.push(bpFmt(cur.t)); } }
  }
  // 심각도: 연속재부팅 다수 → 핵심, 비정상종료 다수 → 주의
  var core = rapid>=3 || (abnormal+rapid)>=8;
  var warn = abnormal>=2 || rapid>=1;
  var level = core?'core':(warn?'warn':'ok');
  return { restarts:starts.length, abnormal:abnormal, rapid:rapid,
    abnTimes:abnTimes.slice(0,10), rapTimes:rapTimes.slice(0,10),
    first:starts.length?bpFmt(starts[0].t):'', last:starts.length?bpFmt(starts[starts.length-1].t):'',
    level:level };
}

/* ===== GPS 보조 분석 =====
   주의: 93G5/9323/7333/7338 등 GPS 이벤트는 이미 diagnoseCounts의 "GPS위치" 카드로 표시됨.
   여기서는 중복을 피하고 "새로 추가되는 신호"만 다룬다:
   ① prevpass 위치기록(마지막 측위 시각·건수) ② 본진단에서 버려지는 93G2(GPS Invalid)
   ③ 7333/7338 동반 시 타코/도어 센서 교차점검 안내 */
function parsePrevpass(u8){
  // 내부에 ASCII 14자리 타임스탬프(YYYYMMDDhhmmss) 포함
  var s=''; for(var i=0;i<u8.length;i++){ var c=u8[i]; s+=(c>=48&&c<=57)?String.fromCharCode(c):' '; }
  var m=s.match(/(20\d{12})/); if(!m) return null;
  var v=m[1]; var d=new Date(+v.slice(0,4),+v.slice(4,6)-1,+v.slice(6,8),+v.slice(8,10),+v.slice(10,12),+v.slice(12,14));
  return isNaN(d.getTime())?null:d;
}
function analyzeGps(prevpass, counts){
  var invalid = counts['93G2']||0;                                  // 본진단에서 버려지는 코드(GPS Invalid)
  var hasTaco = !!(counts['7333']||counts['7338']);                 // 타코/도어 동반 이상
  if(!invalid && !hasTaco) return null;                             // 실질적 GPS 우려 없으면 표시 안 함(노이즈 방지)
  var times=[]; if(prevpass){ for(var j=0;j<prevpass.length;j++){ var d=parsePrevpass(prevpass[j]); if(d) times.push(d); } }
  times.sort(function(a,b){ return a-b; });
  var level = invalid>=50 ? 'warn' : 'info';                        // 93G2 다발 시 경고
  return { count:times.length, lastRec:times.length?bpFmt(times[times.length-1]):'',
    firstRec:times.length?bpFmt(times[0]):'', invalid:invalid, hasTaco:hasTaco, level:level };
}

/* =========================================================
   승하차 고장 격리 (통합 / 승하차 / 케이블)
   - 통합단말기 백업: 유닛별(승차/하차1/하차2) 통신실패 + 통합 자체 건강
   - 승하차 단말기 백업: set_term_info(위치) + 자체 통신끊김(5202/5203/5205) + 생존여부
   - 차량ID로 양쪽을 묶어 원인을 한쪽으로 좁힘
   ========================================================= */
/* 통합 로그의 승하차 유닛별 끊김 이벤트코드 (1=승차,2=하차1,3=하차2) */
var SEUNGHA_UNIT_CODES={
  "승차":["1503","150D","150K","150O","150S","150W"],
  "하차1":["1505","150F","150L","150P","150T","150X"],
  "하차2":["1507","150H","150M","150Q","150U","150Y"]
};
/* 통합단말기 백업에서 본 승하차 유닛별 통신 상태 */
function analyzeIntegratedSeungha(counts){
  var units={}; var any=false;
  for(var u in SEUNGHA_UNIT_CODES){
    var n=0, codes=[];
    var arr=SEUNGHA_UNIT_CODES[u];
    for(var i=0;i<arr.length;i++){ if(counts[arr[i]]){ n+=counts[arr[i]]; codes.push([arr[i],counts[arr[i]]]); } }
    if(n>0){ any=true; units[u]={n:n,codes:codes.sort(function(a,b){return b[1]-a[1];})}; }
  }
  // 전체(유닛 불특정) 승하차 통신 코드: 5203/5205/5303/5401
  var generic=0; ["5203","5205","5303","5401"].forEach(function(c){ if(counts[c]) generic+=counts[c]; });
  if(!any && !generic) return null;
  return { units:units, generic:generic, failedUnits:Object.keys(units) };
}
/* 승하차 단말기 백업 자체 진단 */
function analyzeSeunghaSelf(setTerm, counts, activity, sn){
  var id=parseSetTermInfo(setTerm||'');
  var selfLoss=0; ["5202","5203","5205"].forEach(function(c){ if(counts[c]) selfLoss+=counts[c]; });
  var alive=!!activity;                       // 거래/이벤트 데이터 = 가동 흔적
  return { sn:sn, id:id, posLabel:id?id.posLabel:'', vehicleId:id?id.vehicleId:'',
    selfLoss:selfLoss, alive:alive };
}
/* 고장 격리 판정 — 승하차 백업 기준(+선택적으로 통합 교차정보) */
function isolateFromSeungha(self, integ){
  // integ: 같은 차량 통합 진단 요약 {selfBad:bool, unitFail:bool} 또는 null
  var unit=self.posLabel||'승하차';
  var reasons=[], steps=[], verdict, color, conf;
  var integSelfBad = integ && integ.selfBad;     // 통합 자체 이상(부팅/전원/BMS/다수유닛)
  var integUnitFail = integ && integ.unitFail;   // 통합이 이 유닛 통신실패를 기록

  if(integSelfBad){
    verdict='통합단말기'; color='#B91C1C'; conf='높음';
    reasons.push('통합단말기 백업에서 자체 이상(부팅/전원/BMS 또는 다수 유닛 동시 실패)이 확인됨');
    if(self.alive) reasons.push('승하차('+unit+')는 자체 가동 흔적이 있어 본체 정상 가능성');
    steps=['통합단말기 우선 점검·교체 검토','통합 교체 후 '+unit+' 통신 회복 확인'];
  } else if(!self.alive){
    verdict='승하차 단말기'; color='#C2185B'; conf='높음';
    reasons.push(unit+' 승하차 백업에 가동 흔적(거래/이벤트)이 없음 → 단말기 무응답/미부팅');
    steps=[unit+' 승하차 단말기 전원·커넥터 확인','전원 정상인데 무응답이면 '+unit+' 승하차 단말기 교체'];
  } else if(self.selfLoss>0){
    // 승하차는 살아있고 스스로 통신끊김을 기록 → 링크(케이블/포트) 의심
    verdict='케이블/커넥터'; color='#B45309'; conf=integUnitFail?'높음':'중간';
    reasons.push(unit+' 승하차는 정상 가동 중인데 통신끊김을 '+self.selfLoss+'회 자체 기록 → 본체는 살아있음');
    if(integUnitFail) reasons.push('통합도 동일 '+unit+' 통신실패를 기록 → 양쪽 정상, 사이 연결이 문제');
    else reasons.push('통합 백업까지 함께 보면 더 정확 (통합도 정상이면 케이블 확정)');
    steps=[unit+' 통신 케이블 임시 가설로 교체 TEST','통합단말기 해당 포트 → 예비포트(sp) 이동 점검','회복되면 케이블/커넥터 확정, 안되면 통합 포트/본체'];
  } else {
    verdict='정상'; color='#16A34A'; conf='-';
    reasons.push(unit+' 승하차 자체 통신끊김 기록 없음(정상 범위)');
    steps=['추가 조치 불필요 — 필요 시 통합 백업도 확인'];
  }
  return { unit:unit, vehicleId:self.vehicleId, verdict:verdict, color:color, conf:conf, reasons:reasons, steps:steps,
    needIntegrated: !integ && verdict!=='승하차 단말기' };
}

/* ===== 경로 판별 ===== */
function isImportantPath(p){ return /(^|\/)event\/important\/[^/]+\.evt$/i.test(p) || /(^|\/)important\/[^/]+\.evt$/i.test(p); }
function isAsciiEventPath(p){ if(isImportantPath(p)) return false; return /(^|\/)event\/EVENT_[^/]*\.evt$/i.test(p) || /(^|\/)EVENT_[^/]*\.evt$/i.test(p); }
function snFromPath(p){ const m=(''+p).match(/(?:^|\/)((?:460|465|570|1553|1560)\d{5,})(?:\/|$)/); return m?m[1]:''; }
/* 식별정보 파일: set_term_info(승하차, 위치포함) / term_c_info(통합) — 둘 다 첫 토큰=차량ID */
function isSetTermInfoPath(p){ return /(^|\/)set_term_info\.dat$/i.test(p) || /(^|\/)term_c_info\.dat$/i.test(p); }
/* 승하차 가동 흔적(거래/이벤트 데이터 존재) */
function isSeunghaActivityPath(p){ return /(^|\/)trans\/drive_backup\/[^/]+/i.test(p) || /(^|\/)event\/EVENT_[^/]*\.evt$/i.test(p) || /(^|\/)card_trace\/[^/]+/i.test(p); }
/* 부팅/전원 분석용 sdr.log(현재본만, backup/.tgz 제외) */
function isSdrLogPath(p){ if(/\/backup\//i.test(p)) return false; return /(^|\/)logs\/term\/[^/]*_sdr\.log$/i.test(p) || /(^|\/)[0-9]{8}_sdr\.log$/i.test(p); }
/* GPS 위치기록 prevpass(작은 바이너리) */
function isPrevpassPath(p){ return /(^|\/)gps\/prevpass_data_[0-9]+\.log$/i.test(p) || /(^|\/)prevpass_data_[0-9]+\.log$/i.test(p); }

/* 폴더(여러 파일) 직접 분석 — 큰 debug 파일은 읽지 않아 가볍다 */
async function readBackupFromFiles(fileList){
  const files=Array.prototype.slice.call(fileList); let sn=''; const counts={}; const sdrTexts=[]; const prevpass=[]; let setTerm=''; let activity=false;
  for(let i=0;i<files.length;i++){ if(sn) break; sn=snFromPath(files[i].webkitRelativePath||files[i].name); }
  for(let i=0;i<files.length;i++){
    const f=files[i]; const p=f.webkitRelativePath||f.name;
    try{
      if(isImportantPath(p)){ const u8=new Uint8Array(await f.arrayBuffer()); const c=parseImportantEvt(u8); for(const k in c) counts[k]=(counts[k]||0)+c[k]; }
      else if(isAsciiEventPath(p)){ const t=await f.text(); const c=parseAsciiEvt(t); for(const k in c) counts[k]=(counts[k]||0)+c[k]; if(isSeunghaActivityPath(p)) activity=true; }
      else if(isSetTermInfoPath(p)){ if(!setTerm) setTerm=await f.text(); }
      else if(isSdrLogPath(p)){ sdrTexts.push(await f.text()); }
      else if(isPrevpassPath(p)){ prevpass.push(new Uint8Array(await f.arrayBuffer())); }
      else if(isSeunghaActivityPath(p)){ activity=true; }
    }catch(e){}
  }
  return {sn:sn,counts:counts,sdrTexts:sdrTexts,prevpass:prevpass,setTerm:setTerm,activity:activity};
}
/* zip 분석 */
async function readBackupFromZip(file){
  const zip=await JSZip.loadAsync(file); let sn=''; const imp=[],asc=[],sdr=[],pvp=[]; const counts={}; const sdrTexts=[]; const prevpass=[]; let setTermE=null; let activity=false;
  zip.forEach(function(p,e){ if(e.dir) return; if(!sn) sn=snFromPath(p);
    if(isImportantPath(p)) imp.push(e); else if(isAsciiEventPath(p)){ asc.push(e); if(isSeunghaActivityPath(p)) activity=true; }
    else if(isSetTermInfoPath(p)){ if(!setTermE) setTermE=e; }
    else if(isSdrLogPath(p)) sdr.push(e); else if(isPrevpassPath(p)) pvp.push(e);
    else if(isSeunghaActivityPath(p)) activity=true; });
  for(let i=0;i<imp.length;i++){ const u8=await imp[i].async('uint8array'); const c=parseImportantEvt(u8); for(const k in c) counts[k]=(counts[k]||0)+c[k]; }
  for(let i=0;i<asc.length;i++){ const t=await asc[i].async('string'); const c=parseAsciiEvt(t); for(const k in c) counts[k]=(counts[k]||0)+c[k]; }
  for(let i=0;i<sdr.length;i++){ try{ sdrTexts.push(await sdr[i].async('string')); }catch(e){} }
  for(let i=0;i<pvp.length;i++){ try{ prevpass.push(await pvp[i].async('uint8array')); }catch(e){} }
  let setTerm=''; if(setTermE){ try{ setTerm=await setTermE.async('string'); }catch(e){} }
  return {sn:sn,counts:counts,sdrTexts:sdrTexts,prevpass:prevpass,setTerm:setTerm,activity:activity};
}

/* 메인: 폴더 또는 zip 어느 쪽이든 분석 */
/* 업로드 슬롯(폴더 또는 zip) 한 쌍 읽기 → 분석데이터 또는 null */
async function _readSlot(folderId, zipId){
  const fInp=document.getElementById(folderId), zInp=document.getElementById(zipId);
  const fFiles=(fInp&&fInp.files&&fInp.files.length)?fInp.files:null;
  const zFile=(zInp&&zInp.files&&zInp.files[0])?zInp.files[0]:null;
  if(!fFiles && !zFile) return null;
  if(fFiles) return await readBackupFromFiles(fFiles);
  if(typeof JSZip==='undefined') throw new Error('zip 라이브러리(JSZip) 로드 실패 — 새로고침 후 재시도하세요');
  return await readBackupFromZip(zFile);
}
/* 통합단말기 데이터 분석 → 요약(+교차참조 캐시 저장) */
function analyzeIntegratedData(r, vnum){
  const sn=r.sn||'단말기';
  const dg=diagnoseCounts(sn, r.counts);
  const bootDiag=analyzeBootPower(r.sdrTexts||[]);
  const gpsDiag=analyzeGps(r.prevpass||[], r.counts);
  const integSeungha=analyzeIntegratedSeungha(r.counts);
  const selfBad=(bootDiag&&bootDiag.level==='core') ||
    dg.findings.some(function(f){ return (f.group==='모뎀BMS통신'||f.group==='센터통신'||f.group==='GW통신') && f.core; }) ||
    (integSeungha && integSeungha.failedUnits.length>=2);
  const id=parseSetTermInfo(r.setTerm||''); const vehicleId=id?id.vehicleId:'';
  if(vehicleId){ if(!window.__integByVeh) window.__integByVeh={};
    const uf={}; if(integSeungha) integSeungha.failedUnits.forEach(function(u){ uf[u]=true; });
    window.__integByVeh[vehicleId]={selfBad:!!selfBad, unitFail:integSeungha?integSeungha.failedUnits:[], unitMap:uf, vnum:vnum}; }
  return {sn:sn,dg:dg,bootDiag:bootDiag,gpsDiag:gpsDiag,integSeungha:integSeungha,selfBad:!!selfBad,vehicleId:vehicleId};
}

/* 메인: 통합(슬롯1)·승하차(슬롯2)를 각각/동시 분석 */
async function analyzeLogBackup(vnum, vid){
  const box=document.getElementById('logbk-result'); if(!box) return;
  const isoBox=document.getElementById('logbk-iso');
  if(!window.__integByVeh) window.__integByVeh={};
  let r1=null, r2=null;
  try{ r1=await _readSlot('logbk-folder','logbk-file'); r2=await _readSlot('logbk2-folder','logbk2-file'); }
  catch(e){ box.innerHTML='<span class="text-rose-600 text-[12px]">'+logEsc(e.message||e)+'</span>'; return; }
  if(!r1 && !r2){ box.innerHTML='<span class="text-rose-600 text-[12px]">통합 또는 승하차 백업(폴더/zip)을 1개 이상 선택하세요.</span>'; if(isoBox) isoBox.innerHTML=''; return; }
  box.innerHTML='<span class="text-slate-500 text-[12px]">⏳ 분석 중… (기기 안에서만 처리, 원본 저장 안 함)</span>';
  if(isoBox) isoBox.innerHTML='';
  try{
    // 슬롯과 무관하게 SN으로 통합/승하차 자동 분류(잘못 넣어도 동작)
    let integR=null, seunghaR=null;
    [r1,r2].forEach(function(r){ if(!r) return; if(isSeunghaSn(r.sn||'')) seunghaR=r; else integR=r; });

    let integInfo = integR ? analyzeIntegratedData(integR, vnum) : null;

    if(seunghaR){
      const self=analyzeSeunghaSelf(seunghaR.setTerm, seunghaR.counts, seunghaR.activity, seunghaR.sn);
      let integSummary=null;
      if(integInfo && (!self.vehicleId || !integInfo.vehicleId || integInfo.vehicleId===self.vehicleId)){
        integSummary={selfBad:integInfo.selfBad, unitFail:integInfo.integSeungha?integInfo.integSeungha.failedUnits:[]};
      } else if(self.vehicleId && window.__integByVeh[self.vehicleId]){
        integSummary=window.__integByVeh[self.vehicleId];
      }
      const iso=isolateFromSeungha(self, integSummary);
      window.__lastDiag={vnum:vnum,vid:vid,sn:self.sn,model:logModelOf(self.sn),seungha:self,iso:iso,findings:[],analyzedAt:new Date().toISOString().slice(0,10)};
      if(integInfo){
        // 동시 분석: 통합 진단(logbk-result) + 승하차 격리(logbk-iso, 후순위라 저장카드 소유)
        renderDiag(integInfo.dg, vnum, vid, integInfo.bootDiag, integInfo.gpsDiag, integInfo.integSeungha, integInfo.selfBad);
        renderSeungha(self, iso, vnum, vid, 'logbk-iso');
      } else {
        renderSeungha(self, iso, vnum, vid, 'logbk-result');
        if(isoBox) isoBox.innerHTML='';
      }
      return;
    }

    // 통합만
    if(integInfo){
      window.__lastDiag={vnum:vnum,vid:vid,sn:integInfo.dg.sn,model:integInfo.dg.model,findings:integInfo.dg.findings,bootDiag:integInfo.bootDiag,gpsDiag:integInfo.gpsDiag,integSeungha:integInfo.integSeungha,selfBad:integInfo.selfBad,analyzedAt:new Date().toISOString().slice(0,10)};
      renderDiag(integInfo.dg, vnum, vid, integInfo.bootDiag, integInfo.gpsDiag, integInfo.integSeungha, integInfo.selfBad);
      if(isoBox) isoBox.innerHTML='';
    }
  }catch(err){
    box.innerHTML='<span class="text-rose-600 text-[12px]">분석 실패: '+logEsc(err.message||err)+'<br>올바른 백업(폴더/zip)인지 확인하세요.</span>';
  }
}

/* ===== 승하차 단말기 백업 결과 렌더 (현장용 직관 카드) ===== */
function renderSeungha(self, iso, vnum, vid, targetId){
  targetId=targetId||'logbk-result';
  const box=document.getElementById(targetId); if(!box) return;
  const histId=targetId+'-snhist';
  var unit=self.posLabel||'승하차';
  var head='<div class="flex items-center gap-2 mb-2 flex-wrap">'
    +'<span class="chip bg-slate-100 text-slate-600">'+logEsc(self.sn?'S/N '+self.sn:'승하차')+'</span>'
    +'<span class="chip" style="background:#ede9fe;color:#6D28D9;font-weight:700">'+logEsc(unit)+' 승하차 단말기</span>'
    +(self.vehicleId?'<span class="chip bg-slate-100 text-slate-500">차량ID '+logEsc(self.vehicleId)+'</span>':'')+'</div>';
  var status='<div class="flex gap-1.5 flex-wrap mb-2 text-[11px]">'
    +'<span class="chip '+(self.alive?'bg-emerald-50 text-emerald-700':'bg-rose-50 text-rose-700')+'">'+(self.alive?'🟢 가동 흔적 있음(살아있음)':'🔴 가동 흔적 없음(무응답)')+'</span>'
    +'<span class="chip '+(self.selfLoss?'bg-amber-50 text-amber-700':'bg-slate-50 text-slate-500')+'">자체 통신끊김 '+self.selfLoss+'회</span></div>';
  var conf = iso.conf&&iso.conf!=='-' ? ' <span class="text-[11px] font-medium opacity-80">· 신뢰도 '+logEsc(iso.conf)+'</span>' : '';
  var reasons=iso.reasons.map(function(r){return '<li>'+logEsc(r)+'</li>';}).join('');
  var steps=iso.steps.map(function(s){return '<li>'+logEsc(s)+'</li>';}).join('');
  var verdictCard='<div class="rounded-xl p-3 mb-2 border-2" style="border-color:'+iso.color+';background:'+iso.color+'0d">'
    +'<div class="text-[11px] font-bold text-slate-400 mb-0.5">현장 추정 원인</div>'
    +'<div class="text-[18px] font-extrabold" style="color:'+iso.color+'">▶ '+logEsc(iso.verdict)+conf+'</div>'
    +'<div class="text-[11px] text-slate-500 mt-2 font-semibold">🔎 판단 근거</div>'
    +'<ul class="text-[11.5px] text-slate-700 list-disc pl-5 mt-0.5 space-y-0.5">'+reasons+'</ul>'
    +'<div class="text-[11px] text-slate-500 mt-2 font-semibold">✅ 점검 순서</div>'
    +'<ol class="text-[12px] text-slate-700 list-decimal pl-5 mt-0.5 space-y-0.5">'+steps+'</ol>'
    +'</div>';
  var prompt = iso.needIntegrated
    ? '<div class="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 mb-2">💡 이 차량의 <b>통합단말기 백업</b>도 같은 화면에서 분석하면 <b>통합 문제까지 확정</b>됩니다(통합 이상 시 통합으로 자동 판정).</div>'
    : '';
  var grp = self.posLabel==='승차'?'승하차1통신':self.posLabel==='하차1'?'승하차2통신':self.posLabel==='하차2'?'승하차3통신':'승하차통신';
  box.innerHTML=head+status+verdictCard+prompt+'<div id="'+histId+'" class="mt-3"></div>';
  showActionCard(vnum, vid, {group:grp});
  if(self.sn) loadSnHistory(self.sn,histId);
}

/* 부팅/전원 + GPS 보조 카드 HTML */
function renderExtraCards(bootDiag, gpsDiag){
  var h='';
  if(bootDiag && bootDiag.level!=='ok'){
    var bcore=bootDiag.level==='core';
    var lamp=bcore?'🔴':'🟡', sev=bcore?'핵심':'주의';
    var verdict = bootDiag.rapid>=3 ? '부팅 반복(부팅불량 또는 전원 불안정)'
                : bootDiag.abnormal>=1 ? '정상 종료 없이 전원 차단 의심'
                : '잦은 재시작';
    h+='<div class="border border-rose-100 rounded-lg p-3 mb-2 '+(bcore?'bg-rose-50/40':'bg-amber-50/40')+'">'
      +'<div class="text-[13px] font-extrabold '+(bcore?'text-[#B91C1C]':'text-[#B45309]')+'">'+lamp+' ['+sev+'] 부팅/전원 — '+logEsc(verdict)+'</div>'
      +'<div class="text-[11px] text-slate-600 mt-1 bg-white/70 rounded px-2 py-1.5">🔎 <b>판단 근거</b>: 운영구간 '+logEsc(bootDiag.first)+'~'+logEsc(bootDiag.last)
        +' 중 단말기 <b>재시작 '+bootDiag.restarts+'회</b>'
        +(bootDiag.abnormal?' · 정상종료 없이 재시작 <b>'+bootDiag.abnormal+'회</b>':'')
        +(bootDiag.rapid?' · 5분 내 연속 재부팅 <b>'+bootDiag.rapid+'회</b>':'')+'.</div>';
    if(bootDiag.rapTimes&&bootDiag.rapTimes.length) h+='<div class="text-[11px] text-slate-500 mt-1.5">연속 재부팅: '+logEsc(bootDiag.rapTimes.join(', '))+'</div>';
    else if(bootDiag.abnTimes&&bootDiag.abnTimes.length) h+='<div class="text-[11px] text-slate-500 mt-1.5">비정상 종료 시각: '+logEsc(bootDiag.abnTimes.join(', '))+'</div>';
    h+='<div class="text-[11px] text-slate-500 mt-2 font-semibold">✅ 점검 순서</div>'
      +'<ol class="text-[12px] text-slate-700 list-decimal pl-5 mt-0.5 space-y-0.5">'
      +'<li>차량 메인 전원·Fuse, 통합단말기 전원 케이블 체결 확인(흔들림·접촉 불량)</li>'
      +'<li>전원 케이블 임시 교체 TEST → 재시작 멈추는지 확인</li>'
      +'<li>지속 시 통합단말기 전원부/본체 점검 → 교체 검토</li>'
      +'<li>연속 재부팅이면 부팅 중 멈춤(부팅불량)일 수 있어 본체 우선 점검</li></ol>'
      +'<div class="text-[11px] text-slate-500 mt-1.5">점검 부품: '
      +'<span class="chip bg-rose-50 text-[#B91C1C] border border-rose-200" style="font-size:11px">전원 케이블</span> '
      +'<span class="chip bg-rose-50 text-[#B91C1C] border border-rose-200" style="font-size:11px">차량 Fuse</span> '
      +'<span class="chip bg-rose-50 text-[#B91C1C] border border-rose-200" style="font-size:11px">통합단말기</span></div>'
      +'</div>';
  }
  if(gpsDiag){
    var gwarn = gpsDiag.level==='warn';
    var notes=[];
    if(gpsDiag.invalid) notes.push('GPS Invalid(93G2) <b>'+gpsDiag.invalid+'회</b> 감지'+(gwarn?' — 측위 품질 저하 의심(안테나 시야·체결 확인)':' (참고)'));
    if(gpsDiag.hasTaco) notes.push('타코/도어 센서 동반 이상(7333/7338) — <b>타코·도어 센서 케이블도 함께 점검</b>');
    if(gpsDiag.count) notes.push('최근 위치기록(prevpass) '+gpsDiag.count+'건 · 마지막 측위 '+logEsc(gpsDiag.lastRec));
    var gicon = gwarn?'🟡':'🛰';
    h+='<div class="border '+(gwarn?'border-amber-200 bg-amber-50/40':'border-slate-200 bg-slate-50/50')+' rounded-lg p-3 mb-2">'
      +'<div class="text-[12.5px] font-bold '+(gwarn?'text-[#B45309]':'text-slate-600')+'">'+gicon+' GPS / 측위 보조 점검</div>'
      +'<ul class="text-[11px] text-slate-600 list-disc pl-5 mt-1 space-y-0.5"><li>'+notes.join('</li><li>')+'</li></ul>'
      +'<div class="text-[10px] text-slate-400 mt-1.5">※ 위치기록 기반 보조 신호입니다. GPS 이벤트 상세는 위 “GPS위치” 항목 참고.</div>'
      +'</div>';
  }
  return h;
}

/* 통합 백업에서 본 승하차 유닛별 통신불량 + 격리 안내 카드 */
function renderIntegratedSeungha(integSeungha, selfBad){
  if(!integSeungha) return '';
  var units=integSeungha.units, names=integSeungha.failedUnits;
  var rows=names.map(function(u){
    var v=units[u]; var codes=v.codes.slice(0,3).map(function(c){return c[0]+'×'+c[1];}).join(', ');
    return '<li><b>'+logEsc(u)+'</b> 통신실패 '+v.n+'회 <span class="text-[10px] text-slate-400">('+logEsc(codes)+')</span></li>';
  }).join('');
  if(!rows && !integSeungha.generic) return '';
  var guide = selfBad
    ? '통합단말기 자체 이상(부팅/전원/BMS 또는 다수 유닛 동시)이 함께 보입니다 → <b>통합단말기 문제</b> 가능성이 높습니다.'
    : '통합은 대체로 정상인데 특정 유닛만 실패 → <b>해당 승하차 단말기 또는 케이블</b> 문제입니다.';
  return '<div class="border-2 rounded-xl p-3 mb-2" style="border-color:#7C3AED;background:#7C3AED0d">'
    +'<div class="text-[13px] font-extrabold text-[#6D28D9]">🚪 승하차 통신불량 — 유닛별</div>'
    +(rows?'<ul class="text-[11.5px] text-slate-700 list-disc pl-5 mt-1 space-y-0.5">'+rows+'</ul>':'<div class="text-[11px] text-slate-500 mt-1">유닛 불특정 승하차 통신 이벤트 '+integSeungha.generic+'회</div>')
    +'<div class="text-[11px] text-slate-600 mt-2 bg-white/70 rounded px-2 py-1.5">🔎 '+guide+'</div>'
    +'<div class="text-[11px] text-indigo-700 mt-1.5">💡 정확한 격리: 위 유닛의 <b>승하차 단말기 백업</b>을 이 화면에서 분석하세요. (승하차 살아있고 끊김기록 → 케이블 / 무응답 → 승하차 본체)</div>'
    +'</div>';
}

function renderDiag(dg, vnum, vid, bootDiag, gpsDiag, integSeungha, selfBad){
  const box=document.getElementById('logbk-result');
  const head='<div class="flex items-center gap-2 mb-2 flex-wrap"><span class="chip bg-slate-100 text-slate-600">'+logEsc(dg.model)+(dg.sn&&dg.sn!=='단말기'?' · S/N '+logEsc(dg.sn):'')+'</span></div>';
  const extra=renderExtraCards(bootDiag, gpsDiag)+renderIntegratedSeungha(integSeungha, selfBad);
  if(!dg.findings.length && !extra){
    box.innerHTML=head+'<div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-[13px] text-emerald-700"><b>🟢 통신 장애 신호가 없습니다.</b><div class="text-[11px] mt-1">로그상 승하차·표출기·모뎀 등 통신 이상이 잡히지 않았습니다(정상 범위).</div></div>'
      +'<button onclick="aiLogAnalysis(\''+(''+vnum).replace(/'/g,"\\'")+'\',\''+(''+(vid||'')).replace(/'/g,"\\'")+'\')" class="w-full text-[12px] font-bold text-white rounded-lg py-2 mt-2 hover:brightness-110 active:scale-95 transition" style="background:linear-gradient(135deg,#2563EB,#1D4ED8)">🤖 로그+이력+S/N 종합 AI 분석</button>'
      +'<div id="logbk-ai" class="mt-2"></div><div id="logbk-snhist" class="mt-3"></div>';
    showActionCard(vnum, vid, null);
    if(dg.sn&&dg.sn!=='단말기') loadSnHistory(dg.sn,'logbk-snhist');
    return;
  }
  let rows='';
  for(let i=0;i<dg.findings.length;i++){
    const f=dg.findings[i]; const G=logGuide(f.group);
    const lamp=f.core?'🔴':'🟡'; const sev=f.core?'핵심':'주의';
    let evi='';
    for(let j=0;j<Math.min(f.codes.length,6);j++){
      const code=f.codes[j][0], n=f.codes[j][1], e=LOG_CODES[code]||['','','',''];
      evi+='<li><b>'+code+'</b> '+logEsc(e[0])+' — <b>'+n+'회</b> <span class="text-[10px] '+(e[3]==='핵심이상'?'text-[#B91C1C]':'text-slate-400')+'">['+logEsc(e[3])+']</span></li>';
    }
    const topDesc=(LOG_CODES[f.codes[0][0]]||['',''])[0];
    const reasonTxt='이 단말기 로그에 “'+logEsc(topDesc)+'” 같은 이벤트가 <b>총 '+f.n+'회</b> 기록되어 <b>'+logEsc(G.t)+'</b>로 판단됩니다.';
    const steps=G.steps.map(function(s){return '<li>'+logEsc(s)+'</li>';}).join('');
    const parts=(G.parts&&G.parts.length)?('<div class="text-[11px] text-slate-500 mt-1.5">점검 부품: '+G.parts.map(function(p){return '<span class="chip bg-rose-50 text-[#B91C1C] border border-rose-200" style="font-size:11px">'+logEsc(p)+'</span>';}).join(' ')+'</div>'):'';
    rows+='<div class="border border-rose-100 rounded-lg p-3 mb-2 '+(f.core?'bg-rose-50/40':'bg-amber-50/40')+'">'
      +'<div class="text-[13px] font-extrabold '+(f.core?'text-[#B91C1C]':'text-[#B45309]')+'">'+lamp+' ['+sev+'] '+logEsc(G.t)+' <span class="text-[11px] font-medium text-slate-500">· 총 '+f.n+'회</span></div>'
      +'<div class="text-[11px] text-slate-600 mt-1 bg-white/70 rounded px-2 py-1.5">🔎 <b>판단 근거</b>: '+reasonTxt+'</div>'
      +'<div class="text-[11px] text-slate-500 mt-2 font-semibold">세부 이벤트</div>'
      +'<ul class="text-[11px] text-slate-700 list-disc pl-5 mt-0.5 space-y-0.5">'+evi+'</ul>'
      +'<div class="text-[11px] text-slate-500 mt-2 font-semibold">✅ 점검 순서</div>'
      +'<ol class="text-[12px] text-slate-700 list-decimal pl-5 mt-0.5 space-y-0.5">'+steps+'</ol>'
      +parts+'</div>';
  }
  box.innerHTML=head+(dg.findings.length?'':'<div class="bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-[12px] text-emerald-700 mb-2">🟢 통신 이벤트는 정상 범위입니다 — 아래 부팅/전원·GPS 항목을 확인하세요.</div>')+rows+extra
    +'<button onclick="aiLogAnalysis(\''+(''+vnum).replace(/'/g,"\\'")+'\',\''+(''+(vid||'')).replace(/'/g,"\\'")+'\')" class="w-full text-[12px] font-bold text-white rounded-lg py-2 mt-1 hover:brightness-110 active:scale-95 transition" style="background:linear-gradient(135deg,#2563EB,#1D4ED8)">🤖 로그+이력+S/N 종합 AI 분석</button>'
    +'<div id="logbk-ai" class="mt-2"></div><div id="logbk-snhist" class="mt-3"></div>';
  showActionCard(vnum, vid, dg.findings[0]);
  if(dg.sn&&dg.sn!=='단말기') loadSnHistory(dg.sn,'logbk-snhist');
}

/* ===== 처리 기록 카드 ===== */
function showActionCard(vnum, vid, topFinding){
  const card=document.getElementById('logbk-action'); if(!card) return;
  const preErr = topFinding ? (GROUP_TO_ERRTYPE[topFinding.group]||"기타") : "";
  card.style.display='';
  card.innerHTML='<h3 class="text-xs font-extrabold text-[#7A0B3C] mb-2">📝 처리 기록 (재불량 추적용 누적)</h3>'
    +'<div class="space-y-2">'
    + comboHtml('logbk-err','오류유형', preErr)
    + comboHtml('logbk-act','처리유형(어떤 조치를 했나요)', '')
    +'<button onclick="saveLogDiagnosis(\''+(''+vnum).replace(/'/g,"\\'")+'\',\''+(''+(vid||'')).replace(/'/g,"\\'")+'\')" class="w-full text-[13px] font-bold text-white rounded-lg py-2" style="background:var(--atec-magenta)">💾 진단·처리 저장</button>'
    +'<div id="logbk-save-msg" class="text-[11px] text-center min-h-[16px]"></div>'
    +'</div>';
  setupCombo('logbk-err', ERROR_TYPES);
  setupCombo('logbk-act', ACTION_TYPES);
}

/* 검색형 콤보박스: 한 글자만 쳐도 연관 항목 필터 */
function comboHtml(id, label, val){
  return '<div class="relative">'
    +'<label class="text-[11px] font-semibold text-slate-500">'+logEsc(label)+'</label>'
    +'<input id="'+id+'" type="text" autocomplete="off" value="'+logEsc(val||'')+'" placeholder="입력 또는 선택 (한 글자만 쳐도 검색)" class="w-full mt-0.5 text-[12px] border border-rose-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-[#C2185B]">'
    +'<div id="'+id+'-list" class="hidden absolute z-30 left-0 right-0 mt-0.5 bg-white border border-rose-200 rounded-lg shadow-lg max-h-44 overflow-y-auto"></div>'
    +'</div>';
}
function logChosung(str){
  var CH="ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", out=""; str=''+str;
  for(var i=0;i<str.length;i++){ var c=str.charCodeAt(i)-0xAC00;
    if(c>=0 && c<11172) out+=CH.charAt(Math.floor(c/588)); else out+=str.charAt(i); }
  return out;
}
function setupCombo(id, options){
  const inp=document.getElementById(id), list=document.getElementById(id+'-list'); if(!inp||!list) return;
  function render(q){
    const raw=(q||'').replace(/\s/g,''); const ql=raw.toLowerCase();
    const items=options.filter(function(o){ const on=o.replace(/\s/g,'');
      if(!ql) return true;
      return on.toLowerCase().indexOf(ql)>=0 || logChosung(on).indexOf(raw)>=0; });
    list.innerHTML=items.map(function(o){ return '<div class="px-3 py-1.5 text-[12px] text-slate-700 hover:bg-rose-50 cursor-pointer" data-v="'+logEsc(o)+'">'+logEsc(o)+'</div>'; }).join('')
      || '<div class="px-3 py-1.5 text-[12px] text-slate-400">일치 항목 없음 — 직접 입력 가능</div>';
    list.classList.remove('hidden');
  }
  inp.addEventListener('focus',function(){ render(inp.value); });
  inp.addEventListener('input',function(){ render(inp.value); });
  list.addEventListener('mousedown',function(e){ const d=e.target.closest('[data-v]'); if(d){ inp.value=d.getAttribute('data-v'); list.classList.add('hidden'); } });
  inp.addEventListener('blur',function(){ setTimeout(function(){ list.classList.add('hidden'); },150); });
}

/* ===== Supabase 저장 (결과만, 원본 X) ===== */
function logSbHeaders(extra){ return Object.assign({'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json'}, extra||{}); }
async function saveLogDiagnosis(vnum, vid){
  const msg=document.getElementById('logbk-save-msg');
  function set(t,ok){ if(msg){ msg.textContent=t; msg.style.color=ok?'#16A34A':'#B91C1C'; } }
  const d=window.__lastDiag; if(!d){ set('먼저 분석을 실행하세요.'); return; }
  const err=(document.getElementById('logbk-err')||{}).value||'';
  const act=(document.getElementById('logbk-act')||{}).value||'';
  const note=(document.getElementById('logbk-note')||{}).value||'';
  if(!act){ set('처리유형을 입력/선택하세요.'); return; }
  // ===== 승하차 백업 저장 (고장 격리 결과) =====
  if(d.seungha){
    var s=d.seungha, iso=d.iso||{};
    var grp = s.posLabel==='승차'?'승하차1통신':s.posLabel==='하차1'?'승하차2통신':s.posLabel==='하차2'?'승하차3통신':'승하차통신';
    var srow={ vehicle_no:vnum, terminal_sn:s.sn||'', model:d.model||'', analyzed_at:d.analyzedAt,
      primary_group:grp, error_type:err, action_type:act,
      notes:('['+(s.posLabel||'승하차')+'/추정원인:'+(iso.verdict||'')+'] '+note).slice(0,500),
      faults:[{group:grp, n:s.selfLoss||0, core:false, codes:[['추정원인',iso.verdict||''],['차량ID',s.vehicleId||''],['생존',s.alive?'O':'X'],['자체끊김',s.selfLoss||0]]}],
      created_at:new Date().toISOString() };
    try{
      const r=await fetch(SB_URL+'/rest/v1/log_diagnoses',{method:'POST',headers:logSbHeaders({'Prefer':'return=minimal'}),body:JSON.stringify([srow])});
      if(!r.ok){ const t=await r.text(); throw new Error('저장 실패 '+r.status+' '+t.slice(0,120)); }
      set('저장됐습니다. 이력에 누적됩니다.', true); loadLogHistory(vnum);
    }catch(e){ set(''+(e.message||e)); }
    return;
  }
  const faults=d.findings.map(function(f){ return {group:f.group, n:f.n, core:f.core, codes:f.codes.slice(0,5)}; });
  // 부팅/전원·GPS 보조 진단도 faults에 누적(재불량 추적용)
  if(d.bootDiag && d.bootDiag.level!=='ok'){ faults.push({group:'부팅전원', n:d.bootDiag.restarts, core:d.bootDiag.level==='core', codes:[['재시작',d.bootDiag.restarts],['비정상종료',d.bootDiag.abnormal],['연속재부팅',d.bootDiag.rapid]]}); }
  if(d.gpsDiag){ faults.push({group:'GPS측위', n:d.gpsDiag.invalid||0, core:false, codes:[['93G2(Invalid)',d.gpsDiag.invalid||0],['타코도어동반',d.gpsDiag.hasTaco?1:0],['위치기록',d.gpsDiag.count||0]]}); }
  // 대표 그룹: 이벤트 발견 없으면 부팅/전원 → GPS 순으로 대표 지정
  const primary = d.findings[0] ? d.findings[0].group
    : (d.bootDiag && d.bootDiag.level!=='ok') ? '부팅전원'
    : (d.gpsDiag) ? 'GPS측위' : '정상';
  const row={ vehicle_no:vnum, terminal_sn:d.sn||'', model:d.model||'', analyzed_at:d.analyzedAt,
    primary_group: primary, error_type:err, action_type:act, notes:note,
    faults:faults, created_at:new Date().toISOString() };
  try{
    const r=await fetch(SB_URL+'/rest/v1/log_diagnoses',{method:'POST',headers:logSbHeaders({'Prefer':'return=minimal'}),body:JSON.stringify([row])});
    if(!r.ok){ const t=await r.text(); throw new Error('저장 실패 '+r.status+' '+t.slice(0,120)); }
    set('저장됐습니다. 이력에 누적됩니다.', true);
    loadLogHistory(vnum);
    // 백업 점검 완료 → 즉시 선제점검 대상에서 제외
    try{ if(typeof INSPECTED_BK!=='undefined' && INSPECTED_BK.add) INSPECTED_BK.add(vnum); }catch(e){}
    try{ if(typeof updatePreemptBadge==='function') updatePreemptBadge(); }catch(e){}
    try{ if(typeof renderPreempt==='function' && typeof CURTAB!=='undefined' && CURTAB==='preempt') renderPreempt(); }catch(e){}
  }catch(e){ set(''+(e.message||e)); }
}

/* ===== 진단·처리 이력 + 재불량 분석 ===== */
async function loadLogHistory(vnum){
  const box=document.getElementById('logbk-history'); if(!box) return;
  box.innerHTML='<span class="text-[12px] text-slate-400">이력 불러오는 중…</span>';
  try{
    const url=SB_URL+'/rest/v1/log_diagnoses?vehicle_no=eq.'+encodeURIComponent(vnum)+'&order=analyzed_at.desc,created_at.desc&limit=100';
    const r=await fetch(url,{headers:logSbHeaders()});
    if(!r.ok){ box.innerHTML='<span class="text-[12px] text-slate-400">이력 조회 불가(테이블 미생성일 수 있음).</span>'; return; }
    const rows=await r.json();
    if(!rows.length){ box.innerHTML='<span class="text-[12px] text-slate-400">아직 저장된 진단·처리 이력이 없습니다.</span>'; return; }
    const asc=rows.slice().sort(function(a,b){ return (a.analyzed_at>b.analyzed_at?1:-1); });
    const recurByAction={};
    for(let i=0;i<asc.length;i++){
      const g=asc[i].primary_group, act=asc[i].action_type;
      if(!g||g==='정상'||!act) continue;
      if(!recurByAction[act]) recurByAction[act]={repeat:0,total:0};
      recurByAction[act].total++;
      let recurred=false;
      for(let j=i+1;j<asc.length;j++){ if(asc[j].primary_group===g){ recurred=true; break; } }
      if(recurred) recurByAction[act].repeat++;
    }
    const actStats=Object.keys(recurByAction).map(function(a){ const s=recurByAction[a]; return logEsc(a)+': 재발 '+s.repeat+'/'+s.total; });
    let tl='';
    for(let i=0;i<rows.length;i++){
      const x=rows[i]; const G=logGuide(x.primary_group||''); const core=(x.faults||[]).some(function(f){ return f.core; });
      tl+='<div class="flex items-start gap-2 py-1.5 border-b border-rose-50 last:border-0">'
        +'<span class="text-[10px] text-slate-400 shrink-0 w-16">'+logEsc((''+(x.analyzed_at||'')).slice(2))+'</span>'
        +'<div class="flex-1 min-w-0">'
        +'<div class="text-[12px] font-semibold '+(core?'text-[#B91C1C]':'text-slate-700')+'">'+(core?'🔴':'🟡')+' '+logEsc(x.error_type||G.t||x.primary_group)+'</div>'
        +'<div class="text-[11px] text-slate-500">조치: '+logEsc(x.action_type||'-')+(x.notes?' · '+logEsc(x.notes):'')+'</div>'
        +'</div></div>';
    }
    const statBox=actStats.length?('<div class="bg-rose-50/60 border border-rose-100 rounded-lg px-3 py-2 mb-2 text-[11px] text-slate-600"><b class="text-[#C2185B]">조치별 재불량</b> — '+actStats.join(' · ')+'<div class="text-[10px] text-slate-400 mt-0.5">재발이 적은 조치가 효과적입니다.</div></div>'):'';
    box.innerHTML=statBox+'<div>'+tl+'</div>';
  }catch(e){ box.innerHTML='<span class="text-[12px] text-slate-400">이력 오류: '+logEsc(e.message||e)+'</span>'; }
}

/* ===== 단말기 S/N 과거 이력 (수리 미흡 재발 확인) ===== */
async function loadSnHistory(sn, elId){
  const box=document.getElementById(elId); if(!box||!sn) return;
  try{
    const url=SB_URL+'/rest/v1/log_diagnoses?terminal_sn=eq.'+encodeURIComponent(sn)+'&order=analyzed_at.desc,created_at.desc&limit=20';
    const r=await fetch(url,{headers:logSbHeaders()});
    if(!r.ok) return;
    const rows=await r.json();
    if(!rows.length){ box.innerHTML='<div class="text-[11px] text-slate-400">🔧 이 단말기(S/N '+logEsc(sn)+') 과거 이력 없음.</div>'; return; }
    const cur=(window.__lastDiag&&window.__lastDiag.findings&&window.__lastDiag.findings[0])?window.__lastDiag.findings[0].group:'';
    const repeated=cur && rows.some(function(x){ return (x.faults||[]).some(function(f){ return f.group===cur; }); });
    let tl='';
    for(let i=0;i<rows.length;i++){ const x=rows[i];
      tl+='<div class="flex items-start gap-2 py-1 border-b border-slate-100 last:border-0">'
        +'<span class="text-[10px] text-slate-400 shrink-0 w-14">'+logEsc((''+(x.analyzed_at||'')).slice(2))+'</span>'
        +'<div class="flex-1 min-w-0"><span class="text-[11px] text-slate-700">'+logEsc(x.error_type||x.primary_group||'')+'</span> <span class="text-[10px] text-slate-400">('+logEsc(x.vehicle_no||'')+')</span>'
        +'<div class="text-[10px] text-slate-500">조치: '+logEsc(x.action_type||'-')+'</div></div></div>';
    }
    box.innerHTML='<div class="bg-indigo-50/60 border border-indigo-100 rounded-lg p-3">'
      +'<div class="text-[12px] font-extrabold text-[#3730A3] mb-1">🔧 이 단말기(S/N '+logEsc(sn)+') 과거 이력 '+rows.length+'건</div>'
      +(repeated?'<div class="text-[11px] text-[#B91C1C] font-bold mb-1">⚠ 전에도 같은 장애가 있었습니다 — 수리 미흡 가능성, 점검 강화 권장</div>':'')
      +tl+'</div>';
  }catch(e){}
}

/* ===== AI 종합 분석 (로그 진단 + 차량/S/N 이력 주요, 당일이벤트는 있을 때만) ===== */
async function fetchDiag(col,val){
  try{ const r=await fetch(SB_URL+'/rest/v1/log_diagnoses?'+col+'=eq.'+encodeURIComponent(val)+'&order=analyzed_at.desc&limit=20',{headers:logSbHeaders()}); if(!r.ok) return []; return await r.json(); }catch(e){ return []; }
}
async function aiLogAnalysis(vnum, vid){
  const out=document.getElementById('logbk-ai'); if(!out) return;
  // 공용 키 확보: 메모리 캐시에 없으면(=AI 탭 미방문) 클라우드에서 직접 로드
  let aikey = (typeof getAIKey==='function') ? getAIKey() : '';
  if(!aikey && typeof fetchPublicAIKey==='function'){
    out.innerHTML='<span class="text-[12px] text-slate-500">🔑 AI 공용 키 확인 중…</span>';
    try{ aikey = await fetchPublicAIKey(); }catch(e){ aikey=''; }
    if(aikey){ if(typeof setAIKey==='function') setAIKey(aikey); else { try{ AI_KEY_CACHE=aikey; }catch(e){} } }
  }
  if(!aikey){ out.innerHTML='<span class="text-[12px] text-rose-600">AI 공용 키가 설정되지 않았습니다(관리자에게 등록 요청).</span>'; return; }
  out.innerHTML='<span class="text-[12px] text-slate-500">🤖 로그·이력·S/N 종합 분석 중…</span>';
  try{
    const d=window.__lastDiag||{};
    let ctx='[현재 로그 진단]\n차량 '+vnum+' / '+(d.model||'')+' S/N '+(d.sn||'')+' / 진단일 '+(d.analyzedAt||'')+'\n';
    if(d.findings&&d.findings.length){
      for(let i=0;i<d.findings.length;i++){ const f=d.findings[i]; const G=logGuide(f.group);
        ctx+='- '+G.t+' ('+f.n+'회/'+(f.core?'핵심':'주의')+'): '+f.codes.slice(0,4).map(function(c){return c[0]+'×'+c[1]+'('+((LOG_CODES[c[0]]||['',''])[0])+')';}).join(', ')+'\n'; }
    } else ctx+='- 통신 장애 신호 없음(정상 범위)\n';
    if(d.bootDiag && d.bootDiag.level!=='ok'){
      ctx+='[부팅/전원] 운영구간 '+(d.bootDiag.first||'')+'~'+(d.bootDiag.last||'')+' 재시작 '+d.bootDiag.restarts+'회'
        +(d.bootDiag.abnormal?', 정상종료 없이 재시작 '+d.bootDiag.abnormal+'회':'')
        +(d.bootDiag.rapid?', 5분내 연속재부팅 '+d.bootDiag.rapid+'회':'')+' ('+(d.bootDiag.level==='core'?'핵심':'주의')+')\n';
    }
    if(d.gpsDiag){
      ctx+='[GPS/측위 보조] '+(d.gpsDiag.invalid?'GPS Invalid(93G2) '+d.gpsDiag.invalid+'회':'')
        +(d.gpsDiag.hasTaco?' / 타코·도어 동반이상(7333·7338)':'')
        +(d.gpsDiag.count?' / 위치기록 '+d.gpsDiag.count+'건(마지막 '+d.gpsDiag.lastRec+')':'')+'\n';
    }
    const vh=await fetchDiag('vehicle_no',vnum);
    ctx+='\n[이 차량 과거 로그 진단·처리 이력 '+vh.length+'건]\n';
    for(let i=0;i<Math.min(vh.length,10);i++){ const x=vh[i]; ctx+='- '+(x.analyzed_at||'')+' '+(x.error_type||x.primary_group||'')+' → 조치:'+(x.action_type||'-')+'\n'; }
    let snh=[];
    if(d.sn && d.sn!=='단말기'){ snh=await fetchDiag('terminal_sn',d.sn);
      ctx+='\n[동일 단말기(S/N '+d.sn+') 이력 '+snh.length+'건 — 수리 미흡 재발 확인용]\n';
      for(let i=0;i<Math.min(snh.length,10);i++){ const x=snh[i]; ctx+='- '+(x.analyzed_at||'')+' '+(x.vehicle_no||'')+' '+(x.error_type||x.primary_group||'')+' → '+(x.action_type||'-')+'\n'; } }
    let hasEv=false;
    if(typeof DAILY!=='undefined' && DAILY && vid && DAILY[vid] && DAILY[vid].length){
      hasEv=true; const grp={}; for(let i=0;i<DAILY[vid].length;i++){ const c=DAILY[vid][i].code; grp[c]=(grp[c]||0)+1; }
      const top=Object.keys(grp).sort(function(a,b){return grp[b]-grp[a];}).slice(0,8);
      ctx+='\n[당일 이벤트]\n'+top.map(function(c){ const E=(typeof EVENTS!=='undefined'&&EVENTS[c])?EVENTS[c]:null; return '- '+c+' '+(E?(E.t||''):'')+' ×'+grp[c]; }).join('\n')+'\n';
    }
    const sys='당신은 ATEC 버스 단말기 장애 분석 전문가입니다. 아래 데이터를 근거로 종합 분석하세요.\n'
      +'주요 근거(우선): 1)현재 로그 진단 2)이 차량 과거 로그 이력 3)동일 단말기(S/N) 이력.\n'
      +(hasEv?'당일 이벤트가 제공되었으니 보조로 활용하세요.':'당일 이벤트는 제공되지 않았습니다 — 이벤트 관련 추정/언급은 하지 마세요.')+'\n'
      +'한국어로 짧고 명확하게:\n**종합 진단**(1~2문장)\n**재불량/수리 미흡 여부**(S/N·과거 이력 근거. 조치 후 같은 장애 재발 시 수리 미흡 의심 명시)\n**권장 조치**(구체 1~3개, 과거 효과없던 조치 지양)\n마지막 줄: (주의) AI 추정 — 최종 판단은 기사님 확인 후';
    const res=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+AI_MODEL+':generateContent',{
      method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':aikey},
      body:JSON.stringify({systemInstruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:ctx}]}],generationConfig:{maxOutputTokens:1024,temperature:0.4,thinkingConfig:{thinkingBudget:0}}})});
    const data=await res.json();
    if(!res.ok){ out.innerHTML='<span class="text-[12px] text-rose-600">AI 호출 실패('+res.status+'). 잠시 후 재시도.</span>'; return; }
    const cand=(data.candidates||[])[0];
    let ans=(cand&&cand.content&&cand.content.parts)?cand.content.parts.map(function(p){return p.text||'';}).join(''):'';
    if(!ans) ans='(빈 응답)';
    const html=logEsc(ans).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\n/g,'<br>');
    out.innerHTML='<div class="bg-blue-50 border border-blue-200 rounded-lg p-3 text-[12.5px] text-slate-700 leading-relaxed"><div class="text-[11px] font-bold text-blue-700 mb-1">🤖 AI 종합 분석</div>'+html+'</div>';
  }catch(e){ out.innerHTML='<span class="text-[12px] text-rose-600">AI 분석 오류: '+logEsc(e.message||e)+'</span>'; }
}

/* =========================================================
   단말기(S/N) 조회 — 개체 이력 추적 (탭: 단말기 조회)
   데이터원: log_diagnoses (백업 분석 후 저장된 진단·처리 기록)
   ========================================================= */
function snChip(label,val,color){ return '<span class="inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-2 py-1" style="background:'+color+'18;color:'+color+'">'+logEsc(label)+' <b>'+logEsc(val)+'</b></span>'; }

async function snFetchRows(col, op, val, limit){
  try{
    const url=SB_URL+'/rest/v1/log_diagnoses?'+col+'='+op+'.'+val+'&order=analyzed_at.desc,created_at.desc&limit='+(limit||500);
    const r=await fetch(url,{headers:logSbHeaders()});
    if(!r.ok) return null;
    return await r.json();
  }catch(e){ return null; }
}

async function snSearch(){
  const box=document.getElementById('sn-result'); if(!box) return;
  const qel=document.getElementById('sn-q'); const q=((qel&&qel.value)||'').trim();
  if(q.length<2){ box.innerHTML='<span class="text-[12px] text-rose-600">S/N을 2자 이상 입력하세요 (뒤 4자리 권장).</span>'; return; }
  box.innerHTML='<span class="text-[12px] text-slate-500">조회 중…</span>';
  const rows=await snFetchRows('terminal_sn','ilike','*'+encodeURIComponent(q)+'*',500);
  if(rows===null){ box.innerHTML='<span class="text-[12px] text-rose-600">조회 실패(테이블 미생성일 수 있음).</span>'; return; }
  if(!rows.length){ box.innerHTML='<div class="text-[12px] text-slate-500">\''+logEsc(q)+'\' 와 일치하는 단말기 기록이 없습니다.<br>※ 백업 분석 후 <b>진단·처리 저장</b>을 한 단말기만 조회됩니다.</div>'; return; }
  const bySn={}; for(let i=0;i<rows.length;i++){ const s=rows[i].terminal_sn||'(미상)'; (bySn[s]=bySn[s]||[]).push(rows[i]); }
  const sns=Object.keys(bySn);
  if(sns.length>1){
    let h='<div class="text-[12px] text-slate-500 mb-2">'+sns.length+'개 단말기가 일치합니다. 선택하세요.</div><div class="flex flex-col gap-1.5">';
    for(let i=0;i<sns.length;i++){ const s=sns[i]; h+='<button onclick="snPick(\''+(''+s).replace(/\x27/g,"\\\x27")+'\')" class="text-left text-[12.5px] border border-rose-200 rounded-lg px-3 py-2 hover:bg-rose-50 transition"><b>'+logEsc(s)+'</b> <span class="text-slate-400">('+logModelOf(s)+')</span> · 진단 '+bySn[s].length+'건</button>'; }
    h+='</div>'; box.innerHTML=h; return;
  }
  box.innerHTML=snCardHtml(sns[0], bySn[sns[0]]);
}

async function snPick(sn){
  const box=document.getElementById('sn-result'); if(!box) return;
  box.innerHTML='<span class="text-[12px] text-slate-500">불러오는 중…</span>';
  const rows=await snFetchRows('terminal_sn','eq',encodeURIComponent(sn),200);
  if(!rows||!rows.length){ box.innerHTML='<span class="text-[12px] text-slate-500">기록 없음.</span>'; return; }
  box.innerHTML=snCardHtml(sn, rows);
  const tab=document.getElementById('sn'); if(tab && tab.scrollIntoView){ try{ tab.scrollIntoView({behavior:'smooth',block:'start'}); }catch(e){} }
}

function snCardHtml(sn, rows){
  const asc=rows.slice().sort(function(a,b){ const ka=(a.analyzed_at||a.created_at||''),kb=(b.analyzed_at||b.created_at||''); return ka<kb?-1:ka>kb?1:0; });
  const model=logModelOf(sn);
  const vehSeq=[];
  for(let i=0;i<asc.length;i++){ const v=asc[i].vehicle_no||'(미상)'; const dt=(asc[i].analyzed_at||'').slice(0,10);
    if(!vehSeq.length || vehSeq[vehSeq.length-1].v!==v) vehSeq.push({v:v,from:dt}); }
  const distinctVeh={}; for(let i=0;i<asc.length;i++) distinctVeh[asc[i].vehicle_no||'(미상)']=1;
  const nVeh=Object.keys(distinctVeh).length;
  const firstIdx={}; for(let i=0;i<asc.length;i++){ const g=asc[i].primary_group||asc[i].error_type||''; if(g && !(g in firstIdx)) firstIdx[g]=i; }
  let recur=0; const cseen={}; for(let i=0;i<asc.length;i++){ const g=asc[i].primary_group||asc[i].error_type||''; if(!g) continue; if(cseen[g]) recur++; cseen[g]=1; }
  const lastDate=(rows[0].analyzed_at||rows[0].created_at||'').slice(0,10);
  const actCnt={}; for(let i=0;i<asc.length;i++){ const a=asc[i].action_type||''; if(a) actCnt[a]=(actCnt[a]||0)+1; }
  const acts=Object.keys(actCnt).sort(function(a,b){return actCnt[b]-actCnt[a];});

  let h='<div class="border border-rose-100 rounded-xl p-4" style="background:#fff7fa">';
  h+='<div class="flex items-center gap-2 flex-wrap mb-1"><span class="text-xl font-extrabold text-[#7A0B3C]">S/N '+logEsc(sn)+'</span><span class="text-[11px] font-bold text-white rounded px-2 py-0.5" style="background:#7C3AED">'+model+'</span>';
  if(recur>0) h+='<span class="text-[11px] font-bold text-white rounded px-2 py-0.5" style="background:#B91C1C">재불량 '+recur+'회</span>';
  if(nVeh>1) h+='<span class="text-[11px] font-bold text-white rounded px-2 py-0.5" style="background:#0891B2">이설 '+(nVeh-1)+'회</span>';
  h+='</div>';
  h+='<div class="flex gap-1.5 flex-wrap mb-3">'+snChip('누적 진단',rows.length+'건','#C2185B')+snChip('장착 차량',nVeh+'대','#7A0B3C')+snChip('마지막 진단',lastDate||'-','#64748b')+'</div>';
  if(vehSeq.length){
    h+='<div class="text-[12px] font-bold text-slate-600 mb-1">📍 장착 차량 변천</div><div class="flex items-center gap-1 flex-wrap mb-3 text-[11.5px]">';
    for(let i=0;i<vehSeq.length;i++){ if(i>0) h+='<span class="text-slate-300">→</span>'; h+='<span class="bg-white border border-slate-200 rounded-md px-2 py-1"><b>'+logEsc(vehSeq[i].v)+'</b> <span class="text-slate-400">'+(vehSeq[i].from?vehSeq[i].from.slice(2):'')+'</span></span>'; }
    h+='</div>';
  }
  if(acts.length){ h+='<div class="text-[12px] font-bold text-slate-600 mb-1">🔧 처리유형</div><div class="flex gap-1.5 flex-wrap mb-3">'; for(let i=0;i<acts.length;i++){ h+=snChip(acts[i],actCnt[acts[i]]+'회','#16A34A'); } h+='</div>'; }
  h+='<div class="text-[12px] font-bold text-slate-600 mb-1">🕑 진단·처리 타임라인</div><div class="flex flex-col gap-1">';
  for(let i=asc.length-1;i>=0;i--){ const x=asc[i]; const g=x.primary_group||x.error_type||''; const isRecur=(g && firstIdx[g]<i);
    h+='<div class="flex items-start gap-2 text-[11.5px] bg-white border border-slate-100 rounded-md px-2 py-1.5">'
      +'<span class="text-slate-400 shrink-0 w-14">'+logEsc((x.analyzed_at||'').slice(2))+'</span>'
      +'<div class="flex-1 min-w-0"><span class="text-slate-700">'+logEsc(g||'-')+'</span>'
      +(x.action_type?' <span class="text-slate-400">→ '+logEsc(x.action_type)+'</span>':'')
      +' <span class="text-slate-400">('+logEsc(x.vehicle_no||'')+')</span>'
      +(isRecur?' <span class="text-[10px] font-bold text-white rounded px-1" style="background:#B91C1C">재발</span>':'')
      +'</div></div>';
  }
  h+='</div>';
  if(recur>0) h+='<div class="mt-3 text-[11.5px] text-rose-700 bg-rose-100 rounded-lg px-3 py-2">⚠ 같은 장애가 '+recur+'회 재발했습니다. 수리 미흡 또는 <b>단말기 개체 불량</b> 가능성 — 교체 검토를 권장합니다.</div>';
  h+='</div>';
  return h;
}

async function loadBadTerminals(){
  const box=document.getElementById('sn-rank'); if(!box) return;
  box.innerHTML='<span class="text-[12px] text-slate-400">불량 단말기 집계 중…</span>';
  let rows=null;
  try{ const url=SB_URL+'/rest/v1/log_diagnoses?select=terminal_sn,vehicle_no,primary_group,error_type,action_type,analyzed_at,created_at&order=created_at.desc&limit=3000'; const r=await fetch(url,{headers:logSbHeaders()}); if(r.ok) rows=await r.json(); }catch(e){}
  if(rows===null){ box.innerHTML=''; return; }
  if(!rows.length){ box.innerHTML='<div class="bg-white border border-rose-100 rounded-xl p-6 text-center text-[12.5px] text-slate-400">저장된 단말기 진단 기록이 아직 없습니다.<br>백업 분석 후 <b>진단·처리 저장</b>을 하면 여기에 누적됩니다.</div>'; return; }
  const bySn={};
  for(let i=0;i<rows.length;i++){ const s=rows[i].terminal_sn; if(!s) continue; (bySn[s]=bySn[s]||[]).push(rows[i]); }
  const list=[];
  for(const s in bySn){
    const arr=bySn[s].slice().sort(function(a,b){ const ka=(a.analyzed_at||a.created_at||''),kb=(b.analyzed_at||b.created_at||''); return ka<kb?-1:ka>kb?1:0; });
    const veh={}; const seen={}; let recur=0;
    for(let i=0;i<arr.length;i++){ veh[arr[i].vehicle_no||'?']=1; const g=arr[i].primary_group||arr[i].error_type||''; if(g){ if(seen[g]) recur++; seen[g]=1; } }
    const nVeh=Object.keys(veh).length;
    const score=recur*40 + (nVeh-1)*15 + arr.length*5;
    list.push({sn:s, n:arr.length, recur:recur, nVeh:nVeh, score:score, model:logModelOf(s), last:(arr[arr.length-1].analyzed_at||'').slice(0,10)});
  }
  list.sort(function(a,b){ return b.score-a.score || b.recur-a.recur; });
  const top=[]; for(let i=0;i<list.length;i++){ if(list[i].recur>0||list[i].n>=2) top.push(list[i]); if(top.length>=15) break; }
  if(!top.length){ box.innerHTML='<div class="bg-white border border-rose-100 rounded-xl p-5 text-center text-[12.5px] text-slate-400">아직 재불량(반복) 단말기가 없습니다. 👍</div>'; return; }
  let h='<div class="flex items-center gap-2 mb-2 pl-1"><h3 class="text-[13px] font-extrabold text-[#7A0B3C]">🔧 교체 검토 권장 단말기</h3><span class="text-[11px] text-slate-400">재불량·이설·진단 빈도 종합 상위</span></div>';
  h+='<div class="flex flex-col gap-1.5">';
  for(let i=0;i<top.length;i++){ const t=top[i]; const col=t.recur>=3?'#B91C1C':t.recur>=1?'#D81B60':'#64748b';
    h+='<button onclick="snPick(\''+(''+t.sn).replace(/\x27/g,"\\\x27")+'\')" class="text-left bg-white border border-rose-100 rounded-lg px-3 py-2 hover:bg-rose-50 transition flex items-center gap-2">'
      +'<span class="text-[12px] font-extrabold text-slate-400 w-5">'+(i+1)+'</span>'
      +'<div class="flex-1 min-w-0"><div class="text-[13px] font-bold text-slate-800">S/N '+logEsc(t.sn)+' <span class="text-[10px] font-bold text-white rounded px-1" style="background:#7C3AED">'+t.model+'</span></div>'
      +'<div class="text-[11px] text-slate-500">진단 '+t.n+'건 · 장착 '+t.nVeh+'대'+(t.last?' · 최근 '+t.last:'')+'</div></div>'
      +'<span class="text-[11px] font-bold text-white rounded-md px-2 py-1 shrink-0" style="background:'+col+'">재불량 '+t.recur+'</span>'
      +'</button>';
  }
  h+='</div>';
  box.innerHTML=h;
}

function initSnTab(){
  const box=document.getElementById('sn-result'); if(box) box.innerHTML='';
  const qel=document.getElementById('sn-q'); if(qel) qel.value='';
  loadBadTerminals();
}
/* logengine.js — end */