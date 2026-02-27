const Matcher = (() => {

    /**
     * Convert a grayscale cell to binary using midpoint threshold.
     */
    function toBinary(cell) {
        let min = 255, max = 0;
        for (let i = 0; i < cell.length; i++) {
            if (cell[i] < min) min = cell[i];
            if (cell[i] > max) max = cell[i];
        }
        const threshold = (min + max) / 2;
        const binary = new Uint8Array(cell.length);
        for (let i = 0; i < cell.length; i++) {
            binary[i] = cell[i] > threshold ? 255 : 0;
        }
        return binary;
    }

    /**
     * Hamming distance between two binary images.
     * Counts mismatched pixels normalized to 0-1.
     * Lower = more similar.
     */
    function hammingDist(a, b) {
        if (a.length !== b.length) return 1;
        let diff = 0;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) diff++;
        }
        return diff / a.length;
    }

    /**
     * Normalized Cross-Correlation between two arrays.
     * Returns -1 to 1, where 1 = perfect match.
     */
    function ncc(a, b) {
        if (a.length !== b.length) return -1;
        const n = a.length;
        let sumA = 0, sumB = 0;
        for (let i = 0; i < n; i++) {
            sumA += a[i];
            sumB += b[i];
        }
        const meanA = sumA / n;
        const meanB = sumB / n;

        let num = 0, denA = 0, denB = 0;
        for (let i = 0; i < n; i++) {
            const da = a[i] - meanA;
            const db = b[i] - meanB;
            num += da * db;
            denA += da * da;
            denB += db * db;
        }
        const den = Math.sqrt(denA * denB);
        return den === 0 ? 0 : num / den;
    }

    /**
     * Find the best starting position where 4 consecutive grid cells
     * match the 4 target cells.
     *
     * Uses binary (shape) comparison for robustness across font sizes.
     */
    function findMatch(targetCells, gridCells) {
        if (targetCells.length < 4 || gridCells.length < 4) {
            return null;
        }

        // Convert all cells to binary
        const targetBin = targetCells.slice(0, 4).map(toBinary);
        const gridBin = gridCells.map(toBinary);

        const numGridCells = gridBin.length;
        const scores = new Float64Array(numGridCells);
        const numTargets = targetBin.length;

        for (let pos = 0; pos < numGridCells; pos++) {
            let total = 0;
            for (let t = 0; t < numTargets; t++) {
                const gridIdx = (pos + t) % numGridCells;
                total += hammingDist(targetBin[t], gridBin[gridIdx]);
            }
            scores[pos] = total;
        }

        // Find best (lowest score)
        let bestPos = 0;
        let bestScore = scores[0];
        let secondBest = Infinity;

        for (let i = 1; i < numGridCells; i++) {
            if (scores[i] < bestScore) {
                secondBest = bestScore;
                bestScore = scores[i];
                bestPos = i;
            } else if (scores[i] < secondBest) {
                secondBest = scores[i];
            }
        }

        const confidence = secondBest > 0
            ? Math.min(1, (secondBest - bestScore) / secondBest)
            : 0;

        const cols = estimateColumns(gridCells.length);
        const row = Math.floor(bestPos / cols) + 1;
        const col = (bestPos % cols) + 1;

        return {
            position: bestPos,
            row,
            col,
            cols,
            score: bestScore,
            confidence
        };
    }

    function estimateColumns(totalCells) {
        if (totalCells >= 75 && totalCells <= 85) return 10;
        if (totalCells >= 55 && totalCells <= 65) return 10;
        for (let c = 10; c >= 7; c--) {
            if (totalCells % c === 0) return c;
        }
        return 10;
    }

    /**
     * Find match by comparing OCR text strings.
     * targetCodes: array of 4 strings (e.g., ["58","38","69","61"])
     * gridCodes: flat array of 80 strings (row-major order)
     */
    function findMatchByText(targetCodes, gridCodes) {
        if (!targetCodes || !gridCodes) return null;
        if (targetCodes.length < 2 || gridCodes.length < 4) return null;

        const numCodes = gridCodes.length;
        const numTargets = targetCodes.length;
        const cols = estimateColumns(numCodes);

        for (let pos = 0; pos < numCodes; pos++) {
            let match = true;
            for (let t = 0; t < numTargets; t++) {
                const gridIdx = (pos + t) % numCodes;
                if (gridCodes[gridIdx] !== targetCodes[t]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                return {
                    position: pos,
                    row: Math.floor(pos / cols) + 1,
                    col: (pos % cols) + 1,
                    cols,
                    score: 0,
                    confidence: 1
                };
            }
        }

        // No exact match — try fuzzy matching
        // Handles: character substitutions, partial codes (OCR drops thin chars like 1, 9)
        let bestPos = -1;
        let bestScore = Infinity;
        let secondBest = Infinity;
        for (let pos = 0; pos < numCodes; pos++) {
            let totalScore = 0;
            for (let t = 0; t < numTargets; t++) {
                const gridIdx = (pos + t) % numCodes;
                const a = targetCodes[t];
                const b = gridCodes[gridIdx];
                if (a === b) continue;
                if (a.length === b.length) {
                    let charDiffs = 0;
                    for (let c = 0; c < a.length; c++) {
                        if (a[c] !== b[c]) charDiffs++;
                    }
                    totalScore += charDiffs;
                } else if (a.length < b.length && b.startsWith(a)) {
                    totalScore += 0.5;
                } else if (a.length > 0 && b.length > 0 && a[0] === b[0]) {
                    totalScore += 1;
                } else {
                    totalScore += 2;
                }
            }
            if (totalScore < bestScore) {
                secondBest = bestScore;
                bestScore = totalScore;
                bestPos = pos;
            } else if (totalScore < secondBest) {
                secondBest = totalScore;
            }
        }

        if (bestPos >= 0 && bestScore <= 3) {
            const gap = secondBest - bestScore;
            const confidence = gap > 0
                ? Math.max(0.1, Math.min(1, gap / numTargets))
                : 0.1;
            return {
                position: bestPos,
                row: Math.floor(bestPos / cols) + 1,
                col: (bestPos % cols) + 1,
                cols,
                score: bestScore,
                confidence
            };
        }

        return null;
    }

    return { findMatch, findMatchByText, ncc, hammingDist };
})();
