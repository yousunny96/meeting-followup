const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: opts.body instanceof FormData ? opts.body : opts.body && JSON.stringify(opts.body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '요청 실패');
  return data;
}

const kst = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

/* ---------- 화면 전환 ---------- */
function show(view) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'today') renderToday();
  if (view === 'board') renderBoard();
  if (view === 'history') renderHistory();
  if (view === 'policy') renderPolicy();
  if (view === 'teams') renderTeams();
  window.scrollTo(0, 0);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));

/* ---------- 메뉴 순서: 끌어서 바꾸고, 이 브라우저에 기억한다 ---------- */
const nav = $('nav');
const DEFAULT_NAV = $$('.tab', nav).map((b) => b.dataset.view);
const navVertical = () => getComputedStyle(nav).flexDirection === 'column';
function saveNavOrder() {
  const order = $$('.tab', nav).map((b) => b.dataset.view);
  const changed = order.join() !== DEFAULT_NAV.join();
  store.set('navOrder', changed ? JSON.stringify(order) : '');
  $('#nav-reset').hidden = !changed;
}
function applyNavOrder(order) {
  order.forEach((v) => { const b = $(`.tab[data-view="${v}"]`, nav); if (b) nav.appendChild(b); });
}
try { applyNavOrder(JSON.parse(store.get('navOrder') || '[]')); } catch {}
nav.insertAdjacentHTML('afterend', '<button type="button" id="nav-reset" class="nav-reset" hidden>메뉴 순서 되돌리기</button>');
$('#nav-reset').hidden = $$('.tab', nav).map((b) => b.dataset.view).join() === DEFAULT_NAV.join();
$('#nav-reset').addEventListener('click', () => { applyNavOrder(DEFAULT_NAV); saveNavOrder(); });
$$('.tab', nav).forEach((b) => {
  b.draggable = true;
  b.title = '끌어서 순서를 바꿀 수 있어요';
  b.addEventListener('dragstart', (e) => {
    b.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', b.dataset.view);
  });
  b.addEventListener('dragend', () => { b.classList.remove('dragging'); saveNavOrder(); });
});
nav.addEventListener('dragover', (e) => {
  const dragging = $('.tab.dragging', nav);
  if (!dragging) return;
  e.preventDefault();
  const vertical = navVertical();
  const before = $$('.tab:not(.dragging)', nav).find((x) => {
    const r = x.getBoundingClientRect();
    return vertical ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
  });
  if (before) nav.insertBefore(dragging, before);
  else nav.appendChild(dragging);
});
nav.addEventListener('drop', (e) => e.preventDefault());

let appStatus = {};
api('/api/status').then((s) => {
  appStatus = s;
  const el = $('#mode');
  if (s.mock) { el.textContent = '연습 모드 · AI 미호출'; el.className = 'badge warn'; }
  else if (!s.hasKey) { el.textContent = 'API 키 없음'; el.className = 'badge danger'; }
  else { el.textContent = `AI · ${s.model}`; el.className = 'badge'; }
  const nm = $('#notion-mode');
  nm.classList.remove('hidden');
  if (s.notion.enabled) { nm.textContent = '노션 연결됨'; nm.className = 'badge ok'; }
  else { nm.textContent = '노션 미연결'; nm.className = 'badge gray'; }
  if (!s.canTranscribe) {
    $('#btn-transcribe').disabled = true;
    $('#audio-box .hint').textContent =
      '녹음 변환은 OpenAI 키가 있을 때만 돼요. 지금은 클로바노트 등에서 뽑은 전사본을 붙여넣어 주세요.';
  }
});

/* ---------- 1. 입력 ---------- */
const form = $('#new-form');
form.meetingDate.value = today();
form.owner.value = store.get('owner') || '';
let source = 'file';

$$('#new-form .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    source = b.dataset.src;
    $$('#new-form .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#audio-box').classList.toggle('hidden', source !== 'audio');
    $('#file-box').classList.toggle('hidden', source !== 'file');
  })
);

/* 음성기록 .txt (클로바노트 형식) 읽기
   1행 제목 / 2행 "2026.06.30 화 오후 2:03 ・ 59분 15초" / 3행 기록자 /
   이후 "참석자 1 00:00" 같은 화자 줄 + 발언, 마지막 줄 "clovanote.naver.com" */
const SPEAKER_LINE = /^(.{1,30}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)$/;
function parseVoiceTxt(raw) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim());
  const head = nonEmpty.slice(0, 4);
  const dateLine = head.find((l) => /\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}/.test(l));
  let meetingDate = '';
  if (dateLine) {
    const [, y, m, d] = dateLine.match(/(\d{4})[.\-/]\s?(\d{1,2})[.\-/]\s?(\d{1,2})/);
    meetingDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const duration = dateLine?.match(/(\d+분(?:\s*\d+초)?|\d+시간(?:\s*\d+분)?)/)?.[1] || '';

  const segments = [];
  let cur = null;
  for (const line of lines) {
    const m = line.trim().match(SPEAKER_LINE);
    if (m) {
      cur = { speaker: m[1].trim(), time: m[2], text: [] };
      segments.push(cur);
    } else if (cur && line.trim() && !/^clovanote\.naver\.com$/i.test(line.trim())) {
      cur.text.push(line.trim());
    }
  }
  const title = dateLine && nonEmpty[0] !== dateLine ? nonEmpty[0].trim() : '';
  if (!segments.length) {
    // 화자 줄이 없는 일반 텍스트: 그대로 쓴다
    return { title, meetingDate, duration, attendees: [], transcript: raw.trim(), segments: 0, recognized: false };
  }
  const attendees = [...new Set(segments.map((g) => g.speaker))];
  const transcript = segments
    .filter((g) => g.text.length)
    .map((g) => `[${g.time}] ${g.speaker}: ${g.text.join(' ')}`)
    .join('\n');
  return { title, meetingDate, duration, attendees, transcript, segments: segments.length, recognized: true };
}

async function loadTxtFile(file) {
  const msg = $('#new-msg');
  if (!file) return;
  if (!/\.txt$/i.test(file.name) && file.type !== 'text/plain') {
    return setMsg(msg, '.txt 파일만 올릴 수 있어요.', 'err');
  }
  if (file.size > 2 * 1024 * 1024) return setMsg(msg, '2MB 이하 텍스트 파일만 올릴 수 있어요.', 'err');
  const r = parseVoiceTxt(await file.text());
  if (!r.transcript) return setMsg(msg, '파일에 내용이 없어요.', 'err');
  if (r.title) form.title.value = r.title;
  if (r.meetingDate) form.meetingDate.value = r.meetingDate;
  if (r.attendees.length) form.attendees.value = r.attendees.join(', ');
  form.transcript.value = r.transcript;
  suggestPrev();
  const info = $('#file-info');
  info.classList.remove('hidden');
  info.innerHTML = `<b>${esc(file.name)}</b> · ${r.recognized
    ? `발언 ${r.segments}개 · 화자 ${r.attendees.length}명${r.duration ? ' · ' + esc(r.duration) : ''}`
    : '화자 형식을 찾지 못해 텍스트를 그대로 불러왔어요'}`;
  setMsg(msg, r.recognized && r.attendees.every((a) => /^참석자\s*\d+$/.test(a))
    ? '불러왔어요. 화자가 "참석자 1, 2…"로만 표시돼 있으니 참석자 칸에 실제 이름과 역할을 적어 주면 담당자를 더 정확히 뽑아요.'
    : '불러왔어요. 제목·날짜·참석자를 확인하고 정리하세요.', 'ok');
}

$('#btn-pick-txt').addEventListener('click', () => $('#txt-file').click());
$('#txt-file').addEventListener('change', (e) => loadTxtFile(e.target.files[0]));
const drop = $('#file-box');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadTxtFile(e.dataTransfer.files[0]));

function setMsg(el, text, kind = '') { el.textContent = text; el.className = `msg ${kind}`; }

$('#btn-transcribe').addEventListener('click', async (e) => {
  const file = $('#audio').files[0];
  const msg = $('#new-msg');
  if (!file) return setMsg(msg, '녹음 파일을 먼저 골라 주세요.', 'err');
  const fd = new FormData();
  fd.append('audio', file);
  e.target.disabled = true;
  setMsg(msg, '녹음을 텍스트로 바꾸는 중이에요… (1분짜리 녹음 기준 10~20초)');
  try {
    const { transcript } = await api('/api/transcribe', { method: 'POST', body: fd });
    form.transcript.value = transcript;
    setMsg(msg, '변환했어요. 이름·숫자가 맞는지 확인하고 고친 뒤 정리하세요.', 'ok');
  } catch (err) { setMsg(msg, err.message, 'err'); }
  e.target.disabled = false;
});

