#!/usr/bin/env node
'use strict';

// Ground-truth tests using real game screenshot data.
// Each test case contains the exact grid + target codes read
// from actual phone camera screenshots of the hacking minigame.
// The new Function() calls below load our own project source files
// (matcher.js, ocr.js) - no untrusted input is involved.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

// ===== Ground Truth Data =====
// Each entry: { name, charset, target, grid (80 codes), expectedPos, expectedRow, expectedCol }
// Grid is read left-to-right, top-to-bottom from the screenshot.
// Red cells in screenshots are random hiding, NOT the answer.

const GROUND_TRUTH = [
    {
        name: 'Numeric (42bf1823)',
        charset: 'numeric',
        target: ['28', '98', '94', '55'],
        grid: [
            '51','41','75','66','36','71','93','85','49','88',
            '24','11','25','29','45','14','60','49','01','68',
            '39','12','94','88','65','13','05','17','28','89',
            '50','41','54','91','88','79','37','52','87','44',
            '29','00','78','28','98','94','55','91','14','27',
            '81','50','97','33','85','28','21','84','43','62',
            '67','03','56','50','34','16','77','43','90','58',
            '64','02','91','59','82','26','35','23','81','16'
        ],
        expectedPos: 43,
        expectedRow: 5,
        expectedCol: 4
    },
    {
        name: 'Numeric (ea150fa7)',
        charset: 'numeric',
        target: ['85', '87', '22', '10'],
        grid: [
            '29','71','65','01','10','29','96','54','11','83',
            '65','39','63','31','55','06','74','43','16','84',
            '48','84','18','09','23','31','93','37','38','51',
            '84','87','21','85','87','22','10','55','51','20',
            '31','58','03','60','31','10','36','38','41','49',
            '07','64','14','05','25','20','57','57','01','55',
            '02','65','71','29','69','01','08','21','67','79',
            '13','13','74','92','37','43','51','68','31','94'
        ],
        expectedPos: 33,
        expectedRow: 4,
        expectedCol: 4
    },
    {
        name: 'Numeric (7eaf2a7e)',
        charset: 'numeric',
        target: ['10', '55', '99', '62'],
        grid: [
            '42','29','46','33','91','89','21','12','29','23',
            '40','94','48','20','31','65','13','87','25','40',
            '54','12','36','06','35','36','45','57','30','89',
            '24','78','26','54','99','33','77','72','35','31',
            '31','05','20','57','27','25','51','69','75','76',
            '79','79','50','29','14','75','10','55','99','62',
            '30','21','34','53','41','01','55','70','65','12',
            '41','48','35','20','43','79','98','22','09','84'
        ],
        expectedPos: 56,
        expectedRow: 6,
        expectedCol: 7
    },
    {
        name: 'Alphanumeric (3a1bd929)',
        charset: 'alphanum',
        target: ['UO', 'ZV', 'R0', 'H5'],
        grid: [
            'VN','UH','7E','D8','UO','ZV','R0','H5','E2','D0',
            'KT','LW','NJ','ST','NZ','S7','4D','LY','CX','LH',
            '3W','GX','3L','0J','0C','3Z','O0','RK','6W','T0',
            '5V','T2','NT','GG','IW','DE','Q7','CO','CU','AK',
            '8F','XS','YH','OI','X7','FS','ZX','9L','IW','4L',
            '9W','SP','F6','7L','0P','0L','8J','NF','Q1','NR',
            '9S','YO','XC','L9','9D','O7','UF','CB','OZ','ZV',
            'M8','N1','SO','UP','SR','CZ','0F','H4','U5','OT'
        ],
        expectedPos: 4,
        expectedRow: 1,
        expectedCol: 5
    },
    {
        name: 'Alphanumeric (5e704811)',
        charset: 'alphanum',
        target: ['7V', '81', 'U2', 'KH'],
        grid: [
            'C3','1K','XN','4B','HX','I3','F9','AC','9A','H0',
            '7V','81','U2','KH','RG','RW','F5','XL','S0','SV',
            '48','XN','O1','2O','4O','YL','WY','HQ','VB','PV',
            '2C','UZ','NH','A4','7H','GZ','2O','1Y','LE','Z0',
            'VK','4T','US','BK','NG','HP','EY','Z1','FA','GQ',
            'Y5','3R','J7','7D','CO','XZ','BP','L2','E9','PX',
            'Z9','10','8N','J4','I7','62','ZQ','HH','95','N7',
            'ST','1Q','M5','F3','B9','2A','N6','1F','U5','H0'
        ],
        expectedPos: 10,
        expectedRow: 2,
        expectedCol: 1
    },
    {
        name: 'Alphanumeric (75df3a51)',
        charset: 'alphanum',
        target: ['RC', 'ER', 'BU', 'KZ'],
        grid: [
            'P9','3W','O3','GO','ZW','BN','84','VN','A2','NS',
            'L3','61','RC','ER','BU','KZ','2B','37','QU','6G',
            'K6','7O','52','8J','Z5','3W','DO','6H','01','BN',
            'YY','7Q','YG','HX','TN','BT','4P','08','8X','7K',
            '0Y','KO','T4','KB','4L','5Y','4S','EV','6T','S3',
            'FI','MQ','ZJ','OQ','KN','06','RJ','US','NQ','PD',
            'EL','IF','M8','IV','WK','JL','53','T4','6P','8N',
            'DL','M9','MB','QW','4K','2U','35','E9','W1','KK'
        ],
        expectedPos: 12,
        expectedRow: 2,
        expectedCol: 3
    },
    {
        name: 'Alphabet (63ca78e4)',
        charset: 'alpha',
        target: ['VV', 'YP', 'GK', 'YY'],
        grid: [
            'IW','ZB','AF','CV','PG','VQ','EM','RC','ZK','VV',
            'YP','GK','YY','ZZ','NS','UI','AC','JK','PE','DN',
            'TZ','GX','EE','PE','ZM','UQ','EF','RX','GR','TI',
            'OK','OA','YF','GM','RX','MV','SH','WD','IX','IP',
            'GB','RM','LA','DM','II','AB','ZX','CG','GH','PP',
            'FN','RF','BL','IF','PN','NC','FE','HD','MJ','UV',
            'OM','SW','DD','XB','EB','AK','AC','OI','TP','LC',
            'WU','NP','MX','GM','DD','IZ','VI','BZ','BR','FM'
        ],
        expectedPos: 9,
        expectedRow: 1,
        expectedCol: 10
    },
    {
        name: 'Alphabet (773aadef) - wraps to next row',
        charset: 'alpha',
        target: ['CB', 'WG', 'HI', 'ZI'],
        grid: [
            'LO','YM','WL','LU','IW','GU','JX','MX','QG','XG',
            'PO','OU','RT','OF','HU','DM','RG','SR','BS','PR',
            'HS','TZ','BW','WA','JX','DA','YA','PE','BJ','CC',
            'LP','QB','RU','FS','TS','BX','ZM','YH','VX','NG',
            'YF','DX','EG','OA','LX','PZ','UY','CB','WG','HI',
            'ZI','BA','VO','FI','YY','CD','YS','TW','KQ','JU',
            'XV','GZ','KW','FS','DB','OV','OO','KN','RY','TD',
            'LX','MG','JY','TH','FQ','NO','KK','EW','OC','RY'
        ],
        expectedPos: 47,
        expectedRow: 5,
        expectedCol: 8
    },
    {
        name: 'Greek (1681a24a)',
        charset: 'greek',
        target: ['\u0392\u03A7', '\u039B\u03A6', '\u03A1\u03A9', '\u039A\u03A9'],
        grid: [
            '\u03A6\u0393','\u0393\u03A1','\u03A4\u03A4','\u0396\u0391','\u03A8\u03A8','\u0394\u03A6','\u0393\u0392','\u03A9\u0395','\u03A9\u03A4','\u0398\u0393',
            '\u039C\u03A6','\u039E\u0399','\u03A1\u0392','\u039C\u0398','\u039F\u0393','\u039A\u0394','\u0398\u0396','\u03A9\u039B','\u039C\u039F','\u0397\u0393',
            '\u03A1\u0391','\u039F\u0398','\u0391\u039E','\u039B\u0392','\u03A1\u039D','\u039D\u0395','\u03A9\u0393','\u0393\u03A9','\u0392\u03A4','\u0391\u03A9',
            '\u03A0\u03A0','\u03A1\u03A6','\u0393\u039B','\u03A1\u0394','\u0394\u039C','\u03A0\u03A6','\u0393\u0397','\u039F\u03A6','\u03A0\u039E','\u0398\u03A1',
            '\u0399\u03A0','\u03A9\u0398','\u03A9\u03A1','\u03A8\u03A0','\u039D\u0395','\u0394\u03A4','\u0392\u03A7','\u039B\u03A6','\u03A1\u03A9','\u039A\u03A9',
            '\u0399\u03A8','\u0398\u03A4','\u039E\u03A6','\u0393\u039C','\u0391\u0399','\u03A0\u0398','\u0394\u03A0','\u039D\u039D','\u0393\u039B','\u0399\u03A8',
            '\u0392\u0394','\u0393\u03A5','\u0393\u03A3','\u0394\u03A7','\u0399\u0391','\u039C\u0391','\u0396\u0391','\u03A7\u03A0','\u039C\u0393','\u039A\u0399',
            '\u03A7\u0392','\u0395\u03A3','\u03A5\u0397','\u0398\u03A6','\u039C\u03A0','\u03A8\u03A5','\u0394\u039B','\u039D\u0393','\u0395\u03A3','\u0394\u03A7'
        ],
        expectedPos: 46,
        expectedRow: 5,
        expectedCol: 7
    }
];

