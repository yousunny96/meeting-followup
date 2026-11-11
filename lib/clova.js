// 녹음 → 텍스트: 네이버클라우드 CLOVA Speech 장문 인식 (로컬 파일 업로드, sync)
// 문서: https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-longsentence-local
// - POST {Invoke URL}/recognizer/upload, multipart: media(파일) + params(JSON 문자열)
// - 헤더 X-CLOVASPEECH-API-KEY: 앱의 Secret Key
// - 화자 구분(diarization)을 켜서 "화자 A 00:12" 형태의 전사본으로 돌려준다
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';

export const clovaEnabled = () => Boolean(process.env.CLOVA_SPEECH_INVOKE_URL && process.env.CLOVA_SPEECH_SECRET);

const mmss = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

// 같은 화자가 이어 말한 구간은 한 덩어리로 묶는다
export function segmentsToTranscript(segments = []) {
  const blocks = [];
  for (const seg of segments) {
    const who = seg.speaker?.name || seg.speaker?.label || seg.diarization?.label || '';
    const text = String(seg.textEdited || seg.text || '').trim();
    if (!text) continue;
    const last = blocks.at(-1);
    if (last && who && last.who === who) last.text += ` ${text}`;
    else blocks.push({ who, start: seg.start, text });
  }
  const speakers = [...new Set(blocks.map((b) => b.who).filter(Boolean))];
  // 화자가 있으면 화자별 문단, 없으면 구간마다 한 줄
  const transcript = speakers.length
    ? blocks.map((b) => (b.who ? `화자 ${b.who} ${mmss(b.start)}\n${b.text}` : b.text)).join('\n\n')
    : blocks.map((b) => b.text).join('\n');
  return { transcript, speakers: speakers.map((s) => `화자 ${s}`) };
}

// fetch는 응답 헤더를 5분까지만 기다려서, 긴 녹음(sync)도 받을 수 있게 http(s).request로 보낸다
function post(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('CLOVA Speech 응답이 너무 오래 걸려요. 녹음을 나눠서 올려 주세요.')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function clovaTranscribe(filePath, originalName, { boostWords = [] } = {}) {
  const params = {
    language: 'ko-KR',
    completion: 'sync',
    wordAlignment: false,
    fullText: true,
    diarization: { enable: true },
  };
  // 팀 명단의 이름을 더 잘 알아듣게 한다 (한국어·영어만, 최대 500개 권장)
  const words = [...new Set(boostWords.map((w) => String(w).trim()).filter((w) => /^[가-힣A-Za-z0-9 ]{2,20}$/.test(w)))].slice(0, 500);
  if (words.length) params.boostings = [{ words: words.join(','), weight: 2 }];

  const form = new FormData();
  // 한글 파일 이름은 업로드 과정에서 깨질 수 있어 확장자만 살린 영문 이름으로 보낸다
  const ext = (String(originalName || '').match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0].toLowerCase();
  form.append('media', new Blob([fs.readFileSync(filePath)]), `meeting${ext}`);
  form.append('params', JSON.stringify(params));
  // FormData를 multipart 바이트로 바꾼다 (경계 문자열이 들어간 Content-Type 포함)
  const packed = new Request('http://local/', { method: 'POST', body: form });
  const body = Buffer.from(await packed.arrayBuffer());

  const base = process.env.CLOVA_SPEECH_INVOKE_URL.replace(/\/+$/, '');
  const res = await post(
    `${base}/recognizer/upload`,
    { 'Content-Type': packed.headers.get('content-type'), 'X-CLOVASPEECH-API-KEY': process.env.CLOVA_SPEECH_SECRET },
    body,
    20 * 60 * 1000
  );
  let data = {};
  try { data = JSON.parse(res.text); } catch {}
  const ok = res.status >= 200 && res.status < 300 && ['COMPLETED', 'SUCCEEDED'].includes(String(data.result || '').toUpperCase());
  if (!ok) {
    const why = data.message || data.result || res.text.slice(0, 200);
    const hint = res.status === 401 || /SECRET/i.test(why) ? ' (Secret Key를 확인해 주세요)' : '';
    throw new Error(`CLOVA Speech 변환 실패 (${res.status}) ${why}${hint}`.trim());
  }
  const out = data.segments?.length ? segmentsToTranscript(data.segments) : { transcript: String(data.text || '').trim(), speakers: [] };
  if (!out.transcript) throw new Error('CLOVA Speech가 알아들은 말이 없어요. 녹음 파일을 확인해 주세요.');
  return { ...out, engine: 'CLOVA Speech' };
}
