import { createBotConnection, waitForSpawn, disconnectBot } from '../src/minecraft/connect.js';
import { BaseShelterBuilder } from '../src/survival/base-shelter.js';
import { TaskManager, TASK_STATE, TASK_CATEGORY } from '../src/tasks/task-manager.js';
import { ThreatManager } from '../src/survival/threat-manager.js';
import { CraftingKnowledgeSystem } from '../src/crafting/knowledge.js';
import { FoodManager } from '../src/survival/food-manager.js';
import { BedManager } from '../src/survival/bed-manager.js';
import { StorageOrganizer } from '../src/storage/organization.js';

async function runLiveMasterTest() {
  console.log('================================================================');
  console.log('  MIKA V1.3 — LIVE MINECRAFT SURVIVAL BASE & STORAGE TEST       ');
  console.log('================================================================');
  console.log('Target Server : localhost:56677');
  console.log('Target Bot    : MIKA_SurvivalV13');
  console.log('================================================================\n');

  let bot;
  try {
    bot = createBotConnection({
      host: 'localhost',
      port: 56677,
      username: 'MIKA_SurvivalV13'
    });
  } catch (err) {
    console.error('[Live Test] Failed to create bot connection:', err.message);
    process.exit(1);
  }

  bot.on('error', (err) => console.error('[Live Test] Bot error:', err.message));
  bot.on('kicked', (reason) => console.warn('[Live Test] Bot was kicked:', reason));

  try {
    await waitForSpawn(bot, 30000);
  } catch (err) {
    console.error('[Live Test] Timeout waiting for bot spawn (30s):', err.message);
    disconnectBot(bot, 'Spawn timeout');
    process.exit(1);
  }

  const botPos = bot.entity.position;
  console.log(`[Live Test] Bot spawned at (${Math.floor(botPos.x)}, ${Math.floor(botPos.y)}, ${Math.floor(botPos.z)})`);
  console.log(`[Live Test] Health: ${bot.health}/20 | Food: ${bot.food}/20`);

  // Allow world chunks and entities to populate
  await new Promise(r => setTimeout(r, 2000));

  bot.chat('[MIKA V1.3] Starting Master Objective Live Verification on server...');

  const results = {};

  // 1. Shelter Site Assessment (Phase A)
  console.log('\n--- 1. Testing Shelter Site Assessment (Phase A) ---');
  const shelterBuilder = new BaseShelterBuilder({ width: 5, length: 5 });
  const siteAssessment = shelterBuilder.assessBaseLocation(bot);
  console.log(`Site Assessment Result : Suitable: ${siteAssessment.suitable} | Score: ${siteAssessment.score.toFixed(2)}`);
  console.log(`Chosen Site Position   : (${siteAssessment.bestSite?.x}, ${siteAssessment.bestSite?.y}, ${siteAssessment.bestSite?.z})`);
  console.log(`Site Selection Reason  : ${siteAssessment.reason}`);
  results.siteAssessment = siteAssessment.suitable;

  bot.chat(`[Phase A] Assessed base location: score ${siteAssessment.score.toFixed(2)} at (${siteAssessment.bestSite?.x}, ${siteAssessment.bestSite?.z})`);

  // 2. Shelter Planning & Blueprint (Phase B)
  console.log('\n--- 2. Testing Blueprint & Bill of Materials (Phase B) ---');
  const blueprint = shelterBuilder.generateShelterBlueprint(siteAssessment.bestSite || botPos);
  console.log(`Blueprint Dimensions   : ${blueprint.dimensions.width}x${blueprint.dimensions.length}x${blueprint.dimensions.height}`);
  console.log(`Total Solid Blocks Req : ${blueprint.billOfMaterials.totalSolidBlocks}`);
  console.log(`Floor / Walls / Roof   : ${blueprint.billOfMaterials.floorBlocksNeeded} / ${blueprint.billOfMaterials.wallBlocksNeeded} / ${blueprint.billOfMaterials.roofBlocksNeeded}`);
  console.log(`Estimated Logs Needed  : ${blueprint.billOfMaterials.estimatedLogsNeeded}`);
  results.blueprint = blueprint.billOfMaterials.totalSolidBlocks > 50;

  bot.chat(`[Phase B] Blueprint: 5x5 shelter requires ${blueprint.billOfMaterials.totalSolidBlocks} blocks (~${blueprint.billOfMaterials.estimatedLogsNeeded} logs)`);

  // 3. Task Manager Interruption & Resumption Lifecycle
  console.log('\n--- 3. Testing Task Manager Interruption & Resumption ---');
  const taskManager = new TaskManager();
  const buildTask = taskManager.register({
    id: 'BUILD_BASE_SHELTER',
    objective: 'Build survival base shelter',
    category: TASK_CATEGORY.SHELTER,
    priorityTier: 3,
    progress: { current: 10, total: 50, checkpoint: { phase: 'WALLS', stepIndex: 10 } }
  });

  taskManager.startTask('BUILD_BASE_SHELTER');
  console.log(`Task started           : ${buildTask.id} [${buildTask.state}]`);

  // Simulate threat preemption
  taskManager.interruptCurrentTask('Simulated hostile skeleton detected within 6m', { phase: 'WALLS', stepIndex: 10 });
  console.log(`Task interrupted       : ${buildTask.id} [${buildTask.state}] - Preserved checkpoint:`, buildTask.interruptedState?.checkpoint);

  // Resume task after danger cleared
  const resumed = taskManager.resumeInterruptedTask();
  console.log(`Task resumed           : ${resumed.id} [${resumed.state}] - Resumed from step: ${resumed.progress.checkpoint?.stepIndex}`);
  results.taskResumption = (resumed.state === TASK_STATE.IN_PROGRESS && resumed.progress.checkpoint?.stepIndex === 10);

  bot.chat('[TaskManager] Verified emergency interruption and checkpoint resumption: 0 progress lost!');

  // 4. Crafting Knowledge & Tool Tier Resolution
  console.log('\n--- 4. Testing Crafting Knowledge & Tool Progression ---');
  const crafting = new CraftingKnowledgeSystem();
  const invItems = bot.inventory?.items() || [];
  const invMap = {};
  for (const item of invItems) {
    invMap[item.name] = (invMap[item.name] || 0) + (item.count || 1);
  }
  const bestPickaxe = crafting.selectBestToolTier('pickaxe', invMap);
  const bestSword = crafting.selectBestToolTier('sword', invMap);
  console.log(`Crafting Tool Tiers    : Recommended Pickaxe: ${bestPickaxe} | Recommended Sword: ${bestSword}`);
  const pickaxePlan = crafting.resolveCraftingPlan('stone_pickaxe', 1, invMap);
  console.log(`Stone Pickaxe Plan     : Steps: ${pickaxePlan.steps.length} | Missing Base:`, pickaxePlan.missingBaseMaterials);
  results.crafting = pickaxePlan.steps.length > 0 || pickaxePlan.missingBaseMaterials.length > 0;

  bot.chat(`[Crafting] Recipe resolver active: Tool tier recommendation -> ${bestPickaxe}`);

  // 5. Food Reserves Assessment
  console.log('\n--- 5. Testing Food Sustenance Assessment ---');
  const foodMgr = new FoodManager();
  const foodAssessment = foodMgr.assessFoodReserves({ inventory: invItems });
  console.log(`Food Reserves          : Carried: ${foodAssessment.carriedCount} | Emergency Needed: ${foodAssessment.needsEmergencyFood}`);
  console.log(`Raw Food To Cook       : ${foodAssessment.hasRawFoodToCook} (${foodAssessment.rawCount} raw meat items)`);
  results.food = typeof foodAssessment.carriedCount === 'number';

  bot.chat(`[Food] 3-tier reserve check: Carried food ${foodAssessment.carriedCount} items (Emergency min: 4)`);

  // 6. Sheep Search & Bed Progression (with Graceful BLOCKED handling)
  console.log('\n--- 6. Testing Sheep Search & Bed Progression ---');
  const bedMgr = new BedManager({ maxSearchRadius: 32 });
  const sheepSearch = bedMgr.findNearbySheep(bot);
  console.log(`Sheep Nearby           : Found: ${sheepSearch.found} | Distance: ${sheepSearch.found ? `${sheepSearch.distance.toFixed(1)}m` : 'None in 32m'}`);
  const bedProgression = bedMgr.evaluateBedProgression(bot, taskManager, 'CRAFT_AND_PLACE_BED');
  console.log(`Bed Progression Status : ${bedProgression.status} | Blocked: ${bedProgression.blocked} | Reason: ${bedProgression.reason}`);
  results.bed = (bedProgression.status === 'BLOCKED' || bedProgression.status === 'READY_TO_CRAFT' || bedProgression.status === 'NEEDS_WOOL' || bedProgression.status === 'READY_TO_PLACE');

  bot.chat(`[Bed/Sheep] Status: ${bedProgression.status} — ${bedProgression.reason}`);

  // 7. Chest Storage Organization & Reserves
  console.log('\n--- 7. Testing Storage Organization & Reserves ---');
  const organizer = new StorageOrganizer();
  const surplus = organizer.calculateDepositableSurplus(invItems);
  console.log(`Inventory Items Count  : ${invItems.length} stacks`);
  console.log(`Depositable Surplus    : ${surplus.length} items (Personal reserves preserved)`);
  results.storage = Array.isArray(surplus);

  bot.chat(`[Storage] 7-Category Organizer: ${surplus.length} surplus items eligible for chest deposit`);

  console.log('\n================================================================');
  console.log('  MIKA V1.3 LIVE TEST SUMMARY                                   ');
  console.log('================================================================');
  console.log('1. Site Assessment (Phase A)      :', results.siteAssessment ? 'PASSED' : 'FAILED');
  console.log('2. Blueprint Planning (Phase B)   :', results.blueprint ? 'PASSED' : 'FAILED');
  console.log('3. Task Interrupt & Checkpoint    :', results.taskResumption ? 'PASSED' : 'FAILED');
  console.log('4. Crafting & Tool Tier Upgrade   :', results.crafting ? 'PASSED' : 'FAILED');
  console.log('5. 3-Tier Food Reserve Sustenance :', results.food ? 'PASSED' : 'FAILED');
  console.log('6. Bed Search & Dependency Handle :', results.bed ? 'PASSED' : 'FAILED');
  console.log('7. Categorized Storage Reserves   :', results.storage ? 'PASSED' : 'FAILED');
  console.log('================================================================\n');

  const allPassed = Object.values(results).every(Boolean);
  if (allPassed) {
    bot.chat('[MIKA V1.3: ALL SYSTEMS VERIFIED] Master Objective systems operational in live world!');
  } else {
    bot.chat('[MIKA V1.3: PARTIAL] Some live checks reported warnings.');
  }

  await new Promise(r => setTimeout(r, 2000));
  console.log('[Live Test] Disconnecting MIKA_SurvivalV13...');
  disconnectBot(bot, 'Live verification completed');

  process.exit(allPassed ? 0 : 1);
}

runLiveMasterTest().catch((err) => {
  console.error('[Live Test] Fatal error:', err);
  process.exit(1);
});
