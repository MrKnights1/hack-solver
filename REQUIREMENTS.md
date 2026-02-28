# Hack Solver - Requirements

## Goal

Phone camera PWA that solves the NoPixel Hacking Device minigame.
Point phone at game screen, tap SCAN, get the answer highlighted.

## Game Structure

- **Grid**: 8 rows x 10 columns = 80 cells
- **Target**: 4 cells displayed above the grid
- **Each cell**: exactly 2 characters side by side
- **Task**: find where the 4 target codes appear consecutively in the grid
- **Grid shuffles** every ~1.5 seconds, target stays fixed

## Supported Character Sets

All 6 game modes must be solved:

| Mode | Characters | Example Codes |
|------|-----------|---------------|
| Numeric | 0-9 | 28 98 94 55 |
| Alphabet | A-Z | CB WG HI ZI |
| Alphanumeric | A-Z + 0-9 | XW F9 BW UV |
| Greek | Latin + Greek letters | BX LF PQ KW |
| Braille | Unicode Braille U+2800-28FF | |
| Runes | Unicode Runes U+16A0-16FF | |

**Symbols mode is excluded** (user decision).

## Performance Target

- Total scan time: **under 5 seconds** from tap to result
- Acceptable: up to 8 seconds for difficult charsets
- Unacceptable: over 10 seconds

## Current Pipeline

1. **Capture frame** from phone camera (~5ms)
2. **Detect grid** via adaptive threshold + projection analysis (~80ms)
3. **OCR target** - read 4 target codes (~300ms)
4. **OCR grid** - read 80 grid codes (variable, main bottleneck)
5. **Text match** - find target sequence in grid (~1ms)
6. **Draw result** - highlight matching cells on overlay

## Current Status (v16)

### What Works
- Detection: reliable for all charsets
- Target OCR: reliable for Numeric, Alphabet, Alphanumeric, Greek
- Grid OCR with 3-tier fallback (row -> binarized -> cell-by-cell)
- Text matching with fuzzy fallback
- Test results: 7/11 real screenshots match correctly

### What Doesn't Work
- **Braille**: Tesseract cannot read Braille Unicode characters
- **Runes**: Tesseract cannot read Runic Unicode characters
- **Some Greek images**: target charset misdetected (digits read as Greek)
- **Speed**: cell-by-cell fallback on failing rows adds 500ms per row
  - Worst case: 8 failing rows x 500ms = 4s extra on top of base 3s = 7s total
  - On phone WASM: likely 2-3x slower than Node.js native

### Test Results (scan-test.js on 11 game images)

| Image | Charset | Result | Notes |
|-------|---------|--------|-------|
| 42bf1823 | numeric | MATCH R5C4 | correct |
| 57878602 | alphanum | MATCH R1C9 | correct (fuzzy) |
| 773aadef | alpha | MATCH R5C8 | correct |
| 1681a24a | greek | MATCH R5C7 | correct |
| 63ca78e4 | alpha | MATCH R1C10 | correct |
| 75df3a51 | alpha | MATCH R2C3 | correct |
| ea150fa7 | numeric | MATCH R4C4 | correct (integration test) |
| 3a1bd929 | alphanum | NO MATCH | cells partially read, target row incomplete |
| 59b9a048 | numeric | NO MATCH | target misread (50 -> Greek O) |
| 5e704811 | alphanum | NO MATCH | target misread |
| 2d256bab | braille? | NO MATCH | charset unreadable by Tesseract |

## Key Problems to Solve

### P1: Braille and Runes (OCR cannot read them)
Tesseract has no model for Braille dots or Runic characters.
Need alternative approach - likely pixel/template matching.

### P2: Speed on phone
Browser WASM Tesseract is slower than Node.js native.
Cell-by-cell fallback (10 recognize calls per failing row) may be too slow.

### P3: Remaining OCR failures
Some rows still produce garbage even with cell-by-cell fallback.
Low contrast, small cell size, or camera noise contribute.

## Architecture

```
index.html    - Shell, loads scripts + Tesseract CDN
style.css     - Fullscreen camera overlay UI
camera.js     - getUserMedia, frame capture
detector.js   - Grid + target cell detection (adaptive threshold, projections)
processor.js  - Cell extraction to 32x32 grayscale Uint8Array
ocr.js        - Tesseract OCR (target, grid row, grid cell, parsing)
matcher.js    - Text matching (exact + fuzzy) and pixel matching (hamming)
app.js        - Main flow, UI state, scan orchestration
sw.js         - Service worker cache
```

## Test Infrastructure

```
test/run.test.js              - 63 unit tests (parsing, matching, normalization)
test/ground-truth.test.js     - 16 ground truth tests (known answers)
test/ocr-integration.test.js  - 28 OCR integration tests (real images)
test/scan-test.js             - Full pipeline test on 12 real images
```

Test images: `/root/projektid/hakid/testimages/` (32+ game screenshots)
