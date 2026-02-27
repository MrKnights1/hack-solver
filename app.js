const App = (() => {
    let state = 'idle';
    let animFrameId = null;
    let gridInfo = null;
    let lastMatch = null;

    // Temporal smoothing: vote on position across recent frames
    const VOTE_WINDOW = 10;
    const recentPositions = [];
    let stablePosition = -1;

    // DOM
    const videoEl = document.getElementById('camera');
    const overlayEl = document.getElementById('overlay');
    const overlayCtx = overlayEl.getContext('2d');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const positionEl = document.getElementById('position');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');

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
        try {
            await Camera.start();
            btnStart.classList.add('hidden');
            btnStop.classList.remove('hidden');
            recentPositions.length = 0;
            stablePosition = -1;
            setState('detecting');
            runDetection();
        } catch (err) {
            setState('error', 'Camera access denied');
        }
    }

    function handleStop() {
        cancelAnimationFrame(animFrameId);
        Camera.stop();
        gridInfo = null;
        lastMatch = null;
        recentPositions.length = 0;
        stablePosition = -1;
        btnStop.classList.add('hidden');
        btnStart.classList.remove('hidden');
        positionEl.style.display = 'none';
        clearOverlay();
        setState('idle');
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

    /**
     * Find the most voted position in recent frames.
     */
    function getMostVotedPosition(match) {
        recentPositions.push(match.position);
        if (recentPositions.length > VOTE_WINDOW) {
            recentPositions.shift();
        }

        // Count votes for each position
        const votes = {};
        for (const pos of recentPositions) {
            votes[pos] = (votes[pos] || 0) + 1;
        }

        // Find the position with the most votes
        let bestPos = match.position;
        let bestVotes = 0;
        for (const [pos, count] of Object.entries(votes)) {
            if (count > bestVotes) {
                bestVotes = count;
                bestPos = parseInt(pos);
            }
        }

        // Need at least 3 votes for stability
        if (bestVotes >= 3) {
            stablePosition = bestPos;
        }

        return stablePosition;
    }

    /**
     * Phase 1: Detect the grid structure.
     * Retries every 500ms until found.
     */
    function runDetection() {
        if (state !== 'detecting') return;

        const frame = Camera.captureFrame();
        if (!frame) {
            setTimeout(runDetection, 200);
            return;
        }

        const result = Detector.detect(frame);

        if (result && result.gridCells.length >= 30 && result.targetCells && result.targetCells.length >= 3) {
            gridInfo = result;
            setState('tracking');
            const { targetCells } = Processor.extractAllCells(
                frame, [], result.targetCells
            );
            gridInfo.targetImages = targetCells;
            animFrameId = requestAnimationFrame(liveMatchLoop);
        } else {
            setTimeout(runDetection, 500);
        }
    }

    /**
     * Phase 2: Live matching loop.
     * Re-reads grid cell contents each frame and finds the match.
     * Uses temporal voting to stabilize the result.
     */
    function liveMatchLoop() {
        if (state !== 'tracking') return;

        const frame = Camera.captureFrame();
        if (frame) {
            const { gridCells } = Processor.extractAllCells(
                frame, gridInfo.gridCells, []
            );

            const { targetCells: freshTargets } = Processor.extractAllCells(
                frame, [], gridInfo.targetCells
            );

            const targets = freshTargets.length >= 3 ? freshTargets : gridInfo.targetImages;
            const match = Matcher.findMatch(targets, gridCells);

            if (match) {
                const stablePos = getMostVotedPosition(match);

                if (stablePos >= 0) {
                    const cols = match.cols || 10;
                    const displayMatch = {
                        position: stablePos,
                        row: Math.floor(stablePos / cols) + 1,
                        col: (stablePos % cols) + 1,
                        cols,
                        confidence: match.confidence,
                        score: match.score
                    };
                    lastMatch = displayMatch;
                    drawResult(displayMatch);
                }
            }
        }

        animFrameId = requestAnimationFrame(liveMatchLoop);
    }

    /**
     * Draw the green highlight rectangle on the overlay canvas.
     */
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

        // Draw connecting line
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
