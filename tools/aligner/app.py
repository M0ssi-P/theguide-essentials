import logging
import re
import subprocess
import threading
import time
import unicodedata

import torch
import torchaudio
import uroman
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

SR = 16000
WINDOW = 30 * SR
CONTEXT = SR  # 1 s of audio on each side of a window so frames at the edges see context

log = logging.getLogger('aligner')
logging.basicConfig(level=logging.INFO)

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model(with_star=True).to(device).eval()
if device.type == 'cuda':
    model = model.half()
tokenizer = bundle.get_tokenizer()
aligner = bundle.get_aligner()
letters = set(bundle.get_dict()) - {'-', '*'}
romanizer = uroman.Uroman()
gpu_lock = threading.Lock()

app = FastAPI()


class Verse(BaseModel):
    verse: int
    text: str


class AlignRequest(BaseModel):
    audioUrl: str
    language: str  # iso 639-3
    verses: list[Verse]


def decode(url: str) -> torch.Tensor:
    out = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', url, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
        capture_output=True,
    )
    if out.returncode != 0:
        raise HTTPException(502, f'ffmpeg failed: {out.stderr.decode()[:300]}')
    return torch.frombuffer(bytearray(out.stdout), dtype=torch.float32).unsqueeze(0)


def normalize(text: str, language: str) -> list[str]:
    text = unicodedata.normalize('NFKD', text.lower())
    text = ''.join(c for c in text if not unicodedata.combining(c))
    if re.search(r'[^\x00-\x7f]', text):
        text = romanizer.romanize_string(text, lcode=language).lower()
    text = text.replace('’', "'")
    words = (''.join(c for c in w if c in letters) for w in re.split(r"[^\w']+", text))
    return [w for w in words if w]


def emissions(wav: torch.Tensor) -> torch.Tensor:
    hop = bundle.sample_rate // 50  # MMS emits one frame per 20 ms
    frames = []
    for s in range(0, wav.size(1), WINDOW):
        e = min(s + WINDOW, wav.size(1))
        a, b = max(0, s - CONTEXT), min(wav.size(1), e + CONTEXT)
        em, _ = model(wav[:, a:b].to(device, next(model.parameters()).dtype))
        off = (s - a) // hop
        frames.append(em[0, off : off + -(-(e - s) // hop)].float())
    return torch.cat(frames).unsqueeze(0)


@app.post('/align')
def align(req: AlignRequest):
    t0 = time.perf_counter()
    wav = decode(req.audioUrl)
    duration_ms = round(wav.size(1) * 1000 / SR)

    words, owner = ['*'], [None]
    for v in req.verses:
        for w in normalize(v.text, req.language):
            words.append(w)
            owner.append(v.verse)

    with gpu_lock, torch.inference_mode():
        t1 = time.perf_counter()
        em = emissions(wav)
        try:
            spans = aligner(em[0], tokenizer(words))
        except RuntimeError as e:  # more text than audio frames
            raise HTTPException(422, f'alignment failed: {e}')
        if device.type == 'cuda':
            torch.cuda.synchronize()
        gpu_ms = round((time.perf_counter() - t1) * 1000)

    ms_per_frame = duration_ms / em.size(1)
    first, last = {}, {}
    for verse, span in zip(owner, spans):
        if verse is None:
            continue
        first.setdefault(verse, round(span[0].start * ms_per_frame))
        last[verse] = round(span[-1].end * ms_per_frame)

    timings = []
    for v in req.verses:
        start = first.get(v.verse, timings[-1]['endMs'] if timings else 0)
        timings.append({'verse': v.verse, 'startMs': start, 'endMs': last.get(v.verse, start)})
    # close gaps: each verse runs until the next one starts, the last one until the audio ends
    for cur, nxt in zip(timings, timings[1:]):
        cur['endMs'] = max(nxt['startMs'], cur['startMs'])
    if timings:
        timings[-1]['endMs'] = duration_ms
    for t in timings:
        if t['endMs'] - t['startMs'] < 300:
            log.warning('short verse %s: %s-%s ms in %s', t['verse'], t['startMs'], t['endMs'], req.audioUrl)

    total_ms = round((time.perf_counter() - t0) * 1000)
    log.info('aligned %d words in %d ms (gpu %d ms, audio %d ms)', len(words) - 1, total_ms, gpu_ms, duration_ms)
    return {'durationMs': duration_ms, 'gpuMs': gpu_ms, 'timings': timings}


@app.get('/health')
def health():
    return {'device': str(device), 'cuda': torch.cuda.is_available()}
