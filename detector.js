const Detector = (() => {

    function toGrayscale(imageData) {
        const { data, width, height } = imageData;
        const gray = new Uint8Array(width * height);
        for (let i = 0; i < gray.length; i++) {
            const j = i * 4;
            gray[i] = Math.round(0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]);
        }
        return { data: gray, width, height };
    }

    function adaptiveThreshold(gray, blockSize, C) {
        const { data, width, height } = gray;
        const out = new Uint8Array(width * height);
        const half = Math.floor(blockSize / 2);

        let globalSum = 0;
        for (let i = 0; i < data.length; i++) globalSum += data[i];
        const globalMean = globalSum / data.length;
        const minBrightness = Math.max(40, globalMean + 20);

        const integral = new Float64Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y++) {
            let rowSum = 0;
            for (let x = 0; x < width; x++) {
                rowSum += data[y * width + x];
                integral[(y + 1) * (width + 1) + (x + 1)] =
                    rowSum + integral[y * (width + 1) + (x + 1)];
            }
        }

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixel = data[y * width + x];
                if (pixel < minBrightness) {
                    out[y * width + x] = 0;
                    continue;
                }
                const y1 = Math.max(0, y - half);
                const y2 = Math.min(height - 1, y + half);
                const x1 = Math.max(0, x - half);
                const x2 = Math.min(width - 1, x + half);
                const area = (y2 - y1 + 1) * (x2 - x1 + 1);
                const sum = integral[(y2 + 1) * (width + 1) + (x2 + 1)]
                          - integral[y1 * (width + 1) + (x2 + 1)]
                          - integral[(y2 + 1) * (width + 1) + x1]
                          + integral[y1 * (width + 1) + x1];
                const mean = sum / area;
                out[y * width + x] = pixel > (mean - C) ? 255 : 0;
            }
        }

        return { data: out, width, height };
    }

    function rowProjection(binary) {
        const { data, width, height } = binary;
        const proj = new Float64Array(height);
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) {
                if (data[y * width + x] === 255) sum++;
            }
            proj[y] = sum / width;
        }
        return proj;
    }

    function colProjection(binary, yStart, yEnd) {
        const { data, width } = binary;
        const proj = new Float64Array(width);
        const rowCount = yEnd - yStart;
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let y = yStart; y < yEnd; y++) {
                if (data[y * width + x] === 255) sum++;
            }
            proj[x] = sum / rowCount;
        }
        return proj;
    }

    /**
     * Find peaks in a projection. Returns { start, end, center, peak }.
     */
    function findPeaks(proj, threshold) {
        const groups = [];
        let inGroup = false;
        let start = 0;
        let maxVal = 0;

        for (let i = 0; i < proj.length; i++) {
            if (proj[i] > threshold) {
                if (!inGroup) {
                    inGroup = true;
                    start = i;
                    maxVal = 0;
                }
                if (proj[i] > maxVal) maxVal = proj[i];
            } else if (inGroup) {
                groups.push({ start, end: i, center: (start + i) / 2, peak: maxVal });
                inGroup = false;
            }
        }
        if (inGroup) {
            groups.push({ start, end: proj.length, center: (start + proj.length) / 2, peak: maxVal });
        }

        return groups;
    }

    /**
     * Merge nearby bands into single row bands.
     * Uses median gap as reference: gaps < 40% of the median are within-row
     * and get merged (handles Braille dots, highlighted row sub-bands, etc.)
     */
    function mergeBands(bands) {
        if (bands.length <= 8) return bands;

        const gaps = [];
        for (let i = 1; i < bands.length; i++) {
            gaps.push(bands[i].start - bands[i - 1].end);
        }

        const sorted = gaps.slice().sort((a, b) => a - b);
        const medianGap = sorted[Math.floor(sorted.length / 2)];
        const threshold = Math.max(2, medianGap * 0.4);

        const merged = [{ start: bands[0].start, end: bands[0].end, peak: bands[0].peak }];
        for (let i = 1; i < bands.length; i++) {
            const gap = bands[i].start - merged[merged.length - 1].end;
            if (gap <= threshold) {
                merged[merged.length - 1].end = bands[i].end;
                merged[merged.length - 1].peak = Math.max(merged[merged.length - 1].peak, bands[i].peak);
            } else {
                merged.push({ start: bands[i].start, end: bands[i].end, peak: bands[i].peak });
            }
        }
        merged.forEach(b => b.center = (b.start + b.end) / 2);

        if (merged.length < 8) return bands;
        return merged;
    }

    /**
     * Find the best group of 8 consecutive row bands.
     * Scores by both spacing regularity AND text density.
     */
    function findBestRowGroup(rowBands, minDensity) {
        if (rowBands.length < 8) return null;

        let bestGroup = null;
        let bestScore = Infinity;

        for (let i = 0; i <= rowBands.length - 8; i++) {
            const group = rowBands.slice(i, i + 8);

            const groupMinPeak = Math.min(...group.map(b => b.peak));
            if (groupMinPeak < minDensity) continue;

            const spacings = [];
            for (let j = 1; j < group.length; j++) {
                spacings.push(group[j].center - group[j - 1].center);
            }
            const avgSpacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
            const variance = spacings.reduce((s, sp) => s + (sp - avgSpacing) ** 2, 0) / spacings.length;
            const relativeVariance = variance / (avgSpacing * avgSpacing);

            if (relativeVariance > 0.15) continue;

            const avgDensity = group.reduce((s, b) => s + b.peak, 0) / 8;
            const score = relativeVariance / (avgDensity * avgDensity + 0.0001);

            if (score < bestScore) {
                bestScore = score;
                bestGroup = { rows: group, startIdx: i, spacing: avgSpacing, score: relativeVariance };
            }
        }

        return bestGroup;
    }

    /**
     * Find target row: look for a band above the grid that has
     * ~4 text elements (not 10). The target row is narrower than grid rows.
     *
     * Strategy: compare the horizontal text extent of each candidate band
     * to the grid width. Target has 4/10 = 40% of the width.
     */
    /**
     * Find target row: look for a band above the grid that has
     * ~4 text elements (not 10). Collects all candidates and picks
     * the one with highest text density (peak). Also merges adjacent
     * bands that are part of the same large text (e.g. "ΟΣ ΥΠ ΟΕ ΤΑ"
     * may split into upper/lower sub-bands).
     */
    function findTargetBand(rowBands, bestGroup, gridLeft, gridRight, gray) {
        const { data, width } = gray;
        const gridWidth = gridRight - gridLeft;
        const gridCenter = (gridLeft + gridRight) / 2;

        const candidates = [];

        for (let i = bestGroup.startIdx - 1; i >= 0; i--) {
            const band = rowBands[i];

            const gapFromGrid = bestGroup.rows[0].center - band.center;
            if (gapFromGrid > bestGroup.spacing * 8) break;

            const bStart = band.start;
            const bEnd = band.end;
            const bRows = bEnd - bStart;
            if (bRows < 2) continue;

            const bColMean = new Float64Array(width);
            const bColVar = new Float64Array(width);
            for (let x = 0; x < width; x++) {
                let sum = 0;
                for (let y = bStart; y < bEnd; y++) sum += data[y * width + x];
                bColMean[x] = sum / bRows;
                let sumSq = 0;
                for (let y = bStart; y < bEnd; y++) {
                    const d = data[y * width + x] - bColMean[x];
                    sumSq += d * d;
                }
                bColVar[x] = sumSq / bRows;
            }

            let peakVar = 0;
            for (let x = 0; x < width; x++) {
                if (bColVar[x] > peakVar) peakVar = bColVar[x];
            }
            if (peakVar < 5) continue;

            const varThreshold = peakVar * 0.1;
            let tLeft = -1, tRight = -1;
            for (let x = 0; x < width; x++) {
                if (bColVar[x] > varThreshold) { tLeft = x; break; }
            }
            for (let x = width - 1; x >= 0; x--) {
                if (bColVar[x] > varThreshold) { tRight = x; break; }
            }

            if (tLeft < 0 || tRight <= tLeft) continue;

            const bandWidth = tRight - tLeft;
            const bandCenter = (tLeft + tRight) / 2;
            const widthRatio = bandWidth / gridWidth;
            const centerOffset = Math.abs(bandCenter - gridCenter) / gridWidth;

            if (widthRatio >= 0.20 && widthRatio <= 0.65 && centerOffset < 0.3) {
                candidates.push({ bandIdx: i, tLeft, tRight, peak: band.peak });
            }
        }

        if (candidates.length === 0) return null;

        // If multiple adjacent candidates, merge them into one target region
        // (large target text can split into sub-bands)
        candidates.sort((a, b) => a.bandIdx - b.bandIdx);

        let bestStart = candidates[0].bandIdx;
        let bestEnd = candidates[0].bandIdx;
        let bestLeft = candidates[0].tLeft;
        let bestRight = candidates[0].tRight;
        let bestPeak = candidates[0].peak;

        for (let c = 1; c < candidates.length; c++) {
            if (candidates[c].bandIdx === candidates[c - 1].bandIdx + 1) {
                bestEnd = candidates[c].bandIdx;
                bestLeft = Math.min(bestLeft, candidates[c].tLeft);
                bestRight = Math.max(bestRight, candidates[c].tRight);
                bestPeak = Math.max(bestPeak, candidates[c].peak);
            } else if (candidates[c].peak > bestPeak) {
                bestStart = candidates[c].bandIdx;
                bestEnd = candidates[c].bandIdx;
                bestLeft = candidates[c].tLeft;
                bestRight = candidates[c].tRight;
                bestPeak = candidates[c].peak;
            }
        }

        return {
            bandIdx: bestStart,
            bandEndIdx: bestEnd,
            tLeft: bestLeft,
            tRight: bestRight
        };
    }

    function buildGridCells(bestGroup, gridLeft, gridRight, numCols) {
        const colSpacing = (gridRight - gridLeft) / numCols;
        const rowSpacing = bestGroup.spacing;
        const gridCells = [];

        for (const row of bestGroup.rows) {
            for (let c = 0; c < numCols; c++) {
                const cx = gridLeft + (c + 0.5) * colSpacing;
                const cy = row.center;
                const cellW = colSpacing * 0.92;
                const cellH = rowSpacing * 0.85;
                const x = Math.round(cx - cellW / 2);
                const y = Math.round(cy - cellH / 2);
                gridCells.push({
                    x: Math.max(0, x),
                    y: Math.max(0, y),
                    w: Math.round(cellW),
                    h: Math.round(cellH),
                    cx, cy,
                    area: Math.round(cellW * cellH)
                });
            }
        }

        return gridCells;
    }

    function buildTargetCells(targetRow, tLeft, tRight) {
        const targetH = targetRow.end - targetRow.start;
        const targetCY = (targetRow.start + targetRow.end) / 2;
        const targetSpan = tRight - tLeft;
        const targetCellW = targetSpan / 4;
        const targetCells = [];

        for (let i = 0; i < 4; i++) {
            const cx = tLeft + (i + 0.5) * targetCellW;
            targetCells.push({
                x: Math.round(cx - targetCellW / 2),
                y: targetRow.start,
                w: Math.round(targetCellW),
                h: targetH,
                cx,
                cy: targetCY,
                area: Math.round(targetCellW * targetH)
            });
        }

        return targetCells;
    }

    /**
     * Find grid using binary threshold + projection analysis.
     */
    function findGridByProjection(binary) {
        const { width, height } = binary;

        const rProj = rowProjection(binary);
        const rawRowBands = findPeaks(rProj, 0.02);
        const filteredBands = rawRowBands.filter(b => (b.end - b.start) >= 3);
        if (filteredBands.length < 8) return null;

        const rowBands = mergeBands(filteredBands);

        const bestGroup = findBestRowGroup(rowBands, 0.035);
        if (!bestGroup) return null;

        const gridTop = bestGroup.rows[0].start;
        const gridBottom = bestGroup.rows[7].end;
        const rowSpacing = bestGroup.spacing;
        const numCols = 10;

        const cProj = colProjection(binary, gridTop, gridBottom);
        const kernel = Math.max(3, Math.round(rowSpacing * 0.4));
        const smoothProj = new Float64Array(width);
        for (let x = 0; x < width; x++) {
            let sum = 0, count = 0;
            for (let dx = -kernel; dx <= kernel; dx++) {
                const xx = x + dx;
                if (xx >= 0 && xx < width) { sum += cProj[xx]; count++; }
            }
            smoothProj[x] = sum / count;
        }

        let peakVal = 0;
        for (let x = 0; x < width; x++) {
            if (smoothProj[x] > peakVal) peakVal = smoothProj[x];
        }
        if (peakVal < 0.01) return null;

        const extentThreshold = peakVal * 0.15;
        let gridLeft = -1, gridRight = -1;
        let maxLen = 0;
        let inRegion = false, regionStart = 0;

        for (let x = 0; x <= width; x++) {
            if (x < width && smoothProj[x] > extentThreshold) {
                if (!inRegion) { inRegion = true; regionStart = x; }
            } else if (inRegion) {
                const len = x - regionStart;
                if (len > maxLen) { maxLen = len; gridLeft = regionStart; gridRight = x; }
                inRegion = false;
            }
        }

        if (gridLeft < 0 || gridRight - gridLeft < rowSpacing * 3) return null;

        const rawThreshold = 0.01;
        let trimLeft = gridLeft, trimRight = gridRight;
        for (let x = gridLeft; x < gridRight; x++) {
            if (cProj[x] > rawThreshold) { trimLeft = x; break; }
        }
        for (let x = gridRight - 1; x >= gridLeft; x--) {
            if (cProj[x] > rawThreshold) { trimRight = x + 1; break; }
        }

        const gridCells = buildGridCells(bestGroup, trimLeft, trimRight, numCols);

        // Target detection: use column variance on binary data (same as GS path)
        const targetResult = findTargetBand(rowBands, bestGroup, trimLeft, trimRight, binary);
        let targetCells = null;
        if (targetResult) {
            const startBand = rowBands[targetResult.bandIdx];
            const endBand = rowBands[targetResult.bandEndIdx || targetResult.bandIdx];
            const mergedTarget = {
                start: startBand.start,
                end: endBand.end,
                center: (startBand.start + endBand.end) / 2
            };
            targetCells = buildTargetCells(mergedTarget, targetResult.tLeft, targetResult.tRight);
        }

        return {
            gridCells,
            targetCells: targetCells && targetCells.length >= 4 ? targetCells : null,
            rows: 8,
            cols: numCols
        };
    }

    function detrendedProjection(values, smoothKernel) {
        const n = values.length;
        const baseline = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let sum = 0, count = 0;
            for (let d = -smoothKernel; d <= smoothKernel; d++) {
                const j = i + d;
                if (j >= 0 && j < n) { sum += values[j]; count++; }
            }
            baseline[i] = sum / count;
        }
        const detrended = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            detrended[i] = Math.max(0, values[i] - baseline[i]);
        }
        return detrended;
    }

    /**
     * Camera-friendly grid detection using detrended grayscale projections.
     */
    function findGridByGrayscaleProjection(gray) {
        const { data, width, height } = gray;

        const rowMean = new Float64Array(height);
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) sum += data[y * width + x];
            rowMean[y] = sum / width;
        }

        const detrendKernel = Math.max(20, Math.round(height / 40));
        const rowDetrended = detrendedProjection(rowMean, detrendKernel);

        const rawRowBands = findPeaks(rowDetrended, 3);
        const filteredBands = rawRowBands.filter(b => (b.end - b.start) >= 3);
        if (filteredBands.length < 8) return null;

        const rowBands = mergeBands(filteredBands);

        const bestGroup = findBestRowGroup(rowBands, 4);
        if (!bestGroup) return null;

        const gridTop = bestGroup.rows[0].start;
        const gridBottom = bestGroup.rows[7].end;
        const rowSpacing = bestGroup.spacing;
        const numCols = 10;

        // Column variance to find grid horizontal extent
        const colMean = new Float64Array(width);
        const rowCount = gridBottom - gridTop;
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let y = gridTop; y < gridBottom; y++) sum += data[y * width + x];
            colMean[x] = sum / rowCount;
        }

        const kernel = Math.max(3, Math.round(rowSpacing * 0.4));
        const colVar = new Float64Array(width);
        for (let x = 0; x < width; x++) {
            const mean = colMean[x];
            let sumSq = 0;
            for (let y = gridTop; y < gridBottom; y++) {
                const d = data[y * width + x] - mean;
                sumSq += d * d;
            }
            colVar[x] = sumSq / rowCount;
        }

        const smoothVar = new Float64Array(width);
        for (let x = 0; x < width; x++) {
            let sum = 0, count = 0;
            for (let dx = -kernel; dx <= kernel; dx++) {
                const xx = x + dx;
                if (xx >= 0 && xx < width) { sum += colVar[xx]; count++; }
            }
            smoothVar[x] = sum / count;
        }

        let peakVar = 0;
        for (let x = 0; x < width; x++) {
            if (smoothVar[x] > peakVar) peakVar = smoothVar[x];
        }
        if (peakVar < 10) return null;

        const extentThreshold = peakVar * 0.15;
        let gridLeft = -1, gridRight = -1, maxLen = 0;
        let inRegion = false, regionStart = 0;
        for (let x = 0; x <= width; x++) {
            if (x < width && smoothVar[x] > extentThreshold) {
                if (!inRegion) { inRegion = true; regionStart = x; }
            } else if (inRegion) {
                const len = x - regionStart;
                if (len > maxLen) { maxLen = len; gridLeft = regionStart; gridRight = x; }
                inRegion = false;
            }
        }

        if (gridLeft < 0 || gridRight - gridLeft < rowSpacing * 3) return null;

        let trimLeft = gridLeft, trimRight = gridRight;
        const trimThreshold = peakVar * 0.05;
        for (let x = gridLeft; x < gridRight; x++) {
            if (colVar[x] > trimThreshold) { trimLeft = x; break; }
        }
        for (let x = gridRight - 1; x >= gridLeft; x--) {
            if (colVar[x] > trimThreshold) { trimRight = x + 1; break; }
        }

        const gridCells = buildGridCells(bestGroup, trimLeft, trimRight, numCols);

        // Smart target detection: find a band above the grid with ~4 codes
        const targetResult = findTargetBand(rowBands, bestGroup, trimLeft, trimRight, gray);
        let targetCells = null;
        if (targetResult) {
            const startBand = rowBands[targetResult.bandIdx];
            const endBand = rowBands[targetResult.bandEndIdx || targetResult.bandIdx];
            const mergedTarget = {
                start: startBand.start,
                end: endBand.end,
                center: (startBand.start + endBand.end) / 2
            };
            targetCells = buildTargetCells(mergedTarget, targetResult.tLeft, targetResult.tRight);
        }

        return {
            gridCells,
            targetCells: targetCells && targetCells.length >= 4 ? targetCells : null,
            rows: 8,
            cols: numCols
        };
    }

    function detect(imageData) {
        const gray = toGrayscale(imageData);

        const blockSize = Math.floor(gray.width / 30) | 1;
        const binary = adaptiveThreshold(gray, blockSize, 8);
        const result = findGridByProjection(binary);
        if (result) return result;

        return findGridByGrayscaleProjection(gray);
    }

    function debugDetect(imageData) {
        const gray = toGrayscale(imageData);
        const { width, height } = gray;
        const lines = [];

        const blockSize = Math.floor(width / 30) | 1;
        const binary = adaptiveThreshold(gray, blockSize, 8);
        const rProj = rowProjection(binary);
        const rawBands = findPeaks(rProj, 0.02).filter(b => (b.end - b.start) >= 3);
        const mergedBin = mergeBands(rawBands);
        lines.push(`BIN: ${rawBands.length}→${mergedBin.length} bands`);

        const binResult = findGridByProjection(binary);
        if (binResult) {
            lines.push(`BIN: ${binResult.gridCells.length}c tgt:${binResult.targetCells ? binResult.targetCells.length : 0}`);
        } else {
            lines.push('BIN: no grid');
        }

        const rowMean = new Float64Array(height);
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) sum += gray.data[y * width + x];
            rowMean[y] = sum / width;
        }
        const detrendKernel = Math.max(20, Math.round(height / 40));
        const rowDet = detrendedProjection(rowMean, detrendKernel);
        const gsBands = findPeaks(rowDet, 3).filter(b => (b.end - b.start) >= 3);
        const gsMerged = mergeBands(gsBands);
        lines.push(`GS: ${gsBands.length}→${gsMerged.length} bands`);

        const gsResult = findGridByGrayscaleProjection(gray);
        if (gsResult) {
            lines.push(`GS: ${gsResult.gridCells.length}c tgt:${gsResult.targetCells ? gsResult.targetCells.length : 0}`);
            if (gsResult.gridCells.length > 0) {
                const c0 = gsResult.gridCells[0];
                lines.push(`Grid y=${c0.y} cell=${c0.w}x${c0.h}`);
            }
            if (gsResult.targetCells) {
                const t0 = gsResult.targetCells[0];
                lines.push(`Tgt y=${t0.y} w=${t0.w}`);
            }
        } else {
            lines.push('GS: no grid');
        }

        return lines.join('\n');
    }

    function debugColProjection(imageData, gridTop, gridBottom) {
        const gray = toGrayscale(imageData);
        const blockSize = Math.floor(gray.width / 30) | 1;
        const binary = adaptiveThreshold(gray, blockSize, 8);
        const cProj = colProjection(binary, gridTop, gridBottom);
        const peaks = findPeaks(cProj, 0.02);
        return { cProj, peaks };
    }

    return { detect, debugDetect, toGrayscale, adaptiveThreshold, debugColProjection };
})();
