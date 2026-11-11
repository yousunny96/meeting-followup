// 팀·구성원 명단
// - 노션 '팀·구성원' DB(NOTION_TEAM_DS_ID)가 연결돼 있으면 거기서 읽고 쓴다: '팀' 선택지 = 팀 목록, 각 행 = 구성원
// - 연결이 없으면 knowledge/teams.json 을 쓴다
import fs from 'node:fs';
import path from 'node:path';
import * as notion from './notion.js';

const FILE = path.resolve(import.meta.dirname, '..', 'knowledge', 'teams.json');
const DEFAULT = {
  teams: [
    { name: '프론트', color: 'purple' },
    { name: '백엔드', color: 'brown' },
    { name: '디자이너', color: 'pink' },
    { name: '운영팀', color: 'green' },
    { name: '마케팅팀', color: 'orange' },
    { name: '사업·MD', color: 'blue' },
    { name: '기획(PM)', color: 'red' },
    { name: '미정', color: 'gray' },
  ],
  members: [],
};
export const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];

const useNotion = () => notion.notionEnabled() && Boolean((process.env.NOTION_TEAM_DS_ID || '').trim());
const readLocal = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : structuredClone(DEFAULT));
const writeLocal = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));

function cleanName(s, what) {
  const v = String(s || '').trim();
  if (!v) throw new Error(`${what}을 적어 주세요.`);
  if (v.length > 30) throw new Error(`${what}은 30자 이하로 적어 주세요.`);
  return v;
}

export async function loadDirectory() {
  if (useNotion()) return { origin: 'notion', ...(await notion.loadNotionTeams()) };
  return { origin: 'local', ...readLocal() };
}

export async function addTeam(name, color) {
  name = cleanName(name, '팀 이름');
  color = COLORS.includes(color) ? color : 'gray';
  const dir = await loadDirectory();
  if (dir.teams.some((t) => t.name === name)) throw new Error('이미 있는 팀이에요.');
  if (useNotion()) return notion.addNotionTeam(name, color);
  const d = readLocal();
  d.teams.push({ name, color });
  writeLocal(d);
}

export async function addMember({ name, team, role, aliases }) {
  name = cleanName(name, '이름');
  const dir = await loadDirectory();
  if (team && !dir.teams.some((t) => t.name === team)) throw new Error('없는 팀이에요. 먼저 팀을 추가해 주세요.');
  const member = { name, team: team || '미정', role: String(role || '').trim(), aliases: String(aliases || '').trim() };
  if (useNotion()) return notion.addNotionMember(member);
  const d = readLocal();
  d.members.push({ id: `L-${Date.now()}`, ...member });
  writeLocal(d);
}

export async function updateMember(id, patch) {
  const allowed = {};
  for (const k of ['name', 'team', 'role', 'aliases']) if (patch[k] !== undefined) allowed[k] = String(patch[k]).trim();
  if (allowed.name !== undefined) allowed.name = cleanName(allowed.name, '이름');
  if (allowed.team !== undefined) {
    const dir = await loadDirectory();
    if (!dir.teams.some((t) => t.name === allowed.team)) throw new Error('없는 팀이에요.');
  }
  if (useNotion()) return notion.updateNotionMember(id, allowed);
  const d = readLocal();
  const m = d.members.find((x) => x.id === id);
  if (!m) throw new Error('구성원을 찾을 수 없어요.');
  Object.assign(m, allowed);
  writeLocal(d);
}
