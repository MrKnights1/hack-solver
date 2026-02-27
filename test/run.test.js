#!/usr/bin/env node
'use strict';

// Test suite for hack-solver parsing and matching logic.
// Uses Node.js built-in test runner.
// The new Function() calls below load our own project source files
// (matcher.js, ocr.js) - no untrusted input is involved.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ===== Load Modules =====
// These load our own source files using Function constructor to
// evaluate the IIFE modules in a Node.js environment with minimal
// DOM stubs. No user input is involved - only trusted local files.

function loadMatcher() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'matcher.js'), 'utf-8');
    const loader = new Function(src + '\nreturn Matcher;');
    return loader();
}

function loadOCR() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ocr.js'), 'utf-8');
    const mockCtx = {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(0) }),
        clearRect: () => {},
        set imageSmoothingEnabled(_) {},
        set imageSmoothingQuality(_) {},
    };
    const mockDoc = {
        createElement: () => ({ width: 0, height: 0, getContext: () => mockCtx })
    };
    const mockTesseract = { createWorker: async () => ({}) };
    const loader = new Function('document', 'Tesseract', src + '\nreturn OCR;');
    return loader(mockDoc, mockTesseract);
}

const Matcher = loadMatcher();
const OCR = loadOCR();

// ===== Character Pools =====

function numericPool() {
    const pool = [];
    for (let i = 0; i < 100; i++) pool.push(String(i).padStart(2, '0'));
    return pool;
}

function alphaPool() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const pool = [];
    for (let i = 0; i < letters.length; i++)
        for (let j = 0; j < letters.length; j++)
            pool.push(letters[i] + letters[j]);
    return pool;
}

function alphanumPool() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const pool = [];
    for (let i = 0; i < letters.length; i++)
        for (let j = 0; j < digits.length; j++)
            pool.push(letters[i] + digits[j]);
    for (let i = 0; i < digits.length; i++)
        for (let j = 0; j < letters.length; j++)
            pool.push(digits[i] + letters[j]);
    return pool;
}

function greekPool() {
    const letters = '\u0391\u0392\u0393\u0394\u0395\u0396\u0397\u0398\u0399\u039A\u039B\u039C\u039D\u039E\u039F\u03A0\u03A1\u03A3\u03A4\u03A5\u03A6\u03A7\u03A8\u03A9';
    const pool = [];
    for (let i = 0; i < letters.length; i++)
        for (let j = 0; j < letters.length; j++)
            pool.push(letters[i] + letters[j]);
    return pool;
}

function braillePool() {
    const chars = '\u2801\u2803\u2809\u2819\u2811\u280B\u281B\u2813\u280A\u281A\u2805\u2807\u280D\u281D\u2815\u280F\u281F\u2817\u280E\u281E\u2825\u2827\u283A\u282D\u283D\u2835';
    const pool = [];
    for (let i = 0; i < chars.length; i++)
        for (let j = 0; j < chars.length; j++)
            pool.push(chars[i] + chars[j]);
    return pool;
}

function runesPool() {
    const chars = '\u16A0\u16A2\u16A6\u16A8\u16B1\u16B2\u16B7\u16B9\u16BA\u16BE\u16C1\u16C3\u16C7\u16C8\u16C9\u16CA\u16CB\u16CF\u16D2\u16D6\u16D7\u16DA\u16DC\u16DE\u16DF\u16DD';
    const pool = [];
    for (let i = 0; i < chars.length; i++)
        for (let j = 0; j < chars.length; j++)
            pool.push(chars[i] + chars[j]);
    return pool;
}

// ===== Helpers =====

function makeGrid(pool, target, targetPos) {
    const total = 80;
    const grid = [];
    let pi = 0;
    for (let i = 0; i < total; i++) {
        if (i >= targetPos && i < targetPos + target.length) {
            grid.push(target[i - targetPos]);
        } else {
            while (target.includes(pool[pi % pool.length])) pi++;
            grid.push(pool[pi % pool.length]);
            pi++;
        }
    }
    return grid;
}

function gridToRowTexts(grid, cols) {
    const rows = [];
    for (let r = 0; r < grid.length / cols; r++) {
        rows.push(grid.slice(r * cols, r * cols + cols).join(' '));
    }
    return rows;
}

// ===== Charset Test Generator =====

