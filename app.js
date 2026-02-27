const App = (() => {
    // DOM
    const videoEl = document.getElementById('camera');
    const overlayEl = document.getElementById('overlay');
    const overlayCtx = overlayEl.getContext('2d');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const positionEl = document.getElementById('position');
    const debugEl = document.getElementById('debug');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');

    let cameraRunning = false;
    let ocrReady = false;

    function init() {
        Camera.init(videoEl);
        btnStart.addEventListener('click', handleStart);
        btnStop.addEventListener('click', handleStop);
        resizeOverlay();
        window.addEventListener('resize', resizeOverlay);
    }

    function resizeOverlay() {
        overlayEl.width = overlayEl.clientWidth * (window.devicePixelRatio || 1);
        overlayEl.height = overlayEl.clientHeight * (window.devicePixelRatio || 1);
        overlayCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    }

    function debug(msg) {
        debugEl.textContent = msg;
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

        if (!ocrReady) {
            setStatus('detecting', 'Loading OCR...');
            try {
                await OCR.init();
                ocrReady = true;
            } catch (err) {
                setStatus('error', 'OCR failed to load');
                debug(err.message);
                return;
            }
        }

        scan();
    }

    function handleStop() {
        Camera.stop();
        cameraRunning = false;
        btnStart.textContent = 'START';
        btnStop.classList.add('hidden');
        positionEl.style.display = 'none';
        clearOverlay();
        debug('');
        setStatus('idle', 'Tap START to begin');
    }

    function setStatus(type, message) {
        statusDot.className = type === 'idle' ? '' : type;
        statusText.textContent = message;
    }

    async function scan() {
        setStatus('detecting', 'Scanning...');
        clearOverlay();
        positionEl.style.display = 'none';
        btnStart.disabled = true;

        try {
            const frame = Camera.captureFrame();
            if (!frame) {
                setStatus('error', 'No frame - tap SCAN');
                debug('captureFrame returned null');
                return;
            }

            // Step 1: Detect grid structure
            const detection = Detector.detect(frame);
            if (!detection) {
                setStatus('error', 'Grid not found - tap SCAN');
                debug('Detector returned null');
                return;
            }

            const gc = detection.gridCells.length;
            const tc = detection.targetCells ? detection.targetCells.length : 0;
            debug(`Detected: ${gc} grid, ${tc} target`);

            if (gc < 30 || tc < 3) {
                setStatus('error', `Need 30+ grid & 3+ target, got ${gc}/${tc}`);
                return;
            }

            // Step 2: OCR target codes
            setStatus('detecting', 'Reading target...');
            const targetCodes = await OCR.ocrTarget(frame, detection);
            if (!targetCodes || targetCodes.length < 2) {
                setStatus('error', 'Could not read target codes');
                debug(`Target OCR failed`);
                return;
            }
            debug(`Target: ${targetCodes.join(' ')}`);

            // Step 3: Guess whitelist from target codes
            const whitelist = OCR.guessWhitelist(targetCodes);

            // Step 4: OCR grid (block mode for speed)
            setStatus('detecting', 'Reading grid...');
            let gridCodes = await OCR.ocrGridBlock(frame, detection, whitelist);

            // Fallback to per-row OCR if block failed
            if (!gridCodes) {
                setStatus('detecting', 'Reading grid (row by row)...');
                gridCodes = await OCR.ocrGrid(frame, detection, whitelist);
            }

            if (!gridCodes) {
                setStatus('error', 'Could not read grid');
                debug(`Target: ${targetCodes.join(' ')} | Grid OCR failed`);
                return;
            }

            // Step 5: Normalize and text match
            const normTarget = OCR.normalizeCodes(targetCodes);
            const normGrid = OCR.normalizeCodes(gridCodes);

            const match = Matcher.findMatchByText(normTarget, normGrid);
            if (!match) {
                setStatus('error', 'No match in grid');
                debug(`Target: ${normTarget.join(' ')} | Grid: ${normGrid.length} codes, no match`);
                return;
            }

            // Step 6: Draw result
            const cols = match.cols || 10;
            debug(`Target: ${normTarget.join(' ')} → R${match.row}C${match.col} (${Math.round(match.confidence * 100)}%)`);

            drawResult(detection, match.position, normTarget.length);
            positionEl.textContent = `R${match.row} C${match.col}`;
            positionEl.style.display = 'block';
            setStatus('tracking', `Found: Row ${match.row}, Col ${match.col}`);
        } finally {
            btnStart.disabled = false;
        }
    }

    function drawResult(detection, position, numTargets) {
        clearOverlay();

        const dims = Camera.getVideoDimensions();
        if (!dims.videoWidth) return;

        const scaleX = dims.displayWidth / dims.videoWidth;
        const scaleY = dims.displayHeight / dims.videoHeight;

        overlayCtx.strokeStyle = '#22c55e';
        overlayCtx.lineWidth = 3;
        overlayCtx.shadowColor = '#22c55e';
        overlayCtx.shadowBlur = 12;

        for (let t = 0; t < numTargets; t++) {
            const gridIdx = (position + t) % detection.gridCells.length;
            const blob = detection.gridCells[gridIdx];

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
            const gridIdx = (position + t) % detection.gridCells.length;
            const blob = detection.gridCells[gridIdx];
            const cx = blob.cx * scaleX;
            const cy = blob.cy * scaleY;
            if (t === 0) overlayCtx.moveTo(cx, cy);
            else overlayCtx.lineTo(cx, cy);
        }
        overlayCtx.stroke();
        overlayCtx.shadowBlur = 0;
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
