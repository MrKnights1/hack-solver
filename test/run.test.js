#!/usr/bin/env node
'use strict';

// Test suite for hack-solver matching logic.
// Uses Node.js built-in test runner.
// The new Function() calls below load our own project source files
// (matcher.js) - no untrusted input is involved.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ===== Load Matcher Module =====
// Loads our own source file using Function constructor to evaluate
// the IIFE module in Node.js. No user input is involved - only
// trusted local files.

function loadMatcher() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'matcher.js'), 'utf-8');
    // eslint-disable-next-line no-new-func -- loading own trusted source file
    const loader = new Function('Processor', src + '\nreturn Matcher;');
    // Provide stub Processor since matcher.js references it for identifyCode
    const stubProcessor = {
        splitCellHalves: () => ({ left: new Uint8Array(1024), right: new Uint8Array(1024) })
    };
    return loader(stubProcessor);
}

const Matcher = loadMatcher();

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

        it('fuzzy match with character error', () => {
            const grid = makeGrid(pool, target, 45);
            const match = Matcher.findMatchByText(fuzzyTarget, grid);
            assert.ok(match, 'should find a fuzzy match');
            assert.equal(match.position, 45);
            assert.equal(match.row, 5);
            assert.equal(match.col, 6);
            assert.ok(match.score > 0 && match.score <= 3, 'score ' + match.score + ' should be 0 < s <= 3');
        });
    });
}

// ===== 6 Charset Suites (4 tests each = 24 tests) =====

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

// ===== Hamming Distance Tests =====

describe('Hamming distance', () => {
    it('identical arrays return 0', () => {
        const a = new Uint8Array([0, 255, 0, 255]);
        assert.equal(Matcher.hammingDist(a, a), 0);
    });

    it('completely different arrays return 1', () => {
        const a = new Uint8Array([0, 0, 0, 0]);
        const b = new Uint8Array([255, 255, 255, 255]);
        assert.equal(Matcher.hammingDist(a, b), 1);
    });

    it('half-different arrays return 0.5', () => {
        const a = new Uint8Array([0, 0, 255, 255]);
        const b = new Uint8Array([0, 0, 0, 0]);
        assert.equal(Matcher.hammingDist(a, b), 0.5);
    });

    it('different lengths return 1', () => {
        const a = new Uint8Array([0, 0]);
        const b = new Uint8Array([0, 0, 0]);
        assert.equal(Matcher.hammingDist(a, b), 1);
    });
});

// ===== toBinary Tests =====

describe('toBinary', () => {
    it('thresholds at midpoint', () => {
        const input = new Uint8Array([0, 50, 100, 150, 200, 255]);
        const result = Matcher.toBinary(input);
        // midpoint = (0 + 255) / 2 = 127.5
        assert.deepEqual(Array.from(result), [0, 0, 0, 255, 255, 255]);
    });

    it('uniform array stays same', () => {
        const input = new Uint8Array([128, 128, 128]);
        const result = Matcher.toBinary(input);
        // midpoint = 128, values equal to threshold go to 0
        assert.deepEqual(Array.from(result), [0, 0, 0]);
    });
});