/* 이전 회의 이어서: 승인된 회의 목록 + 제목·내용이 겹치면 자동 추천 */
let prevTouched = false;
let prevOptions = [];
const words = (s) => (String(s).match(/[가-힣A-Za-z0-9]{2,}/g) || []).map((w) => w.toLowerCase());
async function loadPrevOptions() {
  const ms = await api('/api/meetings');
  prevOptions = ms.filter((m) => m.versions.some((v) => v.status === '승인'));
  const sel = form.prevMeetingId;
  const cur = sel.value;
  sel.innerHTML = '<option value="">없음 (새 주제)</option>' + prevOptions.map((m) => `<option value="${m.id}">${esc(m.title)} · ${m.meetingDate}</option>`).join('');
  sel.value = cur;
}
function suggestPrev() {
  if (prevTouched || !prevOptions.length) return;
  const hay = (form.title.value + ' ' + form.transcript.value.slice(0, 4000)).toLowerCase();
  let best = null, bestScore = 0;
  for (const m of prevOptions) {
    const score = [...new Set(words(m.title))].filter((w) => hay.includes(w)).length;
    if (score > bestScore) { best = m; bestScore = score; }
  }
  form.prevMeetingId.value = best ? best.id : '';
  $('#prev-hint').textContent = best
    ? `제목·내용에 '${best.title}'와 겹치는 말이 있어서 이어지는 회의로 골랐어요. 아니면 '없음'으로 바꾸세요.`
    : '같은 주제의 지난 회의를 고르면, 그때 미결이던 항목이 이번에 결정됐는지 AI가 확인해요';
}
form.prevMeetingId.addEventListener('change', () => { prevTouched = true; });
form.title.addEventListener('input', suggestPrev);
loadPrevOptions();

$('#btn-sample').addEventListener('click', async () => {
  const text = await (await fetch('/samples/가상회의_전사본.txt')).text();
  form.title.value = '노바 정규 2집 예약판매·팬사인회 응모 킥오프';
  form.meetingDate.value = '2026-11-09';
  form.owner.value = form.owner.value || '박유선';
  form.attendees.value = '박유선(PM), 정하늘(MD), 이준호(백엔드), 최민지(프론트), 한서진(CS)';
  form.transcript.value = text;
  const info = $('#file-info');
  info.classList.remove('hidden');
  info.innerHTML = '<b>예시 회의</b> · 가상 자료';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#new-msg');
  const btn = form.querySelector('[type=submit]');
  store.set('owner', form.owner.value.trim());
  btn.disabled = true;
  setMsg(msg, 'AI가 회의를 정리하는 중이에요… (보통 10~30초)');
  try {
    const body = Object.fromEntries(new FormData(form));
    body.source = source;
    const { meetingId, version } = await api('/api/meetings', { method: 'POST', body });
    setMsg(msg, '');
    openReview(meetingId, version);
  } catch (err) { setMsg(msg, err.message, 'err'); }
  btn.disabled = false;
});

