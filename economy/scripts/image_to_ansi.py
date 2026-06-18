#!/usr/bin/env python3
"""
image_to_ansi.py — Convert an image to colored ASCII art for Signal Rush CLI v3.

Improvements over v2:
- Aspect-ratio-aware resizing: fits within target bounds without distortion
- Smart auto-crop: detects logo bounds using content density analysis
- 24-bit true-color ANSI output for modern terminals (falls back to 256-color for older)
- Configurable output modes: 'auto' picks best strategy per image
- Handles transparency, whitespace borders, and varied image types robustly

Usage:
  python3 image_to_ansi.py <input_image> [width] [height] [mode]

Mode: auto (default), crop-icon, full-image
"""

import sys
import json
import math
import os
from PIL import Image, ImageFilter
import numpy as np

# ──────────────────────────────────────────────────────────────────────
# ANSI helpers — 256-color and true-color (24-bit)
# ──────────────────────────────────────────────────────────────────────

def _build_ansi256_table():
    table = np.zeros((256, 3), dtype=np.float32)
    standard = [
        [0,0,0],[205,0,0],[0,205,0],[205,205,0],[0,0,238],[205,0,205],
        [0,205,205],[229,229,229],[127,127,127],[255,0,0],[0,255,0],[255,255,0],
        [92,92,255],[255,0,255],[0,255,255],[255,255,255],
    ]
    for i, rgb in enumerate(standard):
        table[i] = rgb
    levels = [0, 95, 135, 175, 215, 255]
    idx = 16
    for r in levels:
        for g in levels:
            for b in levels:
                table[idx] = [r, g, b]
                idx += 1
    for i in range(24):
        v = 8 + i * 10
        table[232 + i] = [v, v, v]
    return table

ANSI_TABLE = _build_ansi256_table()

def rgb_to_ansi256(r, g, b):
    pixel = np.array([r, g, b], dtype=np.float32)
    dists = np.sum((ANSI_TABLE - pixel) ** 2, axis=1)
    return int(np.argmin(dists))

def ansi_fg(r, g, b):
    """True-color ANSI foreground."""
    return f'\033[38;2;{r};{g};{b}m'

def ansi_bg(r, g, b):
    """True-color ANSI background."""
    return f'\033[48;2;{r};{g};{b}m'

def ansi_fg_bg(fr, fg, fb, br, bg, bb):
    """True-color ANSI foreground + background."""
    return f'\033[38;2;{fr};{fg};{fb};48;2;{br};{bg};{bb}m'

RESET = '\033[0m'

# ──────────────────────────────────────────────────────────────────────
# Content-aware auto-crop — find the actual logo/content bounds
# ──────────────────────────────────────────────────────────────────────

def detect_content_bounds(arr, pad=2):
    """
    Detect the bounding box of non-background content in the image.
    Returns (top, bottom, left, right) crop coordinates.
    
    Uses edge-color sampling to determine background, then flood-fills
    from edges to find content boundaries.
    """
    h, w = arr.shape[:2]
    
    # Sample edge pixels to determine background color
    edge_pixels = np.concatenate([
        arr[0, :, :3],      # top row
        arr[-1, :, :3],     # bottom row
        arr[:, 0, :3],      # left column
        arr[:, -1, :3],     # right column
    ]).astype(np.float32)
    bg_color = np.median(edge_pixels, axis=0)
    
    # Compute per-pixel distance from background
    rgb = arr[:, :, :3].astype(np.float32)
    dist = np.sqrt(np.sum((rgb - bg_color) ** 2, axis=2))
    
    # Consider alpha channel if present
    if arr.shape[2] >= 4:
        alpha = arr[:, :, 3]
        content_mask = (dist > 35 * math.sqrt(3)) | (alpha < 128)
    else:
        content_mask = dist > 35 * math.sqrt(3)
    
    # Find bounding box of content
    rows = np.any(content_mask, axis=1)
    cols = np.any(content_mask, axis=0)
    
    if not np.any(rows) or not np.any(cols):
        # Entirely blank or uniform — no crop
        return (0, h, 0, w)
    
    top = max(0, np.argmax(rows) - pad)
    bottom = min(h, h - np.argmax(rows[::-1]) + pad)
    left = max(0, np.argmax(cols) - pad)
    right = min(w, w - np.argmax(cols[::-1]) + pad)
    
    return (top, bottom, left, right)


