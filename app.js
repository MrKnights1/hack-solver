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
    let debugLines = [];

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

    // Debug output uses textContent with newlines, safe from XSS
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

        if (!ocrReady) {
            setStatus('detecting', 'Loading OCR...');
            debug('Loading Tesseract...');
            try {
                await OCR.init();
                ocrReady = true;
                debug('OCR ready');
            } catch (err) {
                setStatus('error', 'OCR failed to load');
                debug('OCR error: ' + err.message);
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
        debugClear();
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
        debugClear();
        btnStart.disabled = true;

        try {
            var frame = Camera.captureFrame();
            if (!frame) {
                setStatus('error', 'No frame');
                debug('captureFrame null');
                return;
            }
            debug('Frame: ' + frame.width + 'x' + frame.height);

            // Step 1: Detect grid
            var det = Detector.detect(frame);
            if (!det) {
                setStatus('error', 'Grid not found');
                debug('Detector returned null');
                return;
            }

            var gc = det.gridCells.length;
            var tc = det.targetCells ? det.targetCells.length : 0;
            debug('Grid: ' + gc + ' cells, Target: ' + tc + ' cells');

            if (gc < 30 || tc < 3) {
                setStatus('error', 'Not enough cells: ' + gc + '/' + tc);
                return;
            }

            // Step 2: OCR target
            setStatus('detecting', 'Reading target...');
            var targetCodes = await OCR.ocrTarget(frame, det);
            if (!targetCodes || targetCodes.length < 2) {
                debug('Target OCR failed');
                setStatus('error', 'Cannot read target');
                return;
            }
            debug('Target: ' + targetCodes.join(' '));

            // Step 3: Whitelist
            var wl = OCR.guessWhitelist(targetCodes);
            debug('Whitelist: ' + (wl || '(none)'));

            // Step 4: OCR grid
            setStatus('detecting', 'Reading grid...');
            var gridCodes = await OCR.ocrGridBlock(frame, det, wl);
            if (gridCodes) {
                debug('Grid block OK: ' + gridCodes.length + ' codes');
            } else {
                debug('Block failed, trying rows...');
                setStatus('detecting', 'Reading rows...');
                gridCodes = await OCR.ocrGrid(frame, det, wl);
            }

            if (!gridCodes) {
                debug('Grid OCR failed');
                setStatus('error', 'Cannot read grid');
                return;
            }

            debug('Grid: ' + gridCodes.length + ' codes');

            // Step 5: Normalize and match
            var normTarget = OCR.normalizeCodes(targetCodes);
            var normGrid = OCR.normalizeCodes(gridCodes);

            var match = Matcher.findMatchByText(normTarget, normGrid);
            if (match) {
                debug('MATCH R' + match.row + ' C' + match.col + ' (' + Math.round(match.confidence * 100) + '%)');
                drawResult(det, match.position, normTarget.length);
                positionEl.textContent = 'R' + match.row + ' C' + match.col;
                positionEl.style.display = 'block';
                setStatus('tracking', 'Row ' + match.row + ', Col ' + match.col);
            } else {
                debug('NO MATCH');
                debug('Target: ' + normTarget.join(' '));
                for (var r = 0; r < 8; r++) {
                    debug('R' + (r + 1) + ': ' + normGrid.slice(r * 10, r * 10 + 10).join(' '));
                }
                setStatus('error', 'No match found');
            }
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
