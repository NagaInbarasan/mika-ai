import test from 'node:test';
import assert from 'node:assert/strict';
import { EndNavigationController } from '../src/navigation/end-navigation.js';

test('EndNavigationController blocks void fall coordinates and off-island boundaries', () => {
  const nav = new EndNavigationController({ voidFallThresholdY: 30, islandRadius: 100 });

  // Safe coordinate on End island
  const safeCoord = { x: 15, y: 65, z: -20 };
  const safeRes = nav.isSafeEndCoordinate(safeCoord);
  assert.strictEqual(safeRes.safe, true);

  // Unsafe low Y (falling into void)
  const voidCoord = { x: 10, y: 15, z: 10 };
  const voidRes = nav.isSafeEndCoordinate(voidCoord);
  assert.strictEqual(voidRes.safe, false);
  assert.ok(voidRes.reason.includes('void boundary'));

  // Unsafe off-island boundary
  const offIslandCoord = { x: 150, y: 65, z: 0 };
  const offRes = nav.isSafeEndCoordinate(offIslandCoord);
  assert.strictEqual(offRes.safe, false);
  assert.ok(offRes.reason.includes('off the main End island'));
});

test('EndNavigationController avoids registered dragon breath hazard zones', () => {
  const nav = new EndNavigationController();

  const hazardPos = { x: 5, y: 65, z: 5 };
  nav.registerBreathHazard(hazardPos, 5000);

  const check = nav.isSafeEndCoordinate(hazardPos);
  assert.strictEqual(check.safe, false);
  assert.ok(check.reason.includes('Dragon Breath'));
});