function runCharsetTests(name, poolFn, target, fuzzyTarget) {
    describe(name, () => {
        const pool = poolFn();

        it('exact match at start (pos 0)', () => {
            const grid = makeGrid(pool, target, 0);
            const match = Matcher.findMatchByText(target, grid);
            assert.ok(match, 'should find a match');
            assert.equal(match.position, 0);
            assert.equal(match.row, 1);
            assert.equal(match.col, 1);
            assert.equal(match.score, 0);
            assert.equal(match.confidence, 1);
        });

        it('exact match in middle (pos 31)', () => {
            const grid = makeGrid(pool, target, 31);
            const match = Matcher.findMatchByText(target, grid);
            assert.ok(match, 'should find a match');
            assert.equal(match.position, 31);
            assert.equal(match.row, 4);
            assert.equal(match.col, 2);
            assert.equal(match.score, 0);
            assert.equal(match.confidence, 1);
        });

        it('exact match near end (pos 76)', () => {
            const grid = makeGrid(pool, target, 76);
            const match = Matcher.findMatchByText(target, grid);
            assert.ok(match, 'should find a match');
            assert.equal(match.position, 76);
            assert.equal(match.row, 8);
            assert.equal(match.col, 7);
            assert.equal(match.score, 0);
            assert.equal(match.confidence, 1);
        });

        it('fuzzy match with OCR error', () => {
            const grid = makeGrid(pool, target, 45);
            const match = Matcher.findMatchByText(fuzzyTarget, grid);
            assert.ok(match, 'should find a fuzzy match');
            assert.equal(match.position, 45);
            assert.equal(match.row, 5);
            assert.equal(match.col, 6);
            assert.ok(match.score > 0 && match.score <= 3, 'score ' + match.score + ' should be 0 < s <= 3');
        });

        it('parse row text and match', () => {
            const grid = makeGrid(pool, target, 20);
            const rowTexts = gridToRowTexts(grid, 10);
            const parsed = [];
            for (const rowText of rowTexts) {
                const codes = OCR.parseRowCodes(rowText, 10);
                assert.equal(codes.length, 10, 'row should parse to 10 codes, got ' + codes.length + ': "' + rowText + '"');
                parsed.push(...codes);
            }
            assert.equal(parsed.length, 80);
            const match = Matcher.findMatchByText(target, parsed);
            assert.ok(match, 'should find match after parsing');
            assert.equal(match.position, 20);
            assert.equal(match.row, 3);
            assert.equal(match.col, 1);
        });
    });
}

// ===== 6 Charset Suites (5 tests each = 30 tests) =====

runCharsetTests(
    'Numeric',
    numericPool,
    ['58', '69', '70', '81'],
    ['58', '6', '70', '81']
);

runCharsetTests(
    'Alphabet',
    alphaPool,
    ['FN', 'KW', 'QD', 'BX'],
    ['FN', 'K', 'QD', 'BX']
);

runCharsetTests(
    'Alphanumeric',
    alphanumPool,
    ['A5', 'C7', 'F1', 'H4'],
    ['A5', 'C', 'F1', 'H4']
);

runCharsetTests(
    'Greek',
    greekPool,
    ['\u0395\u0394', '\u03A1\u039C', '\u0398\u0393', '\u0395\u039F'],
    ['\u0395\u0394', '\u03A1', '\u0398\u0393', '\u0395\u039F']
);

runCharsetTests(
    'Braille',
    braillePool,
    ['\u2801\u2809', '\u281B\u2813', '\u280F\u281F', '\u280E\u281E'],
    ['\u2801\u2809', '\u281B', '\u280F\u281F', '\u280E\u281E']
);

runCharsetTests(
    'Runes',
    runesPool,
    ['\u16A0\u16A6', '\u16B7\u16BA', '\u16C7\u16CA', '\u16D6\u16DA'],
    ['\u16A0\u16A6', '\u16B7', '\u16C7\u16CA', '\u16D6\u16DA']
);

// ===== parseTargetCodes Tests =====

