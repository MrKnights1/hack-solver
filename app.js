const App = (() => {
    // DOM
    const videoEl = document.getElementById('camera');
    const overlayEl = document.getElementById('overlay');
    const overlayCtx = overlayEl.getContext('2d');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const positionEl = document.getElementById('position');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');

    let cameraRunning = false;

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

        const frame = Camera.captureFrame();
        if (!frame) {
            setStatus('error', 'No frame - try again');
            return;
        }

        const detection = Detector.detect(frame);
        if (!detection || detection.gridCells.length < 30
            || !detection.targetCells || detection.targetCells.length < 3) {
            setStatus('error', 'Grid not found - tap SCAN');
            return;
        }

        const { gridCells, targetCells } = Processor.extractAllCells(
            frame, detection.gridCells, detection.targetCells
        );

        const match = Matcher.findMatch(targetCells, gridCells);
        if (!match) {
            setStatus('error', 'No match found - tap SCAN');
            return;
        }

        const cols = match.cols || 10;
        const row = Math.floor(match.position / cols) + 1;
        const col = (match.position % cols) + 1;

        drawResult(detection, match.position, targetCells.length);
        positionEl.textContent = `R${row} C${col}  (${Math.round(match.confidence * 100)}%)`;
        positionEl.style.display = 'block';
        setStatus('tracking', `Found: Row ${row}, Col ${col}`);
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
