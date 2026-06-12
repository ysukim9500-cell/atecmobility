/* ============================================================
   logengine.js — 단말기 로그백업 분석 엔진 (브라우저 전용)
   terminal.html에서 <script src="logengine.js"></script> 로 로드.
   - 업로드한 로그백업(폴더 또는 zip)을 휴대폰 안에서 직접 분석(원본 저장 X)
   - important.evt(중요장애 카운트) + ASCII EVENT(127자, 코드 44~47자리) 디코딩
   - 신호등 + 초보자 점검 가이드 → 처리유형/오류유형 기록 → Supabase 누적(재불량 추적)
   참조 전역(terminal.html 정의): SB_URL, SB_KEY
   ============================================================ */
const LOG_CODES={"3339":["구후불카드 Read 실패","요금처리부","거래/카드","이상"],"3347":["신선불카드 Write 실패","요금처리부","거래/카드","이상"],"7333":["TOPIS 기준 장비 이상 검지(타코/GPS/도어)","BMS","GPS/위치","이상"],"7338":["KSCC 기준 장비 이상 검지(타코/GPS)","BMS","GPS/위치","이상"],"3346":["신선불카드 Read 실패","요금처리부","거래/카드","이상"],"7907":["BMS와 TOPIS간 통신 모듈의 모뎀 연결 실패","BMS","통신","핵심이상"],"3366":["정기권 쓰기 에러","요금처리부","거래/카드","이상"],"93G5":["GPS 정류장 순차적 인식 오류","운전자단말","GPS/위치","핵심이상"],"3368":["모바일 정기권 쓰기 에러","요금처리부","거래/카드","이상"],"333A":["구후불카드 Write 실패","요금처리부","거래/카드","이상"],"7601":["모뎀 상태 정보 5회 이상 수신 실패","BMS","통신","핵심이상"],"150P":["운전자-승하차 통신 30초이상 끊김(승하차2번)","운전자단말","통신","핵심이상"],"150Q":["운전자-승하차 통신 30초이상 끊김(승하차3번)","운전자단말","통신","이상"],"3357":["신후불카드 Write 실패","요금처리부","거래/카드","이상"],"3367":["모바일 정기권 읽기 에러","요금처리부","거래/카드","이상"],"3365":["정기권 읽기 에러","요금처리부","거래/카드","이상"],"1A05":["AFC와 HMI간 통신 연속 끊어짐(30초마다)","운전자단말","통신","이상"],"5203":["운전자-승하차 통신 끊어짐","승하차조작부","통신","이상"],"3703":["G/W와 요금처리부간 통신 끊어짐","요금처리부","통신","핵심이상"],"3356":["신후불카드 Read 실패","요금처리부","거래/카드","이상"],"3312":["CSAM 통신 오류","요금처리부","통신","핵심이상"],"3313":["PSAM 통신 오류","요금처리부","통신","핵심이상"],"9802":["G/W와 단말센터 클라우드간 통신 끊어짐","운전자단말","통신","이상"],"150L":["운전자-승하차 통신 2분이상 끊김(승하차2번)","운전자단말","통신","핵심이상"],"150M":["운전자-승하차 통신 2분이상 끊김(승하차3번)","운전자단말","통신","핵심이상"],"1852":["운전자-수집센터 통신 끊어짐","운전자단말","통신","이상"],"1859":["수집센터 수신메시지 응답시간 초과","운전자단말","통신","이상"],"150O":["운전자-승하차 통신 30초이상 끊김(승하차1번)","운전자단말","통신","핵심이상"],"1A03":["AFC와 HMI간 통신 끊어짐","운전자단말","통신","핵심이상"],"7339":["첫정류장 승차인원 대비 하차인원 초과","BMS","GPS/위치","이상"],"3306":["거래성공/sign3 미수신","요금처리부","거래/카드","이상"],"5205":["승하차 통신끊김 AP상태확인(승하차기준)","승하차조작부","통신","이상"],"9A03":["G/W와 HMI간 통신모듈 끊어짐","운전자단말","통신","이상"],"150T":["운전자-승하차 통신 5분이상 끊김(승하차2번)","운전자단말","통신","이상"],"150U":["운전자-승하차 통신 5분이상 끊김(승하차3번)","운전자단말","통신","이상"],"9605":["G/W-요금처리부 통신끊김(요금2번)","운전자단말","통신","핵심이상"],"3513":["거래파일 운전자 전송 실패","요금처리부","거래/카드","이상"],"1505":["운전자-승하차 통신 끊어짐(승하차2번)","운전자단말","통신","이상"],"7803":["G/W와 BMS간 통신 끊어짐","BMS","통신","핵심이상"],"1901":["BMS 통신상태 이상으로 인한 Reset","운전자단말","통신","핵심이상"],"9403":["G/W와 BMS간 통신 끊어짐","운전자단말","통신","이상"],"9607":["G/W-요금처리부 통신끊김(요금3번)","운전자단말","통신","핵심이상"],"9231":["DTG 10초이상 응답없음","운전자단말","기타","이상"],"150F":["운전자-승하차 통신 끊어짐(승하차2번)","운전자단말","통신","이상"],"7602":["부팅후 2분이상 모뎀 연결안됨","BMS","통신","핵심이상"],"150K":["운전자-승하차 통신 2분이상 끊김(승하차1번)","운전자단말","통신","핵심이상"],"150Y":["운전자-승하차 통신 10분이상 끊김(승하차3번)","운전자단말","통신","이상"],"150X":["운전자-승하차 통신 10분이상 끊김(승하차2번)","운전자단말","통신","이상"],"1507":["운전자-승하차 통신 끊어짐(승하차3번)","운전자단말","통신","이상"],"1213":["거래검증 타임아웃","운전자단말","거래/카드","이상"],"7905":["BMS-TOPIS 통신모듈 센터연결 끊어짐","BMS","통신","핵심이상"],"9603":["G/W-요금처리부 통신끊김(요금1번)","운전자단말","통신","핵심이상"],"1503":["운전자-승하차 통신 끊어짐(승하차1번)","운전자단말","통신","이상"],"7903":["BMS-TOPIS 통신모듈 모뎀연결 끊어짐","BMS","통신","핵심이상"],"3512":["거래검증실패로 운전자에 거래파일 전송","요금처리부","거래/카드","이상"],"150H":["운전자-승하차 통신 끊어짐(승하차3번)","운전자단말","통신","이상"],"1205":["거래파일 검증 실패","운전자단말","거래/카드","이상"],"5401":["연결끊김으로 카드처리 비활성화","승하차조작부","통신","이상"],"150D":["운전자-승하차 통신 끊어짐(승하차1번)","운전자단말","통신","이상"],"150S":["운전자-승하차 통신 5분이상 끊김(승하차1번)","운전자단말","통신","이상"],"7402":["BMS-운전자 통신모듈 끊어짐","BMS","통신","이상"],"3220":["EBCSAM 초기화 에러","요금처리부","펌웨어/OS","이상"],"3305":["5회 재시도 카드읽기 실패","요금처리부","거래/카드","핵심이상"],"1330":["일부 승하차 운행시작 실패상태로 시작","운전자단말","운행","이상"],"13Y0":["일부 승하차 운행종료 실패상태로 종료","운전자단말","운행","이상"],"9503":["운전자-G/W 통신 끊어짐","운전자단말","통신","이상"],"150W":["운전자-승하차 통신 10분이상 끊김(승하차1번)","운전자단말","통신","이상"],"5303":["승하차-요금처리부 통신 끊어짐","승하차조작부","통신","이상"],"3603":["승하차-요금처리부 통신 끊어짐","요금처리부","통신","이상"],"3230":["CSAM 초기화 에러","요금처리부","펌웨어/OS","핵심이상"],"5404":["운전자 CPU LOAD 5.00 이상","승하차조작부","전원/HW","핵심이상"],"1010":["운전자 어플리케이션 초기화 실패","운전자단말","펌웨어/OS","이상"],"1303":["운전자 CPU LOAD 4.00 이상","운전자단말","전원/HW","이상"],"1302":["운전자 CPU LOAD 3.00 이상","운전자단말","전원/HW","이상"],"1020":["운전자 일련번호(IH) 존재안함","운전자단말","운행","이상"],"9A81":["설치실패(Management)","TMGR","펌웨어/OS","이상"],"9AB1":["설치실패(Diagnostic)","TMGR","펌웨어/OS","이상"],"9AD1":["설치실패(apk_install)","TMGR","펌웨어/OS","이상"],"7301":["BMS CPU LOAD 3.00 이상","BMS","전원/HW","핵심이상"],"9323":["GPS 정류장 로그 생성 실패","운전자단말","GPS/위치","이상"],"93G2":["GPS 비정상(Invalid)","운전자단말","GPS/위치","핵심정상"]};

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
 "기타통신":{t:"통신 이상",steps:["연결 케이블·커넥터 점검"],parts:["케이블"]}
};
function logGuide(g){ return LOG_GUIDE[g] || LOG_GUIDE[(''+g).replace(/[123]/,'')] || {t:g,steps:["현장 점검"],parts:[]}; }

