import torch
import typing
import collections
from omegaconf.listconfig import ListConfig
from omegaconf.base import ContainerMetadata

torch.serialization.add_safe_globals([
    ListConfig,
    ContainerMetadata,
    typing.Any,
    list,
    dict,
    tuple,
    set,
    frozenset,
    int,
    float,
    bool,
    str,
    bytes,
    collections.defaultdict
])

import whisperx
import sys
import json

if len(sys.argv) != 3:
    print("Usage: python align_per_verse.py <audio_path> <script_path>")
    sys.exit(1)

audio_path = sys.argv[1]
script_path = sys.argv[2]
device = "cuda" if torch.cuda.is_available() else "cpu"

# Read verses
verses = []
with open(script_path, "r", encoding="utf-8") as f:
    for line in f:
        if line.strip():
            num, text = line.strip().split("|", 1)
            verses.append({"verse": int(num), "text": text})

model = whisperx.load_model(
    "medium.en",
    device,
    compute_type="float16" if device == "cuda" else "float32",
    vad_model=None,  # disables Pyannote VAD
    vad_options=None
)

# Create fake transcription for alignment
segments = [{"text": v["text"], "start": 0.0, "end": 0.0} for v in verses]

# Load alignment model
model_a, metadata = whisperx.load_align_model(language_code="en", device=device)

# Align all segments
aligned = whisperx.align(segments, model_a, metadata, audio_path, device)

# Map aligned words back to verses
verse_outputs = []
for i, verse in enumerate(verses):
    verse_outputs.append({
        "verse": verse["verse"],
        "text": verse["text"],
        "words": aligned[i]["words"],
        "start": aligned[i]["words"][0]["start"],
        "end": aligned[i]["words"][-1]["end"]
    })

print(json.dumps(verse_outputs, ensure_ascii=False, indent=2))