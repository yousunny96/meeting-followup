// 승인된 회의 정리본을 Markdown 파일로 저장 (팀 공유·노션 붙여넣기용)
import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './store.js';

const cell = (v) => String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const kst = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
const due = (d, text) => (d ? `${d}` : `미정 (${text || '기한 언급 없음'})`);

export function renderMarkdown(meeting, version) {
  const f = version.final;
  const lines = [
    `# ${meeting.title}`,
    '',
    `- 회의 ID: ${meeting.id} · v${version.version}`,
    `- 회의 날짜: ${meeting.meetingDate}`,
    `- 참석자: ${meeting.attendees.join(', ')}`,
    `- 정리: AI 초안(${version.model}) → ${version.approvedBy} 검토·승인 (${kst(version.approvedAt)} KST)`,
    '',
    '## 요약',
    '',
    f.summary,
    '',
    '## 결정사항',
    '',
    ...(f.decisions.length ? f.decisions.map((d) => `- ${d.content}`) : ['- 없음']),
    '',
    '## 내 할 일',
    '',
    '| 할 일 | 기한 |',
    '| --- | --- |',
    ...f.my_tasks.map((t) => `| ${cell(t.task)} | ${cell(due(t.due, t.due_text))} |`),
    '',
    '## 개발자 확인 요청',
    '',
    '| 팀 | 대상 | 확인할 내용 | 기한 |',
    '| --- | --- | --- | --- |',
    ...f.dev_requests.map((r) => `| ${cell(r.team || '-')} | ${cell(r.to)} | ${cell(r.question)} | ${cell(due(r.due, r.due_text))} |`),
    '',
    '## 다시 물어볼 것',
    '',
    ...(f.open_questions.length
      ? f.open_questions.map((q) => `- [${q.team || '기타'}] **${q.to_whom}**: ${q.question} — ${q.why}`)
      : ['- 없음']),
    '',
    ...(f.followups?.length
      ? ['## 이전 회의에서 이어진 항목', '', ...f.followups.map((x) => `- [${x.outcome === 'resolved' ? (x.apply ? '결정됨 · 반영' : '결정됨 · 미반영') : '아직 미결'}] ${x.item || x.task_id} → ${x.answer}`), '']
      : []),
    '## BM 논의',
    '',
    ...f.bm.discussed.map((b) => `- **${b.topic}**: ${b.current_state} (확인할 숫자: ${b.numbers_to_check})`),
    '',
    '## 채택한 BM 가설',
    '',
    ...(f.bm.hypotheses.length
      ? f.bm.hypotheses.flatMap((h) => [
          `### ${h.name}`,
          '',
          `- 수익 구조: ${h.revenue_logic}`,
          `- 핵심 가정: ${h.key_assumption}`,
          `- 검증 지표: ${h.metric}`,
          `- 위험: ${h.risk}`,
          '',
        ])
      : ['- 채택한 가설 없음', '']),
  ];
  return lines.join('\n');
}

export function saveReviewMarkdown(review) {
  const stamp = new Date(review.at).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(/[-: ]/g, '');
  let file = `검수_${stamp}.md`;
  for (let n = 2; fs.existsSync(path.join(OUTPUT_DIR, file)); n++) file = `검수_${stamp}_${n}.md`; // 이전 결과를 덮어쓰지 않는다
  const lang = { ko: '한국어', en: '영어', ja: '일본어' }[review.lang];
  const lines = [
    `# 문구 검수: ${review.title}`,
    '',
    `- 검수 시각: ${kst(review.at)} KST · 언어: ${lang}`,
    `- 규칙 검사 ${review.ruleFindings.length}건 · AI 검수(${review.model}) ${review.ai.issues.length}건`,
    '',
    ...(review.site?.total ? [`- 사이트 UI 문구(노션, ${review.site.malls.join('·')}몰): 전체 ${review.site.total}개 중 관련 ${review.site.used}개와 혼용 포인트 ${review.site.notes}개 참고`] : []),
    ...(review.site?.error ? [`- 사이트 UI 문구를 못 읽음: ${review.site.error}`] : []),
    '',
    `> ${review.ai.summary}`,
    '',
    ...(review.hasGlossary
      ? ['## 규칙 검사 (쓰지 말 것 목록과 일치)', '', ...(review.ruleFindings.length
          ? ['| 행 | 찾은 표현 | 공식 표기 | 문맥 |', '| --- | --- | --- | --- |',
             ...review.ruleFindings.map((f) => `| ${f.line} | ${cell(f.found)} | ${cell(f.suggestion)} | ${cell(f.context)} |`)]
          : ['- 없음']), '']
      : []),
    '## 검수 결과',
    '',
    ...(review.ai.issues.length
      ? ['| 구분 | 문서 표현 | 바꿀 표기 | 용어·문구 키 | 이유 |', '| --- | --- | --- | --- | --- |',
         ...review.ai.issues.map((i) => `| ${cell({ '사이트 표기': '사이트와 다름', '혼용 포인트': '화면마다 다름' }[i.source] || i.source || '-')} | ${cell(i.original)} | ${cell(i.suggestion)} | ${cell(i.term)} | ${cell(i.reason)} |`)]
      : ['- 없음']),
    '',
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, file), lines.join('\n'));
  return `output/${file}`;
}

export function saveMarkdown(meeting, version) {
  const file = `${meeting.id}_v${version.version}.md`;
  fs.writeFileSync(path.join(OUTPUT_DIR, file), renderMarkdown(meeting, version));
  return `output/${file}`;
}
