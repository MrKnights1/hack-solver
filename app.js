const App = (() => {
    // DOM
    const videoEl = document.getElementById('camera');
    const overlayEl = document.getElementById('overlay');
    const overlayCtx = overlayEl.getContext('2d');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const positionEl = document.getElementById('position');
    const debugEl = document.getElementById('debug');
    const debugCanvas = document.getElementById('debugCanvas');
    const debugCCtx = debugCanvas.getContext('2d', { willReadFrequently: true });
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');

    let cameraRunning = false;
    let templatesReady = false;
    let debugLines = [];

    function init() {
        Camera.init(videoEl);
        btnStart.addEventListener('click', handleStart);
        btnStop.addEventListener('click', handleStop);
        resizeOverlay();
        window.addEventListener('resize', resizeOverlay);
        autoStartCamera();
    }

    async function autoStartCamera() {
        try {
            await Camera.start();
            cameraRunning = true;
            btnStart.textContent = 'SCAN';
            btnStop.classList.remove('hidden');
            setStatus('idle', 'Tap SCAN to find match');
        } catch (err) {
            setStatus('idle', 'Tap START to begin');
        }
    }

    function resizeOverlay() {
        overlayEl.width = overlayEl.clientWidth * (window.devicePixelRatio || 1);
        overlayEl.height = overlayEl.clientHeight * (window.devicePixelRatio || 1);
        overlayCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    }

    function debug(msg) {
        debugLines.push(msg);
        debugEl.textContent = debugLines.join('\n');
    }

    function debugClear() {
        debugLines = [];
        debugEl.textContent = '';
    }

    async function handleStart() {
        if (!cameraRunning) {
            try {
                await Camera.start();
                cameraRunning = true;
            } catch (err) {
                setStatus('error', 'Camera access denied');
                return;
            }
        }

        btnStart.textContent = 'SCAN';
        btnStop.classList.remove('hidden');
        scan();
    }

    function handleStop() {
        Camera.stop();
        cameraRunning = false;
        btnStart.textContent = 'START';
        btnStop.classList.add('hidden');
        positionEl.style.display = 'none';
        clearOverlay();
        debugClear();
        setStatus('idle', 'Tap START to begin');
    }

    function setStatus(type, message) {
        statusDot.className = type === 'idle' ? '' : type;
        statusText.textContent = message;
    }

    function scan() {
        setStatus('detecting', 'Scanning...');
        clearOverlay();
        positionEl.style.display = 'none';
        debugClear();
        btnStart.disabled = true;

        try {
            var t0 = performance.now();

            if (!templatesReady) {
                Templates.generate();
                templatesReady = true;
                debug('Templates: ' + Math.round(performance.now() - t0) + 'ms');
            }

            // 1. Capture single frame
            var frame = Camera.captureFrame();
            if (!frame) {
                setStatus('error', 'No frame');
                return;
            }
            debug('Frame: ' + frame.width + 'x' + frame.height);

            // 2. Detect grid (once)
            var det = Detector.detect(frame);
            if (!det) {
                setStatus('error', 'Grid not found');
                return;
            }

            var gc = det.gridCells.length;
            var tc = det.targetCells ? det.targetCells.length : 0;
            debug('Grid: ' + gc + ', Target: ' + tc);

            if (gc < 30 || tc < 3) {
                setStatus('error', 'Not enough cells: ' + gc + '/' + tc);
                return;
            }

            // 3. Extract cells (once)
            var extracted = Processor.extractAllCells(frame, det.gridCells, det.targetCells);

            // 4. Split all cells into halves (once, reused across all charset attempts)
            var targetHalvesArr = [];
            var sampleHalves = [];
            for (var i = 0; i < extracted.targetCells.length; i++) {
                var h = Processor.splitCellHalves(extracted.targetCells[i]);
                targetHalvesArr.push(h);
                sampleHalves.push(h.left);
                sampleHalves.push(h.right);
            }

            var gridHalvesArr = [];
            for (var gi = 0; gi < extracted.gridCells.length; gi++) {
                gridHalvesArr.push(Processor.splitCellHalves(extracted.gridCells[gi]));
            }

            // 5. Multi-strategy matching: try ALL charsets + pixel matching
            var allCharsets = Templates.getAllCharsets();
            var charsetNames = Object.keys(allCharsets);
            var bestMatch = null;
            var bestScore = Infinity;
            var bestCharset = '';
            var bestTargetCodes = null;
            var bestGridCodes = null;

            for (var ci = 0; ci < charsetNames.length; ci++) {
                var csName = charsetNames[ci];
                var tpls = allCharsets[csName];

                // Identify target codes
                var tCodes = [];
                for (var ti = 0; ti < extracted.targetCells.length; ti++) {
                    tCodes.push(Matcher.identifyCode(extracted.targetCells[ti], tpls));
                }

                // Identify grid codes
                var gCodes = [];
                for (var gj = 0; gj < extracted.gridCells.length; gj++) {
                    gCodes.push(Matcher.identifyCode(extracted.gridCells[gj], tpls));
                }

                var m = Matcher.findMatchByText(tCodes, gCodes);
                if (m && m.score < bestScore) {
                    bestScore = m.score;
                    bestMatch = m;
                    bestCharset = csName;
                    bestTargetCodes = tCodes;
                    bestGridCodes = gCodes;
                }
            }

            // Also try pixel matching
            var pixelMatch = Matcher.findMatch(extracted.targetCells, extracted.gridCells);

            // Pick winner: exact text match (score=0) wins, otherwise best fuzzy,
            // pixel match as last resort
            var match = null;
            var method = '';

            if (bestMatch && bestMatch.score === 0) {
                match = bestMatch;
                method = bestCharset + ' exact';
            } else if (bestMatch && pixelMatch) {
                // Prefer text match with good confidence over pixel match
                if (bestMatch.confidence >= pixelMatch.confidence) {
                    match = bestMatch;
                    method = bestCharset + ' fuzzy(s=' + bestScore + ')';
                } else {
                    match = pixelMatch;
                    method = 'pixel';
                }
            } else if (bestMatch) {
                match = bestMatch;
                method = bestCharset + ' fuzzy(s=' + bestScore + ')';
            } else if (pixelMatch) {
                match = pixelMatch;
                method = 'pixel';
            }

            if (bestTargetCodes) {
                debug(bestCharset + ': ' + bestTargetCodes.join(' '));
            }

            var elapsed = Math.round(performance.now() - t0);
            debug('Time: ' + elapsed + 'ms');

            if (match) {
                debug(method + ' R' + match.row + 'C' + match.col + ' conf=' + Math.round(match.confidence * 100) + '%');
                if (match.top3) {
                    for (var di = 0; di < match.top3.length; di++) {
                        var mt = match.top3[di];
                        debug('  #' + (di + 1) + ' R' + mt.row + 'C' + mt.col + ' s=' + mt.score.toFixed(3));
                    }
                }
                drawResult(det, match.position, extracted.targetCells.length);
                positionEl.textContent = 'R' + match.row + ' C' + match.col;
                positionEl.style.display = 'block';
                setStatus('tracking', 'Row ' + match.row + ', Col ' + match.col);
            } else {
                debug('NO MATCH (all strategies failed)');
                setStatus('error', 'No match found');
            }

            // Visual debug: show extracted cells vs templates
            drawDebugCells(
                extracted.targetCells, extracted.gridCells,
                bestTargetCodes, bestGridCodes, bestCharset
            );
        } catch (err) {
            debug('Error: ' + err.message);
            setStatus('error', 'Scan failed');
        } finally {
            btnStart.disabled = false;
        }
    }

    function drawResult(detection, position, numTargets) {
        clearOverlay();

        var dims = Camera.getVideoDimensions();
        if (!dims.videoWidth) return;

        var scaleX = dims.displayWidth / dims.videoWidth;
        var scaleY = dims.displayHeight / dims.videoHeight;

        overlayCtx.strokeStyle = '#22c55e';
        overlayCtx.lineWidth = 3;
        overlayCtx.shadowColor = '#22c55e';
        overlayCtx.shadowBlur = 12;

        for (var t = 0; t < numTargets; t++) {
            var gridIdx = (position + t) % detection.gridCells.length;
            var blob = detection.gridCells[gridIdx];

            var x = (blob.x - 4) * scaleX;
            var y = (blob.y - 4) * scaleY;
            var w = (blob.w + 8) * scaleX;
            var h = (blob.h + 8) * scaleY;

            overlayCtx.fillStyle = 'rgba(34, 197, 94, 0.2)';
            overlayCtx.fillRect(x, y, w, h);
            overlayCtx.strokeRect(x, y, w, h);
        }

        overlayCtx.beginPath();
        overlayCtx.strokeStyle = 'rgba(34, 197, 94, 0.6)';
        overlayCtx.lineWidth = 2;
        overlayCtx.shadowBlur = 5;

        for (var t2 = 0; t2 < numTargets; t2++) {
            var gridIdx2 = (position + t2) % detection.gridCells.length;
            var blob2 = detection.gridCells[gridIdx2];
            var cx = blob2.cx * scaleX;
            var cy = blob2.cy * scaleY;
            if (t2 === 0) overlayCtx.moveTo(cx, cy);
            else overlayCtx.lineTo(cx, cy);
        }
        overlayCtx.stroke();
        overlayCtx.shadowBlur = 0;
    }

    function drawDebugCells(targetCells, gridCells, targetCodes, gridCodes, charset) {
        var S = 32;
        var scale = 2;
        var D = S * scale;
        var gap = 4;
        var labelH = 14;

        // Show: target cells (row 1), first 10 grid cells (row 2), template matches (row 3)
        var numGrid = Math.min(10, gridCells.length);
        var maxCols = Math.max(targetCells.length, numGrid);
        var totalW = maxCols * (D + gap) + gap;
        var totalH = 3 * (D + labelH + gap) + gap + labelH;

        debugCanvas.width = totalW;
        debugCanvas.height = totalH;
        debugCanvas.style.width = totalW + 'px';
        debugCanvas.style.height = totalH + 'px';

        debugCCtx.fillStyle = '#000';
        debugCCtx.fillRect(0, 0, totalW, totalH);
        debugCCtx.font = '11px monospace';
        debugCCtx.textAlign = 'center';

        // Row label
        debugCCtx.fillStyle = '#888';
        debugCCtx.textAlign = 'left';
        debugCCtx.fillText('TARGET:', gap, 10);

        // Row 1: target cells
        var y0 = labelH;
        for (var t = 0; t < targetCells.length; t++) {
            var x = gap + t * (D + gap);
            drawCell(debugCCtx, targetCells[t], x, y0, S, scale);
            debugCCtx.fillStyle = '#0f0';
            debugCCtx.textAlign = 'center';
            debugCCtx.fillText(targetCodes ? targetCodes[t] : '?', x + D / 2, y0 + D + 12);
        }

        // Row label
        debugCCtx.fillStyle = '#888';
        debugCCtx.textAlign = 'left';
        debugCCtx.fillText('GRID[0-9]:', gap, y0 + D + labelH + gap);

        // Row 2: first 10 grid cells
        var y1 = y0 + D + labelH + gap + labelH;
        for (var g = 0; g < numGrid; g++) {
            var x2 = gap + g * (D + gap);
            drawCell(debugCCtx, gridCells[g], x2, y1, S, scale);
            debugCCtx.fillStyle = '#ff0';
            debugCCtx.textAlign = 'center';
            debugCCtx.fillText(gridCodes ? gridCodes[g] : '?', x2 + D / 2, y1 + D + 12);
        }

        // Row label
        debugCCtx.fillStyle = '#888';
        debugCCtx.textAlign = 'left';
        debugCCtx.fillText('TEMPLATE:', gap, y1 + D + labelH + gap);

        // Row 3: template images for target codes
        var y2 = y1 + D + labelH + gap + labelH;
        if (charset && targetCodes) {
            var tpls = Templates.getCharset(charset);
            for (var tc = 0; tc < targetCodes.length; tc++) {
                var code = targetCodes[tc];
                // Find matching template halves and draw them side by side
                var leftChar = code[0];
                var rightChar = code[1];
                var leftTpl = null, rightTpl = null;
                for (var ti = 0; ti < tpls.length; ti++) {
                    if (tpls[ti].char === leftChar) leftTpl = tpls[ti];
                    if (tpls[ti].char === rightChar) rightTpl = tpls[ti];
                }
                var x3 = gap + tc * (D + gap);
                // Draw left half
                if (leftTpl) drawCell(debugCCtx, leftTpl.pixels, x3, y2, S, scale / 2);
                // Draw right half
                if (rightTpl) drawCell(debugCCtx, rightTpl.pixels, x3 + D / 2, y2, S, scale / 2);
                debugCCtx.fillStyle = '#0ff';
                debugCCtx.textAlign = 'center';
                debugCCtx.fillText(code, x3 + D / 2, y2 + D + 12);
            }
        }
    }

    function drawCell(ctx, pixels, x, y, size, scale) {
        var d = size * scale;
        var imgData = ctx.createImageData(size, size);
        for (var i = 0; i < pixels.length; i++) {
            var v = pixels[i];
            imgData.data[i * 4] = v;
            imgData.data[i * 4 + 1] = v;
            imgData.data[i * 4 + 2] = v;
            imgData.data[i * 4 + 3] = 255;
        }
        // Draw at native size then scale up
        var tmp = document.createElement('canvas');
        tmp.width = size;
        tmp.height = size;
        tmp.getContext('2d').putImageData(imgData, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, size, size, x, y, d, d);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, d, d);
    }

    function clearOverlay() {
        overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { handleStart, handleStop };
})();
