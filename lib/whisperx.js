// 녹음 → 텍스트: whisperX (로컬, 무료). 화자 구분은 pyannote 모델이라 HF_TOKEN이 필요하다.
// tools/whisperx_transcribe.py 를 앱 전용 가상환경(.venv-whisperx)의 파이썬으로 실행한다.
// - WHISPERX_PYTHON: 다른 파이썬을 쓰려면 경로 지정 / WHISPERX=0: 끄기
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { segmentsToTranscript } from './clova.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'whisperx_transcribe.py');
const pythonPath = () => process.env.WHISPERX_PYTHON || path.join(ROOT, '.venv-whisperx', 'bin', 'python');

export const whisperxEnabled = () => process.env.WHISPERX !== '0' && !process.env.VERCEL && fs.existsSync(pythonPath());
export const whisperxDiarizes = () => Boolean(process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN);

export function whisperxTranscribe(filePath, { minSpeakers, maxSpeakers } = {}) {
  const args = [SCRIPT, filePath];
  if (minSpeakers) args.push('--min', String(minSpeakers));
  if (maxSpeakers) args.push('--max', String(maxSpeakers));
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), args, { env: { ...process.env, PYTHONWARNINGS: 'ignore' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`whisperX를 실행하지 못했어요: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop() || '';
      let data;
      try { data = JSON.parse(line); } catch {
        const tail = err.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        return reject(new Error(`whisperX 변환 실패 (종료 코드 ${code}) ${tail}`.trim()));
      }
      const { transcript, speakers } = segmentsToTranscript(
        data.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, speaker: s.speaker ? { name: s.speaker } : null }))
      );
      if (!transcript) return reject(new Error('whisperX가 알아들은 말이 없어요. 녹음 파일을 확인해 주세요.'));
      resolve({ transcript, speakers, engine: 'whisperX', warning: data.warning || '' });
    });
  });
}
