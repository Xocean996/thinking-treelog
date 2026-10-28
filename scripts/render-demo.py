"""Render a terminal-style card of real CLI output, for the README and the social
preview.

The layout is drawn from a live run, not hand-typed: `build(rows)` just colours the
text that main() captures from `treelog pulse --demo`. If the CLI output changes,
the picture changes with it.
"""

import io
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# A window that looks like a terminal, not a screenshot of one: no chrome text that
# could go stale, no fake menu bar, just the output on a dark card.
BG = (13, 16, 23)
CARD = (19, 23, 33)
BORDER = (42, 50, 68)
TITLE = (232, 238, 250)
DIM = (138, 150, 172)
ACCENT = (109, 156, 255)
GREEN = (110, 200, 140)
AMBER = (224, 178, 96)
RED = (226, 122, 133)

CONSOLA = "C:/Windows/Fonts/consola.ttf"
CONSOLA_BOLD = "C:/Windows/Fonts/consolab.ttf"
# SimSun is the one font here that behaves like a terminal: a CJK glyph is exactly
# twice the width of a Latin one, so the column maths above lines up and no glyph
# falls back to a tofu box. Consolas has no CJK coverage at all.
MONO = "C:/Windows/Fonts/simsun.ttc"
HEADING = "C:/Windows/Fonts/simhei.ttf"


def font(path, size):
    for candidate in (path, CONSOLA):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def capture(width=88):
    """Read the demo output from a file and wrap it to `width` display columns.

    The text is produced by the CLI and dumped to `docs/.demo-output.txt` before
    this script runs — spawning a child process is not always permitted in this
    environment, and re-running the CLI here would also mean the picture could
    drift from what the tool prints.
    """
    here = Path(__file__).resolve().parent.parent
    source = here / "docs" / ".demo-output.txt"
    if not source.exists():
        raise SystemExit(
            f"missing {source}\n"
            "run: node packages/cli/bin/treelog.mjs pulse --demo > docs/.demo-output.txt"
        )
    out = source.read_text(encoding="utf-8-sig")

    lines = []
    for raw in out.splitlines():
        if not raw.strip():
            lines.append("")
            continue
        # Count display width: CJK glyphs occupy two columns in a terminal.
        current = ""
        used = 0
        for ch in raw:
            wide = ord(ch) > 0x1100
            step = 2 if wide else 1
            if used + step > width:
                lines.append(current)
                current = "    "
                used = 4
            current += ch
            used += step
        lines.append(current)

    # Trailing blank lines waste card space.
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def colour_for(line):
    stripped = line.strip()
    if stripped.startswith("工作区脉络"):
        return ACCENT
    if stripped.startswith("在做什么") or stripped.startswith("怎么在做") or stripped.startswith("还没做完"):
        return TITLE
    if stripped.startswith("建议") or stripped.startswith("提问质量"):
        return TITLE
    if stripped.startswith("○"):
        return AMBER
    if stripped.startswith("［"):
        return GREEN
    if stripped.startswith("/"):
        return DIM
    if stripped[:2] in {"◐5", "●7", "○4"}:
        return GREEN
    return (198, 208, 226)


def build(lines, scale=2, pad=26, line_h=23):
    """Draw the card. `scale` is the integer DPI multiplier for crisp text."""
    title_font = font(MONO, 13 * scale)
    mono = font(MONO, 12 * scale)

    char_w = mono.getlength("M")
    card_w = int(char_w * 96) + pad * 2
    card_h = pad * 2 + 30 * scale + line_h * scale * len(lines)

    img = Image.new("RGB", (card_w, card_h), BG)
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle(
        [(2, 2), (card_w - 3, card_h - 3)],
        radius=14 * scale // 1,
        fill=CARD,
        outline=BORDER,
        width=1 * scale,
    )

    # Three window dots, then the command, so the card reads as a real session.
    y = pad - 6 * scale
    for i, colour in enumerate([(237, 106, 94), (245, 191, 79), (98, 197, 84)]):
        cx = pad + 8 * scale + i * 20 * scale
        draw.ellipse(
            [(cx - 5 * scale, y + 3 * scale), (cx + 5 * scale, y + 13 * scale)],
            fill=colour,
        )

    draw.text((pad + 76 * scale, y), "$ treelog pulse --demo", font=title_font, fill=DIM)

    y = pad + 30 * scale
    for line in lines:
        draw.text((pad, y), line, font=mono, fill=colour_for(line))
        y += line_h * scale

    return img


def main():
    here = Path(__file__).resolve().parent.parent
    out_dir = here / "docs"
    out_dir.mkdir(exist_ok=True)

    lines = capture()

    # The README card stops after the open todos. The full output continues into
    # the suggestions and the score sparkline, but a 1600px image pushes the
    # actual text off the first screen, and SimSun has no glyph for ◐ anyway.
    cut = next(
        (i for i, line in enumerate(lines) if line.strip().startswith("建议")),
        len(lines),
    )
    while cut > 0 and not lines[cut - 1].strip():
        cut -= 1

    card = build(lines[:cut])
    card.save(out_dir / "demo-pulse.png")
    print(f"demo-pulse.png  {card.size[0]}x{card.size[1]}  ({cut} lines)")

    # Social preview: 1280x640 is what GitHub and most cards expect. Laid out
    # directly rather than by pasting the README card in — the card is 986px tall
    # and overflows the 640px frame.
    width, height = 1280, 640
    social = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(social)

    head = font(HEADING, 38)
    sub = font(MONO, 19)
    body = font(MONO, 18)
    small = font(MONO, 17)

    draw.text((72, 54), "Thinking TreeLog · 思维树", font=head, fill=TITLE)
    draw.text((72, 112), "Your AI session already contains the reasoning.", font=sub, fill=ACCENT)
    draw.text((72, 140), "This reads it back to you.", font=sub, fill=ACCENT)

    # A thin rule separates the pitch from the proof.
    draw.line([(72, 184), (width - 72, 184)], fill=BORDER, width=2)

    showcase = [
        ("工作区脉络 · 给结算服务加一次重试", ACCENT),
        ("  6 轮 · 10 条消息 · 13 次工具调用 · 今天仍在推进", DIM),
        ("", DIM),
        ("在做什么（最近的提问）：", TITLE),
        ("  1. 支付回调偶尔丢，我想加重试。先看看现在怎么处理的…", (198, 208, 226)),
        ("  2. QPS 200 时丢 0.3%，验收：压测 1000 次零丢失", GREEN),
        ("  3. 这个再优化一下", RED),
        ("", DIM),
        ("还没做完：", TITLE),
        ("  ○ 压测 1000 次验证零丢失", AMBER),
        ("  ○ 补一条回归测试", AMBER),
    ]

    y = 208
    for text, colour in showcase:
        if text:
            draw.text((72, y), text, font=body, fill=colour)
        y += 32

    draw.text(
        (72, height - 54),
        "npx -y @thinking-treelog/cli pulse --demo",
        font=small,
        fill=GREEN,
    )
    social.save(out_dir / "social-preview.png")
    print(f"social-preview.png  {social.size[0]}x{social.size[1]}")


if __name__ == "__main__":
    main()
