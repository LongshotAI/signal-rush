#!/usr/bin/env python3
"""
image_to_chafa.py — High-quality image-to-ANSI converter for Signal Rush.

Uses Chafa (https://hpjansson.org/chafa/) as the primary converter for
superior quality via Unicode Braille patterns (4× resolution boost over
half-block characters). Falls back to our bundled Python converter if
chafa is not available.

Usage:
  python3 image_to_chafa.py <input_image> [max_width=76] [max_height=16]

Output: JSON {"lines": [ANSI-escaped strings]}
"""

import sys
import json
import subprocess
import os
import shutil
import re

# ──────────────────────────────────────────────────────────────────────
# Resolve chafa binary — check bundled first, then system PATH
# ──────────────────────────────────────────────────────────────────────

def _find_chafa():
    """Find chafa binary: bundled -> system PATH -> None."""
    # Bundled path (next to this script or in economy/scripts/)
    bundled_paths = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chafa', 'chafa'),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chafa'),
        '/tmp/chafa-extract/usr/bin/chafa',
        '/usr/local/bin/chafa',
        '/usr/bin/chafa',
    ]
    for p in bundled_paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p

    # System PATH
    system_chafa = shutil.which('chafa')
    if system_chafa:
        return system_chafa

    return None

# ──────────────────────────────────────────────────────────────────────
# Chafa converter (primary — high quality)
# ──────────────────────────────────────────────────────────────────────

def _get_chafa_lib_path():
    """Find chafa shared libraries for LD_LIBRARY_PATH if bundled."""
    # Check common locations for bundled libs
    script_dir = os.path.dirname(os.path.abspath(__file__))
    possible_lib_dirs = [
        os.path.join(script_dir, 'chafa-libs'),
        os.path.join(script_dir, '..', 'chafa-libs'),
        '/tmp/chafa-extract/usr/lib/x86_64-linux-gnu',
    ]
    for d in possible_lib_dirs:
        if os.path.isdir(d) and any(f.startswith('libchafa') for f in os.listdir(d)):
            return d
    return None


def _needs_ld_library_path(chafa_bin):
    """Check if chafa binary needs LD_LIBRARY_PATH to find its libs."""
    try:
        result = subprocess.run([chafa_bin, '--version'],
                                capture_output=True, timeout=5)
        return result.returncode != 0
    except:
        return True


def convert_with_chafa(img_path, max_width=76, max_height=16):
    """
    Convert image to ANSI art using Chafa with Braille symbols.

    Chafa uses Unicode Braille patterns which give 2×4=8 dots per
    character cell, providing 4× the resolution of half-block characters.

    Returns list of ANSI-escaped strings, or None on failure.
    """
    chafa_bin = _find_chafa()
    if not chafa_bin:
        return None

    # Build environment with library path if needed
    env = os.environ.copy()
    lib_path = _get_chafa_lib_path()
    if lib_path and _needs_ld_library_path(chafa_bin):
        env['LD_LIBRARY_PATH'] = lib_path + ':' + env.get('LD_LIBRARY_PATH', '')

    # Chafa CLI options:
    #   -f symbols           : Force symbols mode (not sixel/kitty/iTerm)
    #   --symbols braille    : Use Unicode Braille patterns (2×4 dots per cell)
    #   -c full              : 24-bit true color
    #   --color-space rgb    : Fast color quantization
    #   -s WxH               : Output size in characters
    #   --preprocess on      : Auto contrast/saturation boost
    #   --dither ordered     : Ordered dithering for smooth gradients
    #   (no --fg-only)       : Allow fg+bg color per cell for max fidelity
    try:
        result = subprocess.run(
            [chafa_bin,
             '-f', 'symbols',
             '--symbols', 'braille',
             '-c', 'full',
             '--color-space', 'rgb',
             '-s', f'{max_width}x{max_height}',
             '--preprocess', 'on',
             '--dither', 'ordered',
             img_path],
            capture_output=True, text=True, timeout=10, env=env
        )

        if result.returncode != 0:
            return None

        # Chafa outputs ANSI art directly (no JSON wrapper)
        lines = result.stdout.split('\n')
        # Remove trailing empty lines
        while lines and not lines[-1].strip():
            lines.pop()
        # Strip cursor control and other non-color ANSI sequences.
        # Keep only SGR color codes: \x1b[38;2;R;G;Bm (fg) and \x1b[48;2;R;G;Bm (bg)
        # This prevents cursor hide/show and reset sequences from breaking visibleLength()
        _ansi_keep_color = re.compile(r'\x1b\[(?:38|48);2;\d+;\d+;\d+m')
        def _strip_non_color(s):
            # Extract all color codes with their positions, then rebuild string
            # with only color codes and non-ANSI text
            result = []
            pos = 0
            for m in _ansi_keep_color.finditer(s):
                # Add text between last match and this match (skip any ANSI in between)
                gap = s[pos:m.start()]
                # Remove any ANSI escape sequences from the gap
                gap_clean = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', gap)
                result.append(gap_clean)
                result.append(m.group())  # Keep the color code
                pos = m.end()
            # Handle trailing text
            tail = s[pos:]
            result.append(re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', tail))
            return ''.join(result)
        lines = [_strip_non_color(l) for l in lines]
        # Remove lines that are empty after stripping non-color ANSI
        # (e.g. lines that only contained \x1b[0m reset sequences)
        lines = [l for l in lines if l.strip()]
        # Also remove leading/trailing blank lines for clean logo output
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        return lines if lines else None

    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


# ──────────────────────────────────────────────────────────────────────
# Fallback converter (bundled Python — no external dependencies)
# ──────────────────────────────────────────────────────────────────────

def convert_with_fallback(img_path, max_width=76, max_height=16):
    """
    Fallback converter using the bundled image_to_ansi.py v3.
    Used when chafa is not available.
    """
    import importlib.util
    fallback_script = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        'image_to_ansi.py'
    )
    if not os.path.isfile(fallback_script):
        return None

    try:
        spec = importlib.util.spec_from_file_location("image_to_ansi", fallback_script)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        lines = mod.convert_image_to_ansi(img_path, max_width, max_height * 2, 'auto')
        # Limit height
        return lines[:max_height] if lines else None

    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────
# Main — try chafa first, fall back to bundled converter
# ──────────────────────────────────────────────────────────────────────

def convert_image(img_path, max_width=76, max_height=16):
    """
    Convert image to ANSI art. Tries chafa first (best quality),
    falls back to bundled Python converter.

    Returns list of ANSI-escaped strings.
    """
    # Try chafa first
    lines = convert_with_chafa(img_path, max_width, max_height)
    if lines is not None:
        return lines

    # Fallback to bundled Python converter
    lines = convert_with_fallback(img_path, max_width, max_height)
    if lines is not None:
        return lines

    # Ultimate failure — return a placeholder
    return ['[image conversion failed]']


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <image> [max_width=76] [max_height=16]", file=sys.stderr)
        sys.exit(1)

    img_path = sys.argv[1]
    max_width = int(sys.argv[2]) if len(sys.argv) > 2 else 76
    max_height = int(sys.argv[3]) if len(sys.argv) > 3 else 16

    max_width = max(8, min(max_width, 120))
    max_height = max(2, min(max_height, 40))

    lines = convert_image(img_path, max_width, max_height)
    print(json.dumps({'lines': lines}, ensure_ascii=False))
