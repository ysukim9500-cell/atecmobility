/* ═══════════════════════════════════════════════════════════════════════════
 *  하이패스 영수증 PDF → 운행 배분  (브라우저에서 전부 처리)
 *
 *  PDF 는 서버로 올리지 않는다. 브라우저가 직접 읽어 (일시·금액·영업소·카드뒷4자리)만
 *  뽑고, 이미 받아둔 운행 목록에 맞춘다. 반영은 사람이 확인한 것만 toll-apply 로 보낸다.
 *
 *  PDF 구조 (한국도로공사 영수증 출력물)
 *    · 한 페이지에 영수증이 4열 × N행 격자
 *    · 본문이 Flate 로 압축돼 있고, 글자는 CID(Type0) 라 ToUnicode 표를 풀어야 읽힌다
 *    · 글자 하나하나가 `1 0 0 1 x y Tm ... (코드)Tj` 로 따로 찍힌다
 *  ═════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── zlib inflate ──────────────────────────────────────────────────────────
   *  브라우저 기본 DecompressionStream 을 쓴다. 다만 이건 Node 의 zlib 과 달리
   *  **압축 데이터 뒤에 한 바이트라도 더 있으면 통째로 거부**한다.
   *  PDF 는 endstream 앞에 개행을 넣으므로 그대로 넣으면 전부 실패한다.
   *    ① 끝의 개행·공백을 떼고
   *    ② 그래도 잡동사니가 걸리면, 오류 전까지 받아낸 조각을 살려 쓴다
   *  ────────────────────────────────────────────────────────────────────────── */
  async function tryInflate(data, fmt) {
    try {
      var ds = new DecompressionStream(fmt);
      var rd = new Blob([data]).stream().pipeThrough(ds).getReader();
      var parts = [], total = 0;
      try {
        for (;;) {
          var r = await rd.read();
          if (r.done) break;
          parts.push(r.value); total += r.value.length;
        }
      } catch (e) { /* 뒤에 잡동사니 — 여기까지 받은 건 쓴다 */ }
      if (!total) return null;
      var out = new Uint8Array(total), off = 0;
      parts.forEach(function (p) { out.set(p, off); off += p.length; });
      return out;
    } catch (e) { return null; }
  }
  async function inflate(u8) {
    var e = u8.length;
    while (e > 0 && (u8[e - 1] === 10 || u8[e - 1] === 13 || u8[e - 1] === 32)) e--;
    var data = u8.subarray(0, e);
    var got = await tryInflate(data, 'deflate');
    if (got && got.length) return got;
    got = await tryInflate(data, 'deflate-raw');
    return (got && got.length) ? got : null;
  }

  function latin1(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH)
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return s;
  }

  /* ── PDF 문자열 리터럴의 이스케이프를 바이트로 되돌린다 ── */
  function unesc(t) {
    var out = [], map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (c !== '\\') { out.push(t.charCodeAt(i)); continue; }
      var n = t[++i];
      if (n in map) out.push(map[n]);
      else if (n >= '0' && n <= '7') {
        var o = n;
        while (o.length < 3 && t[i + 1] >= '0' && t[i + 1] <= '7') o += t[++i];
        out.push(parseInt(o, 8));
      } else out.push(t.charCodeAt(i));
    }
    return out;
  }

  /** PDF 바이트 → 영수증 레코드 배열 */
  async function parsePdf(buf) {
    var u8 = new Uint8Array(buf), s = latin1(u8);

    /* 1) 모든 스트림 풀기 */
    var streams = [], re = /stream\r?\n/g, m;
    while ((m = re.exec(s))) {
      var st = m.index + m[0].length;
      var end = s.indexOf('endstream', st); if (end < 0) continue;
      var out = await inflate(u8.subarray(st, end));
      if (out) streams.push(latin1(out));
    }
    if (!streams.length) throw new Error('PDF 안을 읽지 못했습니다. 하이패스에서 받은 원본 파일인지 확인해 주세요.');

    /* 2) ToUnicode 표 */
    var cmap = new Map();
    streams.forEach(function (t) {
      (t.match(/beginbfchar([\s\S]*?)endbfchar/g) || []).forEach(function (blk) {
        var p, r2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        while ((p = r2.exec(blk))) {
          var d = '';
          for (var i = 0; i < p[2].length; i += 4) d += String.fromCharCode(parseInt(p[2].substr(i, 4), 16));
          cmap.set(parseInt(p[1], 16), d);
        }
      });
      (t.match(/beginbfrange([\s\S]*?)endbfrange/g) || []).forEach(function (blk) {
        var p, r3 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        while ((p = r3.exec(blk))) {
          var a = parseInt(p[1], 16), b = parseInt(p[2], 16), c = parseInt(p[3], 16);
          for (var i = a; i <= b && i - a < 65536; i++) cmap.set(i, String.fromCharCode(c + (i - a)));
        }
      });
    });

    /* 3) 글자 + 좌표 */
    var pages = [];
    streams.forEach(function (t) {
      if (!/\bTj\b/.test(t)) return;
      var items = [], p, r4 = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm[\s\S]{0,400}?\((.*?)\)\s*Tj/g;
      while ((p = r4.exec(t))) {
        var by = unesc(p[3]), txt = '';
        for (var i = 0; i + 1 < by.length; i += 2) txt += cmap.get((by[i] << 8) | by[i + 1]) || '';
        items.push({ x: parseFloat(p[1]), y: parseFloat(p[2]), t: txt });
      }
      if (items.length) pages.push(items);
    });
    if (!pages.length) throw new Error('영수증 글자를 찾지 못했습니다.');

    /* 4) 4열 격자로 나눠 영수증 블록마다 필드 뽑기
     *    열 글자폭(≈117)이 열 간격(≈144)보다 좁다 → round 를 쓰면 0열 끝 글자가 1열로 넘어간다.
     *    floor + 여유값이 맞다. */
    var NCOL = 4, recs = [];
    pages.forEach(function (items, pi) {
      var xs = items.map(function (i) { return i.x; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
      var pitch = (maxX - minX) / (NCOL - 1 + 0.81);
      var cols = {};
      items.forEach(function (it) {
        var c = Math.min(NCOL - 1, Math.max(0, Math.floor((it.x - minX + 6) / pitch)));
        (cols[c] = cols[c] || []).push(it);
      });
      Object.keys(cols).forEach(function (c) {
        var arr = cols[c], lines = new Map();
        arr.forEach(function (it) {
          var k = Math.round(it.y * 2) / 2;
          if (!lines.has(k)) lines.set(k, []);
          lines.get(k).push(it);
        });
        var ys = Array.from(lines.keys()).sort(function (a, b) { return b - a; });
        var text = ys.map(function (y) {
          return { y: y, t: lines.get(y).sort(function (a, b) { return a.x - b.x; })
                          .map(function (i) { return i.t; }).join('') };
        });
        var starts = text.filter(function (l) { return l.t.replace(/\s/g, '') === '영수증'; })
                         .map(function (l) { return l.y; });
        starts.forEach(function (top, i) {
          var bot = i + 1 < starts.length ? starts[i + 1] : -1e9;
          var blk = text.filter(function (l) { return l.y <= top && l.y > bot; })
                        .map(function (l) { return l.t; });
          var j = blk.join('\n');
          var dt = j.match(/(\d{4})년(\d{2})월(\d{2})일(\d{2})시(\d{2})분/);
          if (!dt) return;
          var fee = j.match(/(\d)종([\d,]+)원/);
          var card = j.match(/\d{4}-\d{2}\*\*-\*\*\*\*-(\d{4})/);
          var entry = j.match(/입구영업소:(\S+)/);
          recs.push({
            page: pi + 1,
            at: Date.parse(dt[1] + '-' + dt[2] + '-' + dt[3] + 'T' + dt[4] + ':' + dt[5] + ':00+09:00'),
            atText: dt[1] + '-' + dt[2] + '-' + dt[3] + ' ' + dt[4] + ':' + dt[5],
            office: (blk[1] || '').trim(),
            entryOffice: entry ? entry[1] : null,
            carClass: fee ? +fee[1] : null,
            amount: fee ? +fee[2].replace(/,/g, '') : null,
            card4: card ? card[1] : null
          });
        });
      });
    });

    // 같은 영수증이 두 번 잡히는 일이 없도록 (시각+금액+영업소)로 중복 제거
    var seen = new Set();
    recs = recs.filter(function (r) {
      if (r.amount == null || !r.at) return false;
      var k = r.at + '|' + r.amount + '|' + r.office;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    recs.sort(function (a, b) { return a.at - b.at; });
    return recs;
  }

  /**
   * 영수증을 운행에 맞춘다.
   *  · 통과시각이 운행의 [출발, 도착] 안에 들어가면 그 운행의 통행료다.
   *  · 한 운행에 여러 번 지나갔으면 합산한다.
   *  · 카드 뒷4자리로 차량을 고를 수 없으니, 어느 차량이 가장 많이 맞는지 투표로 추정한다.
   */
  function match(recs, trips) {
    var byCard = {};
    recs.forEach(function (r) { (byCard[r.card4 || '?'] = byCard[r.card4 || '?'] || []).push(r); });

    var groups = Object.keys(byCard).map(function (c4) {
      var rs = byCard[c4], vote = {};
      rs.forEach(function (r) {
        trips.forEach(function (t) {
          if (t.end_time && t.start_time <= r.at && r.at <= t.end_time) {
            vote[t.plate_no] = (vote[t.plate_no] || 0) + 1;
          }
        });
      });
      var ranked = Object.keys(vote).sort(function (a, b) { return vote[b] - vote[a]; });
      return {
        card4: c4, records: rs,
        plate: ranked[0] || null,
        vote: ranked.map(function (p) { return { plate: p, n: vote[p] }; }),
        candidates: Array.from(new Set(trips.map(function (t) { return t.plate_no; }))).filter(Boolean).sort()
      };
    });

    groups.forEach(function (g) { assign(g, trips); });
    return groups;
  }

  /** 사람이 직접 정한 통행료인가. 서버의 보호 트리거(old_by_person)와 같은 기준을 쓴다. */
  var PERSON_SOURCES = ['미입력', 'legacy-client-compat', '하이패스 영수증', '웹 직접 입력'];
  function bySource(src) {
    var s = String(src || '');
    if (!s) return 'none';
    if (s.indexOf('기사 ') === 0 || s.indexOf('사용자 입력') === 0) return 'person';
    if (PERSON_SOURCES.indexOf(s) >= 0) return 'person';
    if (s === '자동계산 실패' || s === '영업소 요금표' || s === '요금소 미통과(실주행 GPS)') return 'machine';
    if (s.indexOf('카카오 길찾기') === 0) return 'machine';
    if (s === 'legacy migration') return 'person';   // 이관된 사람 입력값
    return 'unknown';
  }

  /** 그룹의 차량이 정해진 상태에서 실제 배분을 계산한다(차량을 바꾸면 다시 부른다). */
  function assign(g, trips) {
    var mine = g.plate ? trips.filter(function (t) { return t.plate_no === g.plate; }) : [];
    var per = new Map(), unmatched = [];
    g.records.forEach(function (r) {
      var hit = null;
      for (var i = 0; i < mine.length; i++) {
        var t = mine[i];
        // 통과시각이 [출발, 도착] 안이면 그 운행이다. 수기 입력 운행도 시각이 있으면 똑같이 잡힌다.
        if (t.end_time && t.start_time <= r.at && r.at <= t.end_time) { hit = t; break; }
      }
      if (!hit) { unmatched.push(r); return; }
      if (!per.has(hit.id)) per.set(hit.id, { trip: hit, lines: [], sum: 0 });
      var e = per.get(hit.id);
      e.lines.push(r); e.sum += r.amount;
    });

    g.matched = Array.from(per.values()).map(function (e) {
      var cur = e.trip.toll_cost;
      var st = e.trip.toll_status;
      var unset = st === 'UNKNOWN' || st === 'PENDING' || cur == null;
      var who = bySource(e.trip.toll_source);

      if (unset) {
        e.kind = 'new';                 // 미확정 → 확정. 잃을 게 없다.
        e.diff = null; e.pick = true;
      } else if (Number(cur) === e.sum) {
        e.kind = 'same';                // 값이 같다. 굳이 다시 쓸 필요가 없다.
        e.diff = 0; e.pick = false;
      } else if (who === 'person') {
        // ★ 사람이 직접 정한 값이다. 영수증이 더 정확하더라도 **기본으로 덮지 않는다** —
        //   관리자가 눈으로 보고 직접 고르게 한다.
        e.kind = 'diff-person';
        e.diff = e.sum - Number(cur); e.pick = false;
      } else {
        e.kind = 'diff';                // 자동계산과 다르다. 영수증이 실제 청구액이므로 기본 선택.
        e.diff = e.sum - Number(cur); e.pick = true;
      }
      e.who = who;
      return e;
    }).sort(function (a, b) { return a.trip.start_time - b.trip.start_time; });
    g.unmatched = unmatched;
    return g;
  }

  global.Hipass = { parsePdf: parsePdf, match: match, assign: assign, bySource: bySource };
})(window);
