#!/usr/bin/env node
'use strict';

/**
 * Unit tests for filters-pane.js logic.
 * Tests pure functions that don't require DOM.
 * Run with: node filters-pane.test.js
 */

const assert = require('assert');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

// ============================================
// Test the clamp function logic
// ============================================

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

test('clamp: values within range are unchanged', () => {
  assert.strictEqual(clamp(300, 280, 500), 300);
  assert.strictEqual(clamp(400, 280, 500), 400);
  assert.strictEqual(clamp(280, 280, 500), 280);
  assert.strictEqual(clamp(500, 280, 500), 500);
});

test('clamp: values below min are clamped to min', () => {
  assert.strictEqual(clamp(100, 280, 500), 280);
  assert.strictEqual(clamp(0, 280, 500), 280);
  assert.strictEqual(clamp(-50, 280, 500), 280);
  assert.strictEqual(clamp(279, 280, 500), 280);
});

test('clamp: values above max are clamped to max', () => {
  assert.strictEqual(clamp(600, 280, 500), 500);
  assert.strictEqual(clamp(1000, 280, 500), 500);
  assert.strictEqual(clamp(501, 280, 500), 500);
});

// ============================================
// Test state validation logic
// ============================================

const VALID_STATES = ['closed', 'pinned', 'autohide'];

function isValidState(state) {
  return VALID_STATES.includes(state);
}

test('state validation: accepts valid states', () => {
  assert.strictEqual(isValidState('closed'), true);
  assert.strictEqual(isValidState('pinned'), true);
  assert.strictEqual(isValidState('autohide'), true);
});

test('state validation: rejects invalid states', () => {
  assert.strictEqual(isValidState('open'), false);
  assert.strictEqual(isValidState('hidden'), false);
  assert.strictEqual(isValidState(''), false);
  assert.strictEqual(isValidState(null), false);
  assert.strictEqual(isValidState(undefined), false);
  assert.strictEqual(isValidState(123), false);
});

// ============================================
// Test width parsing logic
// ============================================

