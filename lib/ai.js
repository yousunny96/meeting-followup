// AI 호출
// - 회의 정리: Claude API (구조화 출력으로 정해진 JSON만 받는다)
// - 녹음 → 텍스트: Claude에는 음성 인식이 없어서 CLOVA Speech(화자 구분, 우선) 또는 OpenAI Whisper를 쓴다. 키가 있을 때만 켜진다.
// MOCK_AI=1 이면 API를 부르지 않고 samples/ 의 예시 결과를 돌려준다 (키 없이 화면 흐름만 점검할 때).
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { clovaEnabled, clovaTranscribe } from './clova.js';
import { whisperxEnabled, whisperxTranscribe } from './whisperx.js';

const ROOT = path.resolve(import.meta.dirname, '..');

export const isMock = () => process.env.MOCK_AI === '1';
export const analysisModel = () => (isMock() ? 'mock' : process.env.CLAUDE_MODEL || 'claude-opus-5-5');
export const canTranscribe = () => isMock() || clovaEnabled() || whisperxEnabled() || Boolean(process.env.OPENAI_API_KEY);
export const sttEngine = () => (isMock() ? 'mock' : clovaEnabled() ? 'CLOVA Speech' : whisperxEnabled() ? 'whisperX' : process.env.OPENAI_API_KEY ? 'OpenAI Whisper' : null);

let client;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 없어요. .env 파일에 Claude API 키를 넣고 서버를 다시 켜 주세요.');
  }
  client ??= new Anthropic();
  return client;
}

/* ---------- 녹음 → 텍스트 (선택 기능) ---------- */
// 돌려주는 값: { transcript, speakers, engine }
export async function transcribe(filePath, originalName, opts = {}) {
  if (isMock()) {
    return { transcript: fs.readFileSync(path.join(ROOT, 'samples', '가상회의_전사본.txt'), 'utf8'), speakers: [], engine: 'mock' };
  }
  if (clovaEnabled()) return clovaTranscribe(filePath, originalName, opts);
  if (whisperxEnabled()) return whisperxTranscribe(filePath, opts);
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('녹음 변환에는 CLOVA Speech·whisperX·OpenAI 중 하나가 필요해요. 클로바노트에서 내보낸 .txt를 올려 주세요.');
  }
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), originalName);
  form.append('model', process.env.OPENAI_STT_MODEL || 'whisper-1');
  form.append('language', 'ko');
  form.append('response_format', 'text');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`녹음 변환 실패 (${res.status}) ${detail}`.trim());
  }
  // 한 덩어리로 오므로 문장 끝(. ? !) 뒤에서 줄을 나눠 검토하기 쉽게 한다
  const text = (await res.text()).trim().replace(/\s+\./g, '.').replace(/([.?!])\s+/g, '$1\n');
  return { transcript: text, speakers: [], engine: 'OpenAI Whisper' };
}

/* ---------- 회의 정리 ---------- */
const str = { type: 'string' };
const nullableDate = {
  anyOf: [{ type: 'string', description: 'YYYY-MM-DD' }, { type: 'null' }],
  description: '회의 날짜 기준으로 확정할 수 있을 때만 YYYY-MM-DD, 아니면 null',
};
const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arr = (items) => ({ type: 'array', items });
export const DEFAULT_TEAMS = ['프론트', '백엔드', '디자이너', '운영팀', '마케팅팀', '사업·MD', '기획(PM)'];
// 팀 목록은 팀·구성원 명단에서 온다 ('미정'은 빼고 '기타'를 붙인다)
const teamEnum = (dir) => [...new Set([...(dir?.teams?.map((t) => t.name) || DEFAULT_TEAMS).filter((n) => n !== '미정' && n !== '기타'), '기타'])];
export const buildSchema = (teams, followupIds = []) => {
  const team = { type: 'string', enum: teams, description: '상대방이 속한 팀. 명단에 있으면 명단의 팀, 판단할 근거가 없으면 기타' };
  return obj({
  summary: { type: 'string', description: '회의 목적과 결론 2~3문장' },
  decisions: arr(obj({ content: str, evidence: str })),
  my_tasks: arr(obj({ task: str, due: nullableDate, due_text: str, evidence: str })),
  dev_requests: arr(obj({ to: str, team, question: str, due: nullableDate, due_text: str, evidence: str })),
  open_questions: arr(obj({ question: str, to_whom: str, team, why: str })),
  bm: obj({
    discussed: arr(obj({ topic: str, current_state: str, numbers_to_check: str })),
    hypotheses: arr(obj({ name: str, revenue_logic: str, key_assumption: str, metric: str, risk: str })),
  }),
  ...(followupIds.length
    ? {
        followups: arr(obj({
          task_id: { type: 'string', enum: followupIds },
          outcome: { type: 'string', enum: ['resolved', 'still_open'] },
          answer: { type: 'string', description: 'resolved면 결정·답변 내용 한 문장, still_open이면 진행 상황 한 문장' },
          evidence: str,
        })),
      }
    : {}),
  });
};
export const SCHEMA = buildSchema(teamEnum(null));

