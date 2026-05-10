// Verify static/highway.js's getTime() interpolates smoothly via
// performance.now() between setTime() calls (so plugins observe sub-
// frame clock motion despite audio.currentTime's ~23 ms quantization).
//
// Source-level checks confirm the anchor + stall-detect wiring is in
// place; behavioral tests would require reproducing the createHighway
// closure with all its dependencies in a vm sandbox, which is out of
// proportion to what these source-level guards already catch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

test('highway declares chart anchor + stall-detect + rate state', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    assert.match(src, /let\s+_chartAnchorAudioT\s*=\s*0/, 'missing _chartAnchorAudioT');
    assert.match(src, /let\s+_chartAnchorPerfNow\s*=\s*0/, 'missing _chartAnchorPerfNow');
    assert.match(src, /let\s+_chartLastAdvanceAt\s*=\s*0/, 'missing _chartLastAdvanceAt (pause detection)');
    assert.match(src, /let\s+_chartObservedRate\s*=\s*1/, 'missing _chartObservedRate (playback rate awareness)');
    assert.match(src, /const\s+_CHART_MAX_INTERP_MS\s*=\s*100/, 'missing _CHART_MAX_INTERP_MS cap');
});

test('getTime scales interpolation by _chartObservedRate (speed-slider safe)', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const m = src.match(/getTime\(\)\s*\{[\s\S]+?\n\s*\},/);
    assert.ok(m, 'getTime() body not found');
    const slice = m[0];
    assert.match(
        slice,
        /_chartObservedRate\s*\*\s*elapsedMs/,
        'getTime must scale interpolation by observed rate so audio.playbackRate != 1 stays accurate',
    );
});

test('setTime re-anchors and updates _chartLastAdvanceAt only when t actually changes', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    // Repeated setTime calls with the same value must not refresh the
    // anchor (else interpolation stutters); they also must not refresh
    // _chartLastAdvanceAt (else getTime would never detect a stalled
    // audio clock as paused).
    // The implementation may capture performance.now() into a local
    // (e.g. newPerfNow) and assign that to both fields; accept either
    // direct or via-local writes.
    const m = src.match(/if\s*\(\s*t\s*!==\s*_chartAnchorAudioT\s*\)\s*\{[\s\S]+?\}\s*\},/);
    assert.ok(m, 'if (t !== _chartAnchorAudioT) block not found inside setTime');
    const block = m[0];
    assert.match(block, /_chartAnchorAudioT\s*=\s*t/, 'must assign _chartAnchorAudioT = t');
    assert.match(block, /_chartAnchorPerfNow\s*=/, 'must assign _chartAnchorPerfNow');
    assert.match(block, /_chartLastAdvanceAt\s*=/, 'must assign _chartLastAdvanceAt');
});

test('getTime falls back to chartTime when audio has stalled (paused)', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    // Find the actual getTime body. Match the whole brace-balanced
    // method (using a generous greedy slice to ensure we capture both
    // the stall check and the interpolation expression below it).
    const m = src.match(/getTime\(\)\s*\{[\s\S]+?\n\s*\},/);
    assert.ok(m, 'getTime() body not found');
    const slice = m[0];
    // Must check stall-since-last-advance against the cap.
    assert.match(
        slice,
        /nowP\s*-\s*_chartLastAdvanceAt\s*>\s*_CHART_MAX_INTERP_MS/,
        'getTime must short-circuit when audio has stalled past the cap',
    );
    // Must interpolate when active.
    assert.match(slice, /performance\.now\(\)|nowP/, 'getTime must use perfNow');
    // Rate-scaled formula: _chartAnchorAudioT + (_chartObservedRate * elapsedMs) / 1000
    assert.match(
        slice,
        /_chartAnchorAudioT\s*\+\s*\(\s*_chartObservedRate\s*\*\s*elapsedMs\s*\)\s*\/\s*1000/,
        'getTime must compute anchor + rate-scaled elapsed during play',
    );
});

test('api.stop() clears the chart anchor state so re-init starts fresh', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const stopIdx = src.indexOf('stop() {');
    assert.ok(stopIdx !== -1, 'api.stop() not found');
    // The stop block runs until the next method declaration; grab a
    // generous slice and assert the anchor state resets.
    const stopBlock = src.slice(stopIdx, stopIdx + 1500);
    assert.match(stopBlock, /_chartAnchorAudioT\s*=\s*0/, 'stop() must reset _chartAnchorAudioT');
    assert.match(stopBlock, /_chartAnchorPerfNow\s*=\s*0/, 'stop() must reset _chartAnchorPerfNow');
    assert.match(stopBlock, /_chartLastAdvanceAt\s*=\s*0/, 'stop() must reset _chartLastAdvanceAt');
    assert.match(stopBlock, /_chartObservedRate\s*=\s*1/, 'stop() must reset _chartObservedRate to 1x');
});
