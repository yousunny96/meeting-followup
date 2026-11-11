// 저장소: JSON 파일 + 지우지 않는 이력 로그(history.jsonl)
// - data/meetings.json : 회의와 버전(AI 초안 / PM 승인본)
// - data/tasks.json    : 승인된 회의에서 나온 할 일·확인 요청 (누적)
// - data/history.jsonl : 모든 변경을 한 줄씩 쌓기만 한다 (수정·삭제 없음)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// DATA_DIR / OUTPUT_DIR 환경변수로 저장 위치를 바꿀 수 있다 (테스트용 복사본에서 돌릴 때)
// Vercel 같은 서버리스에서는 /tmp 만 쓸 수 있다 (기록은 일정 시간 뒤 사라짐 — 데모용)
const WRITABLE = process.env.VERCEL ? '/tmp' : ROOT;
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(WRITABLE, 'data');
export const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(WRITABLE, 'output');
const MEETINGS = path.join(DATA_DIR, 'meetings.json');
const TASKS = path.join(DATA_DIR, 'tasks.json');
const HISTORY = path.join(DATA_DIR, 'history.jsonl');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function readJson(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // 쓰다가 죽어도 기존 파일이 깨지지 않게
}

export function logHistory(event, detail) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
  fs.appendFileSync(HISTORY, line + '\n');
}