describe('parseTargetCodes', () => {
    it('parses space-separated numeric target', () => {
        const codes = OCR.parseTargetCodes('58 38 69 61');
        assert.deepEqual(codes, ['58', '38', '69', '61']);
    });

    it('parses multi-line text with header', () => {
        const codes = OCR.parseTargetCodes('CONNECTING TO THE HOST\n58 38 69 61');
        assert.deepEqual(codes, ['58', '38', '69', '61']);
    });

    it('parses concatenated 8-digit string', () => {
        const codes = OCR.parseTargetCodes('58386961');
        assert.deepEqual(codes, ['58', '38', '69', '61']);
    });

    it('parses Greek target codes', () => {
        const codes = OCR.parseTargetCodes('\u0395\u0394 \u03A1\u039C \u0398\u0393 \u0395\u039F');
        assert.deepEqual(codes, ['\u0395\u0394', '\u03A1\u039C', '\u0398\u0393', '\u0395\u039F']);
    });

    it('parses Braille target codes', () => {
        const codes = OCR.parseTargetCodes('\u2801\u2809 \u281B\u2813 \u280F\u281F \u280E\u281E');
        assert.deepEqual(codes, ['\u2801\u2809', '\u281B\u2813', '\u280F\u281F', '\u280E\u281E']);
    });
});

// ===== parseRowCodes Edge Cases =====

describe('parseRowCodes edge cases', () => {
    it('handles concatenated digits (no spaces)', () => {
        const codes = OCR.parseRowCodes('58386961421573802954', 10);
        assert.equal(codes.length, 10);
        assert.equal(codes[0], '58');
        assert.equal(codes[3], '61');
    });

    it('handles off-by-one extra char', () => {
        const codes = OCR.parseRowCodes('583869614215738029541', 10);
        assert.equal(codes.length, 10);
        assert.equal(codes[0], '58');
    });

    it('merges split single characters', () => {
        const codes = OCR.parseRowCodes('F N K W Q D B X A C', 5);
        assert.equal(codes.length, 5);
        assert.equal(codes[0], 'FN');
        assert.equal(codes[1], 'KW');
    });

    it('handles Rune row text', () => {
        const text = '\u16A0\u16A2 \u16A6\u16A8 \u16B1\u16B2 \u16B7\u16B9 \u16BA\u16BE \u16C1\u16C3 \u16C7\u16C8 \u16C9\u16CA \u16CB\u16CF \u16D2\u16D6';
        const codes = OCR.parseRowCodes(text, 10);
        assert.equal(codes.length, 10);
        assert.equal(codes[0], '\u16A0\u16A2');
        assert.equal(codes[9], '\u16D2\u16D6');
    });

    it('handles concatenated Greek text', () => {
        const codes = OCR.parseRowCodes('\u0395\u0394\u03A1\u039C\u0398\u0393\u0395\u039F\u0391\u0392\u0393\u0394\u0396\u0397\u0398\u0399\u039A\u039B\u039C\u039D', 10);
        assert.equal(codes.length, 10);
        assert.equal(codes[0], '\u0395\u0394');
        assert.equal(codes[1], '\u03A1\u039C');
    });
});

// ===== Matcher Edge Cases =====

describe('Matcher edge cases', () => {
    it('returns null for empty inputs', () => {
        assert.equal(Matcher.findMatchByText(null, null), null);
        assert.equal(Matcher.findMatchByText([], []), null);
        assert.equal(Matcher.findMatchByText(['58'], ['58', '69', '70']), null);
    });

    it('handles 2-code target (minimum)', () => {
        const target = ['58', '69'];
        const grid = makeGrid(numericPool(), ['58', '69', '70', '81'], 10);
        const match = Matcher.findMatchByText(target, grid);
        assert.ok(match);
        assert.equal(match.position, 10);
    });

    it('estimateColumns returns 10 for 80 cells', () => {
        const pool = numericPool();
        const grid = makeGrid(pool, ['02', '03'], 0);
        const match = Matcher.findMatchByText(['02', '03'], grid);
        assert.ok(match);
        assert.equal(match.cols, 10);
    });

    it('no false positive with distinct target', () => {
        const pool = numericPool();
        const grid = [];
        for (let i = 0; i < 80; i++) grid.push(pool[i]);
        const target = ['91', '92', '93', '94'];
        const match = Matcher.findMatchByText(target, grid);
        if (match) {
            assert.ok(match.score > 0, 'should not be an exact false positive');
        }
    });

    it('char substitution fuzzy match', () => {
        const pool = alphaPool();
        const realTarget = ['AB', 'CD', 'EF', 'GH'];
        const fuzzyTarget = ['AB', 'CX', 'EF', 'GH'];
        const grid = makeGrid(pool, realTarget, 50);
        const match = Matcher.findMatchByText(fuzzyTarget, grid);
        assert.ok(match, 'should find fuzzy match');
        assert.equal(match.position, 50);
        assert.ok(match.score <= 3);
    });
});