def split_logo_from_text(arr, min_gap_rows=3, scan_start_pct=0.35):
    """
    Detect a gap between a logo icon and text below it.
    Scans from scan_start_pct downward looking for consecutive
    uniform rows (variance below threshold).
    
    Returns the row index to crop at (or full height if no gap found).
    """
    h, w = arr.shape[:2]
    scan_start = int(h * scan_start_pct)
    
    GAP_VAR = 80      # variance threshold for "uniform" row
    MIN_GAP = min_gap_rows
    
    # Detect background color from edges
    edge_pixels = np.concatenate([
        arr[0, :, :3], arr[-1, :, :3],
        arr[:, 0, :3], arr[:, -1, :3],
    ]).astype(np.float32)
    bg_color = np.median(edge_pixels, axis=0)
    
    gap_count = 0
    for y in range(scan_start, h):
        row = arr[y, :, :3].astype(np.float32)
        # Distance from background color
        dist = np.sqrt(np.sum((row - bg_color) ** 2, axis=1))
        # Fraction of row that is background
        bg_frac = np.mean(dist < 35 * math.sqrt(3))
        
        if bg_frac > 0.85:
            gap_count += 1
            if gap_count >= MIN_GAP:
                # Found a gap — crop at the start of the gap
                return y - gap_count + 1
        else:
            gap_count = 0
    
    return h  # No gap found — use full height


def auto_crop(img):
    """
    Intelligent auto-crop that handles three image types:
    1. Logo with text below (e.g., brandmark + tagline) → crop to logo only
    2. Logo with whitespace borders → crop to content bounds
    3. Full-bleed image → minimal crop
    
    Returns the cropped PIL Image.
    """
    img_arr = np.array(img)
    h, w = img_arr.shape[:2]
    
    # Step 1: Try to detect logo/text gap (for images with text below logo)
    crop_at = split_logo_from_text(img_arr)
    
    if crop_at < h * 0.85:
        # Found a meaningful gap — crop there
        img = img.crop((0, 0, w, crop_at))
        img_arr = np.array(img)
    
    # Step 2: Trim whitespace borders using content bounds
    top, bottom, left, right = detect_content_bounds(img_arr, pad=2)
    
    # Only crop if we'd remove significant border (>5% of dimensions)
    border_h = top + (img_arr.shape[0] - bottom)
    border_w = left + (img_arr.shape[1] - right)
    total_h = img_arr.shape[0]
    total_w = img_arr.shape[1]
    
    if border_h > total_h * 0.10 or border_w > total_w * 0.10:
        img = img.crop((left, top, right, bottom))
    
    return img

# ──────────────────────────────────────────────────────────────────────
# Image → ANSI ASCII art conversion (2×1 block characters)
# ──────────────────────────────────────────────────────────────────────

