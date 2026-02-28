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
    let templatesReady = false;
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

        if (!templatesReady) {
            setStatus('detecting', 'Generating templates...');
            Templates.generate();
            templatesReady = true;
            debug('Templates ready');
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

    function scan() {
        setStatus('detecting', 'Scanning...');
        clearOverlay();
        positionEl.style.display = 'none';
        debugClear();
        btnStart.disabled = true;

        try {
            var t0 = performance.now();

            var frame = Camera.captureFrame();
            if (!frame) {
                setStatus('error', 'No frame');
                return;
            }
            debug('Frame: ' + frame.width + 'x' + frame.height);

            // Step 1: Detect grid
            var det = Detector.detect(frame);
            if (!det) {
                setStatus('error', 'Grid not found');
                return;
            }

            var gc = det.gridCells.length;
            var tc = det.targetCells ? det.targetCells.length : 0;
            debug('Grid: ' + gc + ' cells, Target: ' + tc + ' cells');

            if (gc < 30 || tc < 3) {
                setStatus('error', 'Not enough cells: ' + gc + '/' + tc);
                return;
            }

            // Step 2: Extract all cells
            var extracted = Processor.extractAllCells(frame, det.gridCells, det.targetCells);

            // Step 3: Detect charset from target cells
            var targetHalves = [];
            for (var i = 0; i < extracted.targetCells.length; i++) {
                var h = Processor.splitCellHalves(extracted.targetCells[i]);
                targetHalves.push(h.left);
                targetHalves.push(h.right);
            }
            var charset = Matcher.detectCharset(targetHalves, Templates.getAllCharsets());
            var templates = Templates.getCharset(charset);
            debug('Charset: ' + charset);

            // Step 4: Identify all codes
            var targetCodes = [];
            for (var t = 0; t < extracted.targetCells.length; t++) {
                targetCodes.push(Matcher.identifyCode(extracted.targetCells[t], templates));
            }
            debug('Target: ' + targetCodes.join(' '));

            var gridCodes = [];
            for (var g = 0; g < extracted.gridCells.length; g++) {
                gridCodes.push(Matcher.identifyCode(extracted.gridCells[g], templates));
            }

            // Step 5: Find match
            var match = Matcher.findMatchByText(targetCodes, gridCodes);

            var elapsed = Math.round(performance.now() - t0);
            debug('Time: ' + elapsed + 'ms');

            if (match) {
                debug('MATCH R' + match.row + ' C' + match.col + ' (' + Math.round(match.confidence * 100) + '%)');
                drawResult(det, match.position, targetCodes.length);
                positionEl.textContent = 'R' + match.row + ' C' + match.col;
                positionEl.style.display = 'block';
                setStatus('tracking', 'Row ' + match.row + ', Col ' + match.col);
            } else {
                debug('NO MATCH');
                debug('Target: ' + targetCodes.join(' '));
                var cols = det.cols || 10;
                var rows = Math.ceil(gridCodes.length / cols);
                for (var r = 0; r < rows; r++) {
                    debug('R' + (r + 1) + ': ' + gridCodes.slice(r * cols, r * cols + cols).join(' '));
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
