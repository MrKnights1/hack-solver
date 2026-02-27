const OCR = (() => {
    let worker = null;
    let initialized = false;
    let currentLang = '';
    let detectedCharset = null;

    const SCALE = 3;
    const CODE_LEN = 2;

    const GREEK_UPPER = '\u0391\u0392\u0393\u0394\u0395\u0396\u0397\u0398\u0399\u039A\u039B\u039C\u039D\u039E\u039F\u03A0\u03A1\u03A3\u03A4\u03A5\u03A6\u03A7\u03A8\u03A9';
    const GREEK_LOWER = '\u03B1\u03B2\u03B3\u03B4\u03B5\u03B6\u03B7\u03B8\u03B9\u03BA\u03BB\u03BC\u03BD\u03BE\u03BF\u03C0\u03C1\u03C3\u03C4\u03C5\u03C6\u03C7\u03C8\u03C9';
    const LATIN_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const LATIN_LOWER = 'abcdefghijklmnopqrstuvwxyz';
    const DIGITS = '0123456789';

    const CHARSETS = {
        numeric: { lang: 'eng', whitelist: DIGITS },
        alpha: { lang: 'eng', whitelist: LATIN_UPPER + LATIN_LOWER },
        greek: { lang: 'ell', whitelist: GREEK_UPPER + GREEK_LOWER },
        alphanum: { lang: 'eng', whitelist: DIGITS + LATIN_UPPER + LATIN_LOWER }
    };

    const CODE_CHAR_RE = /[A-Za-z0-9\u0370-\u03FF]/;
    const CODE_CHARS_RE = /[^A-Za-z0-9\u0370-\u03FF]/g;
    const CODE_CHARS_SPACE_RE = /[^A-Za-z0-9\u0370-\u03FF\s]/g;

    async function init(lang) {
        lang = lang || 'eng';
        if (initialized && currentLang === lang) return;
        if (worker) await worker.terminate();
        worker = await Tesseract.createWorker(lang, 1, { cacheMethod: 'write' });
        currentLang = lang;
        initialized = true;
    }

    async function switchLang(lang) {
        if (currentLang === lang && initialized) return;
        if (worker) await worker.terminate();
        worker = await Tesseract.createWorker(lang, 1, { cacheMethod: 'write' });
        currentLang = lang;
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

    async function ocrRowWithLang(canvas, lang, whitelist) {
        await switchLang(lang);
        await worker.setParameters({
            tessedit_pageseg_mode: '7',
            tessedit_char_whitelist: whitelist || ''
        });
        const result = await worker.recognize(canvas);
        return result.data.text.trim();
    }

    async function detectCharsetFromFrame(frame, gridInfo) {
        if (!gridInfo.gridCells || gridInfo.gridCells.length < 10) return 'alphanum';

        const cols = gridInfo.cols || 10;
        const crop = getRowCrop(frame, gridInfo, 0);
        const canvas = cropRegion(frame, crop.x, crop.y, crop.w, crop.h);
        if (!canvas) return 'alphanum';

        // Try row 0 with eng (no whitelist — let it read whatever it can)
        const engText = await ocrRowWithLang(canvas, 'eng', '');
        const engCodes = parseRowCodes(engText, cols);
        const engValid = engCodes.filter(c => c.length === CODE_LEN).length;

        // Try row 0 with ell (Greek)
        const ellCanvas = cropRegion(frame, crop.x, crop.y, crop.w, crop.h);
        const ellText = await ocrRowWithLang(ellCanvas, 'ell', '');
        const ellCodes = parseRowCodes(ellText, cols);
        const ellValid = ellCodes.filter(c => c.length === CODE_LEN).length;

        // Also try a second row for more confidence
        let engValid2 = 0, ellValid2 = 0;
        const rows = gridInfo.rows || 8;
        if (rows > 2) {
            const crop2 = getRowCrop(frame, gridInfo, 2);
            const canvas2a = cropRegion(frame, crop2.x, crop2.y, crop2.w, crop2.h);
            const canvas2b = cropRegion(frame, crop2.x, crop2.y, crop2.w, crop2.h);
            if (canvas2a && canvas2b) {
                const engText2 = await ocrRowWithLang(canvas2a, 'eng', '');
                engValid2 = parseRowCodes(engText2, cols).filter(c => c.length === CODE_LEN).length;
                const ellText2 = await ocrRowWithLang(canvas2b, 'ell', '');
                ellValid2 = parseRowCodes(ellText2, cols).filter(c => c.length === CODE_LEN).length;
            }
        }

        const engTotal = engValid + engValid2;
        const ellTotal = ellValid + ellValid2;

        if (ellTotal > engTotal) return 'greek';

        if (engTotal >= cols) {
            const allText = engText;
            let digits = 0, letters = 0;
            for (const ch of allText) {
                if (/[0-9]/.test(ch)) digits++;
                else if (/[A-Za-z]/.test(ch)) letters++;
            }
            if (digits > 0 && letters === 0) return 'numeric';
            if (letters > 0 && digits === 0) return 'alpha';
            if (digits > 0 && letters > 0) return 'alphanum';
            return 'alpha';
        }

        // Neither produced good results — try binarized
        const binCanvas = binarize(cropRegion(frame, crop.x, crop.y, crop.w, crop.h));
        if (binCanvas) {
            const binEngText = await ocrRowWithLang(binCanvas, 'eng', '');
            const binEngValid = parseRowCodes(binEngText, cols).filter(c => c.length === CODE_LEN).length;

            const binEllCanvas = binarize(cropRegion(frame, crop.x, crop.y, crop.w, crop.h));
            if (binEllCanvas) {
                const binEllText = await ocrRowWithLang(binEllCanvas, 'ell', '');
                const binEllValid = parseRowCodes(binEllText, cols).filter(c => c.length === CODE_LEN).length;
                if (binEllValid > binEngValid) return 'greek';
            }

            if (binEngValid >= cols) {
                let d = 0, l = 0;
                for (const ch of binEngText) {
                    if (/[0-9]/.test(ch)) d++;
                    else if (/[A-Za-z]/.test(ch)) l++;
                }
                if (d > l) return 'numeric';
                return 'alpha';
            }
        }

        return ellTotal > 0 ? 'greek' : 'alphanum';
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

        // Digit-specific fallback for numeric mode
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

        const cs = detectedCharset ? CHARSETS[detectedCharset] : null;
        if (cs) await switchLang(cs.lang);

        await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });

        const canvas = cropRegion(frame, x, y, w, h);
        if (!canvas) return null;
        const result = await worker.recognize(canvas);
        const codes = parseTargetCodes(result.data.text.trim());

        if (codes && codes.length >= 2) return codes;

        // Fallback: tighter crop (skip header text), PSM 7
        await worker.setParameters({
            tessedit_pageseg_mode: '7',
            tessedit_char_whitelist: cs ? cs.whitelist : ''
        });
        const tightY = t0.y + Math.floor(t0.h * 0.35);
        const tightH = Math.floor(t0.h * 0.65) + pad;
        const tightCanvas = cropRegion(frame, x, tightY, w, tightH);
        if (!tightCanvas) return null;
        const r2 = await worker.recognize(tightCanvas);
        const codes2 = parseTargetCodes(r2.data.text.trim());

        return codes2 && codes2.length >= 2 ? codes2 : null;
    }

    async function ocrGrid(frame, gridInfo) {
        if (!gridInfo.gridCells || gridInfo.gridCells.length < 30) return null;

        const cols = gridInfo.cols || 10;
        const rows = gridInfo.rows || 8;
        const allCodes = [];

        const cs = detectedCharset ? CHARSETS[detectedCharset] : CHARSETS.alphanum;

        await switchLang(cs.lang);
        await worker.setParameters({
            tessedit_pageseg_mode: '7',
            tessedit_char_whitelist: cs.whitelist
        });

        for (let r = 0; r < rows; r++) {
            const crop = getRowCrop(frame, gridInfo, r);

            let canvas = cropRegion(frame, crop.x, crop.y, crop.w, crop.h);
            if (!canvas) {
                for (let c = 0; c < cols; c++) allCodes.push('??');
                continue;
            }

            let result = await worker.recognize(canvas);
            let codes = parseRowCodes(result.data.text.trim(), cols);

            if (codes.length !== cols) {
                canvas = binarize(cropRegion(frame, crop.x, crop.y, crop.w, crop.h));
                if (canvas) {
                    result = await worker.recognize(canvas);
                    codes = parseRowCodes(result.data.text.trim(), cols);
                }
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

    function getDetectedCharset() {
        return detectedCharset;
    }

    function setDetectedCharset(cs) {
        detectedCharset = cs;
    }

    async function terminate() {
        if (worker) {
            await worker.terminate();
            worker = null;
            initialized = false;
            currentLang = '';
            detectedCharset = null;
        }
    }

    return {
        init, switchLang, ocrTarget, ocrGrid, terminate,
        detectCharsetFromFrame, getDetectedCharset, setDetectedCharset,
        cropRegion, binarize, parseRowCodes
    };
})();
