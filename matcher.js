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

    return { findMatch, ncc, hammingDist };
})();
