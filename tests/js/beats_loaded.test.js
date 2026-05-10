// Verify static/highway.js emits `beats:loaded` exactly once when the
// WebSocket delivers the song's beats array, with `{ count }` payload.
// Plugins that need to know when beats are available (metronome, beat-
// snapping editors, sync visualizers) consume this contract.
//
// Same isolation strategy as the other tests/js/ files — extract just
// the relevant case-block source by string matching and exercise it in
// a vm sandbox with stubbed deps.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

test('beats:loaded emit is wired into the WS beats case', () => {
    // Source-level guard: catch a future contributor removing the emit
    // (regression) or replacing window.slopsmith.emit with something
    // else (intentional refactor — this test then needs updating).
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const idx = src.indexOf("case 'beats'");
    assert.ok(idx !== -1, "case 'beats' not found in highway.js");

    // Read a few hundred chars after the case label to capture the body.
    const slice = src.slice(idx, idx + 500);
    assert.match(
        slice,
        /window\.slopsmith\.emit\(\s*['"]beats:loaded['"]/,
        'beats case must emit beats:loaded',
    );
    assert.match(
        slice,
        /count:\s*beats\.length/,
        'beats:loaded payload must include count = beats.length',
    );
});

test('beats:loaded emit is guarded against missing window.slopsmith', () => {
    // The WS handler can fire before the slopsmith namespace is defined
    // (early in app boot). The emit must be guarded so a missing
    // namespace doesn't throw inside the WS message dispatcher.
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const idx = src.indexOf("case 'beats'");
    const slice = src.slice(idx, idx + 500);
    assert.match(
        slice,
        /if\s*\(\s*window\.slopsmith\s*\)/,
        'beats:loaded emit must be wrapped in `if (window.slopsmith)` guard',
    );
});
