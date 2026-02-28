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
     * Downsample 32×32 to 16×16 by averaging 2×2 blocks.
     * Provides alignment tolerance — small shifts get absorbed by the averaging.
     */
    function downsample2x(pixels) {
        var out = new Uint8Array(256);
        for (var y = 0; y < 16; y++) {
            for (var x = 0; x < 16; x++) {
                var idx = (y * 2) * 32 + (x * 2);
                out[y * 16 + x] = (pixels[idx] + pixels[idx + 1] + pixels[idx + 32] + pixels[idx + 33]) >> 2;
            }
        }
        return out;
    }

    /**
     * Find the best starting position where 4 consecutive grid cells
     * match the 4 target cells.
     *
     * Uses a multi-signal ensemble for robustness:
     * - NCC on 32×32 grayscale (invariant to brightness/contrast)
     * - NCC on 16×16 downsampled (tolerant to small alignment shifts)
     * - Binary hamming on 32×32 (shape tiebreaker)
     */
    function findMatch(targetCells, gridCells) {
        if (targetCells.length < 4 || gridCells.length < 4) {
            return null;
        }

        var numTargets = Math.min(4, targetCells.length);
        var numGridCells = gridCells.length;

        // Pre-compute downsampled and binary versions
        var targetSmall = [], targetBin = [];
        for (var t = 0; t < numTargets; t++) {
            targetSmall.push(downsample2x(targetCells[t]));
            targetBin.push(toBinary(targetCells[t]));
        }
        var gridSmall = new Array(numGridCells);
        var gridBin = new Array(numGridCells);
        for (var g = 0; g < numGridCells; g++) {
            gridSmall[g] = downsample2x(gridCells[g]);
            gridBin[g] = toBinary(gridCells[g]);
        }

        var scores = new Float64Array(numGridCells);

        for (var pos = 0; pos < numGridCells; pos++) {
            var total = 0;
            for (var t2 = 0; t2 < numTargets; t2++) {
                var gridIdx = (pos + t2) % numGridCells;

                // NCC on full-res grayscale: pattern correlation (1 = perfect)
                var nccFull = ncc(targetCells[t2], gridCells[gridIdx]);

                // NCC on downsampled: alignment-tolerant correlation
                var nccHalf = ncc(targetSmall[t2], gridSmall[gridIdx]);

                // Hamming on binary: shape distance (0 = perfect)
                var hamVal = hammingDist(targetBin[t2], gridBin[gridIdx]);

                // Combined distance (lower = better)
                total += (1 - nccFull) + (1 - nccHalf) + hamVal * 0.5;
            }
            scores[pos] = total;
        }

        // Find top 3 matches (lowest scores)
        var top = [
            { pos: 0, score: Infinity },
            { pos: 0, score: Infinity },
            { pos: 0, score: Infinity }
        ];

        for (var i = 0; i < numGridCells; i++) {
            if (scores[i] < top[2].score) {
                top[2] = { pos: i, score: scores[i] };
                if (top[2].score < top[1].score) {
                    var tmp = top[1]; top[1] = top[2]; top[2] = tmp;
                }
                if (top[1].score < top[0].score) {
                    var tmp2 = top[0]; top[0] = top[1]; top[1] = tmp2;
                }
            }
        }

        var confidence = top[1].score > 0
            ? Math.min(1, (top[1].score - top[0].score) / top[1].score)
            : 0;

        var cols = estimateColumns(gridCells.length);

        return {
            position: top[0].pos,
            row: Math.floor(top[0].pos / cols) + 1,
            col: (top[0].pos % cols) + 1,
            cols,
            score: top[0].score,
            confidence,
            top3: top.map(function(m) {
                return {
                    pos: m.pos,
                    row: Math.floor(m.pos / cols) + 1,
                    col: (m.pos % cols) + 1,
                    score: m.score
                };
            })
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

    /**
     * Identify a single character by matching a half-cell against charset templates.
     * Returns { char, distance } for the best match.
     */
    function identifyChar(halfPixels, charsetTemplates) {
        var halfBin = toBinary(halfPixels);
        var bestChar = '?';
        var bestDist = 1;

        for (var i = 0; i < charsetTemplates.length; i++) {
            var tplBin = charsetTemplates[i].binary || toBinary(charsetTemplates[i].pixels);
            var dist = hammingDist(halfBin, tplBin);
            if (dist < bestDist) {
                bestDist = dist;
                bestChar = charsetTemplates[i].char;
            }
        }

        return { char: bestChar, distance: bestDist };
    }

    /**
     * Identify a 2-character code from a full cell.
     * Splits the cell into left/right halves and identifies each.
     */
    function identifyCode(cellPixels, charsetTemplates) {
        const halves = Processor.splitCellHalves(cellPixels);
        const left = identifyChar(halves.left, charsetTemplates);
        const right = identifyChar(halves.right, charsetTemplates);
        return left.char + right.char;
    }

    /**
     * Detect which charset best matches sample half-cells.
     * Uses distinctiveness: the gap between best and second-best template match.
     * The correct charset will have high gaps (clear best match per character).
     * Wrong charsets (especially large ones like braille) have low gaps.
     */
    function detectCharset(sampleHalves, allCharsets) {
        var bestName = 'numeric';
        var bestScore = -Infinity;

        var sampleBins = [];
        for (var s = 0; s < sampleHalves.length; s++) {
            sampleBins.push(toBinary(sampleHalves[s]));
        }

        var names = Object.keys(allCharsets);
        for (var n = 0; n < names.length; n++) {
            var templates = allCharsets[names[n]];
            var totalGap = 0;

            for (var s2 = 0; s2 < sampleBins.length; s2++) {
                var halfBin = sampleBins[s2];
                var bd = 1, sd = 1;

                for (var i = 0; i < templates.length; i++) {
                    var tplBin = templates[i].binary || toBinary(templates[i].pixels);
                    var dist = hammingDist(halfBin, tplBin);
                    if (dist < bd) {
                        sd = bd;
                        bd = dist;
                    } else if (dist < sd) {
                        sd = dist;
                    }
                }
                totalGap += (sd - bd);
            }

            var avgGap = totalGap / sampleBins.length;
            if (avgGap > bestScore) {
                bestScore = avgGap;
                bestName = names[n];
            }
        }

        return bestName;
    }

    return { findMatch, findMatchByText, identifyChar, identifyCode, detectCharset, ncc, hammingDist, toBinary };
})();
