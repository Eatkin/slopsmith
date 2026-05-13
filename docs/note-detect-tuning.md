# Note Detection Tuning Workflow

How to iterate on the `note_detect` plugin's detection quality with objective, repeatable measurements instead of "feels worse / feels better" guesswork. The same workflow works for tuning the user's environment (A/V offset, latency comp, channel selection) and for tuning the detector code itself (frame size, confidence thresholds, chord-scoring algorithm).

## Why this exists

Detection quality varies by guitar pickup, audio interface, monitor latency, the user's playing style, and the chart's note density. Eyeballing the player UI tells you whether something feels right, not whether a change improved or regressed scoring. The pieces below let you record once and replay many times against arbitrary parameter combinations:

- **Reference recording** — captures the exact PCM frames the live detector saw, so a single take can be re-scored against any settings.
- **Benchmark sloppak** — a known, distributable chart with isolated failure-mode sections.
- **Headless harness** — runs the same `processFrame` / `matchNotes` / `checkMisses` code path the browser uses, off Node, in seconds per run.
- **Diagnostic JSON** — both live (in-browser) and harness output share the `note_detect.diagnostic.v1` schema, so cross-comparison is trivial.

## The benchmark sloppak

The distributable sloppak ships in-tree at [docs/benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak](benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak) — drop it directly in your sloppak DLC folder (e.g. `…/Steam/steamapps/common/Rocksmith2014/dlc/sloppak/`) and it shows up in the library. The file is a zip under the hood but slopsmith's loader (`is_sloppak`) keys off the `.sloppak` suffix, so don't rename. After playing it once it ends up extracted under `static/sloppak_cache/note_detect_benchmark_v1.sloppak/`, which is where the harness reads its `arrangements/lead.json` from. 90 BPM, 8 numbered sections, ~2:20 total:

| Section | Notes | Isolates |
|---|---|---|
| A. Open strings | 12 single notes | low-frequency YIN behaviour (E2=82 Hz) |
| B. 5th-fret positions | 12 single notes | mid-range pitch accuracy |
| C. 12th-fret octaves | sparse single notes | high-frequency YIN behaviour |
| D. Sustained notes | long-hold single notes | sustain matching / pure-miss vs detected |
| E. Hammer / pull | legato pairs | technique-flag handling, attack ambiguity |
| F. Power chords | 5–6 chord events | 2-string chord scorer |
| G. Open chords | 5–6 chord events | dense chord scorer (5+ strings ringing) |
| H. Bends | bend pairs | pitch-tolerance edge behaviour |

