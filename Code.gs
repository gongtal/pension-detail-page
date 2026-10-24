// 평생 연금 플랜 — 자문 신청 저장 + 방문 분석 + 카피 편집 API
// 배포: [배포 > 배포 관리 > 수정 > 새 버전] (실행: 나 / 액세스: 모든 사용자)
const TAB_NAME = '자문 신청';
const HEADERS = ['접수 일시', '이름', '휴대폰 번호', '나이', '목표 수령액', '개인정보 수집·이용 동의', '제3자 제공 동의', '유입 경로'];
const LOG_TAB = '방문 로그';
const LOG_HEADERS = ['시각', '세션', '방문자', '이벤트', '도달 섹션', '최대 스크롤(%)', '체류(초)', '버튼 클릭', '신청창 열기', '신청 완료', '유입', '기기'];
const COPY_TAB = '카피';

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'copy') return out_({ ok: true, copy: getCopy_() });
  return out_({ status: 'ready' });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 200000) return out_({ ok: false, error: 'invalid_request' });
    const d = JSON.parse(raw);
    switch (d.action) {
      case 'track': return track_(d);
      case 'setup': return setup_(d);
      case 'login': return auth_(d.key) ? out_({ ok: true }) : out_({ ok: false, error: 'unauthorized' });
      case 'stats': return auth_(d.key) ? out_({ ok: true, stats: stats_(d.days) }) : out_({ ok: false, error: 'unauthorized' });
      case 'saveCopy': return auth_(d.key) ? saveCopy_(d.copy) : out_({ ok: false, error: 'unauthorized' });
      default: return lead_(d);
    }
  } catch (err) {
    return out_({ ok: false, error: 'server_error' });
  }
}

/* ---------- 자문 신청 ---------- */
function lead_(d) {
  if (d.website) return out_({ ok: true });
  const name = clean_(d.name, 30);
  const phone = String(d.phone || '').replace(/[^0-9]/g, '');
  const age = parseInt(d.age, 10);
  const goal = clean_(d.goal, 30);
  if (!name || !/^01[016789][0-9]{7,8}$/.test(phone) || !(age >= 15 && age <= 100) || !goal ||
      d.agreePrivacy !== true || d.agreeThird !== true) {
    return out_({ ok: false, error: 'invalid_fields' });
  }
  const cache = CacheService.getScriptCache();
  if (cache.get('p' + phone)) return out_({ ok: true, duplicate: true });
  cache.put('p' + phone, '1', 300);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = tab_(TAB_NAME, HEADERS);
    const phoneFmt = phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    sheet.appendRow([now_(), name, "'" + phoneFmt, age, goal, '동의', '동의', clean_(d.source, 200)]);
  } finally {
    lock.releaseLock();
  }
  return out_({ ok: true });
}