/* ---------- 기한 입력: 연도·월·일을 고른다 (연도 기본값은 올해) ---------- */
const THIS_YEAR = new Date().getFullYear();
function dueInputHtml(value, { name = 'due', cls = '', attrs = '' } = {}) {
  const [y, m, d] = value ? value.split('-').map(Number) : [THIS_YEAR, '', ''];
  const opts = (n, cur, unit) => `<option value="">${unit}</option>` +
    Array.from({ length: n }, (_, i) => i + 1).map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}${unit}</option>`).join('');
  const years = [...new Set([THIS_YEAR - 1, THIS_YEAR, THIS_YEAR + 1, THIS_YEAR + 2, y])].sort();
  return `<span class="md-input ${cls}" ${attrs}>
    <select data-md="y" aria-label="연도">${years.map((v) => `<option value="${v}" ${v === y ? 'selected' : ''}>${v}년</option>`).join('')}</select>
    <select data-md="m" aria-label="월">${opts(12, m, '월')}</select>
    <select data-md="d" aria-label="일">${opts(31, d, '일')}</select>
    <input type="hidden" name="${name}" value="${esc(value || '')}" />
  </span>`;
}
// 월·일을 고르면 숨은 값(YYYY-MM-DD)을 채우고 'duechange' 이벤트를 보낸다
document.addEventListener('change', (e) => {
  if (!e.target.matches('.md-input select')) return;
  const box = e.target.closest('.md-input');
  const y = Number($('[data-md=y]', box).value);
  const m = Number($('[data-md=m]', box).value);
  const daySel = $('[data-md=d]', box);
  if (m) {
    const last = new Date(y, m, 0).getDate();
    [...daySel.options].forEach((o) => { if (o.value) o.hidden = Number(o.value) > last; });
    if (Number(daySel.value) > last) daySel.value = String(last);
  }
  const d = Number(daySel.value);
  const value = m && d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
  $('input[type=hidden]', box).value = value;
  box.classList.toggle('due-missing', !value && box.classList.contains('was-missing'));
  if (value) box.dispatchEvent(new CustomEvent('duechange', { detail: value, bubbles: true }));
});

/* ---------- 2. 검토·승인 ---------- */
const SECTIONS = [
  { key: 'decisions', title: '결정사항', fields: [['content', '결정된 내용']], cls: '' },
  { key: 'my_tasks', title: '내 할 일', fields: [['task', '할 일'], ['due', '기한', 'date']], cls: 'c2', due: true },
  { key: 'dev_requests', title: '개발자 확인 요청', fields: [['team', '팀', 'team'], ['to', '대상'], ['question', '확인할 내용'], ['due', '기한', 'date']], cls: 'c4', due: true },
  { key: 'open_questions', title: '다시 물어볼 것', fields: [['team', '팀', 'team'], ['to_whom', '누구에게'], ['question', '질문'], ['why', '안 물으면 생길 문제']], cls: 'c4' },
  { key: 'bm.discussed', title: 'BM 논의', fields: [['topic', '주제'], ['current_state', '현재 상태'], ['numbers_to_check', '확인할 숫자']], cls: 'c3' },
  {
    key: 'bm.hypotheses', title: 'BM 가설 (AI 제안 · 채택할 것만 체크)', adopt: true,
    fields: [['name', '가설 이름'], ['revenue_logic', '수익 구조'], ['key_assumption', '핵심 가정'], ['metric', '검증 지표'], ['risk', '위험']], cls: 'c-bm',
  },
];
const pick = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);

function itemHtml(sec, it, checked) {
  const inputs = sec.fields
    .map(([name, label, type]) => {
      const val = it[name] ?? '';
      const missing = sec.due && name === 'due' && !val;
      const ph = missing ? `미정: ${it.due_text || '기한 언급 없음'}` : '';
      if (type === 'team') {
        const cur = val || guessTeam(it.to || it.to_whom || '');
        return `<div><div class="mini">${label}</div><select name="team">${AI_TEAMS.map((t) => `<option ${t === cur ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
      }
      if (type === 'date') {
        return `<div><div class="mini">${label}${missing ? ' · 확인 필요' : ''}</div>
          ${dueInputHtml(val, { name, cls: missing ? 'due-missing was-missing' : '', attrs: `title="${esc(ph)}"` })}</div>`;
      }
      return `<div><div class="mini">${label}${missing ? ' · 확인 필요' : ''}</div>
        <input name="${name}" value="${esc(val)}" title="${esc(ph)}" /></div>`;
    })
    .join('');
  const keep = sec.due ? `<input type="hidden" name="due_text" value="${esc(it.due_text || '')}" />` : '';
  const ev = it.evidence ? `<div class="evidence">근거: “${esc(it.evidence)}”</div>` : '';
  const hint = sec.due && !it.due && it.due_text ? `<div class="evidence">AI가 날짜를 확정하지 못했어요 (원문: ${esc(it.due_text)}). 직접 정하거나 비워 두세요.</div>` : '';
  return `<div class="item ${checked ? '' : 'off'}">
    <input type="checkbox" ${checked ? 'checked' : ''} title="포함" />
    <div class="fields ${sec.cls}">${inputs}${keep}</div>${ev}${hint}
    ${it.evidence !== undefined ? `<input type="hidden" name="evidence" value="${esc(it.evidence)}" />` : ''}
  </div>`;
}

async function openReview(meetingId, versionNo) {
  const m = await api(`/api/meetings/${meetingId}`);
  const v = m.versions.find((x) => x.version === versionNo);
  const data = v.status === '검토 대기' ? v.draft : v.final;
  const readonly = v.status !== '검토 대기';
  const el = $('#view-review');

  el.innerHTML = `
    <div class="review-head">
      <div class="grow">
        <h1>${esc(m.title)}</h1>
        <p class="lead">${esc(m.id)} · v${v.version} · ${esc(m.meetingDate)} · ${esc(m.attendees.join(', '))}</p>
      </div>
      <span class="badge ${readonly ? 'ok' : 'warn'}">${esc(v.status)}</span>
    </div>
    ${readonly ? `<div class="notice">이 버전은 ${esc(v.approvedBy || '')} 님이 승인했어요. 수정하려면 이력에서 재분석해 새 버전을 만드세요.</div>`
      : `<div class="notice warn"><b>AI 초안이에요.</b> 근거 문장과 대조해 고치고, 뺄 항목은 체크를 끄세요. 기한이 주황색인 칸은 AI가 날짜를 확정하지 못한 곳이에요.</div>`}
    <details class="transcript"><summary>전사본 원문 보기</summary><pre>${esc(m.transcript)}</pre></details>
    ${await followupHtml(m, data, readonly)}
    <h2>요약</h2>
    <textarea id="f-summary" rows="3">${esc(data.summary)}</textarea>
    ${SECTIONS.map((sec) => {
      const list = pick(data, sec.key) || [];
      return `<h2>${sec.title} <span class="count">${list.length}건</span></h2>
        <div class="items" data-sec="${sec.key}">
          ${list.map((it) => itemHtml(sec, it, readonly || !sec.adopt)).join('') || '<div class="empty">없음</div>'}
        </div>
        ${readonly ? '' : `<button type="button" class="btn ghost small add" data-add="${sec.key}">+ 직접 추가</button>`}`;
    }).join('')}
    ${readonly ? '' : `
      <div class="approve-bar row">
        <span>승인자</span><input id="approver" value="${esc(m.owner)}" />
        <span class="grow hint">승인하면 Markdown 정리본이 저장되고 할 일 보드에 쌓여요.</span>
        <button class="btn primary" id="btn-approve">검토 완료 · 승인</button>
      </div>
      <p id="review-msg" class="msg"></p>`}
  `;
  if (readonly) $$('input, textarea, select', el).forEach((i) => (i.disabled = true));

  el.addEventListener('change', (e) => {
    if (e.target.matches('.item > input[type=checkbox]')) e.target.parentElement.classList.toggle('off', !e.target.checked);
    if (e.target.matches('.fu-toggle input')) {
      const row = e.target.closest('.fu-item');
      row.classList.toggle('on', e.target.checked);
      if (e.target.checked) $('input[name=fu-answer]', row).focus();
    }
  });
  $$('[data-add]', el).forEach((b) =>
    b.addEventListener('click', () => {
      const sec = SECTIONS.find((s) => s.key === b.dataset.add);
      const box = $(`[data-sec="${sec.key}"]`, el);
      $('.empty', box)?.remove();
      box.insertAdjacentHTML('beforeend', itemHtml(sec, { evidence: 'PM 직접 추가', due_text: '' }, true));
    })
  );
  $('#btn-approve', el)?.addEventListener('click', async (e) => {
    const msg = $('#review-msg');
    const final = collect(el);
    e.target.disabled = true;
    try {
      const r = await api(`/api/meetings/${m.id}/versions/${v.version}/approve`, {
        method: 'POST',
        body: { final, approvedBy: $('#approver').value },
      });
      const n = r.notion || {};
      const closedText = r.closed?.length ? ` 이전 회의 항목 ${r.closed.length}건을 닫았어요.` : '';
      if (n.skipped) setMsg(msg, `승인했어요. 정리본 저장: ${r.mdPath}.${closedText}`, 'ok');
      else if (n.ok) setMsg(msg, `승인했어요. 노션 회의록과 할 일 카드 ${n.cards}개를 만들었어요.${closedText}`, 'ok');
      else setMsg(msg, `승인은 됐지만 노션 전송에 실패했어요: ${n.errors.join(' / ')}. 회의 이력에서 다시 보낼 수 있어요.`, 'err');
      setTimeout(() => show('board'), n.ok || n.skipped ? 1200 : 4000);
    } catch (err) { setMsg(msg, err.message, 'err'); e.target.disabled = false; }
  });

  $$('.view').forEach((x) => x.classList.add('hidden'));
  el.classList.remove('hidden');
  $$('.tab').forEach((t) => t.classList.remove('active'));
  window.scrollTo(0, 0);
}

function collect(el) {
  const final = { summary: $('#f-summary', el).value.trim(), bm: {} };
  const fus = $$('[data-fu]', el);
  if (fus.length) {
    final.followups = fus.map((row) => ({
      task_id: row.dataset.fu,
      outcome: $('input[type=checkbox]', row).checked ? 'resolved' : 'still_open',
      item: row.dataset.item,
      answer: $('input[name=fu-answer]', row).value.trim(),
      evidence: row.dataset.evidence || '',
      apply: $('input[type=checkbox]', row).checked,
    }));
  }
  for (const sec of SECTIONS) {
    const items = $$(`[data-sec="${sec.key}"] .item`, el)
      .filter((it) => $('input[type=checkbox]', it).checked)
      .map((it) => {
        const o = {};
        $$('input[name], select[name]', it).forEach((i) => (o[i.name] = i.value.trim()));
        if (sec.due) o.due = o.due || null;
        return o;
      })
      .filter((o) => sec.fields.some(([n]) => n !== 'due' && o[n]));
    const [a, b] = sec.key.split('.');
    if (b) final[a][b] = items; else final[a] = items;
  }
  return final;
}

/* ---------- 이전 회의에서 이어진 항목 ---------- */
// 항목마다 '결정됨' 토글 하나. 켜면 "어떻게 결정됐나요?" 칸이 열리고, 끄면 미결로 그대로 둔다.
async function followupHtml(m, data, readonly) {
  const fus = data.followups || [];
  if (!m.prevMeetingId && !fus.length) return '';
  const prev = (await api('/api/meetings')).find((x) => x.id === m.prevMeetingId);
  const tasks = Object.fromEntries((await api('/api/tasks')).map((t) => [t.id, t]));
  const rows = fus.map((f) => {
    const t = tasks[f.task_id] || {};
    const label = f.item || t.title || f.task_id;
    const aiResolved = f.outcome === 'resolved';
    const already = !readonly && t.status && t.status !== '할 일';
    const on = readonly ? f.apply : aiResolved && !already;
    const meta = [t.type, t.to, already ? `이미 ${t.status}` : ''].filter(Boolean).map(esc).join(' · ');
    return `<div class="fu-item ${on ? 'on' : ''}" data-fu="${esc(f.task_id)}" data-outcome="${f.outcome}" data-item="${esc(label)}" data-evidence="${esc(f.evidence)}">
      <label class="fu-toggle" title="켜면 승인할 때 지난 회의의 이 항목이 완료돼요">
        <input type="checkbox" ${on ? 'checked' : ''} ${readonly || already ? 'disabled' : ''} /><span>결정됨</span>
      </label>
      <div class="fu-body">
        <div class="fu-title">${esc(label)}</div>
        ${meta ? `<div class="fu-meta">${meta}</div>` : ''}
        <div class="fu-decision">
          <div class="mini">어떻게 결정됐나요?</div>
          <input name="fu-answer" value="${aiResolved ? esc(f.answer) : ''}" placeholder="결정된 내용을 한 줄로 적어 주세요" ${readonly ? 'disabled' : ''} />
          ${aiResolved && f.evidence ? `<div class="evidence">근거: “${esc(f.evidence)}”</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  const nOn = fus.filter((f) => (readonly ? f.apply : f.outcome === 'resolved')).length;
  return `<h2>지난 회의에서 이어진 항목 <span class="count">${prev ? esc(prev.title) + ' · ' + prev.meetingDate + ' · ' : ''}결정됨 ${nOn} · 미결 ${fus.length - nOn}</span></h2>
    ${readonly ? '' : `<div class="notice">지난 회의에서 미결이던 항목 중 이번 회의에서 다뤄진 것들이에요. AI가 결정됐다고 본 항목은 <b>결정됨</b>이 켜져 있어요.
      승인하면 결정됨 항목은 지난 회의 할 일에서 <b>완료</b>로 바뀌고, 적은 결정 내용이 함께 기록돼요. 꺼 둔 항목은 미결로 그대로 남아요.</div>`}
    <div class="items fu-list">${rows || '<div class="empty">이번 회의에서 다뤄진 지난 항목이 없어요.</div>'}</div>`;
}

/* ---------- 3. 할 일 보드 (상태별 칸반) ---------- */
$('#show-done').addEventListener('change', renderBoard);

function dday(due) {
  if (!due) return '<span class="badge warn">기한 미정</span>';
  const diff = Math.round((new Date(due) - new Date(today())) / 86400000);
  const cls = diff < 0 ? 'late' : diff <= 2 ? 'soon' : '';
  const label = diff === 0 ? 'D-day' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  return `<span class="dday ${cls}">${label}</span> <span class="hint">${due}</span>`;
}

const ICON = {
  doc: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5M9 13h6M9 17h6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  chevron: '<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  link: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// "이준호(백엔드)" → 아바타 '이' + 이름 + 역할
function person(raw) {
  if (!raw) return '';
  const m = String(raw).match(/^\s*([^()]+?)\s*(?:\(([^)]*)\))?\s*$/);
  const name = (m?.[1] || raw).trim();
  const role = m?.[2] || '';
  return `<span class="person" title="${esc(raw)}"><span class="avatar">${esc(name.slice(0, 1))}</span>${esc(name)}${role ? `<span class="role">${esc(role)}</span>` : ''}</span>`;
}

const TYPE_TAG = { '내 할 일': 'blue', '개발자 확인 요청': 'orange', '다시 물어볼 것': 'gray' };
const COLUMNS = [
  { key: 'todo', title: '할 일', color: 'gray', match: (t) => t.status === '할 일' && t.type === '내 할 일' },
  { key: 'wait', title: '답변 대기', color: 'orange', match: (t) => t.status === '할 일' && t.type !== '내 할 일' },
  { key: 'done', title: '완료', color: 'blue', match: (t) => ['완료', '답변 받음'].includes(t.status) },
  { key: 'old', title: '대체됨', color: 'gray', match: (t) => t.status === '대체됨', optional: true },
];

function kanbanCard(t, col) {
  const who = t.type === '내 할 일' ? store.get('owner') : t.to;
  const action =
    col.key === 'todo' ? `<button class="btn ghost small" data-move="${t.id}" data-to="완료">완료</button>`
    : col.key === 'wait' ? `<button class="btn ghost small" data-move="${t.id}" data-to="답변 받음">답변 받음</button>`
    : col.key === 'done' ? `<button class="btn ghost small" data-move="${t.id}" data-to="할 일">되돌리기</button>` : '';
  const notionLink = t.notion?.url && !t.notion.trashed
    ? `<a class="icon-link" href="${esc(t.notion.url)}" target="_blank" title="노션 카드 열기">${ICON.link}</a>` : '';
  return `<div class="kcard ${col.key === 'old' ? 'muted' : ''}">
    <div class="kcard-title">${esc(t.title)}</div>
    <div class="kcard-meta">
      <span class="tag ${TYPE_TAG[t.type]}">${t.type}</span>
      ${who ? person(who) : ''}
    </div>
    <div class="kcard-foot">
      <span>${col.key === 'done' || col.key === 'old' ? `<span class="hint">${t.status}</span>` : dday(t.due)}</span>
      <span class="row">${notionLink}${action}</span>
    </div>
    ${t.answer && col.key === 'done' ? `<div class="answer-text"><b>${t.type === '내 할 일' ? '결과' : '답변'}</b>${esc(t.answer)}</div>` : ''}
    <a class="kcard-src" href="#" data-open="${t.meetingId}|${t.version}">${ICON.doc}${esc(t.meetingTitle)} · v${t.version}</a>
  </div>`;
}

async function renderBoard() {
  const all = await api('/api/tasks');
  const showOld = $('#show-done').checked;
  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
  const byRecent = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
  if (all.length === 0) {
    $('#board').innerHTML = '<div class="empty">아직 승인한 회의가 없어요. 새 회의를 정리하고 승인해 보세요.</div>';
    return;
  }
  $('#board').innerHTML = `<div class="kanban">${COLUMNS.filter((c) => !c.optional || showOld)
    .map((col) => {
      const cards = all.filter(col.match).sort(col.key === 'done' || col.key === 'old' ? byRecent : byDue);
      return `<section class="kcol ${col.color}">
        <header class="kcol-head"><span class="status-tag ${col.color}"><i></i>${col.title}</span><span class="kcol-count">${cards.length}</span></header>
        ${cards.map((t) => kanbanCard(t, col)).join('') || '<div class="kcol-empty">없음</div>'}
      </section>`;
    }).join('')}</div>`;
  $$('[data-move]', $('#board')).forEach((b) =>
    b.addEventListener('click', async () => {
      if (b.dataset.to === '할 일') {
        b.disabled = true;
        await resolveTask(b.dataset.move, '할 일');
        return renderBoard();
      }
      const card = b.closest('.kcard');
      if (card.querySelector('.answer-editor')) return;
      card.insertAdjacentHTML('beforeend', answerEditorHtml(b.dataset.to));
      bindAnswerEditor(card.querySelector('.answer-editor'), b.dataset.move, b.dataset.to, renderBoard, () => card.querySelector('.answer-editor').remove());
    })
  );
  bindOpen($('#board'));
}

function bindOpen(root) {
  $$('[data-open]', root).forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const [id, v] = a.dataset.open.split('|');
      openReview(id, Number(v));
    })
  );
}

/* ---------- 4. 이력 (회의록 표) ---------- */
let historyYear = null;
const STATUS_TAG = { '승인': 'green', '검토 대기': 'orange', '대체됨': 'gray' };

async function renderHistory() {
  const [meetings, tasks] = await Promise.all([api('/api/meetings'), api('/api/tasks')]);
  const box = $('#history');
  if (!meetings.length) { box.innerHTML = '<div class="empty">아직 정리한 회의가 없어요.</div>'; return; }

  const years = [...new Set(meetings.map((m) => m.meetingDate.slice(0, 4)))].sort().reverse();
  if (!years.includes(historyYear)) historyYear = years[0];
  const rows = meetings
    .filter((m) => m.meetingDate.startsWith(historyYear))
    .sort((a, b) => b.meetingDate.localeCompare(a.meetingDate) || b.id.localeCompare(a.id));

  const rowHtml = (m) => {
    const latest = m.versions[m.versions.length - 1];
    const approved = [...m.versions].reverse().find((v) => v.status === '승인');
    const mine = tasks.filter((t) => t.meetingId === m.id && t.status !== '대체됨');
    const open = mine.filter((t) => t.status === '할 일').length;
    const people = m.attendees.slice(0, 3).map(person).join('') + (m.attendees.length > 3 ? `<span class="hint">+${m.attendees.length - 3}</span>` : '');
    return `<tr class="mrow">
      <td class="name-cell">
        <button class="expand" data-expand="${m.id}" title="버전·기록 펼치기">${ICON.chevron}</button>
        <a href="#" class="doc-title" data-open="${m.id}|${latest.version}">${ICON.doc}<span>${esc(m.title)}</span></a>
      </td>
      <td class="nowrap">${esc(m.meetingDate.replaceAll('-', '/'))}</td>
      <td><div class="people">${people || '<span class="hint">-</span>'}</div></td>
      <td><span class="tag ${STATUS_TAG[latest.status] || 'gray'}">${latest.status}</span> <span class="hint">v${latest.version}</span></td>
      <td class="nowrap">${mine.length ? `<b>${open}</b><span class="hint"> / ${mine.length} 남음</span>` : '<span class="hint">-</span>'}</td>
      <td class="links">
        ${approved?.mdPath ? `<a class="icon-link" href="/${approved.mdPath}" target="_blank" title="정리본(.md)">${ICON.doc}</a>` : ''}
        ${approved?.notion?.url ? `<a class="icon-link" href="${esc(approved.notion.url)}" target="_blank" title="노션 회의록">${ICON.link}</a>` : ''}
      </td>
    </tr>
    <tr class="detail hidden" id="detail-${m.id}"><td colspan="6">
      <ul class="versions">
        ${m.versions.map((v) => `<li>
          <b>v${v.version}</b>
          <span class="tag ${STATUS_TAG[v.status] || 'gray'}">${v.status}</span>
          <span class="hint">${kst(v.createdAt)} · ${esc(v.model)}${v.reason ? ' · ' + esc(v.reason) : ''}</span>
          <a href="#" data-open="${m.id}|${v.version}">${v.status === '검토 대기' ? '검토하기' : '보기'}</a>
          ${v.mdPath ? `<a href="/${v.mdPath}" target="_blank">정리본(.md)</a>` : ''}
          ${v.notion?.url ? `<a href="${esc(v.notion.url)}" target="_blank">노션 회의록</a>` : ''}
          ${v.status === '승인' && !v.notion?.url ? `<button class="btn ghost small" data-notion="${m.id}|${v.version}">노션으로 보내기</button>${v.notion?.error ? `<span class="hint" style="color:var(--danger)">${esc(v.notion.error)}</span>` : ''}` : ''}
        </li>`).join('')}
      </ul>
      <div class="row" style="margin-top:10px">
        <span class="hint">${esc(m.id)} · 입력: ${esc(m.source)}</span>
        <span class="grow"></span>
        <button class="btn ghost small" data-re="${m.id}">재분석 (새 버전 만들기)</button>
        <button class="btn ghost small" data-log="${m.id}">변경 기록 보기</button>
        <button class="btn ghost small danger" data-del="${m.id}">회의 삭제</button>
      </div>
      <ul class="log hidden" id="log-${m.id}"></ul>
    </td></tr>`;
  };

  box.innerHTML = `
    <div class="seg year-tabs">${years.map((y) => `<button type="button" class="seg-btn ${y === historyYear ? 'active' : ''}" data-year="${y}">${y}</button>`).join('')}</div>
    <div class="table-wrap"><table class="db-table">
      <thead><tr><th>이름</th><th style="width:110px">날짜</th><th style="width:240px">참석자</th><th style="width:130px">상태</th><th style="width:96px">후속 항목</th><th style="width:72px">자료</th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody>
    </table></div>`;

  $$('[data-year]', box).forEach((b) => b.addEventListener('click', () => { historyYear = b.dataset.year; renderHistory(); }));
  $$('[data-expand]', box).forEach((b) =>
    b.addEventListener('click', () => {
      const open = $(`#detail-${b.dataset.expand}`).classList.toggle('hidden') === false;
      b.classList.toggle('open', open);
    })
  );
  bindOpen(box);
  $$('[data-notion]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const [id, v] = b.dataset.notion.split('|');
      b.disabled = true; b.textContent = '노션에 보내는 중…';
      try {
        const r = await api(`/api/meetings/${id}/versions/${v}/notion`, { method: 'POST', body: {} });
        if (r.skipped) alert('노션이 연결되지 않았어요. .env에 NOTION_TOKEN을 넣고 서버를 다시 켜 주세요.');
        else if (!r.ok) alert(`노션 전송 실패: ${(r.errors || []).join(' / ')}`);
      } catch (err) { alert(err.message); }
      renderHistory();
    })
  );
  $$('[data-re]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'AI 정리 중…';
      try {
        const r = await api(`/api/meetings/${b.dataset.re}/reanalyze`, { method: 'POST', body: { reason: '재분석' } });
        openReview(r.meetingId, r.version);
      } catch (err) { alert(err.message); b.disabled = false; }
    })
  );
  $$('[data-del]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const m = meetings.find((x) => x.id === b.dataset.del);
      const hasNotion = m?.versions.some((v) => v.notion?.pageId);
      const msg = `'${m?.title || b.dataset.del}' 회의를 삭제할까요?\n\n` +
        '- 이 회의와 여기서 나온 할 일·확인 요청이 앱에서 모두 지워져요. 되돌릴 수 없어요.\n' +
        (hasNotion ? '- 노션 회의록과 캘린더 카드는 휴지통으로 가요 (노션 휴지통에서 되살릴 수 있어요).\n' : '') +
        '- 변경 기록에는 삭제했다는 사실만 남아요.';
      if (!confirm(msg)) return;
      b.disabled = true; b.textContent = '삭제하는 중…';
      try {
        const r = await api(`/api/meetings/${b.dataset.del}`, { method: 'DELETE', body: { by: store.get('owner') } });
        if (r.notionErrors?.length) alert(`앱에서는 지웠지만 노션 일부를 휴지통으로 못 보냈어요: ${r.notionErrors.join(' / ')}`);
      } catch (err) { alert(err.message); }
      renderHistory();
    })
  );
  $$('[data-log]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const ul = $(`#log-${b.dataset.log}`);
      const m = await api(`/api/meetings/${b.dataset.log}`);
      ul.innerHTML = m.history.map((h) => `<li>${kst(h.at)} · <b>${esc(h.event)}</b>
        ${h.version ? ' v' + h.version : ''}${h.approvedBy ? ' · ' + esc(h.approvedBy) : ''}${h.taskId ? ` · ${esc(h.taskId)} ${esc(h.from)}→${esc(h.to)}` : ''}${h.url ? ` · <a href="${esc(h.url)}" target="_blank">노션</a>` : ''}</li>`).join('');
      ul.classList.toggle('hidden');
    })
  );
}