// ===== Ground Truth Matching Tests =====

describe('Ground truth: exact matching on real screenshot data', () => {
    for (const gt of GROUND_TRUTH) {
        it(gt.name, () => {
            assert.equal(gt.grid.length, 80, 'grid should have 80 codes');

            const match = Matcher.findMatchByText(gt.target, gt.grid);
            assert.ok(match, `should find match for target [${gt.target.join(', ')}]`);
            assert.equal(match.position, gt.expectedPos, `position: expected ${gt.expectedPos}, got ${match.position}`);
            assert.equal(match.row, gt.expectedRow, `row: expected R${gt.expectedRow}, got R${match.row}`);
            assert.equal(match.col, gt.expectedCol, `col: expected C${gt.expectedCol}, got C${match.col}`);
            assert.equal(match.score, 0, 'exact match should have score 0');
            assert.equal(match.confidence, 1, 'exact match should have confidence 1');
        });
    }
});

// ===== Greek Normalized Matching on Real Data =====

describe('Ground truth: Greek normalization on real screenshot data', () => {
    const greekGT = GROUND_TRUTH.find(g => g.charset === 'greek');

    it('normalizes Greek target codes', () => {
        const norm = OCR.normalizeCodes(greekGT.target);
        for (const code of norm) {
            assert.equal(code.length, 2, `code "${code}" should be 2 chars`);
        }
    });

    it('finds Greek match after normalization', () => {
        const normTarget = OCR.normalizeCodes(greekGT.target);
        const normGrid = OCR.normalizeCodes(greekGT.grid);
        const match = Matcher.findMatchByText(normTarget, normGrid);
        assert.ok(match, 'should find match after normalization');
        assert.equal(match.position, greekGT.expectedPos);
    });

    it('matches even if OCR reads some Greek chars as Latin', () => {
        const mixedTarget = ['BX', '\u039B\u03A6', 'P\u03A9', 'K\u03A9'];
        const normTarget = OCR.normalizeCodes(mixedTarget);
        const normGrid = OCR.normalizeCodes(greekGT.grid);
        const match = Matcher.findMatchByText(normTarget, normGrid);
        assert.ok(match, 'should find match with mixed Latin/Greek target');
        assert.equal(match.position, greekGT.expectedPos);
    });
});

