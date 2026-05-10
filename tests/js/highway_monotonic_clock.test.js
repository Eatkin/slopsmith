// Verify static/highway.js's getTime() interpolates smoothly via
// performance.now() between setTime() calls (so plugins observe sub-
// frame clock motion despite audio.currentTime's ~23 ms quantization).
//
// Source-level checks confirm the anchor + gating wiring is in place;
// behavioral checks are skipped here because reproducing the createHighway
// closure with all its dependencies (canvas, WebSocket, song state) in
// a vm sandbox would balloon test infrastructure for marginal gain over
// the static contract guards.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

test('highway declares chart anchor + playing-gate state', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    assert.match(src, /let\s+_chartAnchorAudioT\s*=\s*0/, 'missing _chartAnchorAudioT');
    assert.match(src, /let\s+_chartAnchorPerfNow\s*=\s*0/, 'missing _chartAnchorPerfNow');
    assert.match(src, /let\s+_chartIsPlaying\s*=\s*false/, 'missing _chartIsPlaying');
    assert.match(src, /const\s+_CHART_MAX_INTERP_MS\s*=\s*100/, 'missing _CHART_MAX_INTERP_MS cap');
});

test('setTime re-anchors only when t changes (smooth interp during browser-clock dwell)', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    // The setTime body must guard the anchor update with `t !== _chartAnchorAudioT`
    // so repeated calls with the same value (audio.currentTime hasn't ticked
    // yet) don't reset the perfNow origin and break the interpolation.
    assert.match(
        src,
        /if\s*\(\s*t\s*!==\s*_chartAnchorAudioT\s*\)\s*\{\s*[\s\S]*?_chartAnchorAudioT\s*=\s*t\s*;[\s\S]*?_chartAnchorPerfNow\s*=\s*performance\.now\(\)/,
        'setTime must re-anchor only when t differs from the previous anchor value',
    );
});

test('setTime lazy-binds to song:play / song:pause / song:ended', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    assert.match(src, /window\.slopsmith\.on\(\s*['"]song:play['"]/, 'missing song:play subscription');
    assert.match(src, /window\.slopsmith\.on\(\s*['"]song:pause['"]/, 'missing song:pause subscription');
    assert.match(src, /window\.slopsmith\.on\(\s*['"]song:ended['"]/, 'missing song:ended subscription');
});

test('getTime returns chartTime when paused, interpolates when playing, caps via _CHART_MAX_INTERP_MS', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    // Locate the actual method (skip any prose mentions in JSDoc / comments).
    // The api object declares `getTime() { ... }` — match the signature
    // followed by an opening brace and a few lines of body.
    const m = src.match(/getTime\(\)\s*\{[\s\S]{0,800}?_chartIsPlaying[\s\S]{0,400}/);
    assert.ok(m, 'getTime() method body referencing _chartIsPlaying not found');
    const slice = m[0];
    assert.match(slice, /if\s*\(\s*!_chartIsPlaying\s*\)\s*return\s+chartTime/, 'getTime must return raw chartTime when paused');
    assert.match(slice, /performance\.now\(\)\s*-\s*_chartAnchorPerfNow/, 'getTime must interpolate via perfNow - anchorPerfNow');
    assert.match(slice, /elapsedMs\s*>\s*_CHART_MAX_INTERP_MS/, 'getTime must enforce the interpolation cap');
});