/* ---------- 0. 오늘 (표 보기) ---------- */
// 담당 구분: 팀 목록은 팀·구성원 명단(노션 또는 로컬)에서 온다.
// AI가 정한 팀이 없으면(예전 데이터) 명단의 이름·별칭 → 글자 규칙 순으로 추정한다.
const BUILTIN_TEAMS = [
  { name: '내 할 일', color: 'blue' },
  { name: '프론트', color: 'purple', re: /프론트|FE|퍼블|화면 개발|웹 개발|iOS|안드로이드|앱 개발/i },
  { name: '백엔드', color: 'brown', re: /백엔드|BE|서버|API|DB|개발팀|개발/i },
  { name: '디자이너', color: 'pink', re: /디자인|디자이너|UX|UI/i },
  { name: '운영팀', color: 'green', re: /운영|CS|고객센터|주문관리|물류|정산|재무|FAS/i },
  { name: '마케팅팀', color: 'orange', re: /마케팅|프로모션|광고|CRM|콘텐츠/i },
  { name: '사업·MD', color: 'cobalt', re: /사업|MD|기획사|영업|파트너|데이터/i },
  { name: '기타', color: 'gray' },
];
let DIRECTORY = { origin: 'local', teams: [], members: [] };
let TEAMS = BUILTIN_TEAMS;
let AI_TEAMS = BUILTIN_TEAMS.slice(1).map((t) => t.name);
function rebuildTeams() {
  if (!DIRECTORY.teams.length) return;
  const custom = DIRECTORY.teams.filter((t) => !['미정', '기타'].includes(t.name)).map((t) => ({
    name: t.name, color: t.color, re: BUILTIN_TEAMS.find((b) => b.name === t.name)?.re,
  }));
  TEAMS = [BUILTIN_TEAMS[0], ...custom, { name: '기타', color: 'gray' }];
  AI_TEAMS = TEAMS.slice(1).map((t) => t.name);
}
async function loadDirectory() {
  try { DIRECTORY = await api('/api/teams'); rebuildTeams(); } catch (e) { console.warn('팀 명단을 못 읽었어요', e); }
}
function teamOf(t) {
  if (t.type === '내 할 일') return TEAMS[0];
  const name = t.team && t.team !== '기타' ? t.team : guessTeam(t.to || '');
  return TEAMS.find((x) => x.name === name) || TEAMS[TEAMS.length - 1];
}
function guessTeam(to) {
  const hit = DIRECTORY.members.find((m) => m.team !== '미정' &&
    [m.name, ...(m.aliases || '').split(',')].map((s) => s.trim().replace(/\s*님$/, '')).filter(Boolean).some((a) => to.includes(a)));
  if (hit) return hit.team;
  return (TEAMS.slice(1, -1).find((x) => x.re?.test(to)) || { name: '기타' }).name;
}
const daysLeft = (due) => Math.round((new Date(due) - new Date(today())) / 86400000);
const STATUS_OPTIONS = (t) =>
  t.type === '내 할 일' ? [['할 일', '진행 전'], ['완료', '완료']] : [['할 일', '답변 대기'], ['답변 받음', '답변 받음']];

