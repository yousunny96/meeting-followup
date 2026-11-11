// 노션 연동 (선택 기능 — NOTION_TOKEN 이 있을 때만 켜진다)
// - 승인한 회의 → 회의록 LIST 데이터베이스에 페이지 생성
// - 승인한 '내 할 일' → 주간 캘린더 데이터베이스에 카드 생성, 앱에서 완료하면 상태를 '완료'로
// - 운영정책 페이지의 하위 페이지 → 정책 Q&A 근거로 읽기
import notionPkg from '@notionhq/client'; // CommonJS 패키지라 기본 가져오기로 받아야 Node 22에서도 동작
const { Client } = notionPkg;

const env = (k) => (process.env[k] || '').trim();
export const notionEnabled = () => Boolean(env('NOTION_TOKEN'));
export const notionStatus = () => ({
  enabled: notionEnabled(),
  meetings: Boolean(env('NOTION_MEETING_DS_ID')),
  tasks: Boolean(env('NOTION_TASK_DS_ID')),
  policies: Boolean(env('NOTION_POLICY_PAGE_ID')),
});

let client;
function notion() {
  if (!notionEnabled()) throw new Error('NOTION_TOKEN이 없어요. .env에 노션 통합 토큰을 넣어 주세요.');
  client ??= new Client({ auth: env('NOTION_TOKEN') });
  return client;
}

