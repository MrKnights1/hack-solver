const Camera = (() => {
    let videoEl = null;
    let stream = null;
    let captureCanvas = null;
    let captureCtx = null;

    function init(videoElement) {
        videoEl = videoElement;
        captureCanvas = document.createElement('canvas');
        captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
    }

    async function start() {
        const constraints = {
            video: {
                facingMode: 'environment',
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        };

        stream = await navigator.mediaDevices.getUserMedia(constraints);
        videoEl.srcObject = stream;
        await videoEl.play();

        captureCanvas.width = videoEl.videoWidth;
        captureCanvas.height = videoEl.videoHeight;
    }

    function stop() {
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            stream = null;
        }
        videoEl.srcObject = null;
    }

    function captureFrame() {
        if (!videoEl || videoEl.readyState < 2) return null;

        const w = videoEl.videoWidth;
        const h = videoEl.videoHeight;
        if (w === 0 || h === 0) return null;

        if (captureCanvas.width !== w) captureCanvas.width = w;
        if (captureCanvas.height !== h) captureCanvas.height = h;

        captureCtx.drawImage(videoEl, 0, 0, w, h);
        return captureCtx.getImageData(0, 0, w, h);
    }

    function getVideoDimensions() {
        return {
            videoWidth: videoEl.videoWidth,
            videoHeight: videoEl.videoHeight,
            displayWidth: videoEl.clientWidth,
            displayHeight: videoEl.clientHeight
        };
    }

    return { init, start, stop, captureFrame, getVideoDimensions };
})();