// ===== Fuzzy Matching on Real Data (Simulated OCR Errors) =====

describe('Ground truth: fuzzy matching with simulated OCR errors', () => {
    it('numeric: one digit wrong', () => {
        const gt = GROUND_TRUTH[0];
        const fuzzyTarget = ['28', '98', '94', '56'];
        const match = Matcher.findMatchByText(fuzzyTarget, gt.grid);
        assert.ok(match, 'should find fuzzy match');
        assert.equal(match.position, gt.expectedPos);
        assert.ok(match.score > 0 && match.score <= 3);
    });

    it('numeric: prefix drop (thin char)', () => {
        const gt = GROUND_TRUTH[0];
        const fuzzyTarget = ['28', '9', '94', '55'];
        const match = Matcher.findMatchByText(fuzzyTarget, gt.grid);
        assert.ok(match, 'should find fuzzy match with dropped char');
        assert.equal(match.position, gt.expectedPos);
        assert.ok(match.score <= 3);
    });

    it('alphanumeric: zero vs letter O confusion', () => {
        const gt = GROUND_TRUTH[3];
        const fuzzyTarget = ['UO', 'ZV', 'RO', 'H5'];
        const match = Matcher.findMatchByText(fuzzyTarget, gt.grid);
        assert.ok(match, 'should handle 0/O confusion');
        assert.equal(match.position, gt.expectedPos);
        assert.ok(match.score <= 3);
    });

    it('alphabet: two chars wrong across targets', () => {
        const gt = GROUND_TRUTH[6];
        const fuzzyTarget = ['VV', 'YR', 'GK', 'YX'];
        const match = Matcher.findMatchByText(fuzzyTarget, gt.grid);
        assert.ok(match, 'should find fuzzy match with 2 errors');
        assert.equal(match.position, gt.expectedPos);
        assert.ok(match.score <= 3);
    });
});
