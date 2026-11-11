import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './lib/store.js';
import { analyze, transcribe, analysisModel, isMock, canTranscribe, sttEngine, askPolicy, reviewWording } from './lib/ai.js';
import { clovaEnabled } from './lib/clova.js';
import { saveMarkdown, saveReviewMarkdown } from './lib/markdown.js';
import { loadPolicies, loadGlossary, findAvoidedTerms, selectUiStrings } from './lib/knowledge.js';
import * as notion from './lib/notion.js';
import * as teams from './lib/teams.js';

// AI 정리에 넘길 명단. 명단을 못 읽어도 정리는 계속한다.
// 이전 회의의 아직 열린 항목과 결정사항 (AI가 이번 회의에서 결정됐는지 판단할 재료)
function previousContext(prevMeetingId) {
  if (!prevMeetingId) return null;
  const prev = store.getMeeting(prevMeetingId);
  if (!prev) throw new Error('이어서 정리할 이전 회의를 찾을 수 없어요.');
  const approved = [...prev.versions].reverse().find((v) => v.status === '승인');
  const items = store.listTasks()
    .filter((t) => t.meetingId === prevMeetingId && t.status === '할 일')
    .map(({ id, type, title, to }) => ({ id, type, title, to }));
  return { id: prev.id, title: prev.title, meetingDate: prev.meetingDate, items, decisions: (approved?.final?.decisions || []).map((d) => d.content) };
}

// 할 일 상태가 바뀌면 노션 카드 상태를 맞추고, 답변·결과는 그 회의 노션 회의록에 한 줄 남긴다
async function notifyTaskChange(task, { statusChanged, dueChanged }) {
  const out = {};
  if (!notion.notionEnabled()) return out;
  if (task.notion?.pageId && !task.notion.trashed) {
    try {
      if (statusChanged) await notion.setTaskCardStatus(task.notion.pageId, task.status !== '할 일');
      if (dueChanged) await notion.setTaskCardDue(task.notion.pageId, task.due);
    } catch (e) {
      return { notionError: e.message };
    }
  }
  if (statusChanged && task.status !== '할 일' && task.answer) {
    const pageId = store.getMeeting(task.meetingId)?.versions.find((v) => v.version === task.version)?.notion?.pageId;
    if (pageId) {
      const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(5).replace('-', '/');
      try {
        await notion.appendMeetingNote(pageId, `[${task.status} ${day}] ${task.to ? task.to + ' · ' : ''}${task.title} → ${task.answer}`);
        out.notionNoted = true;
      } catch (e) {
        out.notionError = e.message;
      }
    }
  }
  return out;
}

const directoryOrNull = () => teams.loadDirectory().catch((e) => { console.warn('팀 명단 읽기 실패:', e.message); return null; });

// 정책 근거: 노션 정책 페이지가 설정돼 있으면 노션에서, 아니면 knowledge/policies 파일에서
async function currentPolicies(opts) {
  const s = notion.notionStatus();
  if (s.enabled && s.policies) return { origin: 'notion', policies: await notion.loadNotionPolicies(opts) };
  return { origin: 'local', policies: loadPolicies() };
}