export function readHistory(meetingId) {
  if (!fs.existsSync(HISTORY)) return [];
  return fs
    .readFileSync(HISTORY, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((h) => !meetingId || h.meetingId === meetingId);
}

const POLICY_QA = path.join(DATA_DIR, 'policy_qa.jsonl');
export function appendPolicyQa(entry) {
  fs.appendFileSync(POLICY_QA, JSON.stringify(entry) + '\n');
}
export function listPolicyQa() {
  if (!fs.existsSync(POLICY_QA)) return [];
  return fs.readFileSync(POLICY_QA, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export const listMeetings = () => readJson(MEETINGS);
export const listTasks = () => readJson(TASKS);
export const getMeeting = (id) => listMeetings().find((m) => m.id === id);

function nextMeetingId(meetings, meetingDate) {
  const day = meetingDate.replaceAll('-', '');
  const n = meetings.filter((m) => m.id.startsWith(`M-${day}-`)).length + 1;
  return `M-${day}-${String(n).padStart(3, '0')}`;
}

export function createMeeting({ title, meetingDate, attendees, owner, source, transcript, prevMeetingId }) {
  const meetings = listMeetings();
  const meeting = {
    id: nextMeetingId(meetings, meetingDate),
    title,
    meetingDate,
    attendees,
    owner,
    source,
    transcript,
    prevMeetingId: prevMeetingId || null,
    createdAt: new Date().toISOString(),
    versions: [],
  };
  meetings.push(meeting);
  writeJson(MEETINGS, meetings);
  logHistory('회의 등록', { meetingId: meeting.id, title, source });
  return meeting;
}

export function addDraftVersion(meetingId, { draft, model, reason }) {
  const meetings = listMeetings();
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) throw new Error('회의를 찾을 수 없어요.');
  const version = {
    version: meeting.versions.length + 1,
    status: '검토 대기',
    model,
    reason: reason || null,
    createdAt: new Date().toISOString(),
    draft, // AI가 낸 원본. 이후 절대 고치지 않는다.
    final: null,
  };
  meeting.versions.push(version);
  writeJson(MEETINGS, meetings);
  logHistory('AI 초안 생성', { meetingId, version: version.version, model, reason: reason || null });
  return version;
}

export function approveVersion(meetingId, versionNo, { final, approvedBy, mdPath }) {
  const meetings = listMeetings();
  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) throw new Error('회의를 찾을 수 없어요.');
  const version = meeting.versions.find((v) => v.version === versionNo);
  if (!version) throw new Error('버전을 찾을 수 없어요.');
  if (version.status !== '검토 대기') throw new Error(`이미 ${version.status} 상태인 버전이에요.`);

  const approvedAt = new Date().toISOString();
  // 이전에 승인된 버전은 지우지 않고 '대체됨'으로만 표시
  const supersededVersions = [];
  for (const v of meeting.versions) {
    if (v.status === '승인') {
      v.status = '대체됨';
      supersededVersions.push(v);
    }
  }
  Object.assign(version, { status: '승인', final, approvedBy, approvedAt, mdPath });
  writeJson(MEETINGS, meetings);

  // 할 일 보드: 이전 버전에서 나온 미완료 항목은 '대체됨', 새 버전 항목 추가
  const tasks = listTasks();
  const supersededTasks = [];
  for (const t of tasks) {
    if (t.meetingId === meetingId && t.version !== versionNo && !['완료', '답변 받음', '대체됨'].includes(t.status)) {
      t.status = '대체됨';
      t.updatedAt = approvedAt;
      supersededTasks.push(t);
    }
  }
  let seq = tasks.filter((t) => t.meetingId === meetingId).length;
  const add = (type, item) => {
    seq += 1;
    tasks.push({
      id: `${meetingId}-T${String(seq).padStart(2, '0')}`,
      meetingId,
      meetingTitle: meeting.title,
      version: versionNo,
      type,
      title: item.title,
      to: item.to || null,
      team: item.team || null,
      due: item.due || null,
      dueText: item.due_text || null,
      status: '할 일',
      createdAt: approvedAt,
      updatedAt: approvedAt,
    });
  };
  for (const t of final.my_tasks) add('내 할 일', { title: t.task, due: t.due, due_text: t.due_text });
  for (const r of final.dev_requests) add('개발자 확인 요청', { title: r.question, to: r.to, team: r.team, due: r.due, due_text: r.due_text });
  for (const q of final.open_questions) add('다시 물어볼 것', { title: q.question, to: q.to_whom, team: q.team });
  writeJson(TASKS, tasks);

  logHistory('PM 승인', {
    meetingId,
    version: versionNo,
    approvedBy,
    counts: {
      decisions: final.decisions.length,
      my_tasks: final.my_tasks.length,
      dev_requests: final.dev_requests.length,
      open_questions: final.open_questions.length,
      bm_hypotheses_adopted: final.bm.hypotheses.length,
    },
    mdPath,
  });
  const createdTasks = tasks.filter((t) => t.meetingId === meetingId && t.version === versionNo);
  return { meeting, version, createdTasks, supersededTasks, supersededVersions };
}

// 노션 연동 결과(페이지 ID·주소·오류) 기록
export function setVersionNotion(meetingId, versionNo, notion) {
  const meetings = listMeetings();
  const v = meetings.find((m) => m.id === meetingId)?.versions.find((x) => x.version === versionNo);
  if (!v) return;
  v.notion = { ...(v.notion || {}), ...notion, at: new Date().toISOString() };
  writeJson(MEETINGS, meetings);
}

export function setTaskNotion(taskId, notion) {
  const tasks = listTasks();
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.notion = { ...(t.notion || {}), ...notion };
  writeJson(TASKS, tasks);
}

export function updateTaskTeam(taskId, team, by) {
  const v = String(team || '').trim();
  if (!v || v.length > 30) throw new Error('팀 이름이 올바르지 않아요.');
  const tasks = listTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error('항목을 찾을 수 없어요.');
  if (task.status === '대체됨') throw new Error('새 버전으로 대체된 항목은 바꿀 수 없어요.');
  const from = task.type === '내 할 일' ? '내 할 일' : task.team || null;
  // '내 할 일' ↔ 다른 팀 사이를 옮기면 항목 종류와 상태 이름도 맞춘다
  let converted = null;
  if (v === '내 할 일') {
    if (task.type !== '내 할 일') {
      converted = 'toMine';
      task.type = '내 할 일';
      task.team = null;
      if (task.status === '답변 받음') task.status = '완료';
    }
  } else {
    if (task.type === '내 할 일') {
      converted = 'fromMine';
      task.type = '개발자 확인 요청';
      if (task.status === '완료') task.status = '답변 받음';
    }
    task.team = v;
  }
  task.updatedAt = new Date().toISOString();
  writeJson(TASKS, tasks);
  logHistory('구분 변경', { meetingId: task.meetingId, taskId, from, to: v, by: by || null });
  return { task, converted };
}

export function updateTaskDue(taskId, due, by) {
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due || '')) throw new Error('기한은 YYYY-MM-DD 형식이어야 해요.');
  const tasks = listTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error('항목을 찾을 수 없어요.');
  if (task.status === '대체됨') throw new Error('새 버전으로 대체된 항목은 바꿀 수 없어요.');
  const from = task.due;
  task.due = due;
  task.updatedAt = new Date().toISOString();
  writeJson(TASKS, tasks);
  logHistory('기한 지정', { meetingId: task.meetingId, taskId, from, to: due, by: by || null });
  return task;
}

export function updateTaskStatus(taskId, status, by, answer) {
  const allowed = ['할 일', '완료', '답변 받음'];
  if (!allowed.includes(status)) throw new Error('바꿀 수 없는 상태예요.');
  const tasks = listTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error('항목을 찾을 수 없어요.');
  if (task.status === '대체됨') throw new Error('새 버전으로 대체된 항목은 바꿀 수 없어요.');
  const from = task.status;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (status === '할 일') {
    task.resolvedAt = null; // 되돌려도 적어 둔 답변은 남긴다
  } else {
    task.resolvedAt = task.updatedAt;
    if (answer !== undefined) task.answer = String(answer).trim().slice(0, 2000) || null;
  }
  writeJson(TASKS, tasks);
  logHistory('상태 변경', { meetingId: task.meetingId, taskId, from, to: status, by: by || null, answer: status !== '할 일' ? task.answer || null : undefined });
  return task;
}