let todayFilter = '전체';
let showLater = false;

function dueCell(t) {
  if (t.due) {
    const d = daysLeft(t.due);
    const cls = d < 0 ? 'late' : d <= 2 ? 'soon' : '';
    const label = d === 0 ? 'D-day' : d > 0 ? `D-${d}` : `D+${-d}`;
    return `<span class="dday ${cls}">${label}</span><div class="hint">${t.due.slice(5).replace('-', '/')} (${'일월화수목금토'[new Date(t.due).getDay()]})</div>`;
  }
  return `${dueInputHtml('', { cls: 'compact', attrs: `data-due="${t.id}" title="기한 정하기"` })}
    <div class="hint">${esc(t.dueText && t.dueText !== '기한 언급 없음' ? t.dueText : '기한 미정')}</div>`;
}

function todoTableRow(t) {
  const team = teamOf(t);
  const opts = STATUS_OPTIONS(t);
  return `<tr>
    <td class="col-due">${dueCell(t)}</td>
    <td class="col-team">
      <select class="team-select tag ${team.color}" data-team="${t.id}" title="구분 바꾸기">${TEAMS.map((x) => `<option ${x.name === team.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      ${t.type !== '내 할 일' && t.to ? `<div class="hint who">${esc(t.to)}</div>` : ''}
    </td>
    <td class="col-what">
      <div class="what-text">${t.type === '다시 물어볼 것' ? '<span class="q-mark">질문</span>' : ''}${esc(t.title)}</div>
      <a class="src" href="#" data-open="${t.meetingId}|${t.version}">${esc(t.meetingTitle)}</a>
    </td>
    <td class="col-status">
      <select class="status-select" data-status="${t.id}">
        ${opts.map(([v, l]) => `<option value="${v}" ${v === t.status ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </td>
  </tr>`;
}

async function renderToday() {
  const d = new Date();
  $('#today-title').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]}) 오늘 챙길 것`;
  const allTasks = await api('/api/tasks');
  const open = allTasks.filter((t) => t.status === '할 일');
  const weekAgo = Date.now() - 7 * 86400000;
  const recent = allTasks
    .filter((t) => ['완료', '답변 받음'].includes(t.status) && new Date(t.resolvedAt || t.updatedAt).getTime() > weekAgo)
    .sort((a, b) => (b.resolvedAt || b.updatedAt).localeCompare(a.resolvedAt || a.updatedAt));

  // 팀 필터
  const counts = Object.fromEntries(TEAMS.map((x) => [x.name, 0]));
  open.forEach((t) => counts[teamOf(t).name]++);
  $('#today-filters').innerHTML = [['전체', open.length], ...TEAMS.filter((x) => counts[x.name]).map((x) => [x.name, counts[x.name]])]
    .map(([n, c]) => `<button type="button" class="chip-filter ${todayFilter === n ? 'active' : ''}" data-filter="${n}">${n} <b>${c}</b></button>`)
    .join('');
  if (todayFilter !== '전체' && !counts[todayFilter]) todayFilter = '전체';
  const list = open.filter((t) => todayFilter === '전체' || teamOf(t).name === todayFilter);

  const byDue = (a, b) => a.due.localeCompare(b.due);
  const dated = list.filter((t) => t.due).sort(byDue);
  const groups = [
    { key: 'now', title: '지금 챙길 것', sub: '기한 지남 · 오늘', rows: dated.filter((t) => daysLeft(t.due) <= 0) },
    { key: 'soon', title: '곧 마감', sub: '3일 안', rows: dated.filter((t) => daysLeft(t.due) > 0 && daysLeft(t.due) <= 3) },
    { key: 'undated', title: '기한 미정', sub: '날짜를 정하면 위로 올라가요', rows: list.filter((t) => !t.due) },
    { key: 'later', title: '그 이후', sub: '4일 이후', rows: dated.filter((t) => daysLeft(t.due) > 3), collapsible: true },
  ];

  const all = open.filter((t) => t.due);
  $('#today-stats').innerHTML = [
    ['late', all.filter((t) => daysLeft(t.due) < 0).length, '기한 지남'],
    ['today', all.filter((t) => daysLeft(t.due) === 0).length, '오늘 마감'],
    ['', all.filter((t) => daysLeft(t.due) > 0 && daysLeft(t.due) <= 3).length, '3일 안에 마감'],
    ['', open.filter((t) => !t.due).length, '기한 미정'],
  ].map(([c, n, l]) => `<div class="stat ${c}"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const recentHtml = recent.length
    ? `<h2>최근 완료·답변 <span class="count">지난 7일 · ${recent.length}건 · 할 일 보드의 '완료' 칸에도 있어요</span></h2>
      <div class="recent-list">${recent.map(recentRow).join('')}</div>`
    : '';
  if (!open.length) {
    $('#today-list').innerHTML = '<div class="empty" style="margin-top:16px">남은 할 일이 없어요. 회의를 정리하고 승인하면 여기에 모여요.</div>' + recentHtml;
    bindRecent();
    return;
  }
  $('#today-list').innerHTML = `<div class="table-wrap"><table class="db-table today-table">
    <thead><tr><th class="col-due">기한</th><th class="col-team">구분</th><th>내용</th><th class="col-status">상태</th></tr></thead>
    ${groups.map((g) => {
      if (!g.rows.length) return '';
      const hidden = g.collapsible && !showLater;
      return `<tbody>
        <tr class="group-row ${g.key}"><td colspan="4">
          <b>${g.title}</b> <span class="hint">${g.sub} · ${g.rows.length}건</span>
          ${g.collapsible ? `<button type="button" class="link-btn" id="toggle-later">${showLater ? '접기' : '펼치기'}</button>` : ''}
        </td></tr>
        ${hidden ? '' : g.rows.map(todoTableRow).join('')}
      </tbody>`;
    }).join('')}
  </table></div>${recentHtml}`;
  bindRecent();

  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => { todayFilter = b.dataset.filter; renderToday(); }));
  $('#toggle-later')?.addEventListener('click', () => { showLater = !showLater; renderToday(); });
  $$('[data-status]', $('#today-list')).forEach((s) =>
    s.addEventListener('change', async () => {
      if (s.value === '할 일') return;
      const row = s.closest('tr');
      row.nextElementSibling?.classList.contains('answer-row') && row.nextElementSibling.remove();
      row.insertAdjacentHTML('afterend', `<tr class="answer-row"><td colspan="4">${answerEditorHtml(s.value)}</td></tr>`);
      const editorRow = row.nextElementSibling;
      bindAnswerEditor(editorRow.querySelector('.answer-editor'), s.dataset.status, s.value, renderToday, () => { editorRow.remove(); s.value = '할 일'; });
    })
  );
  $$('[data-team]', $('#today-list')).forEach((s) =>
    s.addEventListener('change', async () => {
      s.disabled = true;
      try {
        const r = await api(`/api/tasks/${s.dataset.team}`, { method: 'PATCH', body: { team: s.value, by: store.get('owner') } });
        if (r.notionError) alert(`앱에는 반영했지만 노션 카드는 못 바꿨어요: ${r.notionError}`);
      } catch (err) { alert(err.message); }
      renderToday();
    })
  );
  $$('[data-due]', $('#today-list')).forEach((i) =>
    i.addEventListener('duechange', async (e) => {
      const r = await api(`/api/tasks/${i.dataset.due}`, { method: 'PATCH', body: { due: e.detail, by: store.get('owner') } });
      if (r.notionError) alert(`앱에는 반영했지만 노션 카드 기한은 못 바꿨어요: ${r.notionError}`);
      renderToday();
    })
  );
  bindOpen($('#today-list'));
}
$$('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));
loadDirectory().finally(() => renderToday());

/* ---------- 답변·결과 메모 ---------- */
function answerEditorHtml(to) {
  const isDone = to === '완료';
  const where = appStatus.notion?.enabled ? '앱과 노션 회의록에 함께 남아요.' : '앱에 남고, 할 일 보드 완료 칸에서 볼 수 있어요.';
  return `<div class="answer-editor">
    <div class="mini">${isDone ? '결과 메모' : '받은 답변'} <span class="hint">(선택) ${where}</span></div>
    <textarea rows="3" placeholder="${isDone ? '예: 기획사에 1인 2장 한도로 전달함' : '예: 작업 3일 필요, 11/20 배포 가능. 단 디자인 확정이 11/14까지 와야 함'}"></textarea>
    <div class="row"><span class="grow"></span>
      <button type="button" class="btn ghost small" data-cancel>취소</button>
      <button type="button" class="btn primary small" data-save>${to}(으)로 저장</button>
    </div>
  </div>`;
}

async function resolveTask(id, to, answer) {
  const r = await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: to, answer, by: store.get('owner') } });
  if (r.notionError) alert(`앱에는 저장했지만 노션에는 못 남겼어요: ${r.notionError}`);
  return r;
}

