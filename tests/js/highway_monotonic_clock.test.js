// Verify static/highway.js's getTime() interpolates smoothly via
// performance.now() between setTime() calls (so plugins observe sub-
// frame clock motion despite audio.currentTime's ~23 ms quantization).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

// Brace-balanced extraction so source-level tests stay robust to body
// growth. Returns the full method-or-block text including its braces.
function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${signature}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

// Build a sandbox with the chart-clock state and the extracted setTime
// + getTime methods so behavioral tests can exercise the real
// implementation in isolation.
function buildClockSandbox(perfNowImpl) {
    const sandbox = {
        chartTime: 0,
        currentTime: 0,
        avOffsetSec: 0,
        _chartAnchorAudioT: 0,
        // Match production: NaN sentinel for "no prior anchor" so the
        // first setTime call doesn't try to derive rate from nothing.
        _chartAnchorPerfNow: NaN,
        _chartLastAdvanceAt: 0,
        _chartObservedRate: 1,
        _CHART_MAX_INTERP_MS: 100,
        performance: { now: perfNowImpl },
    };
    vm.createContext(sandbox);
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const setTimeBody = extractBlock(src, 'setTime(t) {');
    const getTimeBody = extractBlock(src, 'getTime() {');
    // Strip trailing comma if present (object-literal method declarations).
    const cleanup = (s) => s.replace(/,?\s*$/, '');
    vm.runInContext(`
        globalThis.setTime = function ${cleanup(setTimeBody)};
        globalThis.getTime = function ${cleanup(getTimeBody)};
    `, sandbox);
    return sandbox;
}

test('highway declares chart anchor + stall-detect + rate state', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    assert.match(src, /let\s+_chartAnchorAudioT\s*=\s*0/, 'missing _chartAnchorAudioT');
    // Initialized to NaN as a "no prior anchor" sentinel — `> 0` on
    // perf=0 was ambiguous in jsdom/test contexts.
    assert.match(src, /let\s+_chartAnchorPerfNow\s*=\s*NaN/, 'missing _chartAnchorPerfNow (NaN sentinel)');
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
    assert.match(stopBlock, /_chartAnchorPerfNow\s*=\s*NaN/, 'stop() must reset _chartAnchorPerfNow to the NaN sentinel');
    assert.match(stopBlock, /_chartLastAdvanceAt\s*=\s*0/, 'stop() must reset _chartLastAdvanceAt');
    assert.match(stopBlock, /_chartObservedRate\s*=\s*1/, 'stop() must reset _chartObservedRate to 1x');
});

// ── Behavioral tests (run extracted setTime/getTime in vm sandbox) ──────

test('behavior: getTime interpolates smoothly between two anchors at 1x', () => {
    let now = 0;
    const sb = buildClockSandbox(() => now);
    // First anchor at audioT=10, perf=0.
    sb.setTime(10);
    // Browser hasn't refreshed audio.currentTime; setTime called again
    // with the same value at perf=16. Anchor must NOT move.
    now = 16;
    sb.setTime(10);
    // Plugin reads at perf=24 — interpolated 24ms from anchor.
    now = 24;
    const t = sb.getTime();
    assert.ok(Math.abs(t - (10 + 0.024)) < 0.001, `expected ~10.024, got ${t}`);
});

test('behavior: getTime returns chartTime when audio has stalled (paused)', () => {
    let now = 0;
    const sb = buildClockSandbox(() => now);
    sb.setTime(10);
    now = 16; sb.setTime(10);
    // 200ms after the last advance — well past the 100ms cap. Even
    // though setTime is still being called every 16ms with the same
    // value (the 60Hz tick), getTime must report raw chartTime.
    now = 200;
    const t = sb.getTime();
    assert.equal(t, 10, `paused getTime must be chartTime (10), got ${t}`);
});

test('behavior: getTime adjusts for non-1x playback rate (observed)', () => {
    let now = 0;
    const sb = buildClockSandbox(() => now);
    // Establish initial anchor.
    sb.setTime(10);
    // Audio advanced 0.025s in 50ms real time → observed rate = 0.5.
    now = 50;
    sb.setTime(10.025);
    // Read 25ms after the latest anchor: chart should advance by
    // rate * elapsed = 0.5 * 0.025 = 0.0125 → 10.0375.
    now = 75;
    const t = sb.getTime();
    assert.ok(Math.abs(t - 10.0375) < 0.0005, `expected ~10.0375 (rate-scaled), got ${t}`);
});

test('behavior: seek discontinuity resets observed rate to 1x', () => {
    let now = 0;
    const sb = buildClockSandbox(() => now);
    sb.setTime(10);
    now = 50;
    sb.setTime(10.025); // observed rate ≈ 0.5
    assert.ok(Math.abs(sb._chartObservedRate - 0.5) < 0.001, `prior segment must measure ≈0.5, got ${sb._chartObservedRate}`);
    // Seek: large t jump in same perf delta — observed-rate clamp
    // rejects this segment, resets to 1.
    now = 70;
    sb.setTime(120); // dPerf=20ms, dT=110s → observed=5500 (out of clamp)
    assert.equal(sb._chartObservedRate, 1, 'seek must reset rate to 1x');
});

test('behavior: getTime caps interpolation at _CHART_MAX_INTERP_MS', () => {
    let now = 0;
    const sb = buildClockSandbox(() => now);
    sb.setTime(10);
    now = 50;
    sb.setTime(10.05); // observed rate ~1
    // Long pause-like gap with NO setTime call. getTime should detect
    // (now - _chartLastAdvanceAt > 100) and return chartTime.
    now = 200;
    const t = sb.getTime();
    assert.equal(t, 10.05, 'beyond cap must fall back to chartTime');
});
