/**
 * Per-frame single-slot registry of the RESOLVED graph-hover value (Phase 2 of the
 * stats interactivity arc, docs/STATS.md). At most one hover is live at a time, so
 * this holds one record, not a keyed map.
 *
 * The paint↔read agreement (docs reference_paint_hittest_agreement), applied to a
 * derived VALUE rather than clickable geometry: the layout slice stores only the raw
 * hover position (`{ paneId, col, row, x, y }`, single-writer layout.update). During
 * the pane pass `stats.render`, the one owner of graph geometry, resolves that
 * position to a value for ITS paneId and publishes `{ x, y, text, ... }` here. The
 * footer (painted after the pane pass) and the hover overlay (painted last) READ it
 * — neither re-derives the value, so both agree with what the graph drew. A hovered
 * pane that isn't a resolvable graph (off-screen, overlay/multi mode, header row)
 * publishes nothing → footer + overlay stay empty (stale-hover self-heal).
 *
 * Cleared at the top of every main-frame paint, repopulated in the same synchronous
 * pass; a read between frames sees the last frame's value (null before the first).
 */
'use strict';

let _hover = null;   // { paneId, x, y, text, metric, value, col } | null

/** Drop the value. Called once at the top of every main-frame paint. */
function clear() { _hover = null; }

/** Record the resolved hover value (from stats.render, for its own paneId). */
function publish(h) { _hover = h || null; }

/** The resolved hover value this frame, or null (no hover / not over a graph). */
function get() { return _hover; }

module.exports = { clear, publish, get };