function bindAnswerEditor(box, id, to, done, cancel) {
  const ta = box.querySelector('textarea');
  ta.focus();
  box.querySelector('[data-cancel]').addEventListener('click', cancel);
  box.querySelector('[data-save]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    await resolveTask(id, to, ta.value);
    done();
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) box.querySelector('[data-save]').click(); });
}

function recentRow(t) {
  const team = teamOf(t);
  return `<div class="recent-item">
    <div class="recent-head"><span class="tag ${team.color}">${team.name}</span>
      <span class="what">${t.to && t.type !== '내 할 일' ? esc(t.to) + ' · ' : ''}${esc(t.title)}</span>
      <span class="grow"></span><span class="hint">${t.status} · ${kst(t.resolvedAt || t.updatedAt).slice(5, 10).replace('-', '/')}</span>
      <button type="button" class="link-btn" data-undo="${t.id}">되돌리기</button></div>
    ${t.answer ? `<div class="answer-text"><b>${t.type === '내 할 일' ? '결과' : '답변'}</b>${esc(t.answer)}</div>` : '<div class="hint">적어 둔 내용 없음</div>'}
  </div>`;
}

function bindRecent() {
  $$('[data-undo]', $('#today-list')).forEach((b) =>
    b.addEventListener('click', async () => { b.disabled = true; await resolveTask(b.dataset.undo, '할 일'); renderToday(); })
  );
}