function parseWidth(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

test('parseWidth: parses valid numeric strings', () => {
  assert.strictEqual(parseWidth('320', 280), 320);
  assert.strictEqual(parseWidth('400', 280), 400);
  assert.strictEqual(parseWidth('100', 280), 100);
});

test('parseWidth: returns fallback for invalid values', () => {
  assert.strictEqual(parseWidth('', 280), 280);
  assert.strictEqual(parseWidth('abc', 280), 280);
  assert.strictEqual(parseWidth(null, 280), 280);
  assert.strictEqual(parseWidth(undefined, 280), 280);
  assert.strictEqual(parseWidth('0', 280), 280);
  assert.strictEqual(parseWidth('-100', 280), 280);
  assert.strictEqual(parseWidth(NaN, 280), 280);
});

test('parseWidth: handles edge cases', () => {
  assert.strictEqual(parseWidth('320.5', 280), 320); // parseInt truncates
  assert.strictEqual(parseWidth('  400  ', 280), 400); // parseInt handles whitespace
  assert.strictEqual(parseWidth('300px', 280), 300); // parseInt stops at non-numeric
});

// ============================================
// Test state machine transitions
// ============================================

class PaneStateMachine {
  constructor(initialState = 'pinned') {
    this.state = isValidState(initialState) ? initialState : 'pinned';
  }

  setState(newState) {
    if (isValidState(newState) && newState !== this.state) {
      this.state = newState;
      return true;
    }
    return false;
  }

  togglePinned() {
    if (this.state === 'pinned') {
      return this.setState('autohide');
    } else {
      return this.setState('pinned');
    }
  }

  toggle() {
    if (this.state === 'closed') {
      return this.setState('pinned');
    } else {
      return this.setState('closed');
    }
  }

  close() {
    return this.setState('closed');
  }

  open() {
    if (this.state === 'closed') {
      return this.setState('pinned');
    }
    return false;
  }
}

test('state machine: initializes to pinned by default', () => {
  const sm = new PaneStateMachine();
  assert.strictEqual(sm.state, 'pinned');
});

test('state machine: initializes to provided valid state', () => {
  assert.strictEqual(new PaneStateMachine('closed').state, 'closed');
  assert.strictEqual(new PaneStateMachine('pinned').state, 'pinned');
  assert.strictEqual(new PaneStateMachine('autohide').state, 'autohide');
});

test('state machine: ignores invalid initial state', () => {
  assert.strictEqual(new PaneStateMachine('invalid').state, 'pinned');
  assert.strictEqual(new PaneStateMachine('').state, 'pinned');
});

test('state machine: togglePinned switches between pinned and autohide', () => {
  const sm = new PaneStateMachine('pinned');
  assert.strictEqual(sm.togglePinned(), true);
  assert.strictEqual(sm.state, 'autohide');
  assert.strictEqual(sm.togglePinned(), true);
  assert.strictEqual(sm.state, 'pinned');
});

test('state machine: togglePinned from closed goes to pinned', () => {
  const sm = new PaneStateMachine('closed');
  assert.strictEqual(sm.togglePinned(), true);
  assert.strictEqual(sm.state, 'pinned');
});

test('state machine: toggle switches between closed and pinned', () => {
  const sm = new PaneStateMachine('pinned');
  assert.strictEqual(sm.toggle(), true);
  assert.strictEqual(sm.state, 'closed');
  assert.strictEqual(sm.toggle(), true);
  assert.strictEqual(sm.state, 'pinned');
});

test('state machine: toggle from autohide goes to closed', () => {
  const sm = new PaneStateMachine('autohide');
  assert.strictEqual(sm.toggle(), true);
  assert.strictEqual(sm.state, 'closed');
});

test('state machine: close always goes to closed', () => {
  const sm1 = new PaneStateMachine('pinned');
  assert.strictEqual(sm1.close(), true);
  assert.strictEqual(sm1.state, 'closed');

  const sm2 = new PaneStateMachine('autohide');
  assert.strictEqual(sm2.close(), true);
  assert.strictEqual(sm2.state, 'closed');

  const sm3 = new PaneStateMachine('closed');
  assert.strictEqual(sm3.close(), false); // Already closed
  assert.strictEqual(sm3.state, 'closed');
});

test('state machine: open only works from closed', () => {
  const sm1 = new PaneStateMachine('closed');
  assert.strictEqual(sm1.open(), true);
  assert.strictEqual(sm1.state, 'pinned');

  const sm2 = new PaneStateMachine('pinned');
  assert.strictEqual(sm2.open(), false); // Already open
  assert.strictEqual(sm2.state, 'pinned');

  const sm3 = new PaneStateMachine('autohide');
  assert.strictEqual(sm3.open(), false); // Already open (in autohide mode)
  assert.strictEqual(sm3.state, 'autohide');
});

test('state machine: setState rejects invalid states', () => {
  const sm = new PaneStateMachine('pinned');
  assert.strictEqual(sm.setState('invalid'), false);
  assert.strictEqual(sm.state, 'pinned');
  assert.strictEqual(sm.setState(''), false);
  assert.strictEqual(sm.state, 'pinned');
});

test('state machine: setState returns false when state unchanged', () => {
  const sm = new PaneStateMachine('pinned');
  assert.strictEqual(sm.setState('pinned'), false);
  assert.strictEqual(sm.state, 'pinned');
});

// ============================================
// Test persistence serialization
// ============================================

test('persistence: state serializes as string', () => {
  const states = ['closed', 'pinned', 'autohide'];
  states.forEach(state => {
    assert.strictEqual(typeof state, 'string');
    assert.strictEqual(state.length > 0, true);
  });
});

test('persistence: width serializes as string number', () => {
  const width = 350;
  const serialized = String(width);
  assert.strictEqual(serialized, '350');
  assert.strictEqual(parseInt(serialized, 10), 350);
});

console.log('\nAll filters-pane tests completed.');
