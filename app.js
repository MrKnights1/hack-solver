const App = (() => {
    let state = 'idle';
    let gridInfo = null;
    let lastMatch = null;
    let detectAttempts = 0;
    let ocrIntervalId = null;

    const videoEl = document.getElementById('camera');
    const overlayEl = document.getElementById('overlay');
    const overlayCtx = overlayEl.getContext('2d');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const positionEl = document.getElementById('position');
    const debugEl = document.getElementById('debug');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    const btnCapture = document.getElementById('btnCapture');

    function init() {
        Camera.init(videoEl);
        btnStart.addEventListener('click', handleStart);
        btnStop.addEventListener('click', handleStop);
        btnCapture.addEventListener('click', handleCapture);
        resizeOverlay();
        window.addEventListener('resize', resizeOverlay);
    }

    function resizeOverlay() {
        overlayEl.width = overlayEl.clientWidth * (window.devicePixelRatio || 1);
        overlayEl.height = overlayEl.clientHeight * (window.devicePixelRatio || 1);
        overlayCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    }

    function log(msg) {
        debugEl.style.display = 'block';
        debugEl.textContent = msg;
    }

    async function handleStart() {
        try {
            await Camera.start();
            btnStart.classList.add('hidden');
            btnStop.classList.remove('hidden');
            btnCapture.classList.remove('hidden');
            detectAttempts = 0;
            setState('detecting');
            runDetection();
        } catch (err) {
            setState('error', 'Camera access denied');
            log('Camera error: ' + err.message);
        }
    }

    function handleStop() {
        if (ocrIntervalId) {
            clearInterval(ocrIntervalId);
            ocrIntervalId = null;
        }
        Camera.stop();
        OCR.terminate();
        gridInfo = null;
        lastMatch = null;
        btnStop.classList.add('hidden');
        btnCapture.classList.add('hidden');
        btnStart.classList.remove('hidden');
        positionEl.style.display = 'none';
        debugEl.style.display = 'none';
        clearOverlay();
        setState('idle');
    }

    function handleCapture() {
        const frame = Camera.captureFrame();
        if (!frame) {
            log('No frame to capture');
            return;
        }

        const result = Detector.detect(frame);
        const debugInfo = Detector.debugDetect ? Detector.debugDetect(frame) : '';

        let msg = `Frame: ${frame.width}x${frame.height}\n`;
        msg += debugInfo + '\n';

        if (result) {
            msg += `Grid: ${result.gridCells.length} cells\n`;
            msg += `Target: ${result.targetCells ? result.targetCells.length : 0} cells\n`;
            if (result.gridCells.length > 0) {
                const c0 = result.gridCells[0];
                const cN = result.gridCells[result.gridCells.length - 1];
                msg += `Grid area: (${c0.x},${c0.y})-(${cN.x + cN.w},${cN.y + cN.h})\n`;
                msg += `Cell size: ~${c0.w}x${c0.h}`;
            }
        } else {
            msg += 'Detection: FAILED';
        }

        log(msg);
        drawDebugCells(result);

        const canvas = document.createElement('canvas');
        canvas.width = frame.width;
        canvas.height = frame.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(frame, 0, 0);

        if (result) {
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            for (const cell of result.gridCells) {
                ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
            }
            if (result.targetCells) {
                ctx.strokeStyle = '#ff0000';
                ctx.lineWidth = 3;
                for (const cell of result.targetCells) {
                    ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
                }
            }
        }

        canvas.toBlob(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'hack-debug-' + Date.now() + '.png';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    function setState(newState, message) {
        state = newState;
        statusDot.className = '';

        switch (newState) {
            case 'idle':
                statusText.textContent = 'Tap START to begin';
                break;
            case 'detecting':
                statusDot.className = 'detecting';
                statusText.textContent = 'Detecting grid...';
                break;
            case 'reading':
                statusDot.className = 'detecting';
                statusText.textContent = message || 'Reading codes...';
                break;
            case 'tracking':
                statusDot.className = 'tracking';
                statusText.textContent = 'Tracking';
                break;
            case 'error':
                statusDot.className = 'error';
                statusText.textContent = message || 'Detection failed';
                break;
        }
    }

    function runDetection() {
        if (state !== 'detecting') return;

        const frame = Camera.captureFrame();
        if (!frame) {
            setTimeout(runDetection, 200);
            return;
        }

        detectAttempts++;
        const result = Detector.detect(frame);

        let dbg = `#${detectAttempts} | ${frame.width}x${frame.height} | `;

        if (result) {
            const gc = result.gridCells.length;
            const tc = result.targetCells ? result.targetCells.length : 0;
            dbg += `Grid:${gc} Tgt:${tc}`;
            if (gc < 30) dbg += ' (need >=30 grid)';
            if (tc < 3) dbg += ' (need >=3 target)';
        } else {
            dbg += 'No grid found';
        }

        log(dbg);

        if (result && result.gridCells.length >= 30 && result.targetCells && result.targetCells.length >= 3) {
            gridInfo = result;
            startOCR(frame);
        } else {
            setTimeout(runDetection, 500);
        }
    }

    async function startOCR(frame) {
        setState('reading', 'Loading OCR...');
        log('Initializing Tesseract (eng+ell)...');

        try {
            await OCR.init();

            setState('reading', 'Reading target...');
            const rawTarget = await OCR.ocrTarget(frame, gridInfo);
            if (!rawTarget) {
                log('Failed to read target codes');
                setState('detecting');
                setTimeout(runDetection, 2000);
                return;
            }

            const whitelist = OCR.guessWhitelist(rawTarget);
            log(`Target: [${rawTarget.join(', ')}] wl:${whitelist.length}`);

            setState('reading', 'Reading grid...');
            const rawGrid = await OCR.ocrGrid(frame, gridInfo, whitelist);
            if (!rawGrid) {
                log('Failed to read grid codes');
                setState('detecting');
                setTimeout(runDetection, 2000);
                return;
            }

            const targetCodes = OCR.normalizeCodes(rawTarget);
            const gridCodes = OCR.normalizeCodes(rawGrid);

            const match = Matcher.findMatchByText(targetCodes, gridCodes);

            if (!match) {
                let dbg = `No match\nT: [${targetCodes.join(',')}]`;
                const gc = gridInfo.cols || 10;
                for (let r = 0; r < Math.ceil(gridCodes.length / gc); r++) {
                    dbg += `\nR${r+1}: ${gridCodes.slice(r*gc, r*gc+gc).join(' ')}`;
                }
                log(dbg);
                setState('detecting');
                setTimeout(runDetection, 2000);
                return;
            }

            gridInfo.targetCodes = targetCodes;
            gridInfo.gridCodes = gridCodes;
            lastMatch = match;
            setState('tracking');
            drawResult(match);
            log(`FOUND R${match.row}C${match.col}\nTarget: [${targetCodes.join(', ')}]\nConf: ${(match.confidence * 100).toFixed(0)}%`);

            ocrIntervalId = setInterval(() => refreshOCR(), 3000);
        } catch (err) {
            log('OCR error: ' + err.message + '\n' + err.stack);
            setState('error', 'OCR failed');
            setTimeout(() => {
                setState('detecting');
                runDetection();
            }, 3000);
        }
    }

    async function refreshOCR() {
        if (state !== 'tracking') return;

        const frame = Camera.captureFrame();
        if (!frame) return;

        try {
            const result = Detector.detect(frame);
            if (!result || result.gridCells.length < 30) return;

            gridInfo = result;

            const rawGrid = await OCR.ocrGrid(frame, gridInfo);
            if (!rawGrid) return;

            const gridCodes = OCR.normalizeCodes(rawGrid);
            gridInfo.gridCodes = gridCodes;

            const match = Matcher.findMatchByText(gridInfo.targetCodes, gridCodes);
            if (match) {
                lastMatch = match;
                drawResult(match);
                log(`R${match.row} C${match.col} | ${gridInfo.targetCodes.join(' ')}`);
            }
        } catch (_) {
            // Silently retry next interval
        }
    }

    function drawDebugCells(result) {
        clearOverlay();
        if (!result) return;

        const dims = Camera.getVideoDimensions();
        if (!dims.videoWidth) return;

        const scaleX = dims.displayWidth / dims.videoWidth;
        const scaleY = dims.displayHeight / dims.videoHeight;

        overlayCtx.strokeStyle = '#00ffff';
        overlayCtx.lineWidth = 1;
        for (const cell of result.gridCells) {
            overlayCtx.strokeRect(
                cell.x * scaleX, cell.y * scaleY,
                cell.w * scaleX, cell.h * scaleY
            );
        }

        if (result.targetCells) {
            overlayCtx.strokeStyle = '#ff4444';
            overlayCtx.lineWidth = 2;
            for (const cell of result.targetCells) {
                overlayCtx.strokeRect(
                    cell.x * scaleX, cell.y * scaleY,
                    cell.w * scaleX, cell.h * scaleY
                );
            }
        }
    }

    function drawResult(match) {
        clearOverlay();

        const dims = Camera.getVideoDimensions();
        if (!dims.videoWidth) return;

        const scaleX = dims.displayWidth / dims.videoWidth;
        const scaleY = dims.displayHeight / dims.videoHeight;

        const numTargets = Math.min(4, gridInfo.targetCells ? gridInfo.targetCells.length : 4);

        overlayCtx.strokeStyle = '#22c55e';
        overlayCtx.lineWidth = 3;
        overlayCtx.shadowColor = '#22c55e';
        overlayCtx.shadowBlur = 12;

        for (let t = 0; t < numTargets; t++) {
            const gridIdx = (match.position + t) % gridInfo.gridCells.length;
            const blob = gridInfo.gridCells[gridIdx];

            const x = (blob.x - 4) * scaleX;
            const y = (blob.y - 4) * scaleY;
            const w = (blob.w + 8) * scaleX;
            const h = (blob.h + 8) * scaleY;

            overlayCtx.fillStyle = 'rgba(34, 197, 94, 0.2)';
            overlayCtx.fillRect(x, y, w, h);
            overlayCtx.strokeRect(x, y, w, h);
        }

        overlayCtx.beginPath();
        overlayCtx.strokeStyle = 'rgba(34, 197, 94, 0.6)';
        overlayCtx.lineWidth = 2;
        overlayCtx.shadowBlur = 5;

        for (let t = 0; t < numTargets; t++) {
            const gridIdx = (match.position + t) % gridInfo.gridCells.length;
            const blob = gridInfo.gridCells[gridIdx];
            const cx = blob.cx * scaleX;
            const cy = blob.cy * scaleY;
            if (t === 0) overlayCtx.moveTo(cx, cy);
            else overlayCtx.lineTo(cx, cy);
        }
        overlayCtx.stroke();
        overlayCtx.shadowBlur = 0;

        positionEl.textContent = `R${match.row} C${match.col}`;
        positionEl.style.display = 'block';
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
