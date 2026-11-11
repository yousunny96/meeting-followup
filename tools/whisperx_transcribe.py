"""녹음 → 화자 구분 전사본 (whisperX, 로컬 실행)

사용: python tools/whisperx_transcribe.py <오디오 파일> [--model large-v3-turbo] [--min 2 --max 6]
출력: 마지막 줄에 JSON 한 줄 {segments:[{start,end,text,speaker}], diarized, warning}
- start/end는 밀리초, speaker는 등장 순서대로 A, B, C …
- 화자 구분은 pyannote 모델을 쓰므로 HF_TOKEN(허깅페이스 토큰)이 있어야 한다.
  토큰이 없거나 실패하면 전사만 하고 warning에 이유를 남긴다.
"""
import argparse
import inspect
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default=os.environ.get("WHISPERX_MODEL", "large-v3-turbo"))
    ap.add_argument("--language", default="ko")
    ap.add_argument("--min", type=int, default=None, dest="min_speakers")
    ap.add_argument("--max", type=int, default=None, dest="max_speakers")
    args = ap.parse_args()

    import whisperx

    device = "cpu"  # 정렬·화자 구분(torch)은 CPU
    # 전사(faster-whisper)는 애플 실리콘이면 맥 GPU(MPS)로 먼저 시도하고, 안 되면 CPU로 돌아간다.
    # (M4에서 2분 17초 녹음: CPU 158초 → MPS 105초) WHISPERX_DEVICE=cpu 로 고정할 수 있다.
    import platform
    want = os.environ.get("WHISPERX_DEVICE") or ("mps" if platform.system() == "Darwin" and platform.machine() == "arm64" else "cpu")
    model = None
    for asr_device in ([want, "cpu"] if want != "cpu" else ["cpu"]):
        try:
            log(f"모델 불러오는 중: {args.model} ({asr_device})")
            model = whisperx.load_model(args.model, asr_device, compute_type="int8" if asr_device == "cpu" else "float16", language=args.language)
            break
        except Exception as e:  # noqa: BLE001
            log(f"{asr_device}로 불러오지 못해 다음 방법으로: {e}")
    if model is None:
        raise SystemExit("whisperX 모델을 불러오지 못했어요.")
    audio = whisperx.load_audio(args.audio)
    log("전사 중…")
    result = model.transcribe(audio, batch_size=8, language=args.language)
    warning = ""

    # 단어 단위 시간 맞추기 (화자를 단어별로 붙이려면 필요). 실패해도 문장 단위로 계속한다.
    try:
        log("시간 정렬 중…")
        align_model, meta = whisperx.load_align_model(language_code=args.language, device=device)
        result = whisperx.align(result["segments"], align_model, meta, audio, device, return_char_alignments=False)
    except Exception as e:  # noqa: BLE001
        warning = f"단어 정렬 생략: {e}"

    diarized = False
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not token:
        warning = (warning + " / " if warning else "") + "HF_TOKEN이 없어 화자 구분은 하지 않았어요."
    else:
        try:
            log("화자 구분 중…")
            Pipeline = getattr(getattr(whisperx, "diarize", whisperx), "DiarizationPipeline", None) or whisperx.DiarizationPipeline
            params = inspect.signature(Pipeline.__init__).parameters
            kw = {"token": token} if "token" in params else {"use_auth_token": token}
            diarize = Pipeline(device=device, **kw)
            dkw = {}
            if args.min_speakers:
                dkw["min_speakers"] = args.min_speakers
            if args.max_speakers:
                dkw["max_speakers"] = args.max_speakers
            spk = diarize(audio, **dkw)
            result = whisperx.assign_word_speakers(spk, result)
            diarized = True
        except Exception as e:  # noqa: BLE001
            warning = (warning + " / " if warning else "") + f"화자 구분 실패: {e}"

    names = {}
    segments = []
    for s in result.get("segments", []):
        text = str(s.get("text", "")).strip()
        if not text:
            continue
        raw = s.get("speaker")
        name = ""
        if raw:
            if raw not in names:
                names[raw] = chr(ord("A") + len(names)) if len(names) < 26 else str(len(names) + 1)
            name = names[raw]
        segments.append({
            "start": int(float(s.get("start", 0)) * 1000),
            "end": int(float(s.get("end", 0)) * 1000),
            "text": text,
            "speaker": name,
        })
    print(json.dumps({"segments": segments, "diarized": diarized, "warning": warning}, ensure_ascii=False))


if __name__ == "__main__":
    main()
