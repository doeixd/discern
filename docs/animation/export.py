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
    # Only the opening Jev lesson loops inline; the full tutorial has narration.
    preview_end = chapters[1]["start"] - .35
    ffmpeg("-i", SOURCE, "-t", preview_end, "-filter_complex",
           "fps=8,scale=800:-1:flags=lanczos,split[a][b];"
           "[a]palettegen=max_colors=96:stats_mode=diff[p];"
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
