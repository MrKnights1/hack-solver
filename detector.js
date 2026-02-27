const Detector = (() => {

    /**
     * Convert RGBA ImageData to grayscale Uint8Array.
     */
    function toGrayscale(imageData) {
        const { data, width, height } = imageData;
        const gray = new Uint8Array(width * height);
        for (let i = 0; i < gray.length; i++) {
            const j = i * 4;
            gray[i] = Math.round(0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]);
        }
        return { data: gray, width, height };
    }

    /**
     * Adaptive threshold using integral image.
     * Also requires a minimum absolute brightness to eliminate dark-background noise.
     */
    function adaptiveThreshold(gray, blockSize, C) {
        const { data, width, height } = gray;
        const out = new Uint8Array(width * height);
        const half = Math.floor(blockSize / 2);

        // Compute global mean brightness for adaptive minimum
        let globalSum = 0;
        for (let i = 0; i < data.length; i++) globalSum += data[i];
        const globalMean = globalSum / data.length;
        // Minimum brightness: midpoint between background and text
        // Text is typically >150, background <50. Use global mean + offset.
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
                // Must exceed absolute minimum brightness
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

    /**
     * Compute row projection — sum of white pixels per row.
     */
    function rowProjection(binary) {
        const { data, width, height } = binary;
        const proj = new Float64Array(height);
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) {
                if (data[y * width + x] === 255) sum++;
            }
            proj[y] = sum / width; // Normalized 0-1
        }
        return proj;
    }

    /**
     * Compute column projection in a vertical sub-range.
     */
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
     * Find contiguous bands in a projection where values exceed a threshold.
     * Returns array of { start, end, avg } sorted by length descending.
     */
    function findBands(proj, threshold) {
        const bands = [];
        let inBand = false;
        let start = 0;
        let sum = 0;

        for (let i = 0; i < proj.length; i++) {
            if (proj[i] > threshold) {
                if (!inBand) {
                    inBand = true;
                    start = i;
                    sum = 0;
                }
                sum += proj[i];
            } else if (inBand) {
                bands.push({ start, end: i, avg: sum / (i - start) });
                inBand = false;
            }
        }
        if (inBand) {
            bands.push({ start, end: proj.length, avg: sum / (proj.length - start) });
        }

        bands.sort((a, b) => (b.end - b.start) - (a.end - a.start));
        return bands;
    }

    /**
     * Find peaks (text rows/columns) in a projection.
     * Groups consecutive high-value runs and returns their centers.
     */
    function findPeaks(proj, threshold) {
        const groups = [];
        let inGroup = false;
        let start = 0;

        for (let i = 0; i < proj.length; i++) {
            if (proj[i] > threshold) {
                if (!inGroup) {
                    inGroup = true;
                    start = i;
                }
            } else if (inGroup) {
                groups.push({ start, end: i, center: (start + i) / 2 });
                inGroup = false;
            }
        }
        if (inGroup) {
            groups.push({ start, end: proj.length, center: (start + proj.length) / 2 });
        }

        return groups;
    }

    /**
     * Merge nearby bands into single row bands.
     * Handles characters like Braille where dots create multiple
     * thin horizontal bands per text row.
     */
    function mergeBands(bands) {
        if (bands.length <= 8) return bands;

        // Compute gaps between consecutive bands
        const gaps = [];
        for (let i = 1; i < bands.length; i++) {
            gaps.push(bands[i].start - bands[i - 1].end);
        }

        // Find the natural break using ratio-based jump detection.
        // Within-char gaps (e.g. Braille dots) are ~2-3px,
        // between-row gaps are ~18px — a 6-9× ratio increase.
        const sorted = gaps.slice().sort((a, b) => a - b);
        let maxRatio = 0, threshold = sorted[sorted.length - 1];
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i - 1] > 0) {
                const ratio = sorted[i] / sorted[i - 1];
                if (ratio > maxRatio) {
                    maxRatio = ratio;
                    threshold = (sorted[i - 1] + sorted[i]) / 2;
                }
            }
        }

        // Only merge if there's a significant ratio jump (at least 2×)
        if (maxRatio < 2) return bands;

        // Merge bands with gaps below threshold
        const merged = [{ start: bands[0].start, end: bands[0].end }];
        for (let i = 1; i < bands.length; i++) {
            const gap = bands[i].start - merged[merged.length - 1].end;
            if (gap <= threshold) {
                merged[merged.length - 1].end = bands[i].end;
            } else {
                merged.push({ start: bands[i].start, end: bands[i].end });
            }
        }
        merged.forEach(b => b.center = (b.start + b.end) / 2);

        // Only use merged result if it still has enough bands for grid detection
        if (merged.length < 8) return bands;
        return merged;
    }

    /**
     * Find the grid region and target region using projections.
     * Returns { gridCells, targetCells, rows, cols } or null.
     *
     * Strategy:
     * 1. Row projection → find horizontal text bands
     * 2. The densest group of 8+ bands = the grid rows
     * 3. Column projection within grid → find 10 columns
     * 4. Grid cells = row × column intersections
     * 5. Target = row band above the grid, divided into 4 cells
     */
    function findGridByProjection(binary) {
        const { width, height } = binary;

        // Row projection — find horizontal text density
        const rProj = rowProjection(binary);

        // Find text row bands (runs of above-threshold density)
        // Threshold: pixels are "text" if >2% of the row is white
        // Filter out noise bands (< 3px tall)
        const rawRowBands = findPeaks(rProj, 0.02);
        const filteredBands = rawRowBands.filter(b => (b.end - b.start) >= 3);
        if (filteredBands.length < 8) return null;

        // Merge nearby bands (handles Braille/dotted characters where each
        // text row produces multiple thin horizontal bands).
        // Compute gaps, find natural break between "within-char" and "between-row" gaps.
        const rowBands = mergeBands(filteredBands);

        // Find the group of 8 consecutive bands with the most uniform spacing
        // (the 8×10 grid has evenly-spaced rows)
        let bestGroup = null;
        let bestScore = Infinity;

        for (let i = 0; i <= rowBands.length - 8; i++) {
            const group = rowBands.slice(i, i + 8);
            const spacings = [];
            for (let j = 1; j < group.length; j++) {
                spacings.push(group[j].center - group[j - 1].center);
            }
            const avgSpacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
            // Variance of spacing — lower = more regular
            const variance = spacings.reduce((s, sp) => s + (sp - avgSpacing) ** 2, 0) / spacings.length;
            const relativeVariance = variance / (avgSpacing * avgSpacing);

            if (relativeVariance < bestScore) {
                bestScore = relativeVariance;
                bestGroup = { rows: group, startIdx: i, spacing: avgSpacing };
            }
        }

        if (!bestGroup || bestScore > 0.1) return null;

        // Grid vertical extent
        const gridTop = bestGroup.rows[0].start;
        const gridBottom = bestGroup.rows[7].end;
        const rowSpacing = bestGroup.spacing;

        // Column detection: smooth the column projection to find the
        // grid's horizontal extent, then divide into equal columns.
        // This works regardless of character set or font size.
        const cProj = colProjection(binary, gridTop, gridBottom);
        const numCols = 10;

        // Smooth with a moving average (kernel = half the row spacing)
        // to blur individual character peaks into a density envelope.
        const kernel = Math.max(3, Math.round(rowSpacing * 0.4));
        const smoothProj = new Float64Array(width);
        for (let x = 0; x < width; x++) {
            let sum = 0, count = 0;
            for (let dx = -kernel; dx <= kernel; dx++) {
                const xx = x + dx;
                if (xx >= 0 && xx < width) {
                    sum += cProj[xx];
                    count++;
                }
            }
            smoothProj[x] = sum / count;
        }

        // Find the peak value in the smoothed projection
        let peakVal = 0;
        for (let x = 0; x < width; x++) {
            if (smoothProj[x] > peakVal) peakVal = smoothProj[x];
        }
        if (peakVal < 0.01) return null;

        // Use a fraction of the peak as threshold to find the grid extent
        const extentThreshold = peakVal * 0.15;

        // Find the longest contiguous region above the threshold
        let gridLeft = -1, gridRight = -1;
        let maxLen = 0;
        let inRegion = false, regionStart = 0;

        for (let x = 0; x <= width; x++) {
            if (x < width && smoothProj[x] > extentThreshold) {
                if (!inRegion) { inRegion = true; regionStart = x; }
            } else if (inRegion) {
                const len = x - regionStart;
                if (len > maxLen) {
                    maxLen = len;
                    gridLeft = regionStart;
                    gridRight = x;
                }
                inRegion = false;
            }
        }

        if (gridLeft < 0 || gridRight - gridLeft < rowSpacing * 3) return null;

        // The grid content might not start/end at exact cell boundaries.
        // Trim to the actual text content by finding where the raw
        // projection first/last exceeds a threshold.
        const rawThreshold = 0.01;
        let trimLeft = gridLeft, trimRight = gridRight;
        for (let x = gridLeft; x < gridRight; x++) {
            if (cProj[x] > rawThreshold) { trimLeft = x; break; }
        }
        for (let x = gridRight - 1; x >= gridLeft; x--) {
            if (cProj[x] > rawThreshold) { trimRight = x + 1; break; }
        }

        const gridWidth = trimRight - trimLeft;
        const colSpacing = gridWidth / numCols;
        const gridCenterX = (trimLeft + trimRight) / 2;

        // Build grid cells from row bands × equal-spaced columns
        const gridCells = [];

        for (const row of bestGroup.rows) {
            for (let c = 0; c < numCols; c++) {
                const cx = trimLeft + (c + 0.5) * colSpacing;
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

        // Target cells: find text band above the grid, divide into 4
        const targetCells = [];
        const targetBandIdx = bestGroup.startIdx - 1;

        if (targetBandIdx >= 0) {
            const targetRow = rowBands[targetBandIdx];
            const targetH = targetRow.end - targetRow.start;
            const targetCY = (targetRow.start + targetRow.end) / 2;

            // Find target row text extent
            const targetCProj = colProjection(binary, targetRow.start, targetRow.end);
            let tLeft = -1, tRight = -1;
            for (let x = 0; x < width; x++) {
                if (targetCProj[x] > 0.03) { tLeft = x; break; }
            }
            for (let x = width - 1; x >= 0; x--) {
                if (targetCProj[x] > 0.03) { tRight = x; break; }
            }

            if (tLeft >= 0 && tRight > tLeft) {
                const targetSpan = tRight - tLeft;
                const targetCellW = targetSpan / 4;

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
            }
        }

        return {
            gridCells,
            targetCells: targetCells.length >= 4 ? targetCells : null,
            rows: 8,
            cols: numCols
        };
    }

    /**
     * Detrended projection: compute mean per row/col, subtract a smoothed
     * baseline, and return peaks. Works on raw grayscale, robust to
     * camera lighting gradients.
     */
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
     * Fallback for when adaptive threshold fails (phone camera input).
     */
    function findGridByGrayscaleProjection(gray) {
        const { data, width, height } = gray;

        // Row mean brightness
        const rowMean = new Float64Array(height);
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) sum += data[y * width + x];
            rowMean[y] = sum / width;
        }

        // Detrend with large kernel to remove lighting gradient
        const rowDetrended = detrendedProjection(rowMean, 30);

        // Find peaks (text rows) — threshold at 3 brightness units above baseline
        const rawRowBands = findPeaks(rowDetrended, 3);
        const filteredBands = rawRowBands.filter(b => (b.end - b.start) >= 3);
        if (filteredBands.length < 8) return null;

        const rowBands = mergeBands(filteredBands);

        // Find the group of 8 consecutive bands with most uniform spacing
        let bestGroup = null;
        let bestScore = Infinity;

        for (let i = 0; i <= rowBands.length - 8; i++) {
            const group = rowBands.slice(i, i + 8);
            const spacings = [];
            for (let j = 1; j < group.length; j++) {
                spacings.push(group[j].center - group[j - 1].center);
            }
            const avgSpacing = spacings.reduce((a, b) => a + b, 0) / spacings.length;
            const variance = spacings.reduce((s, sp) => s + (sp - avgSpacing) ** 2, 0) / spacings.length;
            const relativeVariance = variance / (avgSpacing * avgSpacing);

            if (relativeVariance < bestScore) {
                bestScore = relativeVariance;
                bestGroup = { rows: group, startIdx: i, spacing: avgSpacing };
            }
        }

        if (!bestGroup || bestScore > 0.15) return null;

        const gridTop = bestGroup.rows[0].start;
        const gridBottom = bestGroup.rows[7].end;
        const rowSpacing = bestGroup.spacing;
        const numCols = 10;

        // Column mean brightness within grid area
        const colMean = new Float64Array(width);
        const rowCount = gridBottom - gridTop;
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let y = gridTop; y < gridBottom; y++) {
                sum += data[y * width + x];
            }
            colMean[x] = sum / rowCount;
        }

        // Smooth column projection to find grid horizontal extent
        const kernel = Math.max(3, Math.round(rowSpacing * 0.4));
        const smoothCol = new Float64Array(width);
        for (let x = 0; x < width; x++) {
            let sum = 0, count = 0;
            for (let dx = -kernel; dx <= kernel; dx++) {
                const xx = x + dx;
                if (xx >= 0 && xx < width) { sum += colMean[xx]; count++; }
            }
            smoothCol[x] = sum / count;
        }

        // Find grid horizontal extent using column brightness variance.
        // Text columns have high variance (bright text + dark background),
        // non-grid areas are uniformly dark with low variance.
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

        // Smooth variance to find extent
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

        // Trim to actual text by finding first/last columns with variance
        let trimLeft = gridLeft, trimRight = gridRight;
        const trimThreshold = peakVar * 0.05;
        for (let x = gridLeft; x < gridRight; x++) {
            if (colVar[x] > trimThreshold) { trimLeft = x; break; }
        }
        for (let x = gridRight - 1; x >= gridLeft; x--) {
            if (colVar[x] > trimThreshold) { trimRight = x + 1; break; }
        }

        const gridWidth = trimRight - trimLeft;
        const colSpacing = gridWidth / numCols;

        // Build grid cells
        const gridCells = [];
        for (const row of bestGroup.rows) {
            for (let c = 0; c < numCols; c++) {
                const cx = trimLeft + (c + 0.5) * colSpacing;
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

        // Target cells: find text band above the grid
        const targetCells = [];
        const targetBandIdx = bestGroup.startIdx - 1;

        if (targetBandIdx >= 0) {
            const targetRow = rowBands[targetBandIdx];
            const targetH = targetRow.end - targetRow.start;
            const targetCY = (targetRow.start + targetRow.end) / 2;

            // Find target row text extent using column variance
            const tRowCount = targetRow.end - targetRow.start;
            const tColMean = new Float64Array(width);
            const tColVar = new Float64Array(width);
            for (let x = 0; x < width; x++) {
                let sum = 0;
                for (let y = targetRow.start; y < targetRow.end; y++) {
                    sum += data[y * width + x];
                }
                tColMean[x] = sum / tRowCount;
                let sumSq = 0;
                for (let y = targetRow.start; y < targetRow.end; y++) {
                    const d = data[y * width + x] - tColMean[x];
                    sumSq += d * d;
                }
                tColVar[x] = sumSq / tRowCount;
            }

            let tPeakVar = 0;
            for (let x = 0; x < width; x++) {
                if (tColVar[x] > tPeakVar) tPeakVar = tColVar[x];
            }

            const tThreshold = tPeakVar * 0.1;
            let tLeft = -1, tRight = -1;
            for (let x = 0; x < width; x++) {
                if (tColVar[x] > tThreshold) { tLeft = x; break; }
            }
            for (let x = width - 1; x >= 0; x--) {
                if (tColVar[x] > tThreshold) { tRight = x; break; }
            }

            if (tLeft >= 0 && tRight > tLeft) {
                const targetSpan = tRight - tLeft;
                const targetCellW = targetSpan / 4;
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
            }
        }

        return {
            gridCells,
            targetCells: targetCells.length >= 4 ? targetCells : null,
            rows: 8,
            cols: numCols
        };
    }

    /**
     * Main detection function.
     * Tries binary threshold first (clean screenshots), falls back to
     * detrended grayscale projection (camera input).
     */
    function detect(imageData) {
        const gray = toGrayscale(imageData);

        // Primary: binary threshold approach (fast, works for screenshots)
        const blockSize = Math.floor(gray.width / 30) | 1;
        const binary = adaptiveThreshold(gray, blockSize, 8);
        const result = findGridByProjection(binary);
        if (result) return result;

        // Fallback: detrended grayscale projection (camera input)
        return findGridByGrayscaleProjection(gray);
    }

    /**
     * Debug: expose column projection data for diagnostics.
     */
    function debugColProjection(imageData, gridTop, gridBottom) {
        const gray = toGrayscale(imageData);
        const blockSize = Math.floor(gray.width / 30) | 1;
        const binary = adaptiveThreshold(gray, blockSize, 8);
        const cProj = colProjection(binary, gridTop, gridBottom);
        const peaks = findPeaks(cProj, 0.02);
        return { cProj, peaks };
    }

    return { detect, toGrayscale, adaptiveThreshold, debugColProjection };
})();
