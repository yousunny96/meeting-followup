// 기한 글자 입력을 날짜(YYYY-MM-DD)로 바꾼다. 못 알아보면 null.
// base: 기준일(YYYY-MM-DD). 검토 화면에서는 회의 날짜, 할 일 보드에서는 오늘.
// 받는 형식 예: 2026-11-28 · 2026.11.28 · 20261128 · 11/28 · 11.28 · 1128 · 11월 28일 · 28일
//              오늘 · 내일 · 모레 · 금 · 금요일 · 이번주 금 · 다음주 월 · 3일 후 · 2주 뒤 · 월말 · 다음달 5일
const WEEK = '일월화수목금토';
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const make = (y, m, d) => {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function parseDue(text, base) {
  const [by, bm, bd] = (base || '').split('-').map(Number);
  const b = by ? new Date(by, bm - 1, bd) : new Date(new Date().setHours(0, 0, 0, 0));
  let s = String(text ?? '')
    .trim()
    .replace(/\([^)]*\)/g, ' ') // (금) 같은 요일 표기
    .replace(/(까지|이내|안에|중|쯤|경|정도|오전|오후)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // 연도 없는 월·일: 기준일보다 두 달 넘게 앞서면 다음 해로 본다
  const guessYear = (m, d) => {
    const dt = make(b.getFullYear(), m, d);
    if (dt && dt < addDays(b, -60)) return make(b.getFullYear() + 1, m, d);
    return dt;
  };
  const out = (dt) => (dt ? iso(dt) : null);
  let r;

  // 숫자만 (구분자 없음)
  if ((r = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return out(make(+r[1], +r[2], +r[3]));
  if ((r = s.match(/^(\d{2})(\d{2})(\d{2})$/))) return out(make(2000 + +r[1], +r[2], +r[3]));
  if ((r = s.match(/^(\d{1,2})(\d{2})$/))) return out(guessYear(+r[1], +r[2]));

  // 연·월·일 (구분자 . / - 또는 년월일)
  if ((r = s.match(/^(\d{2,4})\s*[.\/\-년]\s*(\d{1,2})\s*[.\/\-월]\s*(\d{1,2})\s*일?\.?$/))) {
    const y = r[1].length === 2 ? 2000 + +r[1] : +r[1];
    return out(make(y, +r[2], +r[3]));
  }
  // 월·일
  if ((r = s.match(/^(\d{1,2})\s*[.\/\-월]\s*(\d{1,2})\s*일?\.?$/))) return out(guessYear(+r[1], +r[2]));

  // 상대 날짜
  const words = { 오늘: 0, 금일: 0, 내일: 1, 명일: 1, 모레: 2, 내일모레: 2, 글피: 3 };
  if (s.replace(/ /g, '') in words) return out(addDays(b, words[s.replace(/ /g, '')]));
  if ((r = s.match(/^(\d+)\s*(일|주|달|개월)\s*(후|뒤)$/))) {
    const n = +r[1];
    if (r[2] === '일') return out(addDays(b, n));
    if (r[2] === '주') return out(addDays(b, n * 7));
    const dt = new Date(b.getFullYear(), b.getMonth() + n, b.getDate());
    return out(dt.getDate() === b.getDate() ? dt : new Date(b.getFullYear(), b.getMonth() + n + 1, 0));
  }

  // 이번 달 / 다음 달
  const t = s.replace(/ /g, '');
  if ((r = t.match(/^(이번달|이달|다음달|담달|다다음달)?(말|말일|월말)$/))) {
    const add = { 다음달: 1, 담달: 1, 다다음달: 2 }[r[1]] || 0;
    return out(new Date(b.getFullYear(), b.getMonth() + add + 1, 0));
  }
  if ((r = t.match(/^(이번달|이달|다음달|담달|다다음달)?(초)$/))) {
    const add = { 다음달: 1, 담달: 1, 다다음달: 2 }[r[1]] ?? 1;
    return out(new Date(b.getFullYear(), b.getMonth() + add, 1));
  }
  if ((r = t.match(/^(이번달|이달|다음달|담달|다다음달)?(\d{1,2})일$/))) {
    const add = { 다음달: 1, 담달: 1, 다다음달: 2 }[r[1]];
    if (add !== undefined) return out(make(new Date(b.getFullYear(), b.getMonth() + add, 1).getFullYear(), new Date(b.getFullYear(), b.getMonth() + add, 1).getMonth() + 1, +r[2]));
    // "28일"만: 이번 달, 이미 지났으면 다음 달
    let dt = make(b.getFullYear(), b.getMonth() + 1, +r[2]);
    if (!dt || dt < b) { const nm = new Date(b.getFullYear(), b.getMonth() + 1, 1); dt = make(nm.getFullYear(), nm.getMonth() + 1, +r[2]); }
    return out(dt);
  }

  // 요일 (이번주·다음주·다다음주 + 월~일)
  if ((r = t.match(/^(이번주|이번|금주|다음주|담주|차주|다음|다다음주)?([일월화수목금토])(요일)?$/))) {
    const want = WEEK.indexOf(r[2]);
    const mondayIdx = (d) => (d.getDay() + 6) % 7; // 월=0 … 일=6
    const wantM = (want + 6) % 7;
    const weekAdd = { 다음주: 1, 담주: 1, 차주: 1, 다음: 1, 다다음주: 2 }[r[1]];
    if (weekAdd !== undefined || r[1]) {
      const monday = addDays(b, -mondayIdx(b));
      return out(addDays(monday, (weekAdd || 0) * 7 + wantM));
    }
    // 요일만: 기준일 이후(당일 포함) 가장 가까운 그 요일
    return out(addDays(b, (want - b.getDay() + 7) % 7));
  }
  return null;
}

export const weekdayOf = (v) => WEEK[new Date(v + 'T00:00:00').getDay()];
