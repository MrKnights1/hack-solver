const OCR = (() => {
    let worker = null;
    let initialized = false;
    let currentLang = '';

    const SCALE = 3;

    async function init(lang) {
        lang = lang || 'eng';
        if (initialized && currentLang === lang) return;

        if (worker) {
            await worker.terminate();
        }

        worker = await Tesseract.createWorker(lang, 1, {
            cacheMethod: 'write'
        });

        currentLang = lang;
        initialized = true;
    }

    async function setWhitelist(chars) {
        if (!worker) return;
        await worker.setParameters({
            tessedit_char_whitelist: chars
        });
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

    function parseRowCodes(text, expectedCount) {
        const cleaned = text.replace(/[^A-Za-z0-9]/g, '');

        if (/^\d+$/.test(cleaned) && cleaned.length === expectedCount * 2) {
            const codes = [];
            for (let i = 0; i < cleaned.length; i += 2) codes.push(cleaned.substring(i, i + 2));
            return codes;
        }

        if (/^\d+$/.test(cleaned) && cleaned.length >= expectedCount * 2 && cleaned.length <= expectedCount * 2 + 2) {
            const codes = [];
            for (let i = 0; i < expectedCount * 2; i += 2) codes.push(cleaned.substring(i, i + 2));
            return codes;
        }

        let parts = text.replace(/[^A-Za-z0-9\u0370-\u03FF\s]/g, ' ').trim().split(/\s+/).filter(c => c.length > 0);
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
            if (code.length > 2 && code.length % 2 === 0) {
                for (let i = 0; i < code.length; i += 2) expanded.push(code.substring(i, i + 2));
            } else expanded.push(code);
        }
        if (expanded.length === expectedCount) return expanded;

        return parts.length > 0 ? parts : (cleaned.length > 0 ? [cleaned] : []);
    }

    function parseTargetCodes(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            const digits = line.replace(/[^0-9]/g, '');
            if (digits.length >= 6 && digits.length <= 10) {
                const parts = line.replace(/[^A-Za-z0-9\s]/g, ' ').trim().split(/\s+/).filter(c => c.length > 0);
                const digitParts = parts.map(p => p.replace(/[^0-9]/g, '')).filter(p => p.length > 0);
                if (digitParts.length >= 3 && digitParts.length <= 5) {
                    return digitParts.slice(0, 4);
                }
                if (digits.length === 8) {
                    const codes = [];
                    for (let i = 0; i < 8; i += 2) codes.push(digits.substring(i, i + 2));
                    return codes;
                }
                if (digitParts.length >= 2) return digitParts.slice(0, 4);
            }
        }

        const allDigits = text.replace(/[^0-9]/g, '');
        if (allDigits.length === 8) {
            const codes = [];
            for (let i = 0; i < 8; i += 2) codes.push(allDigits.substring(i, i + 2));
            return codes;
        }

        const parts = text.replace(/[^A-Za-z0-9\u0370-\u03FF\s]/g, ' ').trim().split(/\s+/).filter(c => c.length > 0);
        const digitParts = parts.map(p => p.replace(/[^0-9]/g, '')).filter(p => p.length > 0);
        return digitParts.length >= 2 ? digitParts.slice(0, 4) : null;
    }

    async function ocrTarget(frame, gridInfo) {
        if (!gridInfo.targetCells || gridInfo.targetCells.length < 4) return null;

        const t0 = gridInfo.targetCells[0];
        const tLast = gridInfo.targetCells[gridInfo.targetCells.length - 1];

        const pad = 8;
        const x = Math.max(0, t0.x - pad);
        const y = Math.max(0, t0.y - pad);
        const w = Math.min(frame.width - x, (tLast.x + tLast.w) - t0.x + pad * 2);
        const h = Math.min(frame.height - y, t0.h + pad * 2);

        await worker.setParameters({ tessedit_pageseg_mode: '6' });

        const canvas = cropRegion(frame, x, y, w, h);
        if (!canvas) return null;
        const result = await worker.recognize(canvas);
        const codes = parseTargetCodes(result.data.text.trim());

        if (codes && codes.length >= 2) return codes;

        await worker.setParameters({ tessedit_pageseg_mode: '7' });
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

        await worker.setParameters({
            tessedit_pageseg_mode: '7',
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        });

        for (let r = 0; r < rows; r++) {
            const firstCell = gridInfo.gridCells[r * cols];
            const lastCell = gridInfo.gridCells[r * cols + (cols - 1)];

            const pad = 4;
            const x = Math.max(0, firstCell.x - pad);
            const y = Math.max(0, firstCell.y - pad);
            const w = Math.min(frame.width - x, (lastCell.x + lastCell.w) - firstCell.x + pad * 2);
            const h = Math.min(frame.height - y, firstCell.h + pad * 2);

            let canvas = cropRegion(frame, x, y, w, h);
            if (!canvas) {
                for (let c = 0; c < cols; c++) allCodes.push('??');
                continue;
            }

            let result = await worker.recognize(canvas);
            let codes = parseRowCodes(result.data.text.trim(), cols);

            if (codes.length !== cols) {
                canvas = binarize(cropRegion(frame, x, y, w, h));
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

    async function terminate() {
        if (worker) {
            await worker.terminate();
            worker = null;
            initialized = false;
            currentLang = '';
        }
    }

    return { init, setWhitelist, ocrTarget, ocrGrid, terminate };
})();