/* ---------- 방문 기록 (개인정보 없음) ---------- */
function track_(d) {
  const sid = String(d.sid || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  const vid = String(d.vid || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  if (!sid) return out_({ ok: false });
  const ev = ['view', 'leave', 'cta', 'open', 'submit'].indexOf(d.ev) >= 0 ? d.ev : 'view';
  const num = function (v, max) { v = Number(v); return isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0; };
  tab_(LOG_TAB, LOG_HEADERS).appendRow([
    now_(), sid, vid, ev, num(d.depth, 50), num(d.scroll, 100), num(d.dur, 86400),
    num(d.cta, 999), d.open ? 1 : 0, d.submit ? 1 : 0, clean_(d.src, 120), clean_(d.dev, 10)
  ]);
  return out_({ ok: true });
}

function stats_(days) {
  days = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const sh = tab_(LOG_TAB, LOG_HEADERS);
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, LOG_HEADERS.length).getValues() : [];
  const since = Date.now() - days * 86400000;
  const S = {};
  rows.forEach(function (r) {
    const t = r[0] instanceof Date ? r[0] : new Date(String(r[0]).replace(' ', 'T') + '+09:00');
    if (!(t.getTime() >= since)) return;
    const sid = r[1]; if (!sid) return;
    const s = S[sid] || (S[sid] = { vid: r[2], t: t, depth: 0, scroll: 0, dur: 0, cta: 0, open: 0, submit: 0, src: '', dev: '' });
    if (t < s.t) s.t = t;
    s.depth = Math.max(s.depth, Number(r[4]) || 0);
    s.scroll = Math.max(s.scroll, Number(r[5]) || 0);
    s.dur = Math.max(s.dur, Number(r[6]) || 0);
    s.cta = Math.max(s.cta, Number(r[7]) || 0);
    s.open = Math.max(s.open, Number(r[8]) || 0);
    s.submit = Math.max(s.submit, Number(r[9]) || 0);
    if (r[10] && !s.src) s.src = String(r[10]);
    if (r[11] && !s.dev) s.dev = String(r[11]);
  });
  const list = Object.keys(S).map(function (k) { return S[k]; });
  const daily = {}, vis = {}, src = {}, dev = {}, depth = {};
  let bounce = 0, durSum = 0, ctaS = 0, openS = 0, subS = 0;
  list.forEach(function (s) {
    const day = Utilities.formatDate(s.t, 'Asia/Seoul', 'yyyy-MM-dd');
    daily[day] = daily[day] || { date: day, sessions: 0, visitors: {} };
    daily[day].sessions++; daily[day].visitors[s.vid] = 1; vis[s.vid] = 1;
    if (s.dur < 10 || s.depth <= 1) bounce++;
    durSum += s.dur; if (s.cta) ctaS++; if (s.open) openS++; if (s.submit) subS++;
    const so = s.src || '직접 방문'; src[so] = (src[so] || 0) + 1;
    const dv = s.dev || '알 수 없음'; dev[dv] = (dev[dv] || 0) + 1;
    depth[s.depth] = (depth[s.depth] || 0) + 1;
  });
  return {
    days: days,
    sessions: list.length,
    visitors: Object.keys(vis).length,
    bounceRate: list.length ? bounce / list.length : 0,
    avgDuration: list.length ? durSum / list.length : 0,
    ctaRate: list.length ? ctaS / list.length : 0,
    openRate: list.length ? openS / list.length : 0,
    submitRate: list.length ? subS / list.length : 0,
    submits: subS,
    daily: Object.keys(daily).sort().map(function (k) { return { date: k, sessions: daily[k].sessions, visitors: Object.keys(daily[k].visitors).length }; }),
    depth: depth,
    sources: src,
    devices: dev
  };
}

/* ---------- 관리자 비밀번호 ---------- */
function hash_(s) {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'pension-plan:' + String(s), Utilities.Charset.UTF_8);
  return b.map(function (x) { return ('0' + (x & 255).toString(16)).slice(-2); }).join('');
}
function setup_(d) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_HASH')) return out_({ ok: false, error: 'already_set' });
  const pw = String(d.key || '');
  if (pw.length < 8) return out_({ ok: false, error: 'too_short' });
  props.setProperty('ADMIN_HASH', hash_(pw));
  return out_({ ok: true });
}
function auth_(key) {
  const h = PropertiesService.getScriptProperties().getProperty('ADMIN_HASH');
  if (!h || !key) return false;
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('authfail') || 0);
  if (fails >= 20) return false; // 무차별 대입 방지 (10분)
  const ok = hash_(key) === h;
  if (!ok) cache.put('authfail', String(fails + 1), 600);
  return ok;
}

/* ---------- 카피 ---------- */
function getCopy_() {
  const cache = CacheService.getScriptCache();
  const c = cache.get('copy');
  if (c) return JSON.parse(c);
  const sh = tab_(COPY_TAB, ['키', '내용', '수정 시각']);
  const n = sh.getLastRow() - 1;
  const obj = {};
  if (n > 0) sh.getRange(2, 1, n, 2).getValues().forEach(function (r) { if (r[0]) obj[String(r[0])] = String(r[1]); });
  cache.put('copy', JSON.stringify(obj), 600);
  return obj;
}
function saveCopy_(copy) {
  if (!copy || typeof copy !== 'object') return out_({ ok: false, error: 'invalid' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = tab_(COPY_TAB, ['키', '내용', '수정 시각']);
    const n = sh.getLastRow() - 1;
    const keys = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]); }) : [];
    Object.keys(copy).slice(0, 300).forEach(function (k) {
      const key = String(k).replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
      if (!key) return;
      const val = String(copy[k] == null ? '' : copy[k]).slice(0, 2000);
      const i = keys.indexOf(key);
      if (val === '') { if (i >= 0) { sh.deleteRow(i + 2); keys.splice(i, 1); } return; }
      if (i >= 0) sh.getRange(i + 2, 2, 1, 2).setValues([["'" + val, now_()]]);
      else { sh.appendRow([key, "'" + val, now_()]); keys.push(key); }
    });
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('copy');
  return out_({ ok: true, copy: getCopy_() });
}

/* ---------- 공통 ---------- */
function tab_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#EEEFFE');
    sh.setFrozenRows(1);
  }
  return sh;
}
function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }
function clean_(v, max) {
  let s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
