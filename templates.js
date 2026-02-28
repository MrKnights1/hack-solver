const Templates = (() => {
    const CELL_SIZE = 32;

    const CHARSETS = {
        numeric: '0123456789',
        alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        greek: '\u0391\u0392\u0393\u0394\u0395\u0396\u0397\u0398\u0399\u039A\u039B\u039C\u039D\u039E\u039F\u03A0\u03A1\u03A3\u03A4\u03A5\u03A6\u03A7\u03A8\u03A9',
        braille:
            '\u2840\u2841\u2842\u2843\u2844\u2845\u2846\u2847\u2848\u2849\u284A\u284B\u284C\u284D\u284E\u284F' +
            '\u2850\u2851\u2852\u2853\u2854\u2855\u2856\u2857\u2858\u2859\u285A\u285B\u285C\u285D\u285E\u285F' +
            '\u2860\u2861\u2862\u2863\u2864\u2865\u2866\u2867\u2868\u2869\u286A\u286B\u286C\u286D\u286E\u286F' +
            '\u2870\u2871\u2872\u2873\u2874\u2875\u2876\u2877\u2878\u2879\u287A\u287B\u287C\u287D\u287E\u287F' +
            '\u2880\u2881\u2882\u2883\u2884\u2885\u2886\u2887\u2888\u2889\u288A\u288B\u288C\u288D\u288E\u288F' +
            '\u2890\u2891\u2892\u2893\u2894\u2895\u2896\u2897\u2898\u2899\u289A\u289B\u289C\u289D\u289E\u289F' +
            '\u28A0\u28A1\u28A2\u28A3\u28A4\u28A5\u28A6\u28A7\u28A8\u28A9\u28AA\u28AB\u28AC\u28AD\u28AE\u28AF' +
            '\u28B0\u28B1\u28B2\u28B3\u28B4\u28B5\u28B6\u28B7\u28B8\u28B9\u28BA\u28BB\u28BC\u28BD\u28BE\u28BF' +
            '\u28C0\u28C1\u28C2\u28C3\u28C4\u28C5\u28C6\u28C7\u28C8\u28C9\u28CA\u28CB\u28CC\u28CD\u28CE\u28CF' +
            '\u28D0\u28D1\u28D2\u28D3\u28D4\u28D5\u28D6\u28D7\u28D8\u28D9\u28DA\u28DB\u28DC\u28DD\u28DE\u28DF' +
            '\u28E0\u28E1\u28E2\u28E3\u28E4\u28E5\u28E6\u28E7\u28E8\u28E9\u28EA\u28EB\u28EC\u28ED\u28EE\u28EF' +
            '\u28F0\u28F1\u28F2\u28F3\u28F4\u28F5\u28F6\u28F7\u28F8\u28F9\u28FA\u28FB\u28FC\u28FD\u28FE\u28FF',
        runes: '\u16A0\u16A5\u16A7\u16A8\u16A9\u16AC\u16AD\u16BB\u16D0\u16D1\u16D2\u16D3\u16D4\u16D5\u16D6\u16D7\u16D8\u16D9\u16DA\u16DB\u16DC\u16DD\u16DE\u16DF\u16E4'
    };

    let generated = null;

    function renderChar(char, fontSize) {
        const size = fontSize * 3;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size, size);

        ctx.fillStyle = '#fff';
        ctx.font = fontSize + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(char, size / 2, size / 2);

        const imgData = ctx.getImageData(0, 0, size, size);
        const gray = new Uint8Array(size * size);
        for (let i = 0; i < gray.length; i++) {
            gray[i] = imgData.data[i * 4];
        }
        return { gray, w: size, h: size };
    }

    function tightCropAndNormalize(gray, w, h) {
        var minVal = 255, maxVal = 0;
        for (var i = 0; i < gray.length; i++) {
            if (gray[i] < minVal) minVal = gray[i];
            if (gray[i] > maxVal) maxVal = gray[i];
        }
        var threshold = (minVal + maxVal) / 2;

        var tMinX = w, tMaxX = 0, tMinY = h, tMaxY = 0;
        var hasText = false;
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                if (gray[y * w + x] > threshold) {
                    hasText = true;
                    if (x < tMinX) tMinX = x;
                    if (x > tMaxX) tMaxX = x;
                    if (y < tMinY) tMinY = y;
                    if (y > tMaxY) tMaxY = y;
                }
            }
        }

        if (!hasText) {
            tMinX = 0; tMaxX = w - 1;
            tMinY = 0; tMaxY = h - 1;
        }

        var margin = Math.max(1, Math.round(Math.min(tMaxX - tMinX, tMaxY - tMinY) * 0.1));
        tMinX = Math.max(0, tMinX - margin);
        tMaxX = Math.min(w - 1, tMaxX + margin);
        tMinY = Math.max(0, tMinY - margin);
        tMaxY = Math.min(h - 1, tMaxY + margin);

        var cropW = tMaxX - tMinX + 1;
        var cropH = tMaxY - tMinY + 1;

        var srcCanvas = document.createElement('canvas');
        srcCanvas.width = cropW;
        srcCanvas.height = cropH;
        var srcCtx = srcCanvas.getContext('2d');
        var cropData = srcCtx.createImageData(cropW, cropH);

        for (var cy = 0; cy < cropH; cy++) {
            for (var cx = 0; cx < cropW; cx++) {
                var g = gray[(tMinY + cy) * w + (tMinX + cx)];
                var dstIdx = (cy * cropW + cx) * 4;
                cropData.data[dstIdx] = g;
                cropData.data[dstIdx + 1] = g;
                cropData.data[dstIdx + 2] = g;
                cropData.data[dstIdx + 3] = 255;
            }
        }
        srcCtx.putImageData(cropData, 0, 0);

        var dstCanvas = document.createElement('canvas');
        dstCanvas.width = CELL_SIZE;
        dstCanvas.height = CELL_SIZE;
        var dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
        dstCtx.drawImage(srcCanvas, 0, 0, cropW, cropH, 0, 0, CELL_SIZE, CELL_SIZE);
        var scaled = dstCtx.getImageData(0, 0, CELL_SIZE, CELL_SIZE);

        var result = new Uint8Array(CELL_SIZE * CELL_SIZE);
        var gMin = 255, gMax = 0;
        for (var j = 0; j < result.length; j++) {
            var v = scaled.data[j * 4];
            result[j] = v;
            if (v < gMin) gMin = v;
            if (v > gMax) gMax = v;
        }

        var range = gMax - gMin;
        if (range > 10) {
            for (var k = 0; k < result.length; k++) {
                result[k] = Math.round(((result[k] - gMin) / range) * 255);
            }
        }

        return result;
    }

    function binarize(pixels) {
        var min = 255, max = 0;
        for (var i = 0; i < pixels.length; i++) {
            if (pixels[i] < min) min = pixels[i];
            if (pixels[i] > max) max = pixels[i];
        }
        var threshold = (min + max) / 2;
        var binary = new Uint8Array(pixels.length);
        for (var i = 0; i < pixels.length; i++) {
            binary[i] = pixels[i] > threshold ? 255 : 0;
        }
        return binary;
    }

    function generateCharset(charString, fontSize) {
        var chars = Array.from(charString);
        var templates = [];
        for (var i = 0; i < chars.length; i++) {
            var rendered = renderChar(chars[i], fontSize);
            var pixels = tightCropAndNormalize(rendered.gray, rendered.w, rendered.h);
            templates.push({ char: chars[i], pixels: pixels, binary: binarize(pixels) });
        }
        return templates;
    }

    function generate() {
        if (generated) return generated;
        var fontSize = 48;
        generated = {};
        var names = Object.keys(CHARSETS);
        for (var i = 0; i < names.length; i++) {
            generated[names[i]] = generateCharset(CHARSETS[names[i]], fontSize);
        }
        return generated;
    }

    function getCharset(name) {
        if (!generated) generate();
        return generated[name] || null;
    }

    function getAllCharsets() {
        if (!generated) generate();
        return generated;
    }

    return { generate, getCharset, getAllCharsets, CHARSETS, CELL_SIZE };
})();
