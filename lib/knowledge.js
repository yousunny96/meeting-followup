// 정책 문서와 용어집 읽기
// - knowledge/policies/*.md : 노션·지라에서 내보낸 정책 문서를 넣는 곳 (지금은 가상 자료)
// - knowledge/용어집.csv     : 사이트에서 쓰는 공식 표기와 번역어
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const POLICY_DIR = path.join(ROOT, 'knowledge', 'policies');
const GLOSSARY = path.join(ROOT, 'knowledge', '용어집.csv');

export function loadPolicies() {
  return fs
    .readdirSync(POLICY_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(POLICY_DIR, file), 'utf8');
      const title = (text.match(/^#\s+(.+)$/m) || [, file])[1].trim();
      const source = (text.match(/^출처 표시:\s*(.+)$/m) || [, '출처 미상'])[1].trim();
      return { file, title, source, text };
    });
}

export function loadGlossary() {
  if (!fs.existsSync(GLOSSARY)) return [];
  const [header, ...rows] = fs.readFileSync(GLOSSARY, 'utf8').trim().split('\n');
  return rows
    .filter((r) => r.trim())
    .map((r) => {
      const [ko, avoid, en, ja, note] = r.split(',').map((c) => (c ?? '').trim());
      return { ko, avoid: avoid ? avoid.split('|').map((s) => s.trim()).filter(Boolean) : [], en, ja, note: note || '' };
    });
}

// 규칙 기반 검사: "쓰지 말 것" 표현이 한국어 문서에 들어갔는지 찾는다 (AI 없이 항상 같은 결과)
export function findAvoidedTerms(text, glossary = loadGlossary()) {
  const findings = [];
  const lines = text.split('\n');
  for (const g of glossary) {
    // 공식 표기 안에 들어 있는 부분 문자열은 제외 (예: '팬사인회' 안의 '사인회')
    for (const bad of g.avoid) {
      lines.forEach((line, i) => {
        const official = [];
        for (let p = line.indexOf(g.ko); p !== -1; p = line.indexOf(g.ko, p + 1)) official.push([p, p + g.ko.length]);
        for (let p = line.indexOf(bad); p !== -1; p = line.indexOf(bad, p + 1)) {
          const inside = official.some(([s, e]) => p >= s && p + bad.length <= e);
          if (!inside) findings.push({ line: i + 1, found: bad, suggestion: g.ko, context: line.trim().slice(0, 80) });
        }
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

// 사이트 UI 문구 1,000여 행을 매번 다 보내지 않고, 문서에 나온 표현과 '주요 문구'만 고른다
export function selectUiStrings(text, rows, limit = 400) {
  const hit = (s) => s && s.length >= 2 && text.includes(s);
  const matched = rows.filter((r) => hit(r.text) || hit(r.ko) || hit(r.en));
  const out = [];
  const seen = new Set();
  for (const r of [...matched, ...rows.filter((r) => r.core)]) {
    const k = `${r.mall}|${r.key}|${r.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= limit) break;
  }
  return { rows: out, matched: matched.length };
}
