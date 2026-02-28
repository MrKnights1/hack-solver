#!/usr/bin/env node
'use strict';

// Full pipeline scan test: detect → OCR target → OCR grid → text match
// Uses sharp for image cropping (browser canvas APIs don't work in Node.js)
//
// SECURITY NOTE: The new Function() calls below are used exclusively to load
// our own trusted project source files in a Node.js environment.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const IMAGES_DIR = '/root/projektid/hakid/testimages';
const SCALE = 3;

function loadModule(filename, extraGlobals, returnVar) {
    const src = fs.readFileSync(path.join(__dirname, '..', filename), 'utf-8');
    const mockCtx = {
        createImageData: (w, h) => ({
            data: new Uint8ClampedArray(w * h * 4), width: w, height: h
        }),
        putImageData: () => {},
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(0) }),
        clearRect: () => {},
        set imageSmoothingEnabled(_) {},
        set imageSmoothingQuality(_) {},
    };
    const mockCanvas = { width: 0, height: 0, getContext: () => mockCtx };
    const mockDoc = { createElement: () => ({ ...mockCanvas }) };

    const globals = { document: mockDoc, ...extraGlobals };
    const argNames = Object.keys(globals);
    const argValues = Object.values(globals);

    const loader = new Function(...argNames, src + '\nreturn ' + returnVar + ';');
    return loader(...argValues);
}

const Detector = loadModule('detector.js', {}, 'Detector');
const Matcher = loadModule('matcher.js', {}, 'Matcher');

// Load OCR module only for parser/normalizer functions (not for cropRegion/worker)
const mockTesseract = { createWorker: async () => ({}) };
const OCR = loadModule('ocr.js', { Tesseract: mockTesseract }, 'OCR');

async function loadImage(filepath) {
    const { data, info } = await sharp(filepath)
        .raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    return {
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height
    };
}

async function cropAndUpscale(filepath, x, y, w, h, scale) {
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    w = Math.round(w);
    h = Math.round(h);
    if (w < 3 || h < 3) return null;

    return await sharp(filepath)
        .extract({ left: x, top: y, width: w, height: h })
        .resize(w * scale, h * scale, { kernel: sharp.kernel.lanczos3 })
        .png()
        .toBuffer();
}

async function cropAndUpscaleBinarized(filepath, x, y, w, h, scale) {
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    w = Math.round(w);
    h = Math.round(h);
    if (w < 3 || h < 3) return null;

    return await sharp(filepath)
        .extract({ left: x, top: y, width: w, height: h })
        .resize(w * scale, h * scale, { kernel: sharp.kernel.lanczos3 })
        .greyscale()
        .threshold()
        .png()
        .toBuffer();
}

