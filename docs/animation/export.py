"""Export the rendered Manim scene as a web MP4, README GIF, and poster.

Requires ffmpeg on PATH. Run after explainer.py, from any directory.
"""
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "media/videos/720p30/discern-explainer.mp4"
OUT = HERE.parent / "assets"


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


if __name__ == "__main__":
    if not SOURCE.is_file():
        raise SystemExit("Render first: uv run docs/animation/explainer.py")
    OUT.mkdir(parents=True, exist_ok=True)
    ffmpeg("-i", SOURCE, "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", "-an", OUT / "discern-explainer.mp4")
    # The whole captioned explanation plays inline; low fps keeps Git lightweight.
    ffmpeg("-i", SOURCE, "-filter_complex",
           "fps=8,scale=800:-1:flags=lanczos,split[a][b];"
           "[a]palettegen=max_colors=96:stats_mode=diff[p];"
           "[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
           "-loop", "0", OUT / "discern-explainer.gif")
    ffmpeg("-ss", "3", "-i", SOURCE, "-frames:v", "1", OUT / "discern-poster.png")