/* 오류유형 / 처리유형 드롭다운 옵션 */
const ERROR_TYPES=["BMS 데이터 이상(앞뒤차 간격)","GPS 수신이상","LTE모뎀불량","SAM통신오류","기구물파손","기타","다인승불량","단말기 테스트","단말기고정불량","단말기백업","단말기사용문의","단말기위치조정","단말기정보불일치","단말기파손","대폐차(증차/감차) 작업","메모리불량","미승인카드","부저불량","비콘 외부안테나 이상","비콘 이상","승차통신불량","승하차 음성 불량","승하차부팅불량","승하차전원불량","승하차터치불량","승하차화면불량","시간이상","예방점검","운수사방문요청","운영정보이상","운행시작/종료안됨","음성불량","장기미통신","전원불량(전체)","차량 고장","초기화실패","카드다시","카드무감","키버튼불량(승하차)","키버튼불량(운전자)","타사장비 장애접수","타코/개폐센서이상","태그리스 FW 이상","통합단말기 BMS불량","통합단말기 CITS불량","통합단말기 FAN 불량","통합단말기 모뎀불량(ST1)","통합단말기 서버연결대기중","통합단말기 승하차 전체통신불량","통합단말기 전원불량","통합단말기 케이블불량","통합단말기 포트불량","통합연결대기중","펌웨어오류","표출 단말기 음성 불량","표출 단말기 키패드불량","표출 단말기?히든버튼 불량","표출단말기 미인증 표시","표출단말기 부팅불량","표출단말기 전원불량","표출단말기 전원스위치 불량","표출단말기 케이블불량","표출단말기 터치불량","표출단말기 화면불량","하차1WI-FI통신불량","하차2WI-FI통신불량","하차유선통신불량"];
const ACTION_TYPES=["DTG커넥터 재연결","DTG커넥터 탈거","F/W, OS 적용","GPS안테나교체","GPS위치변경","GPS커넥터재연결","LCD패널교체","LTE 안테나 교체","LTE 안테나 재연결","LTE모뎀교체","LTE커넥터 재연결","LTE케이블교체","LTE케이블재연결","SAM세척&재삽입","USIM 세척","고정작업","기처리건","기타","단말기 재등록","단말기 초기화","단말기사용안내","단말기위치조정","단말기전원 On/Off","단말기커버교체","대폐차(증차/감차) 완료","메인 전원ON/OFF","모니터링","모뎀USIM세척","볼륨조정","브라켓교체","비콘 교체","사용 안내","설정값 변경","승차 케이블 교체","승차단말기교체","승차단말기재등록","승차전원케이블교체","승차전원케이블재연결","승차통신케이블교체","승차통신케이블재연결","승하차 위치 맞교체","운수사 방문","원인분석","이상없음","전화응대","접수취소","차량Fuse교체","차량메인 스위치 On/Off","케이블 교체","케이블 재결선(케이블 결선작업)","케이블 재연결","타사장비 간섭(이관)","타사장비 커넥터 탈거","타코메타설정값변경","타코메타케이블교체","타코메타케이블재연결","태그리스 FW 재설치","태그리스 비콘 교체","태그리스 설정 활성화","태그리스 외부안테나 교체","태그리스 케이블 교체","태그리스 허브교체","통합단말기 교체","통합단말기 전원 케이블교체","통합단말기 전원 케이블재연결","통합단말기 초기화","통합단말기재등록","통합단말기전원케이블교체","통합단말기전원케이블재연결","포트변경","표출기 케이블교체","표출기 케이블재연결","표출단말기 교체","하차 케이블 교체","하차 케이블 재연결","하차1단말기교체","하차2단말기교체","허브보드 교체"];
const GROUP_TO_ERRTYPE={"승하차1통신":"승차통신불량","승하차2통신":"하차유선통신불량","승하차3통신":"하차유선통신불량","승하차통신":"통합단말기 승하차 전체통신불량","표출기통신":"표출단말기 케이블불량","모뎀BMS통신":"통합단말기 모뎀불량(ST1)","센터통신":"통합단말기 서버연결대기중","GW통신":"통합단말기 케이블불량","카드SAM":"SAM통신오류","GPS위치":"GPS 수신이상","운행":"운행시작/종료안됨","전원HW":"기타","펌웨어":"펌웨어오류","기타통신":"기타"};