async function scanImage(filepath, worker) {
    const name = path.basename(filepath, '.jpg').substring(0, 8);
    console.log('\n=== ' + name + ' ===');

    const frame = await loadImage(filepath);
    console.log('  Frame: ' + frame.width + 'x' + frame.height);

    const det = Detector.detect(frame);
    if (!det) {
        console.log('  DETECT FAILED');
        return;
    }
    console.log('  Grid: ' + det.gridCells.length + ', Target: ' +
        (det.targetCells ? det.targetCells.length : 0));

    if (det.gridCells.length < 30 || !det.targetCells || det.targetCells.length < 3) {
        console.log('  NOT ENOUGH CELLS');
        return;
    }

    const cols = det.cols || 10;
    const rows = det.rows || 8;

    // OCR target using sharp crop
    const t0 = det.targetCells[0];
    const tLast = det.targetCells[det.targetCells.length - 1];
    const tPad = 8;
    const tX = Math.max(0, t0.x - tPad);
    const tY = Math.max(0, t0.y - tPad);
    const tW = Math.min(frame.width - tX, (tLast.x + tLast.w) - t0.x + tPad * 2);
    const tH = Math.min(frame.height - tY, t0.h + tPad * 2);

    await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
    let targetBuf = await cropAndUpscale(filepath, tX, tY, tW, tH, SCALE);
    let targetResult = await worker.recognize(targetBuf);
    let targetCodes = OCR.parseTargetCodes(targetResult.data.text.trim());

    if (!targetCodes || targetCodes.length < 2) {
        const tightY = t0.y + Math.floor(t0.h * 0.35);
        const tightH = Math.floor(t0.h * 0.65) + tPad;
        await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
        targetBuf = await cropAndUpscale(filepath, tX, tightY, tW, tightH, SCALE);
        if (targetBuf) {
            targetResult = await worker.recognize(targetBuf);
            targetCodes = OCR.parseTargetCodes(targetResult.data.text.trim());
        }
    }

    if (!targetCodes || targetCodes.length < 2) {
        console.log('  TARGET OCR FAILED: "' + targetResult.data.text.trim() + '"');
        return;
    }
    console.log('  Target: ' + targetCodes.join(' '));

    const wl = OCR.guessWhitelist(targetCodes);
    console.log('  Whitelist: ' + (wl || '(none)'));

    // OCR grid block (whole grid as one image)
    const pad = 6;
    const firstCell = det.gridCells[0];
    const lastCell = det.gridCells[det.gridCells.length - 1];
    const gx = Math.max(0, firstCell.x - pad);
    const gy = Math.max(0, firstCell.y - pad);
    const gw = Math.min(frame.width - gx, (lastCell.x + lastCell.w) - firstCell.x + pad * 2);
    const gh = Math.min(frame.height - gy, (lastCell.y + lastCell.h) - firstCell.y + pad * 2);

    await worker.setParameters({
        tessedit_pageseg_mode: '6',
        tessedit_char_whitelist: wl || ''
    });

    let gridCodes = null;
    let method = 'block';
    const gridBuf = await cropAndUpscale(filepath, gx, gy, gw, gh, SCALE);
    if (gridBuf) {
        const gridResult = await worker.recognize(gridBuf);
        const text = gridResult.data.text.trim();
        const lines = text.split('\n').filter(l => l.trim().length > 0);

        const allCodes = [];
        for (let r = 0; r < rows; r++) {
            if (r < lines.length) {
                const codes = OCR.parseRowCodes(lines[r].trim(), cols);
                if (codes.length === cols) {
                    allCodes.push(...codes);
                } else {
                    for (let c = 0; c < cols; c++) allCodes.push(codes[c] || '??');
                }
            } else {
                for (let c = 0; c < cols; c++) allCodes.push('??');
            }
        }
        if (allCodes.length === rows * cols && !allCodes.includes('??')) {
            gridCodes = allCodes;
        }
    }

    // Fallback: OCR row by row
    if (!gridCodes) {
        method = 'rows';
        await worker.setParameters({
            tessedit_pageseg_mode: '7',
            tessedit_char_whitelist: wl || ''
        });

        const allCodes = [];
        for (let r = 0; r < rows; r++) {
            const fc = det.gridCells[r * cols];
            const lc = det.gridCells[Math.min(r * cols + (cols - 1), det.gridCells.length - 1)];
            const rPad = 4;
            const rx = Math.max(0, fc.x - rPad);
            const ry = Math.max(0, fc.y - rPad);
            const rw = Math.min(frame.width - rx, (lc.x + lc.w) - fc.x + rPad * 2);
            const rh = Math.min(frame.height - ry, fc.h + rPad * 2);

            const rowBuf = await cropAndUpscale(filepath, rx, ry, rw, rh, SCALE);
            if (!rowBuf) {
                for (let c = 0; c < cols; c++) allCodes.push('??');
                continue;
            }
            let result = await worker.recognize(rowBuf);
            let codes = OCR.parseRowCodes(result.data.text.trim(), cols);

            // Fallback 1: try binarized version
            if (codes.length !== cols) {
                const binBuf = await cropAndUpscaleBinarized(filepath, rx, ry, rw, rh, SCALE);
                if (binBuf) {
                    const r2 = await worker.recognize(binBuf);
                    const c2 = OCR.parseRowCodes(r2.data.text.trim(), cols);
                    if (c2.length === cols || c2.length > codes.length) {
                        codes = c2;
                        result = r2;
                    }
                }
            }

            // Fallback 2: cell-by-cell OCR
            if (codes.length !== cols) {
                await worker.setParameters({
                    tessedit_pageseg_mode: '8',
                    tessedit_char_whitelist: wl || ''
                });
                const cellCodes = [];
                const cellPad = 2;
                const cellScale = 5;
                for (let c = 0; c < cols; c++) {
                    const cell = det.gridCells[r * cols + c];
                    const cx = Math.max(0, cell.x - cellPad);
                    const cy = Math.max(0, cell.y - cellPad);
                    const cw = Math.min(frame.width - cx, cell.w + cellPad * 2);
                    const ch = Math.min(frame.height - cy, cell.h + cellPad * 2);

                    const cellBuf = await cropAndUpscale(filepath, cx, cy, cw, ch, cellScale);
                    if (!cellBuf) { cellCodes.push('??'); continue; }

                    const cr = await worker.recognize(cellBuf);
                    const ct = cr.data.text.trim().replace(/[^A-Za-z0-9\u0370-\u03FF]/g, '');
                    cellCodes.push(ct.length >= 1 && ct.length <= 3 ? ct : '??');
                }
                // Restore row PSM for next row
                await worker.setParameters({
                    tessedit_pageseg_mode: '7',
                    tessedit_char_whitelist: wl || ''
                });
                // Use cell codes if they have more valid entries
                const validCells = cellCodes.filter(c => c !== '??').length;
                const validRow = codes.filter(c => c !== '??').length;
                if (validCells > validRow) {
                    codes = cellCodes;
                }
            }

            if (codes.length === cols) {
                allCodes.push(...codes);
            } else {
                for (let c = 0; c < cols; c++) allCodes.push(codes[c] || '??');
            }
        }
        if (allCodes.length === rows * cols) {
            gridCodes = allCodes;
        }
    }

    if (!gridCodes) {
        console.log('  GRID OCR FAILED (' + method + ')');
        return;
    }
    console.log('  Grid (' + method + '): ' + gridCodes.length + ' codes');

    const normTarget = OCR.normalizeCodes(targetCodes);
    const normGrid = OCR.normalizeCodes(gridCodes);

    const match = Matcher.findMatchByText(normTarget, normGrid);
    if (match) {
        console.log('  MATCH: R' + match.row + ' C' + match.col +
            ' conf=' + Math.round(match.confidence * 100) + '% score=' + match.score);
    } else {
        console.log('  NO MATCH');
    }
    console.log('  Target: ' + normTarget.join(' '));
    for (let r = 0; r < rows; r++) {
        console.log('  R' + (r + 1) + ': ' + normGrid.slice(r * cols, r * cols + cols).join(' '));
    }
}

async function main() {
    const files = fs.readdirSync(IMAGES_DIR)
        .filter(f => f.endsWith('.jpg'))
        .slice(0, 12);

    console.log('Testing ' + files.length + ' images from ' + IMAGES_DIR);

    const worker = await Tesseract.createWorker('eng+ell');

    for (const f of files) {
        await scanImage(path.join(IMAGES_DIR, f), worker);
    }

    await worker.terminate();
}

main().catch(console.error);