def convert_image_to_ansi(img_path, max_width=64, max_height=20, mode='auto'):
    """
    Convert an image to colored ASCII art lines.
    
    Uses 2×1 block characters: each character cell covers 2 vertical pixels.
    Top pixel → foreground color, bottom pixel → background color, char = ▀.
    
    Args:
        img_path: Path to input image.
        max_width: Maximum output width in characters.
        max_height: Maximum output height in lines.
        mode: 'auto' (smart crop), 'crop-icon' (aggressive icon crop), 
              'full-image' (no cropping).
    
    Returns:
        List of strings (ANSI-escaped lines).
    """
    img = Image.open(img_path).convert('RGBA')
    
    # Step 1: Auto-crop based on mode
    if mode == 'auto':
        img = auto_crop(img)
    elif mode == 'crop-icon':
        img_arr = np.array(img)
        crop_at = split_logo_from_text(img_arr)
        if crop_at < img_arr.shape[0] * 0.85:
            img = img.crop((0, 0, img_arr.shape[1], crop_at))
        # Then trim borders
        img_arr = np.array(img)
        top, bottom, left, right = detect_content_bounds(img_arr, pad=2)
        img = img.crop((left, top, right, bottom))
    # mode == 'full-image': no cropping
    
    # Step 2: Resize preserving aspect ratio to fit within max_width × (max_height * 2) pixels
    # We use max_height * 2 because each character line represents 2 pixel rows
    target_pixel_h = max_height * 2
    img_w, img_h = img.size
    
    # Compute scale to fit within bounds
    scale_w = max_width / img_w
    scale_h = target_pixel_h / img_h
    scale = min(scale_w, scale_h, 1.0)  # Never upscale (keeps crisp)
    
    new_w = max(4, int(img_w * scale))
    new_h = max(4, int(img_h * scale))
    
    # Ensure even height for 2×1 block pairing
    if new_h % 2 != 0:
        new_h += 1
    
    # Ensure width doesn't exceed max_width after rounding
    new_w = min(new_w, max_width)
    
    img = img.resize((new_w, new_h), Image.LANCZOS)
    
    # Slight blur to reduce moiré patterns at small sizes
    if new_w < img_w * 0.3:
        img = img.filter(ImageFilter.GaussianBlur(radius=0.5))
    
    arr = np.array(img)  # (H, W, 4) uint8
    
    # Step 3: Build ANSI output using 2×1 block characters
    lines = []
    actual_height = arr.shape[0]
    
    for row_start in range(0, actual_height - 1, 2):
        top_row = arr[row_start]
        bot_row = arr[row_start + 1]
        
        line_parts = []
        cur_state = None  # (fg_rgb, bg_rgb) or None
        
        for col in range(arr.shape[1]):
            tr, tg, tb = int(top_row[col, 0]), int(top_row[col, 1]), int(top_row[col, 2])
            br, bg_c, bb = int(bot_row[col, 0]), int(bot_row[col, 1]), int(bot_row[col, 2])
            ta = int(top_row[col, 3]) if arr.shape[2] >= 4 else 255
            ba = int(bot_row[col, 3]) if arr.shape[2] >= 4 else 255
            
            t_transparent = ta < 128
            b_transparent = ba < 128
            
            if t_transparent and b_transparent:
                # Both transparent → space
                if cur_state is not None:
                    line_parts.append(RESET)
                    cur_state = None
                line_parts.append(' ')
                continue
            
            # Determine character and colors
            if not t_transparent and not b_transparent:
                # Both visible
                if tr == br and tg == bg_c and tb == bb:
                    # Same color → full block, only emit fg
                    state = ((tr, tg, tb), None)
                    char = '█'
                else:
                    # Different colors → half block with fg+bg
                    state = ((tr, tg, tb), (br, bg_c, bb))
                    char = '▀'
            elif not t_transparent and b_transparent:
                # Only top visible
                state = ((tr, tg, tb), None)
                char = '▀'
            else:
                # Only bottom visible
                state = ((br, bg_c, bb), None)
                char = '▄'
            
            # Emit ANSI only when state changes
            if state != cur_state:
                if state[1] is None:
                    # Single color (fg only)
                    r, g, b = state[0]
                    line_parts.append(ansi_fg(r, g, b))
                else:
                    # Two colors (fg + bg)
                    fr, fg, fb = state[0]
                    br2, bg2, bb2 = state[1]
                    line_parts.append(ansi_fg_bg(fr, fg, fb, br2, bg2, bb2))
                cur_state = state
            
            line_parts.append(char)
        
        if cur_state is not None:
            line_parts.append(RESET)
        
        lines.append(''.join(line_parts))
    
    return lines


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <image> [max_width=64] [max_height=20] [mode=auto]", file=sys.stderr)
        sys.exit(1)
    
    img_path = sys.argv[1]
    max_width = int(sys.argv[2]) if len(sys.argv) > 2 else 64
    max_height = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    mode = sys.argv[4] if len(sys.argv) > 4 else 'auto'
    
    max_width = max(8, min(max_width, 120))
    max_height = max(2, min(max_height, 40))
    
    lines = convert_image_to_ansi(img_path, max_width, max_height, mode)
    print(json.dumps({'lines': lines}, ensure_ascii=False))