Every chart note has `sus > 0` — so anything you tune against this benchmark exercises the sustain path, not staccato detection. (If we add a staccato section later, the cleanest split is by section name; don't categorize by `sus` value on the event log — see the "Common pitfalls" section.)

To rebuild after edits to the exercise list, follow the docstring at the top of `build_benchmark.py`. The script writes both an unzipped directory (`.sloppak/`) and a zipped archive (`.sloppak.zip`). The slopsmith library scanner (`lib/sloppak.py::is_sloppak()`) matches on the `.sloppak` suffix, **not** on `.sloppak.zip` — the directory form is usable as-is, but the zip output needs its suffix swapped before it'll be discovered. After regenerating, copy the zip output to the tracked path with the `.sloppak` suffix so it stays a drop-in install:

```bash
cp static/sloppak_cache/note_detect_benchmark_v1.sloppak.zip \
   docs/benchmarks/note_detect_v1/note_detect_benchmark_v1.sloppak
```

Also update `docs/benchmarks/note_detect_v1/BENCHMARK.md` if you changed sections — it's the user-facing description that ships inside the sloppak, kept alongside the tracked file so contributors can see the section list without having to unzip.

## End-to-end iteration loop

The typical cycle for one tuning hypothesis:

1. **Enable tuning mode** (Settings → Note Detection → "Detection tuning (advanced)"). Off by default; turns on the dev surfaces (Reference Recording, Diagnostic JSON, miss-category breakdown).
2. **Arm a recording** from the gear popover next to the Detect button on the player. Arm before pressing Play.
3. **Play through the benchmark** (or any song) at **1.0× playback speed**. Half-speed playback breaks audio↔chart alignment and produces all-miss garbage — see Pitfalls.
4. **Auto-save fires on song end.** The WAV lands in `static/note_detect_recordings/note_detect_<slug>_<timestamp>.wav` (bind-mounted, so it's reachable from the host without a copy step).
5. **Run the headless harness** with a known config:
    ```bash
    node plugins/note_detect/tools/harness.js \
        --audio static/note_detect_recordings/note_detect_<…>.wav \
        --chart static/sloppak_cache/note_detect_benchmark_v1.sloppak/arrangements/lead.json \
        --out /tmp/run.json
    ```
   Prints a one-liner: `<hits>/<total> hits (<%>) — breakdown {pure, chordPartial, early, late, sharp, flat}`.
6. **Sweep parameters** by re-running the harness with different flags (see "Harness flags" below). Compare bins side-by-side. The same recording can drive dozens of runs in seconds.
7. **Form a hypothesis, change code or settings, repeat.** Each PR or settings tweak should move at least one bin in the right direction. If you can't show that, you don't have evidence to ship it.

## Harness flags

All flags map 1:1 to a runtime setting; defaults mirror what a fresh plugin install ships with:

| Flag | Default | Notes |
|---|---|---|
| `--audio <path>` | — | WAV/OGG/MP3 input. WAV is parsed natively; other formats need ffmpeg on PATH. |
| `--chart <path>` | — | The arrangement JSON (e.g. `arrangements/lead.json` from a sloppak directory). |
| `--out <path>` | — | Diagnostic JSON destination. |
| `--method yin\|hps` | `yin` | CREPE is not exercised by the harness (needs WebGL). |
| `--pitch-tolerance <cents>` | `50` | Outer match window for pitch. |
| `--pitch-hit-threshold <cents>` | `20` | Tighter band that counts as "clean" pitch. |
| `--timing-tolerance <s>` | `0.150` | Outer match window for timing. |
| `--timing-hit-threshold <s>` | `0.100` | Tighter band that counts as "clean" timing. |
| `--chord-hit-ratio <r>` | `0.6` | Fraction of strings that must ring for a chord hit (per-string energy bands). |
| `--latency <s>` | `0.080` | Detector pipeline latency compensation. |
| `--frame-size <n>` | `1024` | YIN buffer size in samples. Bigger = better low-freq detection, more latency. |
| `--sample-rate <hz>` | `44100` | Decode target. The WAV reader resamples if the file is different. |
| `--arrangement guitar\|bass` | `guitar` | Picks the open-string MIDI table. |
| `--string-count <n>` | `6` | Used by the string-fret → MIDI math. |
| `--av-offset-ms <ms>` | `0` | Same semantics as `setAvOffsetMs` — pass the user's main-Settings value when replaying their take. **Use `=` for negatives**: `--av-offset-ms=-100`. |
| `--verbose` | off | Logs progress to stderr. |

## Diagnostic JSON — the bits that matter for iteration

Schema `note_detect.diagnostic.v1`. Identical output from live (Settings → Download Diagnostic JSON) and harness. Key fields when comparing runs:

- `summary.hits / misses / accuracy` — top-line score.
- `miss_breakdown` — per-category miss bins:
  - `pure` — detector never reported a confident matching pitch in the note's time window. Usually a detector or buffer issue.
  - `chordPartial` — chord saw some strings but missed the per-string ratio.
  - `early / late` — pitch was right but timing landed outside the inner hit threshold.
  - `sharp / flat` — pitch was outside the pitch hit threshold (but inside the outer tolerance, otherwise it'd be `pure`).
- `timing_error_ms` — distribution over **all matched judgments**. Pinned near a constant when av-offset is wrong (matcher snaps to nearest chart note); use for diagnostics only, *not* as a calibration signal.
- `timing_error_ms_hits` — distribution over **only hits**. Responds linearly to av-offset. The A/V auto-calibrate feature keys off this.
- `pitch_error_cents` — same shape as timing but for pitch.
- `events[]` — per-judgment log (capped). Each entry: `{t, at, s, f, sus, hit, chord, ts, ps, te, pe, ex, dx, cnf, tf}`. The `cnf` field is the pitch-detection confidence at match time; `dx` is the detected MIDI; `ex` is the expected MIDI.

## A/V auto-calibrate — the iterative pattern

Settings → Note Detection → "A/V Sync — Auto-Calibrate" surfaces a button that reads `timing_error_ms_hits.median` and applies `setAvOffsetMs(currentOffset − median)`. Expected workflow:

1. If your current A/V offset is wildly off and you're getting almost no hits, **reset the main Settings A/V slider to 0 first**. The matcher snaps to wrong chart notes when offset is far off, which makes `te-hits` an unreliable signal.
2. Play a section with Detect on until you see at least 5 hits on the counter.
3. Click **Apply** — it sets the new offset and clears the timing samples so the next reading reflects only the new regime.
4. Play another section. Apply again. Usually converges in 2–3 rounds; the button greys out as "Already within 20 ms" when there's nothing useful left to suggest.

Crucially: **don't trust the suggestion at low hit counts.** Hits at a far-off offset come from coincidental near-matches to wrong chart notes, and their median is noise. The button gates on `n ≥ 5` but for noisy players a higher manual threshold is wise.

## Common pitfalls

- **Playback speed must be 1.0× during recording.** The recording captures audio at whatever pace it actually played, but the chart times are absolute. A half-speed take produces all-miss output because every chart event fires its match window before the audio has reached that note. Always confirm the speed slider before pressing Play.
- **Don't categorize event-log entries by `event.sus`.** `checkMisses` historically passed only `{s, f}` into miss judgments, so every pure-missed sustained note showed up as `sus=0` in the event log. The bug is fixed (full chart-note flows through now) but old recordings on older builds will mislead you. The reliable answer is to join event entries back against the source chart by `(t, s, f)` and read `sus` from there.
- **All-matched `timing_error_ms.median` is *not* a calibration signal.** When A/V offset is wrong, the matcher matches the user's pluck against whatever chart note is closest in time, not the intended one. The resulting te median is pinned near a constant regardless of the offset value. Always use `timing_error_ms_hits.median` for calibration math.
- **At a very wrong A/V offset, the auto-calibrate suggestion can point further wrong.** When few hits land, their te median is a property of which wrong chart notes happened to be reachable, not of the user's real skew. Start near zero or near a known reasonable value if you suspect the offset is far off.
- **Sweeping parameter X won't fix a problem that lives outside X.** If pure misses dominate at the default config and stay pinned across a 4× range of frame sizes or pitch tolerances, the bottleneck is not those parameters — likely the detector algorithm, the chord scorer, or the matching window logic. Recognise the ceiling and pivot to code changes.

## Recipes

### "Did my detector change improve things?"

Same recording, same chart, two harness runs. Recipe assumes you're at the repo root; the harness lives in the note_detect plugin tree:

```bash
HARNESS=plugins/note_detect/tools/harness.js
git stash
node $HARNESS --audio <wav> --chart <json> --out /tmp/before.json
git stash pop
node $HARNESS --audio <wav> --chart <json> --out /tmp/after.json
node -e "
const fs = require('fs');
for (const [n, p] of [['before','/tmp/before.json'],['after','/tmp/after.json']]) {
  const d = JSON.parse(fs.readFileSync(p,'utf8'));
  console.log(n, d.summary, d.miss_breakdown);
}
"
```

If `summary.hits` went up *and* no miss-bin went up by more than ~1, ship it. If hits went up but `sharp/flat` went up too, you traded pure misses for pitch misses — investigate whether the tolerance shift makes sense.

### "Find the optimal A/V offset for this take"

Sweep:

```bash
HARNESS=plugins/note_detect/tools/harness.js
for AV in -100 -50 0 50 100 150 200; do
  echo "=== av=$AV ==="
  node $HARNESS --audio <wav> --chart <json> --av-offset-ms=$AV --out /tmp/sw_$AV.json | tail -1
done
```

Pick the highest hit count, then narrow in with finer steps. Cross-reference with `timing_error_ms_hits.median` — at the optimum it'll be close to zero.

### "Categorize misses by chart section"

Join the event log against the chart's `sections[]` to bin per-section hit rate. Useful for finding which exercises in the benchmark sloppak a tuning change improves or regresses.

### "Why is this specific note pure-missed?"

Find the note's `t` in the chart, then grep the event log for entries near that time. If `cnf` is 0 for every nearby event, the detector never fired confidently — likely a YIN buffer / confidence issue. If `cnf > 0` but `dx` doesn't match `ex`, pitch detection is firing on a different note (octave error, harmonic, neighbour string).

## Reference

- Plugin source: [plugins/note_detect/screen.js](../plugins/note_detect/screen.js) — `matchNotes`, `checkMisses`, `_diagTimingErrors` / `_diagTimingErrorsHits`, `getDiagnostic`.
- Routes: [plugins/note_detect/routes.py](../plugins/note_detect/routes.py) — the `/api/plugins/note_detect/recording` endpoint that writes recordings to disk.
- Harness: [plugins/note_detect/tools/harness.js](../plugins/note_detect/tools/harness.js).
- Benchmark builder: [docs/benchmarks/note_detect_v1/build_benchmark.py](benchmarks/note_detect_v1/build_benchmark.py).
- Settings UI: [plugins/note_detect/settings.html](../plugins/note_detect/settings.html) — A/V auto-calibrate panel, tuning-mode toggle, diagnostic block.