function friendly(error) {
  const code = error?.code;
  if (code === 'unauthorized') return new Error('노션 토큰이 올바르지 않아요. .env의 NOTION_TOKEN을 확인해 주세요.');
  if (code === 'object_not_found' || code === 'restricted_resource') {
    return new Error('노션 페이지에 접근할 수 없어요. 노션에서 해당 페이지의 … → 연결(Connections)에 통합을 추가해 주세요.');
  }
  if (code === 'rate_limited') return new Error('노션 요청이 많아요. 잠시 후 다시 시도해 주세요.');
  if (code === 'validation_error') return new Error(`노션 데이터베이스 열 구성이 달라요: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

async function call(fn) {
  try {
    return await fn(notion());
  } catch (e) {
    throw friendly(e);
  }
}

/* ---------- 블록 만들기 ---------- */
const text = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 2000) } }];
const heading = (s) => ({ type: 'heading_2', heading_2: { rich_text: text(s) } });
const para = (s) => ({ type: 'paragraph', paragraph: { rich_text: text(s) } });
const bullet = (s) => ({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: text(s) } });
const todo = (s) => ({ type: 'to_do', to_do: { rich_text: text(s), checked: false } });
const dueText = (d, t) => (d ? d : `미정(${t || '기한 언급 없음'})`);

function meetingBlocks(meeting, version) {
  const f = version.final;
  const list = (items, fn) => (items.length ? items.map(fn) : [para('없음')]);
  return [
    para(`회의 후속 정리기에서 ${version.approvedBy} 님이 검토·승인한 정리본입니다. (AI 초안: ${version.model})`),
    heading('요약'),
    para(f.summary),
    heading('결정사항'),
    ...list(f.decisions, (d) => bullet(d.content)),
    heading('내 할 일'),
    ...list(f.my_tasks, (t) => todo(`${t.task} — ${dueText(t.due, t.due_text)}`)),
    heading('개발자 확인 요청'),
    ...list(f.dev_requests, (r) => bullet(`[${r.team || '기타'}] ${r.to} · ${r.question} — ${dueText(r.due, r.due_text)}`)),
    heading('다시 물어볼 것'),
    ...list(f.open_questions, (q) => bullet(`[${q.team || '기타'}] ${q.to_whom}: ${q.question} (${q.why})`)),
    ...(f.followups?.length
      ? [heading('이전 회의에서 이어진 항목'), ...f.followups.map((x) => bullet(`[${x.outcome === 'resolved' ? '결정됨' : '아직 미결'}] ${x.item || x.task_id} → ${x.answer}`))]
      : []),
    heading('BM 논의'),
    ...list(f.bm.discussed, (b) => bullet(`${b.topic}: ${b.current_state} / 확인할 숫자: ${b.numbers_to_check}`)),
    heading('채택한 BM 가설'),
    ...list(f.bm.hypotheses, (h) => bullet(`${h.name}: ${h.revenue_logic} / 가정: ${h.key_assumption} / 지표: ${h.metric} / 위험: ${h.risk}`)),
  ].slice(0, 100); // 노션 한 번에 100블록까지
}

/* ---------- 회의록 LIST ---------- */
export async function createMeetingPage(meeting, version) {
  const ds = env('NOTION_MEETING_DS_ID');
  if (!ds) throw new Error('NOTION_MEETING_DS_ID가 없어요.');
  const page = await call((n) =>
    n.pages.create({
      parent: { type: 'data_source_id', data_source_id: ds },
      properties: {
        이름: { title: text(meeting.title) },
        유형: { select: { name: '기타' } },
        날짜: { date: { start: meeting.meetingDate } },
        참석자: { rich_text: text(meeting.attendees.join(', ')) },
        '정리 상태': { select: { name: '승인' } },
        버전: { number: version.version },
        '회의 ID': { rich_text: text(meeting.id) },
      },
      children: meetingBlocks(meeting, version),
    })
  );
  return { pageId: page.id, url: page.url };
}

export const markMeetingSuperseded = (pageId) =>
  call((n) => n.pages.update({ page_id: pageId, properties: { '정리 상태': { select: { name: '대체됨' } } } }));

/* ---------- 주간 캘린더 ---------- */
export async function createTaskCard(task, owner, meetingPageId) {
  const ds = env('NOTION_TASK_DS_ID');
  if (!ds) throw new Error('NOTION_TASK_DS_ID가 없어요.');
  const properties = {
    이름: { title: text(task.title) },
    상태: { status: { name: '대기' } },
    담당자: { rich_text: text(owner) },
    '할 일 ID': { rich_text: text(task.id) },
  };
  if (task.due) properties['기한'] = { date: { start: task.due } };
  if (meetingPageId) properties['회의'] = { relation: [{ id: meetingPageId }] };
  const page = await call((n) => n.pages.create({ parent: { type: 'data_source_id', data_source_id: ds }, properties }));
  return { pageId: page.id, url: page.url };
}

export const setTaskCardStatus = (pageId, done) =>
  call((n) => n.pages.update({ page_id: pageId, properties: { 상태: { status: { name: done ? '완료' : '대기' } } } }));

export const setTaskCardDue = (pageId, due) =>
  call((n) => n.pages.update({ page_id: pageId, properties: { 기한: { date: due ? { start: due } : null } } }));

// 답변·결과 메모를 회의록 페이지의 '후속 진행 기록' 아래에 한 줄씩 쌓는다 (제목이 없으면 처음에 만든다)
const NOTE_HEADING = '후속 진행 기록';
export const appendMeetingNote = (pageId, line) =>
  call(async (n) => {
    const blocks = await listChildren(n, pageId);
    const hasHeading = blocks.some((b) => b.type === 'heading_2' && plain(b.heading_2.rich_text) === NOTE_HEADING);
    const children = hasHeading ? [bullet(line)] : [heading(NOTE_HEADING), bullet(line)];
    return n.blocks.children.append({ block_id: pageId, children });
  });

// 새 버전이 승인돼 대체된 카드는 휴지통으로 (노션에서 30일 안에 복원 가능)
export const trashTaskCard = (pageId) => call((n) => n.pages.update({ page_id: pageId, in_trash: true }));

/* ---------- 정책 페이지 읽기 ---------- */
async function listChildren(n, blockId) {
  const out = [];
  let cursor;
  do {
    const r = await n.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

const plain = (rt = []) => rt.map((t) => t.plain_text).join('');

function blocksToText(blocks) {
  const lines = [];
  let n = 0;
  for (const b of blocks) {
    const v = b[b.type] || {};
    const pad = '  '.repeat(b._depth || 0);
    if (b.type !== 'numbered_list_item') n = 0;
    if (b.type === 'heading_1') lines.push(`# ${plain(v.rich_text)}`);
    else if (b.type === 'heading_2') lines.push(`## ${plain(v.rich_text)}`);
    else if (b.type === 'heading_3') lines.push(`### ${plain(v.rich_text)}`);
    else if (b.type === 'numbered_list_item') lines.push(`${pad}${++n}. ${plain(v.rich_text)}`);
    else if (b.type === 'bulleted_list_item') lines.push(`${pad}- ${plain(v.rich_text)}`);
    else if (b.type === 'to_do') lines.push(`${pad}- [${v.checked ? 'x' : ' '}] ${plain(v.rich_text)}`);
    else if (b.type === 'table_row') lines.push(`| ${v.cells.map((c) => plain(c).replace(/\|/g, '/')).join(' | ')} |`);
    else if (b.type === 'child_page' || b.type === 'child_database') continue;
    else if (v.rich_text) lines.push(pad + plain(v.rich_text));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// 토글·표·열·중첩 목록 안쪽까지 읽는다 (하위 페이지는 별도 문서로 읽으므로 들어가지 않음)
async function listDeep(n, blockId, depth = 0) {
  const out = [];
  for (const b of await listChildren(n, blockId)) {
    b._depth = depth;
    out.push(b);
    if (b.has_children && depth < 4 && !['child_page', 'child_database'].includes(b.type)) {
      const nested = b.type === 'column_list' || b.type === 'column' || b.type === 'table' || b.type === 'synced_block';
      out.push(...(await listDeep(n, b.id, nested ? depth : depth + 1)));
    }
  }
  return out;
}

/* ---------- 팀·구성원 DB ---------- */
let teamCache = { at: 0, data: null };
const teamDs = () => env('NOTION_TEAM_DS_ID');

export async function loadNotionTeams() {
  if (teamCache.data && Date.now() - teamCache.at < 60 * 1000) return teamCache.data;
  const data = await call(async (n) => {
    const src = await n.dataSources.retrieve({ data_source_id: teamDs() });
    const options = src.properties?.['팀']?.select?.options || [];
    const members = [];
    let cursor;
    do {
      const r = await n.dataSources.query({ data_source_id: teamDs(), page_size: 100, start_cursor: cursor });
      for (const p of r.results) {
        const pr = p.properties || {};
        members.push({
          id: p.id,
          name: plain(pr['이름']?.title).trim(),
          team: pr['팀']?.select?.name || '미정',
          role: plain(pr['역할']?.rich_text).trim(),
          aliases: plain(pr['별칭']?.rich_text).trim(),
          url: p.url,
        });
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    const dbId = src.parent?.database_id;
    return {
      teams: options.map((o) => ({ name: o.name, color: o.color === 'default' ? 'gray' : o.color })),
      members: members.filter((m) => m.name).sort((a, b) => a.name.localeCompare(b.name, 'ko')),
      url: dbId ? `https://www.notion.so/${dbId.replaceAll('-', '')}` : null,
    };
  });
  teamCache = { at: Date.now(), data };
  return data;
}

export async function addNotionTeam(name, color) {
  await call(async (n) => {
    const src = await n.dataSources.retrieve({ data_source_id: teamDs() });
    const options = (src.properties?.['팀']?.select?.options || []).map((o) => ({ id: o.id, name: o.name }));
    await n.dataSources.update({
      data_source_id: teamDs(),
      properties: { 팀: { select: { options: [...options, { name, color }] } } },
    });
  });
  teamCache = { at: 0, data: null };
}

const memberProps = (m) => {
  const p = {};
  if (m.name !== undefined) p['이름'] = { title: text(m.name) };
  if (m.team !== undefined) p['팀'] = { select: { name: m.team } };
  if (m.role !== undefined) p['역할'] = { rich_text: m.role ? text(m.role) : [] };
  if (m.aliases !== undefined) p['별칭'] = { rich_text: m.aliases ? text(m.aliases) : [] };
  return p;
};

export async function addNotionMember(m) {
  await call((n) => n.pages.create({ parent: { type: 'data_source_id', data_source_id: teamDs() }, properties: memberProps(m) }));
  teamCache = { at: 0, data: null };
}

export async function updateNotionMember(pageId, m) {
  await call((n) => n.pages.update({ page_id: pageId, properties: memberProps(m) }));
  teamCache = { at: 0, data: null };
}

/* ---------- 사이트 UI 문구 용어집 ---------- */
export const uiStringsEnabled = () => notionEnabled() && Boolean(env('NOTION_UI_STRINGS_DS_ID'));
let uiCache = { at: 0, data: null };
export async function loadUiStrings() {
  if (uiCache.data && Date.now() - uiCache.at < 10 * 60 * 1000) return uiCache.data;
  const data = await call(async (n) => {
    const rows = [];
    let cursor;
    do {
      const r = await n.dataSources.query({ data_source_id: env('NOTION_UI_STRINGS_DS_ID'), page_size: 100, start_cursor: cursor });
      for (const p of r.results) {
        const pr = p.properties || {};
        rows.push({
          mall: pr['몰']?.select?.name || '', screen: pr['화면']?.select?.name || '', key: plain(pr['문구 키']?.rich_text),
          text: plain(pr['표기']?.title), ko: plain(pr['한국어']?.rich_text), en: plain(pr['영어']?.rich_text),
          note: plain(pr['위치·비고']?.rich_text), core: Boolean(pr['주요 문구']?.checkbox),
        });
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    // 용어집 페이지에서 '혼용' 제목 아래 글머리표만 검수 기준으로 읽는다
    const pageId = env('NOTION_UI_PAGE_ID');
    const notes = [];
    if (pageId) {
      let inNotes = false;
      for (const b of await listChildren(n, pageId)) {
        if (b.type.startsWith('heading_')) inNotes = plain(b[b.type].rich_text).includes('혼용');
        else if (inNotes && b.type === 'bulleted_list_item') notes.push(plain(b.bulleted_list_item.rich_text));
      }
    }
    const malls = [...new Set(rows.map((r) => r.mall).filter(Boolean))];
    return { rows, notes, malls, url: pageId ? `https://www.notion.so/${pageId.replaceAll('-', '')}` : null };
  });
  uiCache = { at: Date.now(), data };
  return data;
}

let policyCache = { at: 0, data: null };

// 노션 속성 값을 한 줄 글로 바꾼다
function propToText(p) {
  switch (p?.type) {
    case 'title': return plain(p.title);
    case 'rich_text': return plain(p.rich_text);
    case 'select': return p.select?.name || '';
    case 'status': return p.status?.name || '';
    case 'multi_select': return p.multi_select.map((x) => x.name).join(', ');
    case 'date': return p.date ? [p.date.start, p.date.end].filter(Boolean).join(' ~ ') : '';
    case 'number': return p.number == null ? '' : String(p.number);
    case 'checkbox': return p.checkbox ? '예' : '';
    case 'url': return p.url || '';
    case 'email': return p.email || '';
    case 'people': return p.people.map((x) => x.name).filter(Boolean).join(', ');
    case 'formula': return String(p.formula?.[p.formula?.type] ?? '');
    default: return '';
  }
}

const POLICY_LIMIT = { pageDepth: 3, dbRows: 60, dbRowBodies: 40, docChars: 60000 };

// 페이지 본문 + 그 안의 하위 페이지·인라인 데이터베이스까지 읽는다
const pageUrl = (id) => `https://www.notion.so/${id.replaceAll('-', '')}`;

// sections: 인용문이 어느 노션 페이지에서 왔는지 찾아 링크를 걸 수 있게 페이지별 본문을 따로 모은다
async function readPolicyPage(n, pageId, depth, sections, title) {
  const blocks = await listDeep(n, pageId);
  const own = blocksToText(blocks);
  sections.push({ title, url: pageUrl(pageId), text: own });
  const parts = [own];
  for (const b of blocks) {
    if (b.type === 'child_page' && depth < POLICY_LIMIT.pageDepth) {
      parts.push(`\n## 하위 페이지: ${b.child_page.title}\n${await readPolicyPage(n, b.id, depth + 1, sections, b.child_page.title)}`);
    } else if (b.type === 'child_database') {
      parts.push(`\n## 데이터베이스: ${b.child_database.title}\n${await readPolicyDb(n, b.id, depth, sections)}`);
    }
  }
  return parts.join('\n');
}

async function readPolicyDb(n, databaseId, depth, sections) {
  let sources;
  try {
    sources = (await n.databases.retrieve({ database_id: databaseId })).data_sources || [];
  } catch {
    return '(연결된 데이터베이스라 읽을 수 없어요)';
  }
  const out = [];
  for (const ds of sources) {
    const rows = [];
    let cursor;
    do {
      const r = await n.dataSources.query({ data_source_id: ds.id, page_size: 100, start_cursor: cursor });
      rows.push(...r.results.filter((x) => x.object === 'page'));
      cursor = r.has_more && rows.length < POLICY_LIMIT.dbRows ? r.next_cursor : undefined;
    } while (cursor);
    if (sources.length > 1) out.push(`### ${ds.name || '데이터 소스'}`);
    for (const [i, row] of rows.slice(0, POLICY_LIMIT.dbRows).entries()) {
      const props = Object.entries(row.properties);
      const title = propToText(props.find(([, v]) => v.type === 'title')?.[1]) || '(제목 없음)';
      const meta = props
        .filter(([, v]) => v.type !== 'title')
        .map(([k, v]) => [k, propToText(v)])
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
      out.push(`### ${title}${meta ? `\n(${meta})` : ''}`);
      sections.push({ title, url: pageUrl(row.id), text: `${title}\n${meta}` });
      if (i < POLICY_LIMIT.dbRowBodies && depth < POLICY_LIMIT.pageDepth) {
        const body = (await readPolicyPage(n, row.id, depth + 1, sections, title)).trim();
        if (body) out.push(body);
      }
    }
    if (rows.length > POLICY_LIMIT.dbRows) out.push(`(행 ${rows.length}개 중 ${POLICY_LIMIT.dbRows}개만 읽음)`);
  }
  return out.join('\n');
}

// 하위 DB까지 읽으면 노션 요청 한도 때문에 1분 넘게 걸린다.
// 그래서 서버 시작 때 미리 읽어 두고, 10분이 지나면 이전 내용으로 답하면서 뒤에서 새로 읽는다.
let policyLoading = null;
export async function loadNotionPolicies({ fresh = false } = {}) {
  const root = env('NOTION_POLICY_PAGE_ID');
  if (!root) throw new Error('NOTION_POLICY_PAGE_ID가 없어요.');
  const stale = !policyCache.data || Date.now() - policyCache.at > 10 * 60 * 1000;
  if (fresh || stale) {
    policyLoading ||= fetchNotionPolicies(root).finally(() => { policyLoading = null; });
    if (fresh || !policyCache.data) return policyLoading;
    policyLoading.catch(() => {});
  }
  return policyCache.data;
}

export function policyLoadState() {
  return { loading: Boolean(policyLoading), loadedAt: policyCache.at ? new Date(policyCache.at).toISOString() : null };
}

async function fetchNotionPolicies(root) {
  const data = await call(async (n) => {
    const rootPage = await n.pages.retrieve({ page_id: root });
    const rootTitle = plain(Object.values(rootPage.properties).find((p) => p.type === 'title')?.title);
    const pages = (await listChildren(n, root)).filter((b) => b.type === 'child_page');
    const docs = [];
    // 노션 요청 한도(초당 약 3회)를 넘지 않도록 문서를 하나씩 읽는다
    for (const p of pages) {
      const sections = [];
      let body = await readPolicyPage(n, p.id, 0, sections, p.child_page.title);
      if (body.length > POLICY_LIMIT.docChars) body = `${body.slice(0, POLICY_LIMIT.docChars)}\n(문서가 길어 앞부분만 읽음)`;
      docs.push({
        file: `notion:${p.id}`,
        title: p.child_page.title,
        source: `노션 > ${rootTitle} > ${p.child_page.title} (최종 수정 ${p.last_edited_time.slice(0, 10)})`,
        url: `https://www.notion.so/${p.id.replaceAll('-', '')}`,
        text: `# ${p.child_page.title}\n\n${body}`,
        sections: sections.filter((x) => x.text.trim()),
      });
    }
    return docs;
  });
  if (!data.length) throw new Error('노션 정책 페이지 아래에 하위 페이지가 없어요.');
  policyCache = { at: Date.now(), data };
  return data;
}