/* ---------- 7. 팀 설정 ---------- */
const COLOR_NAMES = { gray: '회색', brown: '갈색', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라', pink: '분홍', red: '빨강' };
function teamsMsg(text, kind = '') { setMsg($('#teams-msg'), text, kind); }
async function teamsCall(fn, okText) {
  try {
    DIRECTORY = await fn();
    rebuildTeams();
    teamsMsg(okText + (DIRECTORY.origin === 'notion' ? ' 노션에도 반영했어요.' : ''), 'ok');
    renderTeams();
  } catch (err) { teamsMsg(err.message, 'err'); }
}

async function renderTeams() {
  await loadDirectory();
  const d = DIRECTORY;
  $('#teams-source').innerHTML = d.origin === 'notion'
    ? `<div class="notice"><b>노션 '팀·구성원' DB</b>에서 읽고 있어요. 여기서 바꾸면 노션에도 바로 반영되고, 노션에서 고친 내용은 1분 안에 여기에 보여요. ${d.url ? `<a href="${esc(d.url)}" target="_blank">노션에서 열기</a>` : ''}</div>`
    : '<div class="notice warn"><b>로컬 파일(knowledge/teams.json)</b>을 쓰고 있어요. 노션 팀·구성원 DB를 연결하면 노션과 함께 관리돼요.</div>';
  const count = (name) => d.members.filter((m) => m.team === name).length;
  $('#teams-count').textContent = `${d.teams.length}개`;
  $('#teams-list').innerHTML = d.teams.map((t) => `<span class="tag ${t.color}">${esc(t.name)} ${count(t.name)}</span>`).join('');
  const colorOpts = Object.entries(COLOR_NAMES).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('#team-add').color.innerHTML = colorOpts;
  const teamOpts = (cur) => d.teams.map((t) => `<option ${t.name === cur ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  $('#member-add').team.innerHTML = teamOpts('미정');
  const only = $('#only-undecided').checked;
  const list = d.members.filter((m) => !only || m.team === '미정');
  $('#members-count').textContent = `${d.members.length}명 · 팀 미정 ${count('미정')}명`;
  $('#members-body').innerHTML = list.map((m) => `<tr data-member="${m.id}">
    <td><input class="cell-input" data-field="name" value="${esc(m.name)}" /></td>
    <td><select class="cell-input team-${esc(d.teams.find((t) => t.name === m.team)?.color || 'gray')}" data-field="team">${teamOpts(m.team)}</select></td>
    <td><input class="cell-input" data-field="role" value="${esc(m.role)}" placeholder="역할" /></td>
    <td><input class="cell-input" data-field="aliases" value="${esc(m.aliases)}" placeholder="예: 소민 님" /></td>
  </tr>`).join('') || '<tr><td colspan="4"><div class="empty">구성원이 없어요.</div></td></tr>';
  $$('#members-body [data-field]').forEach((el) =>
    el.addEventListener('change', () => {
      const id = el.closest('tr').dataset.member;
      el.disabled = true;
      teamsCall(() => api(`/api/members/${id}`, { method: 'PATCH', body: { [el.dataset.field]: el.value } }), '저장했어요.');
    })
  );
}

$('#only-undecided').addEventListener('change', renderTeams);
$('#team-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  teamsCall(() => api('/api/teams', { method: 'POST', body: { name: f.name.value, color: f.color.value } }), `'${f.name.value.trim()}' 팀을 추가했어요.`)
    .then(() => { f.name.value = ''; });
});
$('#member-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  teamsCall(() => api('/api/members', { method: 'POST', body: { name: f.name.value, team: f.team.value, role: f.role.value, aliases: f.aliases.value } }), `${f.name.value.trim()} 님을 추가했어요.`)
    .then(() => { f.name.value = ''; f.role.value = ''; f.aliases.value = ''; });
});

/* ---------- 5. 정책 Q&A ---------- */
const POLICY_EXAMPLES = [
  '예약판매 상품 출고가 늦어지면 취소할 수 있어?',
  '해외배송 무료 기준은 쿠폰 쓰기 전 금액이야?',
  '팬사인회 한 사람이 두 번 당첨될 수 있어?',
  '랜덤 포토카드 확률을 못 받으면 어떻게 해?',
  '앨범 반품할 때 왕복 배송비는 누가 내?',
  '팬사인회 당첨자 좌석 배치는 어떻게 정해?',
];

function answerHtml(r) {
  return `<div class="card answer">
    <div class="row"><span class="badge ${r.found ? 'ok' : 'warn'}">${r.found ? '정책 근거 있음' : '정책에 없음'}</span><span class="hint">${esc(r.question)}</span></div>
    <p class="text">${esc(r.answer)}</p>
    ${r.citations.map((c) => {
      const url = c.url || policyDocUrl[c.doc_title];
      return `<div class="cite"><div class="src"><span>${esc(c.doc_title)} · ${esc(c.article)} ${c.verified ? '· 원문 일치 확인' : '· <span style="color:var(--danger)">원문과 다름, 직접 확인 필요</span>'}</span>${url ? `<a class="cite-link" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(c.page || c.doc_title)}">노션에서 보기 ↗</a>` : ''}</div>“${esc(c.quote)}”</div>`;
    }).join('')}
    ${r.follow_up ? `<div class="notice warn" style="margin-bottom:0">확인할 점: ${esc(r.follow_up)}</div>` : ''}
  </div>`;
}

// 예전 답변(링크 없이 저장된 것)은 문서 제목으로 노션 링크를 찾아 단다
let policyDocUrl = {};
async function renderPolicy(refresh = false) {
  let origin, docs, loading;
  try {
    ({ origin, docs, loading } = await api(`/api/policies${refresh ? '?refresh=1' : ''}`));
  } catch (err) {
    policyDocUrl = Object.fromEntries(docs.filter((d) => d.url).map((d) => [d.title, d.url]));
  $('#policy-docs').innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
    return;
  }
  $('#policy-docs').innerHTML =
    `<span class="badge ${origin === 'notion' ? 'ok' : 'gray'}">${origin === 'notion' ? '노션에서 읽는 중' : '로컬 파일'}</span>` +
    docs.map((d) => (d.url
      ? `<a class="chip" href="${esc(d.url)}" target="_blank" title="${esc(d.source)}">${esc(d.title)}</a>`
      : `<span class="chip" title="${esc(d.source)}">${esc(d.title)} · ${esc(d.source.split(' (')[0])}</span>`)).join('') +
    (origin === 'notion' ? `<span class="hint" style="align-self:center">${docs.length}개 문서${loading ? ' · 노션에서 새로 읽는 중' : ''}</span><button type="button" class="btn ghost small" id="btn-policy-refresh">노션에서 다시 불러오기</button>` : '');
  $('#btn-policy-refresh')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '불러오는 중… (하위 DB까지 읽어 1분쯤 걸려요)';
    await renderPolicy(true);
  });
  $('#policy-examples').innerHTML = POLICY_EXAMPLES.map((q) => `<button class="chip" type="button">${esc(q)}</button>`).join('');
  $$('#policy-examples .chip').forEach((b) =>
    b.addEventListener('click', () => {
      $('#policy-form').question.value = b.textContent;
      $('#policy-form').requestSubmit();
    })
  );
  const hist = await api('/api/policy/history');
  $('#policy-history').innerHTML = hist.length
    ? hist.map((h) => `<div class="qa"><div class="q">${esc(h.question)}</div><div class="a">${esc(h.answer)} <span class="hint">· ${kst(h.at)}</span></div></div>`).join('')
    : '<div class="empty">아직 질문이 없어요.</div>';
}

$('#policy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = e.target.question.value.trim();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  $('#policy-answer').innerHTML = '<p class="msg">정책 문서를 찾는 중이에요…</p>';
  try {
    const r = await api('/api/policy/ask', { method: 'POST', body: { question: q } });
    $('#policy-answer').innerHTML = answerHtml(r);
    renderPolicy();
  } catch (err) {
    $('#policy-answer').innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
  }
  btn.disabled = false;
});

/* ---------- 6. 문구 검수 ---------- */
const REVIEW_SAMPLE = [
  '【お知らせ】NOVA 2ndアルバムの予約販売を開始しました。',
  '在庫切れの商品は「再入荷お知らせ」ボタンから再入庫要請ができます。',
  '最近チェックした商品はマイページの「最近見た商品」からご確認ください。',
  'お気に入りに追加した商品は価額が安い順で並べ替えできます。',
].join('\n');

$('#btn-review-sample').addEventListener('click', () => {
  const f = $('#review-form');
  f.title.value = 'JP몰 공지 초안 (예시)';
  f.lang.value = 'ja';
  f.text.value = REVIEW_SAMPLE;
});

$('#btn-glossary').addEventListener('click', async () => {
  const box = $('#glossary');
  if (box.classList.toggle('hidden')) return;
  const { local: g, site } = await api('/api/glossary');
  const siteHtml = site?.total
    ? `<div class="notice">검수 기준은 <b>노션 사이트 UI 문구 용어집</b>이에요: ${site.malls.join('·')}몰 ${site.total}개 문구(주요 문구 ${site.core}개) · 혼용 포인트 ${site.notes}개. 검수할 때는 문서에 나온 표현과 주요 문구만 골라 AI에 보내요. ${site.url ? `<a href="${esc(site.url)}" target="_blank">노션에서 열기</a>` : ''}</div>`
    : site?.error ? `<div class="notice warn">노션 사이트 UI 문구를 못 읽었어요: ${esc(site.error)}</div>` : '';
  box.innerHTML = (siteHtml || '<div class="notice warn">노션 UI 문구 용어집이 연결되지 않았어요.</div>') + (g.length
    ? `<h2>추가 용어집 <span class="count">${g.length}개 · knowledge/용어집.csv</span></h2>
      <table><thead><tr><th>공식 표기</th><th>쓰지 말 것</th><th>English</th><th>日本語</th></tr></thead><tbody>
      ${g.map((x) => `<tr><td><b>${esc(x.ko)}</b></td><td>${esc(x.avoid.join(', '))}</td><td>${esc(x.en)}</td><td>${esc(x.ja)}</td></tr>`).join('')}
      </tbody></table>`
    : '');
});

$('#review-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#review-text-msg');
  const btn = f.querySelector('button.primary');
  btn.disabled = true;
  setMsg(msg, '사이트 화면 문구와 비교하는 중이에요…');
  try {
    const r = await api('/api/review', { method: 'POST', body: { title: f.title.value, lang: f.lang.value, text: f.text.value } });
    setMsg(msg, `검수 결과를 저장했어요: ${r.mdPath}`, 'ok');
    const rule = r.ruleFindings.length
      ? `<table><thead><tr><th style="width:60px">행</th><th>찾은 표현</th><th>공식 표기</th><th>문맥</th></tr></thead><tbody>
        ${r.ruleFindings.map((x) => `<tr><td>${x.line}</td><td><span class="badge danger">${esc(x.found)}</span></td><td><b>${esc(x.suggestion)}</b></td><td class="hint">${esc(x.context)}</td></tr>`).join('')}
        </tbody></table>`
      : `<div class="empty">${r.lang === 'ko' ? '쓰지 말 것 목록과 일치하는 표현이 없어요.' : '규칙 검사는 한국어 문서에만 적용돼요.'}</div>`;
    const SOURCE = {
      '사이트 표기': { label: '사이트와 다름', color: 'blue' },
      '혼용 포인트': { label: '화면마다 다름', color: 'orange' },
      '용어집': { label: '용어집', color: 'gray' },
    };
    const text0 = f.text.value;
    const ai = r.ai.issues.length
      ? `<table class="review-table"><thead><tr><th style="width:120px">구분</th><th>문서 표현</th><th>바꿀 표기</th><th>이유</th><th style="width:84px"></th></tr></thead><tbody>
        ${r.ai.issues.map((x, i) => {
          const src = SOURCE[x.source] || { label: x.source || '-', color: 'gray' };
          const found = x.original && text0.includes(x.original);
          return `<tr data-issue="${i}">
            <td><span class="tag ${src.color}">${esc(src.label)}</span></td>
            <td>${esc(x.original)}</td>
            <td><b>${esc(x.suggestion)}</b>${x.term ? `<div class="hint">${esc(x.term)}</div>` : ''}</td>
            <td class="hint">${esc(x.reason)}</td>
            <td>${found ? `<button type="button" class="btn ghost small" data-apply="${i}">적용</button>` : '<span class="hint" title="문서에서 같은 표현을 찾지 못해 직접 고쳐야 해요">직접 수정</span>'}</td>
          </tr>`;
        }).join('')}
        </tbody></table>
        <p class="hint legend"><b>사이트와 다름</b>: 실제 사이트 화면에는 다른 문구가 쓰여요. 그 문구로 맞추면 돼요.
        · <b>화면마다 다름</b>: 사이트 안에서도 화면에 따라 같은 뜻을 다른 말로 써요(예: 목록은 売り切れ, FAQ는 在庫切れ). 안내하려는 화면에 맞춰 고르세요.</p>`
      : '<div class="empty">사이트 화면 문구와 다른 곳을 찾지 못했어요.</div>';
    const appliable = r.ai.issues.filter((x) => x.original && text0.includes(x.original)).length;
    $('#review-result').innerHTML = `
      <div class="notice">${esc(r.ai.summary)}
        <div class="hint" style="margin-top:4px">${r.site?.total ? `실제 사이트 화면 문구 ${r.site.used}개와 비교했어요.` : r.site?.error ? '사이트 화면 문구를 못 읽었어요.' : ''} 결과는 파일로도 저장했어요 · <a href="/${r.mdPath}" target="_blank">열기</a></div></div>
      ${r.hasGlossary ? `<h2>규칙 검사 <span class="count">${r.ruleFindings.length}건 · 쓰지 말 것 목록과 일치</span></h2>${rule}` : ''}
      <h2>검수 결과 <span class="count">${r.ai.issues.length}건</span>
        ${appliable ? `<span class="grow"></span><button type="button" class="btn ghost small" id="btn-undo-all" hidden>원래대로</button><button type="button" class="btn primary small" id="btn-apply-all">모두 적용</button>` : ''}</h2>${ai}`;

    // 바로 적용: 검수할 문구 칸의 표현을 바꿀 표기로 바꾼다 (원문은 '원래대로'로 되돌릴 수 있음)
    const applyOne = (i) => {
      const x = r.ai.issues[i];
      const b = $(`[data-apply="${i}"]`);
      if (!b || b.disabled || !f.text.value.includes(x.original)) return false;
      f.text.value = f.text.value.split(x.original).join(x.suggestion);
      b.textContent = '적용됨';
      b.disabled = true;
      b.closest('tr').classList.add('applied');
      $('#btn-undo-all')?.removeAttribute('hidden');
      return true;
    };
    const afterApply = () => {
      const left = $$('[data-apply]:not(:disabled)').length;
      if ($('#btn-apply-all')) $('#btn-apply-all').disabled = left === 0;
      setMsg(msg, `위 '검수할 문구' 칸에 반영했어요.${left ? ` 남은 제안 ${left}건.` : ' 다시 검수해 확인할 수 있어요.'}`, 'ok');
    };
    $$('[data-apply]').forEach((b) => b.addEventListener('click', () => { applyOne(Number(b.dataset.apply)); afterApply(); }));
    $('#btn-apply-all')?.addEventListener('click', () => { r.ai.issues.forEach((_, i) => applyOne(i)); afterApply(); });
    $('#btn-undo-all')?.addEventListener('click', () => {
      f.text.value = text0;
      $$('[data-apply]').forEach((b) => { b.textContent = '적용'; b.disabled = false; b.closest('tr').classList.remove('applied'); });
      if ($('#btn-apply-all')) $('#btn-apply-all').disabled = false;
      $('#btn-undo-all').setAttribute('hidden', '');
      setMsg(msg, '검수 전 문구로 되돌렸어요.', 'ok');
    });
  } catch (err) {
    setMsg(msg, err.message, 'err');
  }
  btn.disabled = false;
});
