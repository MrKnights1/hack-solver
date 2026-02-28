const OCR = (() => {
    let worker = null;
    let initialized = false;

    const SCALE = 3;
    const CODE_LEN = 2;

    const GREEK_UPPER = '\u0391\u0392\u0393\u0394\u0395\u0396\u0397\u0398\u0399\u039A\u039B\u039C\u039D\u039E\u039F\u03A0\u03A1\u03A3\u03A4\u03A5\u03A6\u03A7\u03A8\u03A9';
    const LATIN_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const DIGITS = '0123456789';

    const GREEK_TO_LATIN = {
        '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z',
        '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M',
        '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T',
        '\u03A5': 'Y', '\u03A7': 'X'
    };

    const GREEK_LOWER_TO_LATIN = {
        '\u03B1': 'A', '\u03B2': 'B', '\u03B5': 'E', '\u03B6': 'Z',
        '\u03B7': 'H', '\u03B9': 'I', '\u03BA': 'K', '\u03BC': 'M',
        '\u03BD': 'N', '\u03BF': 'O', '\u03C1': 'P', '\u03C4': 'T',
        '\u03C5': 'Y', '\u03C7': 'X'
    };

    const CODE_CHAR_RE = /[A-Za-z0-9\u0370-\u03FF\u16A0-\u16FF\u2800-\u28FF]/;
    const CODE_CHARS_RE = /[^A-Za-z0-9\u0370-\u03FF\u16A0-\u16FF\u2800-\u28FF]/g;
    const CODE_CHARS_SPACE_RE = /[^A-Za-z0-9\u0370-\u03FF\u16A0-\u16FF\u2800-\u28FF\s]/g;

    function normalizeText(text) {
        let result = '';
        for (const ch of text) {
            if (GREEK_TO_LATIN[ch]) result += GREEK_TO_LATIN[ch];
            else if (GREEK_LOWER_TO_LATIN[ch]) result += GREEK_LOWER_TO_LATIN[ch];
            else result += ch.toUpperCase();
        }
        return result;
    }

    function normalizeCodes(codes) {
        return codes.map(code => normalizeText(code));
    }

    function guessWhitelist(codes) {
        let hasDigit = false, hasLatin = false, hasGreek = false;
        for (const code of codes) {
            for (const ch of code) {
                if (/[0-9]/.test(ch)) hasDigit = true;
                else if (/[A-Za-z]/.test(ch)) hasLatin = true;
                else if (/[\u0370-\u03FF]/.test(ch)) hasGreek = true;
            }
        }
        if (hasGreek) return LATIN_UPPER + GREEK_UPPER;
        if (hasLatin && hasDigit) return LATIN_UPPER + DIGITS;
        if (hasLatin) return LATIN_UPPER;
        if (hasDigit) return DIGITS;
        return '';
    }

    async function init() {
        if (initialized) return;
        worker = await Tesseract.createWorker('eng+ell', 1, { cacheMethod: 'write' });
        initialized = true;
    }

    function cropRegion(frameData, x, y, w, h, scale) {
        const { data, width, height } = frameData;
        x = Math.max(0, Math.round(x));
        y = Math.max(0, Math.round(y));
        w = Math.min(width - x, Math.round(w));
        h = Math.min(height - y, Math.round(h));
        if (w < 3 || h < 3) return null;

        scale = scale || SCALE;

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = w;
        srcCanvas.height = h;
        const srcCtx = srcCanvas.getContext('2d');
        const srcImg = srcCtx.createImageData(w, h);

        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
                const srcIdx = ((y + row) * width + (x + col)) * 4;
                const dstIdx = (row * w + col) * 4;
                srcImg.data[dstIdx] = data[srcIdx];
                srcImg.data[dstIdx + 1] = data[srcIdx + 1];
                srcImg.data[dstIdx + 2] = data[srcIdx + 2];
                srcImg.data[dstIdx + 3] = 255;
            }
        }
        srcCtx.putImageData(srcImg, 0, 0);

        const outCanvas = document.createElement('canvas');
        outCanvas.width = w * scale;
        outCanvas.height = h * scale;
        const outCtx = outCanvas.getContext('2d');
        outCtx.imageSmoothingEnabled = true;
        outCtx.imageSmoothingQuality = 'high';
        outCtx.drawImage(srcCanvas, 0, 0, outCanvas.width, outCanvas.height);

        return outCanvas;
    }

    function binarize(canvas) {
        if (!canvas) return null;
        const ctx = canvas.getContext('2d');
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        const n = canvas.width * canvas.height;

        for (let i = 0; i < n; i++) {
            const idx = i * 4;
            const g = Math.round(0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2]);
            d[idx] = g; d[idx + 1] = g; d[idx + 2] = g;
        }

        const hist = new Int32Array(256);
        for (let i = 0; i < n; i++) hist[d[i * 4]]++;
        let sumAll = 0;
        for (let i = 0; i < 256; i++) sumAll += i * hist[i];
        let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            const wF = n - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            const v = wB * wF * ((sumB / wB) - ((sumAll - sumB) / wF)) ** 2;
            if (v > maxVar) { maxVar = v; threshold = t; }
        }

        let below = 0;
        for (let i = 0; i < n; i++) if (d[i * 4] < threshold) below++;
        const inv = below > n / 2;

        for (let i = 0; i < n; i++) {
            const idx = i * 4;
            const bw = (inv ? (d[idx] < threshold) : (d[idx] >= threshold)) ? 255 : 0;
            d[idx] = bw; d[idx + 1] = bw; d[idx + 2] = bw;
        }

        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    function getRowCrop(frame, gridInfo, rowIdx) {
        const cols = gridInfo.cols || 10;
        const firstCell = gridInfo.gridCells[rowIdx * cols];
        const lastCell = gridInfo.gridCells[Math.min(rowIdx * cols + (cols - 1), gridInfo.gridCells.length - 1)];
        const pad = 4;
        const x = Math.max(0, firstCell.x - pad);
        const y = Math.max(0, firstCell.y - pad);
        const w = Math.min(frame.width - x, (lastCell.x + lastCell.w) - firstCell.x + pad * 2);
        const h = Math.min(frame.height - y, firstCell.h + pad * 2);
        return { x, y, w, h };
    }

    function parseRowCodes(text, expectedCount) {
        const cleaned = text.replace(CODE_CHARS_RE, '');

        if (cleaned.length === expectedCount * CODE_LEN) {
            const codes = [];
            for (let i = 0; i < cleaned.length; i += CODE_LEN) codes.push(cleaned.substring(i, i + CODE_LEN));
            return codes;
        }

        if (cleaned.length >= expectedCount * CODE_LEN && cleaned.length <= expectedCount * CODE_LEN + 2) {
            const codes = [];
            for (let i = 0; i < expectedCount * CODE_LEN; i += CODE_LEN) codes.push(cleaned.substring(i, i + CODE_LEN));
            return codes;
        }

        let parts = text.replace(CODE_CHARS_SPACE_RE, ' ').trim().split(/\s+/).filter(c => c.length > 0);
        if (parts.length === expectedCount) return parts;

        if (parts.length > expectedCount) {
            const merged = [];
            let i = 0;
            while (i < parts.length && merged.length < expectedCount) {
                if (parts[i].length === 1 && i + 1 < parts.length && parts[i + 1].length === 1) {
                    merged.push(parts[i] + parts[i + 1]);
                    i += 2;
                } else {
                    merged.push(parts[i]);
                    i++;
                }
            }
            if (merged.length === expectedCount) return merged;
        }

        const expanded = [];
        for (const code of (parts.length > 0 ? parts : [cleaned])) {
            if (code.length > CODE_LEN && code.length % CODE_LEN === 0) {
                for (let i = 0; i < code.length; i += CODE_LEN) expanded.push(code.substring(i, i + CODE_LEN));
            } else expanded.push(code);
        }
        if (expanded.length === expectedCount) return expanded;

        return parts.length > 0 ? parts : (cleaned.length > 0 ? [cleaned] : []);
    }

    function parseTargetCodes(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            const parts = line.replace(CODE_CHARS_SPACE_RE, ' ').trim().split(/\s+/).filter(c => c.length > 0);
            const codeParts = parts.filter(p => p.length >= 1 && p.length <= 3 && CODE_CHAR_RE.test(p));
            if (codeParts.length >= 3 && codeParts.length <= 5) {
                return codeParts.slice(0, 4);
            }
        }

        const allChars = text.replace(CODE_CHARS_RE, '');
        if (allChars.length >= 6 && allChars.length <= 10 && allChars.length % CODE_LEN === 0) {
            const codes = [];
            for (let i = 0; i < allChars.length; i += CODE_LEN) codes.push(allChars.substring(i, i + CODE_LEN));
            if (codes.length >= 3 && codes.length <= 5) return codes.slice(0, 4);
        }

        for (const line of lines) {
            const digits = line.replace(/[^0-9]/g, '');
            if (digits.length >= 6 && digits.length <= 10) {
                const parts = line.replace(/[^0-9\s]/g, ' ').trim().split(/\s+/).filter(c => c.length > 0);
                if (parts.length >= 3 && parts.length <= 5) return parts.slice(0, 4);
                if (digits.length === 8) {
                    const codes = [];
                    for (let i = 0; i < 8; i += 2) codes.push(digits.substring(i, i + 2));
                    return codes;
                }
                if (parts.length >= 2) return parts.slice(0, 4);
            }
        }

        const allParts = text.replace(CODE_CHARS_SPACE_RE, ' ').trim().split(/\s+/).filter(c => c.length > 0 && CODE_CHAR_RE.test(c));
        return allParts.length >= 2 ? allParts.slice(0, 4) : null;
    }

    async function ocrTarget(frame, gridInfo) {
        if (!gridInfo.targetCells || gridInfo.targetCells.length < 3) return null;

        const t0 = gridInfo.targetCells[0];
        const tLast = gridInfo.targetCells[gridInfo.targetCells.length - 1];

        const pad = 8;
        const x = Math.max(0, t0.x - pad);
        const y = Math.max(0, t0.y - pad);
        const w = Math.min(frame.width - x, (tLast.x + tLast.w) - t0.x + pad * 2);
        const h = Math.min(frame.height - y, t0.h + pad * 2);

        await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });

        const canvas = cropRegion(frame, x, y, w, h);
        if (!canvas) return null;
        const result = await worker.recognize(canvas);
        const codes = parseTargetCodes(result.data.text.trim());

        if (codes && codes.length >= 2) return codes;

        await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
        const tightY = t0.y + Math.floor(t0.h * 0.35);
        const tightH = Math.floor(t0.h * 0.65) + pad;
        const tightCanvas = cropRegion(frame, x, tightY, w, tightH);
        if (!tightCanvas) return null;
        const r2 = await worker.recognize(tightCanvas);
        const codes2 = parseTargetCodes(r2.data.text.trim());

        return codes2 && codes2.length >= 2 ? codes2 : null;
    }

    async function ocrGridBlock(frame, gridInfo, whitelist) {
        if (!gridInfo.gridCells || gridInfo.gridCells.length < 30) return null;

        const cols = gridInfo.cols || 10;
        const rows = gridInfo.rows || 8;
        const pad = 6;

        const firstCell = gridInfo.gridCells[0];
        const lastCell = gridInfo.gridCells[gridInfo.gridCells.length - 1];
        const x = Math.max(0, firstCell.x - pad);
        const y = Math.max(0, firstCell.y - pad);
        const w = Math.min(frame.width - x, (lastCell.x + lastCell.w) - firstCell.x + pad * 2);
        const h = Math.min(frame.height - y, (lastCell.y + lastCell.h) - firstCell.y + pad * 2);

        await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: whitelist || ''
        });

        const canvas = cropRegion(frame, x, y, w, h);
        if (!canvas) return null;

        const result = await worker.recognize(canvas);
        const text = result.data.text.trim();
        const lines = text.split('\n').filter(l => l.trim().length > 0);

        const allCodes = [];
        for (let r = 0; r < rows; r++) {
            if (r < lines.length) {
                const codes = parseRowCodes(lines[r].trim(), cols);
                if (codes.length === cols) {
                    allCodes.push(...codes);
                } else {
                    for (let c = 0; c < cols; c++) allCodes.push(codes[c] || '??');
                }
            } else {
                for (let c = 0; c < cols; c++) allCodes.push('??');
            }
        }

        return allCodes.length === rows * cols ? allCodes : null;
    }

    async function ocrCellRow(frame, gridInfo, rowIdx, whitelist) {
        const cols = gridInfo.cols || 10;
        const codes = [];
        const pad = 2;
        const cellScale = 5;

        await worker.setParameters({
            tessedit_pageseg_mode: '8',
            tessedit_char_whitelist: whitelist || ''
        });

        for (let c = 0; c < cols; c++) {
            const cell = gridInfo.gridCells[rowIdx * cols + c];
            const cx = Math.max(0, cell.x - pad);
            const cy = Math.max(0, cell.y - pad);
            const cw = Math.min(frame.width - cx, cell.w + pad * 2);
            const ch = Math.min(frame.height - cy, cell.h + pad * 2);

            const canvas = cropRegion(frame, cx, cy, cw, ch, cellScale);
            if (!canvas) {
                codes.push('??');
                continue;
            }

            const result = await worker.recognize(canvas);
            const text = result.data.text.trim().replace(CODE_CHARS_RE, '');
            codes.push(text.length >= 1 && text.length <= 3 ? text : '??');
        }

        return codes;
    }

    async function ocrGrid(frame, gridInfo, whitelist) {
        if (!gridInfo.gridCells || gridInfo.gridCells.length < 30) return null;

        const cols = gridInfo.cols || 10;
        const rows = gridInfo.rows || 8;
        const allCodes = [];

        await worker.setParameters({
            tessedit_pageseg_mode: '7',
            tessedit_char_whitelist: whitelist || ''
        });

        for (let r = 0; r < rows; r++) {
            const crop = getRowCrop(frame, gridInfo, r);

            const canvas = cropRegion(frame, crop.x, crop.y, crop.w, crop.h);
            if (!canvas) {
                for (let c = 0; c < cols; c++) allCodes.push('??');
                continue;
            }

            const result = await worker.recognize(canvas);
            var codes = parseRowCodes(result.data.text.trim(), cols);

            if (codes.length !== cols) {
                const binCanvas = cropRegion(frame, crop.x, crop.y, crop.w, crop.h);
                if (binCanvas) {
                    binarize(binCanvas);
                    const r2 = await worker.recognize(binCanvas);
                    const c2 = parseRowCodes(r2.data.text.trim(), cols);
                    if (c2.length === cols || c2.length > codes.length) {
                        codes = c2;
                    }
                }
            }

            if (codes.length !== cols) {
                await worker.setParameters({
                    tessedit_pageseg_mode: '7',
                    tessedit_char_whitelist: whitelist || ''
                });
                codes = await ocrCellRow(frame, gridInfo, r, whitelist);
            }

            if (codes.length === cols) {
                allCodes.push(...codes);
            } else {
                for (let c = 0; c < cols; c++) {
                    allCodes.push(codes[c] || '??');
                }
            }
        }

        return allCodes.length === rows * cols ? allCodes : null;
    }

    async function terminate() {
        if (worker) {
            await worker.terminate();
            worker = null;
            initialized = false;
        }
    }

    return {
        init, ocrTarget, ocrGridBlock, ocrGrid, ocrCellRow, terminate,
        cropRegion, binarize, parseRowCodes, parseTargetCodes,
        normalizeText, normalizeCodes, guessWhitelist
    };
})();
