const Processor = (() => {
    const CELL_SIZE = 32;
    let tempCanvas = null;
    let tempCtx = null;

    function getCanvas() {
        if (!tempCanvas) {
            tempCanvas = document.createElement('canvas');
            tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        }
        return { canvas: tempCanvas, ctx: tempCtx };
    }

    /**
     * Extract a cell image and normalize to CELL_SIZE × CELL_SIZE grayscale.
     * Tight-crops to text content before scaling so characters at different
     * font sizes produce similar normalized images.
     */
    function extractCell(imageData, blob, padding) {
        const { canvas, ctx } = getCanvas();
        const { width, height, data } = imageData;
        const pad = padding || 2;

        // Bounding box with padding
        const sx = Math.max(0, blob.x - pad);
        const sy = Math.max(0, blob.y - pad);
        const sw = Math.min(width - sx, blob.w + pad * 2);
        const sh = Math.min(height - sy, blob.h + pad * 2);

        // Extract raw grayscale pixels for the cell region
        const cellGray = new Uint8Array(sw * sh);
        for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
                const srcIdx = ((sy + y) * width + (sx + x)) * 4;
                cellGray[y * sw + x] = Math.round(
                    0.299 * data[srcIdx] + 0.587 * data[srcIdx + 1] + 0.114 * data[srcIdx + 2]
                );
            }
        }

        // Find threshold for this cell (Otsu-like: midpoint between min and max)
        let minVal = 255, maxVal = 0;
        for (let i = 0; i < cellGray.length; i++) {
            if (cellGray[i] < minVal) minVal = cellGray[i];
            if (cellGray[i] > maxVal) maxVal = cellGray[i];
        }
        const threshold = (minVal + maxVal) / 2;

        // Find tight bounding box of text pixels (above threshold)
        let tMinX = sw, tMaxX = 0, tMinY = sh, tMaxY = 0;
        let hasText = false;
        for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
                if (cellGray[y * sw + x] > threshold) {
                    hasText = true;
                    if (x < tMinX) tMinX = x;
                    if (x > tMaxX) tMaxX = x;
                    if (y < tMinY) tMinY = y;
                    if (y > tMaxY) tMaxY = y;
                }
            }
        }

        // If no text found, use the full cell
        if (!hasText) {
            tMinX = 0; tMaxX = sw - 1;
            tMinY = 0; tMaxY = sh - 1;
        }

        // Add small margin around tight crop
        const margin = Math.max(1, Math.round(Math.min(tMaxX - tMinX, tMaxY - tMinY) * 0.1));
        tMinX = Math.max(0, tMinX - margin);
        tMaxX = Math.min(sw - 1, tMaxX + margin);
        tMinY = Math.max(0, tMinY - margin);
        tMaxY = Math.min(sh - 1, tMaxY + margin);

        const cropW = tMaxX - tMinX + 1;
        const cropH = tMaxY - tMinY + 1;

        // Draw tight-cropped region to canvas, scaled to CELL_SIZE
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = cropW;
        srcCanvas.height = cropH;
        const srcCtx = srcCanvas.getContext('2d');
        const cropData = srcCtx.createImageData(cropW, cropH);

        for (let y = 0; y < cropH; y++) {
            for (let x = 0; x < cropW; x++) {
                const g = cellGray[(tMinY + y) * sw + (tMinX + x)];
                const dstIdx = (y * cropW + x) * 4;
                cropData.data[dstIdx] = g;
                cropData.data[dstIdx + 1] = g;
                cropData.data[dstIdx + 2] = g;
                cropData.data[dstIdx + 3] = 255;
            }
        }
        srcCtx.putImageData(cropData, 0, 0);

        canvas.width = CELL_SIZE;
        canvas.height = CELL_SIZE;
        ctx.drawImage(srcCanvas, 0, 0, cropW, cropH, 0, 0, CELL_SIZE, CELL_SIZE);
        const scaled = ctx.getImageData(0, 0, CELL_SIZE, CELL_SIZE);

        // Convert to grayscale and normalize contrast
        const gray = new Uint8Array(CELL_SIZE * CELL_SIZE);
        let gMin = 255, gMax = 0;
        for (let i = 0; i < gray.length; i++) {
            const v = scaled.data[i * 4];
            gray[i] = v;
            if (v < gMin) gMin = v;
            if (v > gMax) gMax = v;
        }

        // Contrast normalization: stretch to 0-255
        const range = gMax - gMin;
        if (range > 10) {
            for (let i = 0; i < gray.length; i++) {
                gray[i] = Math.round(((gray[i] - gMin) / range) * 255);
            }
        }

        return gray;
    }

    /**
     * Extract all grid cells and target cells from a camera frame.
     */
    function extractAllCells(imageData, gridBlobs, targetBlobs) {
        const gridCells = gridBlobs.map(blob => extractCell(imageData, blob));
        const targetCells = targetBlobs
            ? targetBlobs.map(blob => extractCell(imageData, blob))
            : [];
        return { gridCells, targetCells };
    }

    return { extractCell, extractAllCells, CELL_SIZE };
})();