function rosterText(dir) {
  const rows = (dir?.members || []).map((m) => `- ${m.name}${m.aliases ? ` (별칭: ${m.aliases})` : ''}: ${m.team}${m.role ? `, ${m.role}` : ''}`);
  return rows.length ? rows.join('\n') : '- (명단 없음)';
}

function previousText(prev) {
  if (!prev) return '';
  const items = prev.items.map((t) => `- [${t.id}] ${t.type}${t.to ? ` · ${t.to}` : ''}: ${t.title}`).join('\n') || '- (열린 항목 없음)';
  const decisions = prev.decisions.map((d) => `- ${d}`).join('\n') || '- (없음)';
  return `\n\n이 회의는 이전 회의 "${prev.title}"(${prev.meetingDate})에 이어지는 회의다.
12. followups: 아래 <previous_open_items> 각각에 대해 이번 전사본에서 다뤄진 것만 넣는다.
   - 이번 회의에서 결정됐거나 답을 받았으면 outcome=resolved, answer에 무엇으로 정해졌는지 한 문장으로 쓴다.
   - 논의는 됐지만 결론이 안 났으면 outcome=still_open, answer에 지금 상황을 한 문장으로 쓴다.
   - 이번 전사본에서 언급되지 않은 항목은 넣지 않는다. 비슷한 단어만 나왔다고 결정된 것으로 보지 않는다.
   - evidence에는 근거가 된 이번 전사본 문장을 그대로 옮긴다.
13. 이전 회의의 열린 항목과 같은 내용을 이번 회의의 my_tasks, dev_requests, open_questions에 다시 만들지 않는다 (followups로 추적한다). 이번 회의에서 새로 생긴 일만 넣는다. 이전 항목이 이번에 결정됐다면 그 결정은 decisions에도 넣는다.

<previous_decisions>\n${decisions}\n</previous_decisions>

<previous_open_items>\n${items}\n</previous_open_items>`;
}

function systemPrompt({ owner, meetingDate, teams, directory, previous }) {
  return `너는 이커머스 PM "${owner}"의 회의 후속 정리 도우미다. 회의 날짜는 ${meetingDate}이다.
요구사항이 구체화되기 전 단계의 회의 전사본을 읽고, PM이 회의 직후 챙겨야 할 것을 정리한다.

규칙:
1. 전사본에 없는 사실을 지어내지 않는다. 숫자·날짜·사람 이름은 전사본에 나온 것만 쓴다.
2. evidence에는 근거가 된 전사본 문장을 짧게 그대로 옮긴다. PM이 원문과 대조해 검증한다.
3. decisions에는 회의에서 합의된 것만 넣는다. 의견만 나오고 결론이 없으면 open_questions로 보낸다.
4. my_tasks에는 "${owner}"(PM)가 직접 해야 하는 일만 넣는다. 다른 사람의 일은 넣지 않는다.
5. dev_requests에는 PM이 개발자에게 확인받거나 답을 받아야 하는 것을 넣는다. to에는 개발자 이름이나 역할을 쓴다.
6. 기한: "다음 주 수요일", "이번 주 금요일" 같은 표현은 회의 날짜 기준으로 YYYY-MM-DD로 바꾼다. 확신할 수 없으면 due는 null로 두고 due_text에 원문 표현(없으면 "기한 언급 없음")을 쓴다.
7. open_questions에는 아직 모호해서 누군가에게 다시 물어봐야 하는 것을 넣는다. why에는 그대로 두면 생길 문제를 한 문장으로 쓴다.
8. bm.discussed에는 회의에서 나온 가격·수수료·프로모션·수익 관련 논의를 넣고, numbers_to_check에 확인이 필요한 숫자를 적는다.
9. bm.hypotheses에는 회의 내용에 근거한 수익 모델 가설을 2~3개 제안한다. 이것은 AI의 제안이며 PM이 채택 여부를 정한다. 수치를 예측하지 말고 검증할 지표(metric)와 위험(risk)을 쓴다.
10. dev_requests와 open_questions의 team에는 상대방이 속한 팀을 다음 중에서 고른다: ${teams.join(', ')}.
   - 상대방 이름이나 별칭이 아래 <roster>에 있고 팀이 '미정'이 아니면 그 팀을 쓴다. to/to_whom에는 명단의 이름을 쓴다.
   - 명단에 없거나 팀이 '미정'이면 발언 내용으로 역할을 판단한다 (예: 화면·UI·마이페이지 노출 작업 → 프론트, 서버·API·DB·쿠폰 계산·주문·정산 로직 → 백엔드, 정산 운영·CS → 운영 쪽). 개발이라고만 하고 어느 쪽인지 드러나지 않으면 다루는 작업 내용으로 판단한다. 근거가 없으면 기타를 고른다.
   - 명단에 없는 사람이나 팀을 지어내지 않는다.
11. 모든 문장은 짧은 한국어로 쓴다.

<roster>
${rosterText(directory)}
</roster>${previousText(previous)}`;
}