function logEsc(t){ return (''+t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function logModelOf(sn){ return ({"460":"B700","465":"B710","570":"B800"})[(''+sn).slice(0,3)] || "단말기"; }

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

/* ===== 경로 판별 ===== */
function isImportantPath(p){ return /(^|\/)event\/important\/[^/]+\.evt$/i.test(p) || /(^|\/)important\/[^/]+\.evt$/i.test(p); }
function isAsciiEventPath(p){ if(isImportantPath(p)) return false; return /(^|\/)event\/EVENT_[^/]*\.evt$/i.test(p) || /(^|\/)EVENT_[^/]*\.evt$/i.test(p); }
function snFromPath(p){ const m=(''+p).match(/(?:^|\/)((?:460|465|570)\d{6,})(?:\/|$)/); return m?m[1]:''; }

/* 폴더(여러 파일) 직접 분석 — 큰 debug 파일은 읽지 않아 가볍다 */
async function readBackupFromFiles(fileList){
  const files=Array.prototype.slice.call(fileList); let sn=''; const counts={};
  for(let i=0;i<files.length;i++){ if(sn) break; sn=snFromPath(files[i].webkitRelativePath||files[i].name); }
  for(let i=0;i<files.length;i++){
    const f=files[i]; const p=f.webkitRelativePath||f.name;
    try{
      if(isImportantPath(p)){ const u8=new Uint8Array(await f.arrayBuffer()); const c=parseImportantEvt(u8); for(const k in c) counts[k]=(counts[k]||0)+c[k]; }
      else if(isAsciiEventPath(p)){ const t=await f.text(); const c=parseAsciiEvt(t); for(const k in c) counts[k]=(counts[k]||0)+c[k]; }
    }catch(e){}
  }
  return {sn:sn,counts:counts};
}
/* zip 분석 */
async function readBackupFromZip(file){
  const zip=await JSZip.loadAsync(file); let sn=''; const imp=[],asc=[]; const counts={};
  zip.forEach(function(p,e){ if(e.dir) return; if(!sn) sn=snFromPath(p);
    if(isImportantPath(p)) imp.push(e); else if(isAsciiEventPath(p)) asc.push(e); });
  for(let i=0;i<imp.length;i++){ const u8=await imp[i].async('uint8array'); const c=parseImportantEvt(u8); for(const k in c) counts[k]=(counts[k]||0)+c[k]; }
  for(let i=0;i<asc.length;i++){ const t=await asc[i].async('string'); const c=parseAsciiEvt(t); for(const k in c) counts[k]=(counts[k]||0)+c[k]; }
  return {sn:sn,counts:counts};
}

/* 메인: 폴더 또는 zip 어느 쪽이든 분석 */
async function analyzeLogBackup(vnum, vid){
  const box=document.getElementById('logbk-result'); if(!box) return;
  const folderInp=document.getElementById('logbk-folder');
  const zipInp=document.getElementById('logbk-file');
  const folderFiles=(folderInp&&folderInp.files&&folderInp.files.length)?folderInp.files:null;
  const zipFile=(zipInp&&zipInp.files&&zipInp.files[0])?zipInp.files[0]:null;
  if(!folderFiles && !zipFile){ box.innerHTML='<span class="text-rose-600 text-[12px]">먼저 단말기 <b>폴더</b> 또는 <b>zip</b>을 선택하세요.</span>'; return; }
  box.innerHTML='<span class="text-slate-500 text-[12px]">⏳ 분석 중… (휴대폰 안에서만 처리, 원본은 저장 안 함)</span>';
  try{
    let sn='', counts={};
    if(folderFiles){ const r=await readBackupFromFiles(folderFiles); sn=r.sn; counts=r.counts; }
    else {
      if(typeof JSZip==='undefined'){ box.innerHTML='<span class="text-rose-600 text-[12px]">zip 분석 라이브러리 로드 실패(JSZip). 폴더 선택을 이용하거나 새로고침하세요.</span>'; return; }
      const r=await readBackupFromZip(zipFile); sn=r.sn; counts=r.counts;
    }
    if(!sn) sn='단말기';
    const dg=diagnoseCounts(sn, counts);
    window.__lastDiag={vnum:vnum,vid:vid,sn:dg.sn,model:dg.model,findings:dg.findings,analyzedAt:new Date().toISOString().slice(0,10)};
    renderDiag(dg, vnum, vid);
  }catch(err){
    box.innerHTML='<span class="text-rose-600 text-[12px]">분석 실패: '+logEsc(err.message||err)+'<br>올바른 단말기 백업(폴더/zip)인지 확인하세요.</span>';
  }
}

function renderDiag(dg, vnum, vid){
  const box=document.getElementById('logbk-result');
  const head='<div class="flex items-center gap-2 mb-2 flex-wrap"><span class="chip bg-slate-100 text-slate-600">'+logEsc(dg.model)+(dg.sn&&dg.sn!=='단말기'?' · S/N '+logEsc(dg.sn):'')+'</span></div>';
  if(!dg.findings.length){
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
  box.innerHTML=head+rows
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
  const faults=d.findings.map(function(f){ return {group:f.group, n:f.n, core:f.core, codes:f.codes.slice(0,5)}; });
  const row={ vehicle_no:vnum, terminal_sn:d.sn||'', model:d.model||'', analyzed_at:d.analyzedAt,
    primary_group: d.findings[0]?d.findings[0].group:'정상', error_type:err, action_type:act, notes:note,
    faults:faults, created_at:new Date().toISOString() };
  try{
    const r=await fetch(SB_URL+'/rest/v1/log_diagnoses',{method:'POST',headers:logSbHeaders({'Prefer':'return=minimal'}),body:JSON.stringify([row])});
    if(!r.ok){ const t=await r.text(); throw new Error('저장 실패 '+r.status+' '+t.slice(0,120)); }
    set('저장됐습니다. 이력에 누적됩니다.', true);
    loadLogHistory(vnum);
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
  if(typeof getAIKey!=='function' || !getAIKey()){ out.innerHTML='<span class="text-[12px] text-rose-600">AI 공용 키가 설정되지 않았습니다(관리자에게 등록 요청).</span>'; return; }
  out.innerHTML='<span class="text-[12px] text-slate-500">🤖 로그·이력·S/N 종합 분석 중…</span>';
  try{
    const d=window.__lastDiag||{};
    let ctx='[현재 로그 진단]\n차량 '+vnum+' / '+(d.model||'')+' S/N '+(d.sn||'')+' / 진단일 '+(d.analyzedAt||'')+'\n';
    if(d.findings&&d.findings.length){
      for(let i=0;i<d.findings.length;i++){ const f=d.findings[i]; const G=logGuide(f.group);
        ctx+='- '+G.t+' ('+f.n+'회/'+(f.core?'핵심':'주의')+'): '+f.codes.slice(0,4).map(function(c){return c[0]+'×'+c[1]+'('+((LOG_CODES[c[0]]||['',''])[0])+')';}).join(', ')+'\n'; }
    } else ctx+='- 통신 장애 신호 없음(정상 범위)\n';
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
      +'주요 근거(우선): ①현재 로그 진단 ②이 차량 과거 로그 이력 ③동일 단말기(S/N) 이력.\n'
      +(hasEv?'당일 이벤트가 제공되었으니 보조로 활용하세요.':'당일 이벤트는 제공되지 않았습니다 — 이벤트 관련 추정/언급은 하지 마세요.')+'\n'
      +'한국어로 짧고 명확하게:\n**종합 진단**(1~2문장)\n**재불량/수리 미흡 여부**(S/N·과거 이력 근거. 조치 후 같은 장애 재발 시 수리 미흡 의심 명시)\n**권장 조치**(구체 1~3개, 과거 효과없던 조치 지양)\n마지막 줄: ⚠ AI 추정 — 최종 판단은 기사님 확인 후';
    const res=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+AI_MODEL+':generateContent',{
      method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':getAIKey()},
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
/* logengine.js — end */
