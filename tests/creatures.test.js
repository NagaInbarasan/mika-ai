import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATURE_DATABASE,
  CreatureKnowledge,
  defaultCreatureKnowledge
} from '../src/swarm/creatures.js';

test('CREATURE_DATABASE contains required passive, neutral, and hostile mobs', () => {
  const passiveMobs = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'horse', 'donkey', 'cod', 'salmon'];
  const neutralMobs = ['wolf', 'bee', 'iron_golem', 'llama', 'polar_bear', 'dolphin', 'trader_llama'];
  const hostileMobs = [
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch',
    'drowned', 'husk', 'stray', 'phantom', 'pillager', 'vindicator', 'ravager',
    'blaze', 'ghast', 'magma_cube', 'slime', 'silverfish', 'guardian', 'elder_guardian',
    'warden', 'wither_skeleton'
  ];

  for (const name of passiveMobs) {
    const entry = CREATURE_DATABASE[name];
    assert.ok(entry, `Passive mob ${name} should exist in CREATURE_DATABASE`);
    assert.strictEqual(entry.type, 'passive');
    assert.ok(typeof entry.health === 'number');
    assert.ok(Array.isArray(entry.drops));
    assert.ok(Array.isArray(entry.foodDrops));
    assert.ok(Array.isArray(entry.craftDrops));
    assert.ok(typeof entry.dangerLevel === 'number');
    assert.ok(typeof entry.huntStrategy === 'string');
    assert.ok(['high', 'medium', 'low', 'none'].includes(entry.foodValue));
    assert.ok(typeof entry.xpValue === 'number');
  }

  for (const name of neutralMobs) {
    const entry = CREATURE_DATABASE[name];
    assert.ok(entry, `Neutral mob ${name} should exist in CREATURE_DATABASE`);
    assert.strictEqual(entry.type, 'neutral');
  }

  for (const name of hostileMobs) {
    const entry = CREATURE_DATABASE[name];
    assert.ok(entry, `Hostile mob ${name} should exist in CREATURE_DATABASE`);
    assert.strictEqual(entry.type, 'hostile');
  }
});

test('CreatureKnowledge: query methods work properly', () => {
  const ck = new CreatureKnowledge();

  // getCreature
  assert.strictEqual(ck.getCreature('cow').type, 'passive');
  assert.strictEqual(ck.getCreature('COW').type, 'passive');
  assert.strictEqual(ck.getCreature('unknown_mob'), null);
  assert.strictEqual(ck.getCreature(null), null);

  // isHuntable
  assert.strictEqual(ck.isHuntable('cow'), true);
  assert.strictEqual(ck.isHuntable('horse'), false); // horse has no food drops
  assert.strictEqual(ck.isHuntable('zombie'), false); // hostile, not passive
  assert.strictEqual(ck.isHuntable('polar_bear'), false); // neutral

  // isHostile
  assert.strictEqual(ck.isHostile('creeper'), true);
  assert.strictEqual(ck.isHostile('wolf'), false);
  assert.strictEqual(ck.isHostile('cow'), false);

  // isDangerous
  // cow has dangerLevel 0 -> false
  assert.strictEqual(ck.isDangerous('cow', 20), false);
  assert.strictEqual(ck.isDangerous('cow', 5), false);
  // spider has dangerLevel 4 -> dangerous only if botHealth < 10
  assert.strictEqual(ck.isDangerous('spider', 20), false);
  assert.strictEqual(ck.isDangerous('spider', 9), true);
  // creeper has dangerLevel 8 -> dangerous always (even at full health)
  assert.strictEqual(ck.isDangerous('creeper', 20), true);

  // getSafeHuntTargets
  const safeAtFullHealth = ck.getSafeHuntTargets(20);
  assert.ok(safeAtFullHealth.includes('cow'));
  assert.ok(safeAtFullHealth.includes('pig'));
  assert.ok(safeAtFullHealth.includes('chicken'));
  assert.ok(!safeAtFullHealth.includes('creeper'));
  assert.ok(!safeAtFullHealth.includes('zombie'));

  // getHuntStrategy
  assert.strictEqual(ck.getHuntStrategy('cow'), 'melee');
  assert.strictEqual(ck.getHuntStrategy('skeleton'), 'shield_close');
  assert.strictEqual(ck.getHuntStrategy('creeper'), 'hit_and_run');
  assert.strictEqual(ck.getHuntStrategy('unknown'), 'avoid');

  // getBestFoodSource
  const best = ck.getBestFoodSource();
  assert.ok(['cow', 'pig'].includes(best));
});

test('CreatureKnowledge: dynamic learning and drops query', () => {
  const ck = new CreatureKnowledge();

  const drops = ck.getDropsForCreature('cow');
  assert.ok(drops.food.includes('raw_beef'));
  assert.ok(drops.craft.includes('leather'));
  assert.ok(drops.all.includes('raw_beef') && drops.all.includes('leather'));

  // Learn observed drops
  ck.learnCreature('cow', ['milk_bucket', 'leather']);
  const learned = ck.getLearnedDrops('cow');
  assert.ok(learned.has('milk_bucket'));
  assert.ok(learned.has('leather'));

  const updatedDrops = ck.getDropsForCreature('cow');
  assert.ok(updatedDrops.all.includes('milk_bucket'));

  // getCreaturesByDrop
  const leatherDroppers = ck.getCreaturesByDrop('leather');
  assert.ok(leatherDroppers.includes('cow'));
  assert.ok(leatherDroppers.includes('horse'));

  const milkDroppers = ck.getCreaturesByDrop('milk_bucket');
  assert.ok(milkDroppers.includes('cow'));

  // defaultCreatureKnowledge singleton check
  assert.ok(defaultCreatureKnowledge instanceof CreatureKnowledge);
  assert.strictEqual(defaultCreatureKnowledge.getCreature('pig').type, 'passive');
});