export async function analyze({ transcript, owner, meetingDate, title, attendees, directory, previous }) {
  if (isMock()) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'mock-analysis.json'), 'utf8'));
  }
  return callClaude({
    system: systemPrompt({ owner, meetingDate, teams: teamEnum(directory), directory, previous }),
    user: `회의 제목: ${title}\n참석자: ${attendees.join(', ')}\n\n<transcript>\n${transcript}\n</transcript>`,
    schema: buildSchema(teamEnum(directory), previous?.items.map((t) => t.id) || []),
  });
}

/* ---------- 정책 답변 ---------- */
const POLICY_SCHEMA = obj({
  found: { type: 'boolean', description: '정책 문서에서 답의 근거를 찾았으면 true' },
  answer: { type: 'string', description: '짧은 해요체 답변. 근거가 없으면 찾을 수 없다고만 쓴다' },
  citations: arr(obj({ doc_title: str, article: str, quote: str })),
  follow_up: { type: 'string', description: '정책에 없어 담당자에게 확인할 점. 없으면 빈 문자열' },
});

export async function askPolicy(question, policies) {
  if (isMock()) {
    return {
      found: true,
      answer: '[연습 모드 예시] 출고가 7일 이상 늦어지면 출고 전까지 수수료 없이 전액 취소할 수 있어요.',
      citations: [{ doc_title: '예약판매 취소·환불 정책', article: '제5조 (출고 지연)', quote: '출고 지연 안내를 받은 고객은 출고 전까지 수수료 없이 전액 취소할 수 있다.' }],
      follow_up: '',
    };
  }
  const docs = policies
    .map((p) => `<document title="${p.title}" source="${p.source}">\n${p.text}\n</document>`)
    .join('\n\n');
  return callClaude({
    system: `너는 이커머스 PM과 운영팀이 사내 정책을 확인할 때 쓰는 정책 답변 도우미다.
규칙:
1. 아래 <policies>의 문서 내용만 근거로 답한다. 문서에 없는 내용은 추측하지 않는다.
2. 근거를 찾지 못하면 found=false, answer는 "정책 문서에서 찾을 수 없어요."로 쓰고, follow_up에 누구에게 무엇을 확인하면 좋을지 적는다.
3. citations의 quote는 문서 문장을 한 글자도 바꾸지 말고 그대로 옮긴다. article에는 "제5조 (출고 지연)"처럼 조 번호와 제목을 쓴다.
4. 숫자·기간·금액은 문서에 적힌 그대로 쓴다.
5. 문서끼리 충돌하거나 정책이 모호하면 answer에 그 사실을 밝히고 follow_up에 확인할 점을 쓴다.
6. 짧고 쉬운 해요체로 답한다.

<policies>
${docs}
</policies>`,
    user: question,
    schema: POLICY_SCHEMA,
    effort: 'low',
  });
}

/* ---------- 문구 검수 (용어집) ---------- */
const REVIEW_SCHEMA = obj({
  summary: { type: 'string', description: '검수 결과 한두 문장' },
  issues: arr(obj({ original: str, suggestion: str, term: str, reason: str, source: { type: 'string', enum: ['용어집', '사이트 표기', '혼용 포인트'] } })),
});

function siteText(site) {
  if (!site?.rows?.length && !site?.notes?.length) return '';
  const rows = site.rows.map((r) => `| ${r.mall} | ${r.screen} | ${r.key} | ${r.text} | ${r.ko || '-'} | ${r.en || '-'} | ${r.note || '-'} |`).join('\n');
  const notes = site.notes.map((x) => `- ${x}`).join('\n') || '- 없음';
  return `\n\n<site_strings>\n| 몰 | 화면 | 문구 키 | 표기 | 한국어 | 영어 | 위치·비고 |\n${rows}\n</site_strings>\n\n<site_notes>\n${notes}\n</site_notes>`;
}