// 승인된 버전을 노션에 맞춘다. 여러 번 불러도 이미 만든 것은 다시 만들지 않는다.
async function syncMeetingToNotion(meetingId, versionNo) {
  const s = notion.notionStatus();
  if (!s.enabled) return { skipped: true };
  const errors = [];
  const meeting = store.getMeeting(meetingId);
  const version = meeting.versions.find((v) => v.version === versionNo);
  if (version?.status !== '승인') throw new Error('승인된 버전만 노션에 보낼 수 있어요.');

  let pageId = version.notion?.pageId;
  if (s.meetings && !pageId) {
    try {
      const page = await notion.createMeetingPage(meeting, version);
      pageId = page.pageId;
      store.setVersionNotion(meetingId, versionNo, { ...page, error: null });
    } catch (e) {
      errors.push(`회의록: ${e.message}`);
      store.setVersionNotion(meetingId, versionNo, { error: e.message });
    }
  }
  for (const old of meeting.versions.filter((v) => v.status === '대체됨' && v.notion?.pageId && !v.notion.superseded)) {
    try {
      await notion.markMeetingSuperseded(old.notion.pageId);
      store.setVersionNotion(meetingId, old.version, { superseded: true });
    } catch (e) {
      errors.push(`이전 회의록 v${old.version}: ${e.message}`);
    }
  }

  let cards = 0;
  if (s.tasks) {
    for (const t of store.listTasks().filter((x) => x.meetingId === meetingId)) {
      try {
        if (t.version === versionNo && t.type === '내 할 일' && t.status !== '대체됨' && !t.notion?.pageId) {
          const card = await notion.createTaskCard(t, meeting.owner, pageId);
          if (t.status === '완료') await notion.setTaskCardStatus(card.pageId, true);
          store.setTaskNotion(t.id, card);
          cards += 1;
        } else if (t.status === '대체됨' && t.notion?.pageId && !t.notion.trashed) {
          await notion.trashTaskCard(t.notion.pageId);
          store.setTaskNotion(t.id, { trashed: true });
        }
      } catch (e) {
        errors.push(`할 일 ${t.id}: ${e.message}`);
      }
    }
  }
  const url = store.getMeeting(meetingId).versions.find((v) => v.version === versionNo).notion?.url || null;
  store.logHistory('노션 연동', { meetingId, version: versionNo, url, cards, errors });
  return { ok: errors.length === 0, url, cards, errors };
}

