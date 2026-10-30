# Aligner

Verse timings for Bible audio with Meta's MMS forced aligner (`torchaudio.pipelines.MMS_FA`) on the GPU. Needs `ffmpeg` on the PATH.

```sh
py -3.11 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app:app --port 8765
```

`POST /align {audioUrl, language (iso 639-3), verses: [{verse, text}]}` returns `{durationMs, gpuMs, timings: [{verse, startMs, endMs}]}`.