export async function reviewWording({ text, lang, glossary, ruleFindings, site }) {
  if (isMock()) {
    // 예시 문구(JP몰 공지)에 들어 있는 표현으로 '바로 적용' 흐름을 보여준다
    const sample = [
      { source: '사이트 표기', original: '価額', suggestion: '価格', term: '(연습 모드 예시)', reason: '[연습 모드 예시] 정렬 메뉴 화면에는 「価格が安い順」으로 쓰여요.' },
      { source: '혼용 포인트', original: '最近チェックした商品', suggestion: '最近見た商品', term: '(연습 모드 예시)', reason: '[연습 모드 예시] 같은 목록을 화면마다 다르게 불러요. 마이페이지 메뉴 이름에 맞추는 것을 권해요.' },
    ].filter((x) => text.includes(x.original));
    return { summary: `[연습 모드 예시] 실제 AI 대신 정해진 예시 결과예요. ${sample.length}건을 찾았어요.`, issues: sample };
  }
  const table = glossary
    .map((g) => `| ${g.ko} | ${g.avoid.join(', ') || '-'} | ${g.en} | ${g.ja} | ${g.note || '-'} |`)
    .join('\n');
  const already = ruleFindings.map((f) => `- ${f.line}행 "${f.found}" → "${f.suggestion}"`).join('\n') || '- 없음';
  const target = { ko: '한국어', en: '영어', ja: '일본어' }[lang] || '한국어';
  const glossaryBlock = glossary.length
    ? `\n\n<glossary>\n| 공식 표기 | 쓰지 말 것 | English | 日本語 | 비고 |\n${table}\n</glossary>`
    : '';
  return callClaude({
    system: `너는 K-pop 굿즈 쇼핑몰의 기획서·공지 문구 검수자다. 실제 사이트 화면 문구(<site_strings>)를 기준으로 ${target} 문서를 검수한다.
규칙:
1. 기준과 다르게 쓰인 표현만 찾는다. 문체·맞춤법 일반 교정은 하지 않는다.
2. <site_strings>는 실제 사이트 화면에 쓰이는 표기다. 문서가 같은 화면 요소(버튼·메뉴·상태·탭 이름)를 가리키는데 사이트 표기와 다르게 썼으면 지적한다. 한국어 문서는 '한국어' 열, 영어 문서는 '영어' 열, 일본어 문서는 '표기' 열(해당 몰 화면 문구)이 기준이다. term에는 문구 키를 쓴다. 이벤트명·상품명처럼 시즌마다 바뀌는 문구는 기준으로 삼지 않는다.
3. <site_notes>는 사이트에서 같은 뜻의 표기가 섞여 쓰이는 지점이다. 문서가 그중 하나를 쓰면 어떤 화면 기준인지 확인하라고 reason에 적는다.
4. original은 문서에서 바꿀 부분만 적힌 그대로 짧게 옮기고, suggestion에는 그 자리에 그대로 넣을 표현을 쓴다. PM이 '적용'을 누르면 문서의 original이 suggestion으로 바뀌므로, 바꾼 뒤에도 문장이 자연스러워야 한다 (original에 포함한 조사·괄호·앞뒤 단어는 suggestion에도 똑같이 남긴다).
5. 확실하지 않은 것은 넣지 않는다. 문제가 없으면 issues는 빈 배열이다.
6. source에는 근거가 된 기준(사이트 표기 / 혼용 포인트${glossary.length ? ' / 용어집' : ''})을 쓴다.${glossary.length ? `
7. <glossary>가 있으면 공식 표기도 기준으로 삼는다. 규칙 검사가 이미 찾은 항목은 다시 넣지 않는다. 용어집과 사이트 표기가 다르면 둘 다 reason에 적어 PM이 고르게 한다.` : ''}${glossaryBlock}

<rule_findings>
${already}
</rule_findings>${siteText(site)}`,
    user: `<document lang="${lang}">\n${text}\n</document>`,
    schema: REVIEW_SCHEMA,
    effort: 'low',
  });
}

/* ---------- 공통 호출 ---------- */
async function callClaude({ system, user, schema, effort = 'medium' }) {
  let response;
  try {
    response = await claude().beta.messages.create({
      model: analysisModel(),
      max_tokens: 16000,
      output_config: { effort, format: { type: 'json_schema', schema } },
      // 안전 분류기가 거절하면 서버가 다른 모델로 한 번 더 시도한다
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error('Claude API 키가 올바르지 않아요. .env를 확인해 주세요.');
    if (error instanceof Anthropic.RateLimitError) throw new Error('Claude 요청이 많아요. 잠시 후 다시 시도해 주세요.');
    if (error instanceof Anthropic.APIError) throw new Error(`Claude 요청 실패 (${error.status}) ${error.message}`);
    throw error;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error(`AI가 요청을 거절했어요: ${response.stop_details?.explanation || '사유 미상'}`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('입력이 너무 길어 답이 중간에 끊겼어요. 나눠서 넣어 주세요.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('AI 응답이 비어 있어요. 다시 시도해 주세요.');
  return JSON.parse(text);
}