const ROOT = import.meta.dirname;
const app = express();
const upload = multer({ dest: process.env.VERCEL ? '/tmp/uploads' : path.join(ROOT, 'uploads'), limits: { fileSize: (clovaEnabled() ? 500 : 25) * 1024 * 1024 } }); // CLOVA Speech는 큰 녹음도 받는다

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(store.OUTPUT_DIR));
app.use('/samples', express.static(path.join(ROOT, 'samples')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

app.get('/api/status', (req, res) => {
  res.json({
    mock: isMock(),
    model: analysisModel(),
    hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
    canTranscribe: canTranscribe(),
    sttEngine: sttEngine(),
    notion: notion.notionStatus(),
  });
});

// 1. 녹음 → 텍스트
app.post(
  '/api/transcribe',
  upload.single('audio'),
  wrap(async (req, res) => {
    if (!req.file) throw new Error('녹음 파일을 올려 주세요.');
    try {
      // 팀 명단의 이름을 인식 힌트로 넘긴다 (CLOVA Speech)
      let boostWords = [];
      try { boostWords = (await teams.loadDirectory()).members.map((m) => m.name); } catch {}
      res.json(await transcribe(req.file.path, req.file.originalname, { boostWords }));
    } finally {
      fs.rmSync(req.file.path, { force: true }); // 원본 녹음은 서버에 남기지 않는다
    }
  })
);

// 2. 회의 등록 + AI 초안
app.post(
  '/api/meetings',
  wrap(async (req, res) => {
    const { title, meetingDate, attendees, owner, source, transcript, prevMeetingId } = req.body;
    const missing = [];
    if (!title?.trim()) missing.push('회의 제목');
    if (!isDate(meetingDate)) missing.push('회의 날짜');
    if (!owner?.trim()) missing.push('내 이름');
    if (!transcript?.trim() || transcript.trim().length < 50) missing.push('전사본(50자 이상)');
    if (missing.length) throw new Error(`빠진 값이 있어요: ${missing.join(', ')}`);

    const people = String(attendees || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const previous = previousContext(prevMeetingId);
    const draft = await analyze({ transcript, owner, meetingDate, title, attendees: people, directory: await directoryOrNull(), previous });
    const meeting = store.createMeeting({
      title: title.trim(),
      meetingDate,
      attendees: people,
      owner: owner.trim(),
      source: source === 'audio' ? '녹음' : source === 'file' ? '음성기록 파일' : '전사본',
      transcript,
      prevMeetingId: previous?.id,
    });
    const version = store.addDraftVersion(meeting.id, { draft, model: analysisModel() });
    res.json({ meetingId: meeting.id, version: version.version });
  })
);

// 2-1. 같은 회의 재분석 → 새 버전 (이전 버전은 그대로 보존)
app.post(
  '/api/meetings/:id/reanalyze',
  wrap(async (req, res) => {
    const meeting = store.getMeeting(req.params.id);
    if (!meeting) throw new Error('회의를 찾을 수 없어요.');
    const draft = await analyze({ ...meeting, directory: await directoryOrNull(), previous: previousContext(meeting.prevMeetingId) });
    const version = store.addDraftVersion(meeting.id, {
      draft,
      model: analysisModel(),
      reason: req.body?.reason || '재분석',
    });
    res.json({ meetingId: meeting.id, version: version.version });
  })
);

app.get('/api/meetings', (req, res) => {
  const list = store.listMeetings().map(({ transcript, versions, ...m }) => ({
    ...m,
    versions: versions.map(({ draft, final, ...v }) => v),
  }));
  res.json(list.reverse());
});

// 회의 삭제: 앱에서는 지우고, 노션 회의록·캘린더 카드는 휴지통으로 보낸다
app.delete(
  '/api/meetings/:id',
  wrap(async (req, res) => {
    const by = String(req.body?.by || '').trim() || null;
    const { meeting, tasks } = store.deleteMeeting(req.params.id, by);
    const notionErrors = [];
    let trashed = 0;
    if (notion.notionEnabled()) {
      const pages = [
        ...meeting.versions.map((v) => v.notion?.pageId).filter(Boolean),
        ...tasks.filter((t) => t.notion?.pageId && !t.notion.trashed).map((t) => t.notion.pageId),
      ];
      for (const pageId of new Set(pages)) {
        try {
          await notion.trashPage(pageId);
          trashed++;
        } catch (e) {
          notionErrors.push(e.message);
        }
      }
    }
    res.json({ ok: true, meetingId: meeting.id, title: meeting.title, tasks: tasks.length, notionTrashed: trashed, notionErrors });
  })
);

app.get(
  '/api/meetings/:id',
  wrap(async (req, res) => {
    const meeting = store.getMeeting(req.params.id);
    if (!meeting) throw new Error('회의를 찾을 수 없어요.');
    res.json({ ...meeting, history: store.readHistory(meeting.id) });
  })
);

// 3. PM 검토·승인 → 저장(Markdown) + 할 일 보드 반영
app.post(
  '/api/meetings/:id/versions/:v/approve',
  wrap(async (req, res) => {
    const { final, approvedBy } = req.body;
    if (!approvedBy?.trim()) throw new Error('승인자 이름을 적어 주세요.');
    for (const key of ['summary', 'decisions', 'my_tasks', 'dev_requests', 'open_questions', 'bm']) {
      if (!(key in (final || {}))) throw new Error(`승인본에 ${key}가 없어요.`);
    }
    const bad = [...final.my_tasks, ...final.dev_requests].find((t) => t.due && !isDate(t.due));
    if (bad) throw new Error(`기한은 YYYY-MM-DD로 적어 주세요: ${bad.due}`);

    const meeting = store.getMeeting(req.params.id);
    const versionNo = Number(req.params.v);
    const pending = meeting?.versions.find((v) => v.version === versionNo);
    if (!pending) throw new Error('버전을 찾을 수 없어요.');
    const mdPath = saveMarkdown(meeting, {
      ...pending,
      final,
      approvedBy: approvedBy.trim(),
      approvedAt: new Date().toISOString(),
    });
    store.approveVersion(meeting.id, versionNo, { final, approvedBy: approvedBy.trim(), mdPath });
    // 노션 전송이 실패해도 승인·로컬 저장은 그대로 유지한다 (이력 화면에서 다시 보내기 가능)
    let notionResult;
    try {
      notionResult = await syncMeetingToNotion(meeting.id, versionNo);
    } catch (e) {
      notionResult = { ok: false, errors: [e.message] };
    }
    // 이전 회의에서 이어진 항목: PM이 체크한 '결정됨'만 닫는다
    const closed = [];
    for (const f of final.followups || []) {
      if (!f.apply || f.outcome !== 'resolved') continue;
      const t = store.listTasks().find((x) => x.id === f.task_id);
      if (!t || t.status !== '할 일') continue;
      const status = t.type === '내 할 일' ? '완료' : '답변 받음';
      const answer = `${String(f.answer || '').trim()} (${meeting.meetingDate} '${meeting.title}' 회의에서 결정)`;
      const updated = store.updateTaskStatus(t.id, status, approvedBy.trim(), answer);
      const n = await notifyTaskChange(updated, { statusChanged: true });
      closed.push({ id: t.id, title: t.title, status, ...n });
    }
    if (closed.length) store.logHistory('이전 회의 항목 정리', { meetingId: meeting.id, version: versionNo, from: meeting.prevMeetingId, closed: closed.map((c) => c.id) });
    res.json({ ok: true, mdPath, notion: notionResult, closed });
  })
);

app.post(
  '/api/meetings/:id/versions/:v/notion',
  wrap(async (req, res) => {
    res.json(await syncMeetingToNotion(req.params.id, Number(req.params.v)));
  })
);

app.get('/api/tasks', (req, res) => res.json(store.listTasks()));

app.patch(
  '/api/tasks/:id',
  wrap(async (req, res) => {
    const { status, due, by, answer, team } = req.body || {};
    if (status === undefined && due === undefined && team === undefined) throw new Error('바꿀 값(status, due, team)이 없어요.');
    let task;
    let converted = null;
    if (team !== undefined) ({ task, converted } = store.updateTaskTeam(req.params.id, team, by));
    if (due !== undefined) task = store.updateTaskDue(req.params.id, due, by);
    if (status !== undefined) task = store.updateTaskStatus(req.params.id, status, by, answer);
    const extra = await notifyTaskChange(task, { statusChanged: status !== undefined, dueChanged: due !== undefined });
    // 내 할 일이 아니게 되면 주간 캘린더 카드는 휴지통으로, 내 할 일이 되면 카드를 새로 만든다
    if (converted && notion.notionEnabled()) {
      try {
        if (converted === 'fromMine' && task.notion?.pageId && !task.notion.trashed) {
          await notion.trashTaskCard(task.notion.pageId);
          store.setTaskNotion(task.id, { trashed: true });
        }
        if (converted === 'toMine' && notion.notionStatus().tasks) {
          const m = store.getMeeting(task.meetingId);
          const meetingPageId = m?.versions.find((v) => v.version === task.version)?.notion?.pageId;
          if (meetingPageId) {
            const card = await notion.createTaskCard(task, m.owner, meetingPageId);
            if (task.status === '완료') await notion.setTaskCardStatus(card.pageId, true);
            store.setTaskNotion(task.id, { ...card, trashed: false });
          }
        }
      } catch (e) {
        extra.notionError = e.message;
      }
    }
    res.json({ ...task, ...extra });
    return;
  })
);

/* ---------- 정책 답변 봇 ---------- */
app.get(
  '/api/policies',
  wrap(async (req, res) => {
    const { origin, policies } = await currentPolicies({ fresh: req.query.refresh === '1' });
    res.json({ origin, docs: policies.map(({ text, sections, ...p }) => ({ ...p, chars: text.length })), ...(origin === 'notion' ? notion.policyLoadState() : {}) });
  })
);

app.post(
  '/api/policy/ask',
  wrap(async (req, res) => {
    const question = String(req.body?.question || '').trim();
    if (question.length < 2) throw new Error('질문을 적어 주세요.');
    const { origin, policies } = await currentPolicies();
    const result = await askPolicy(question, policies);
    // 인용문이 실제 문서에 그대로 있는지 시스템이 다시 확인한다
    const all = policies.map((p) => p.text).join('\n');
    // 인용문이 들어 있는 가장 작은 노션 페이지(하위 페이지·DB 행)를 찾아 바로 열 수 있는 링크를 단다
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    result.citations = result.citations.map((c) => {
      const doc = policies.find((p) => p.title === c.doc_title);
      const q = norm(c.quote);
      const hit = q && [...(doc?.sections || []), ...policies.flatMap((p) => (p === doc ? [] : p.sections || []))]
        .filter((s) => norm(s.text).includes(q))
        .sort((a, b) => a.text.length - b.text.length)[0];
      return { ...c, verified: all.includes(c.quote), url: hit?.url || doc?.url || null, page: hit && hit.title !== c.doc_title ? hit.title : null };
    });
    const entry = { at: new Date().toISOString(), question, model: analysisModel(), origin, ...result };
    store.appendPolicyQa(entry);
    res.json(entry);
  })
);

app.get('/api/policy/history', (req, res) => res.json(store.listPolicyQa().reverse().slice(0, 20)));

/* ---------- 문구 검수 (용어집) ---------- */
app.get(
  '/api/glossary',
  wrap(async (req, res) => {
    let site = null;
    if (notion.uiStringsEnabled()) {
      try {
        const s = await notion.loadUiStrings();
        site = { total: s.rows.length, core: s.rows.filter((r) => r.core).length, malls: s.malls, notes: s.notes.length, url: s.url };
      } catch (e) {
        site = { error: e.message };
      }
    }
    res.json({ local: loadGlossary(), site });
  })
);

app.post(
  '/api/review',
  wrap(async (req, res) => {
    const text = String(req.body?.text || '');
    const lang = ['ko', 'en', 'ja'].includes(req.body?.lang) ? req.body.lang : 'ko';
    const title = String(req.body?.title || '').trim() || '제목 없음';
    if (text.trim().length < 10) throw new Error('검수할 문구를 10자 이상 넣어 주세요.');
    const glossary = loadGlossary();
    const ruleFindings = lang === 'ko' ? findAvoidedTerms(text, glossary) : [];
    let site = null;
    let siteInfo = null;
    if (notion.uiStringsEnabled()) {
      try {
        const all = await notion.loadUiStrings();
        const sel = selectUiStrings(text, all.rows);
        site = { rows: sel.rows, notes: all.notes };
        siteInfo = { total: all.rows.length, used: sel.rows.length, matched: sel.matched, notes: all.notes.length, malls: all.malls, url: all.url };
      } catch (e) {
        siteInfo = { error: e.message };
      }
    }
    if (!isMock() && !glossary.length && !site?.rows?.length) {
      throw new Error(siteInfo?.error ? `검수 기준(노션 UI 문구)을 못 읽었어요: ${siteInfo.error}` : '검수 기준이 없어요. 노션 UI 문구 용어집을 연결해 주세요.');
    }
    const ai = await reviewWording({ text, lang, glossary, ruleFindings, site });
    const review = { at: new Date().toISOString(), title, lang, model: analysisModel(), ruleFindings, ai, site: siteInfo, hasGlossary: glossary.length > 0 };
    review.mdPath = saveReviewMarkdown(review);
    store.logHistory('문구 검수', { title, lang, rule: ruleFindings.length, ai: ai.issues.length, mdPath: review.mdPath });
    res.json(review);
  })
);

/* ---------- 팀·구성원 ---------- */
app.get('/api/teams', wrap(async (req, res) => res.json(await teams.loadDirectory())));
app.post('/api/teams', wrap(async (req, res) => {
  await teams.addTeam(req.body?.name, req.body?.color);
  store.logHistory('팀 추가', { name: req.body?.name });
  res.json(await teams.loadDirectory());
}));
app.post('/api/members', wrap(async (req, res) => {
  await teams.addMember(req.body || {});
  res.json(await teams.loadDirectory());
}));
app.patch('/api/members/:id', wrap(async (req, res) => {
  await teams.updateMember(req.params.id, req.body || {});
  res.json(await teams.loadDirectory());
}));

export default app; // Vercel은 이 app을 함수로 감싸 실행한다

const port = Number(process.env.PORT || 3000);
if (!process.env.VERCEL) app.listen(port, () => {
  console.log(`회의 후속 정리기: http://localhost:${port}`);
  console.log(isMock() ? '연습 모드(MOCK_AI=1): AI를 부르지 않고 예시 결과를 씁니다.' : `AI 모델: ${analysisModel()}`);
  // 노션 정책은 읽는 데 오래 걸려서 서버가 뜨자마자 미리 읽어 둔다
  const ns = notion.notionStatus();
  if (ns.enabled && ns.policies) {
    const t = Date.now();
    notion.loadNotionPolicies()
      .then((d) => console.log(`노션 정책 ${d.length}개 문서를 읽었어요 (${Math.round((Date.now() - t) / 1000)}초)`))
      .catch((e) => console.log(`노션 정책을 못 읽었어요: ${e.message}`));
  }
});
