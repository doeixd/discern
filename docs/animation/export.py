"""Export the rendered Manim scene as a web MP4, README GIF, and poster.

Requires ffmpeg on PATH. Run after explainer.py, from any directory.
"""
from pathlib import Path
import json
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SILENT = "--silent" in sys.argv
STEM = "discern-explainer-silent" if SILENT else "discern-explainer"
SOURCE = HERE / "media/videos/720p30" / f"{STEM}.mp4"
OUT = HERE.parent / "assets"


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


if __name__ == "__main__":
    if not SOURCE.is_file():
        raise SystemExit("Render first: uv run docs/animation/explainer.py")
    OUT.mkdir(parents=True, exist_ok=True)
    timeline_name = "timeline-silent.json" if SILENT else "timeline.json"
    timeline = json.loads((HERE / "media" / timeline_name).read_text(encoding="utf-8"))

    def stamp(seconds):
        millis = round(seconds * 1000)
        hours, millis = divmod(millis, 3600000)
        minutes, millis = divmod(millis, 60000)
        seconds, millis = divmod(millis, 1000)
        return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"

    srt = "\n\n".join(f'{i+1}\n{stamp(c["start"])} --> {stamp(c["end"])}\n{c["text"]}'
                       for i,c in enumerate(timeline)) + "\n"
    (OUT / f"{STEM}.srt").write_text(srt, encoding="utf-8")
    chapters = [c for c in timeline if c["cue"] == 0]
    metadata = ";FFMETADATA1\n"
    for i,c in enumerate(chapters):
        end = chapters[i+1]["start"] if i+1 < len(chapters) else timeline[-1]["end"] + 1
        metadata += (f'\n[CHAPTER]\nTIMEBASE=1/1000\nSTART={round(c["start"]*1000)}\n'
                     f'END={round(end*1000)}\ntitle={c["title"]}\n')
    chapter_file = HERE / "media" / ("chapters-silent.txt" if SILENT else "chapters.txt")
    chapter_file.write_text(metadata, encoding="utf-8")
    sound = ["-an"] if SILENT else ["-map", "0:a:0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                                    "-c:a", "aac", "-ac", "1", "-b:a", "96k"]
    ffmpeg("-i", SOURCE, "-i", chapter_file, "-map_metadata", "1", "-map_chapters", "1",
           "-map", "0:v:0", "-c:v", "libx264", "-crf", "22", "-pix_fmt", "yuv420p",
           *sound, "-movflags", "+faststart", OUT / f"{STEM}.mp4")
    # The GIF is a trailer, not the opening: one beat per chapter, so the loop
    # shows the whole arc from Jev to composed programs rather than the intro.
    # LEAD skips the chapter transition so each beat lands on a settled frame.
    LEAD, BEAT, HOOK, GIF_FPS = 1.2, 2.0, 3.6, 12
    limit = timeline[-1]["end"]
    beats = []
    for i, c in enumerate(chapters):
        start = c["start"] + LEAD
        end = min(start + (HOOK if i == 0 else BEAT), limit)
        if end > start:
            beats.append((start, end))
    trim = "".join(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[b{i}];"
                   for i, (s, e) in enumerate(beats))
    concat = "".join(f"[b{i}]" for i in range(len(beats)))
    ffmpeg("-i", SOURCE, "-filter_complex",
           f"{trim}{concat}concat=n={len(beats)}:v=1:a=0[t];"
           f"[t]fps={GIF_FPS},scale=800:-1:flags=lanczos,split[a][b];"
           "[a]palettegen=max_colors=128:stats_mode=full[p];"
           "[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
           "-loop", "0", OUT / f"{STEM}.gif")
    poster = "discern-poster-silent.png" if SILENT else "discern-poster.png"
    ffmpeg("-i", SOURCE, "-ss", timeline[2]["start"]+1.2, "-frames:v", "1", OUT / poster)
    transcript = ["# From Jev to composed programs", "",
                  ("Silent Manim tutorial with on-screen explanations." if SILENT else "Narrated Manim tutorial.")
                  + " All model outputs and thresholds are illustrative.", ""]
    for c in timeline:
        if c["cue"] == 0:
            transcript.extend([f'## {stamp(c["start"])[:8]} — {c["title"]}', ""])
        transcript.extend([c["text"], ""])
    transcript.extend(["## Sources", "",
        "- [TypeSafe: System One and Jev](https://docs.typesafe.ai/concepts/system-one)",
        "- [TypeSafe question types](https://docs.typesafe.ai/primitives)",
        "- [Typechecked example](../../examples/explainer.ts)",
        "- [Discern implementation](../../src/index.ts)",
        "- [Procedure implementation](../../src/procedure.ts)", ""])
    transcript_name = "transcript-silent.md" if SILENT else "transcript.md"
    (HERE / transcript_name).write_text("\n".join(transcript), encoding="utf-8")
