-- ============================================================
--  로그 진단·처리 이력 누적 테이블 (재불량 추적용)
--  원본 로그는 저장 안 함 — "진단 결과 + 처리유형"만 작게 누적.
--  Supabase → SQL Editor 에 붙여넣고 Run.
-- ============================================================

create table if not exists public.log_diagnoses (
  id            bigint generated always as identity primary key,
  vehicle_no    text not null,          -- 차량번호 (예: 서울74사3021)
  terminal_sn   text,                   -- 단말기 일련번호 (예: 460001314)
  model         text,                   -- B700 / B710 / B800
  analyzed_at   date,                   -- 로그 진단 기준일
  primary_group text,                   -- 대표 장애 그룹 (승하차3통신 등)
  error_type    text,                   -- 선택한 오류유형
  action_type   text,                   -- 처리유형(무슨 조치를 했나)
  notes         text,                   -- 메모
  faults        jsonb,                  -- 진단 상세 [{group,n,core,codes}]
  created_at    timestamptz default now()
);

create index if not exists idx_logdiag_vehicle on public.log_diagnoses (vehicle_no);
create index if not exists idx_logdiag_created on public.log_diagnoses (created_at);

-- RLS: publishable(anon) 키로 읽기·쓰기 허용 (terminal.html이 그 키로 호출)
alter table public.log_diagnoses enable row level security;

drop policy if exists logdiag_select on public.log_diagnoses;
create policy logdiag_select on public.log_diagnoses for select using (true);

drop policy if exists logdiag_insert on public.log_diagnoses;
create policy logdiag_insert on public.log_diagnoses for insert with check (true);

-- 이력 수정(UPDATE) 허용 — terminal.html의 '수정' 기능용
drop policy if exists logdiag_update on public.log_diagnoses;
create policy logdiag_update on public.log_diagnoses for update using (true) with check (true);

-- 이력 삭제(DELETE) 허용 — anon 키로 호출. '관리자만'은 화면(앱)에서 통제(삭제 버튼은 관리자에게만 노출).
drop policy if exists logdiag_delete on public.log_diagnoses;
create policy logdiag_delete on public.log_diagnoses for delete using (true);

-- ============================================================
--  (선택) 30일 후 자동 삭제 — pg_cron 사용 시
--  Supabase Dashboard → Database → Extensions 에서 pg_cron 활성화 후 실행
-- ============================================================
-- select cron.schedule(
--   'logdiag_cleanup', '0 3 * * *',
--   $$ delete from public.log_diagnoses where created_at < now() - interval '30 days' $$
-- );
--
--  pg_cron 안 쓰면, 데이터가 워낙 작아(건당 수 KB) 그냥 둬도 됩니다.
--  수동 정리: delete from public.log_diagnoses where created_at < now() - interval '30 days';
