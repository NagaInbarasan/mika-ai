import { createBotConnection, waitForSpawn, disconnectBot } from '../src/minecraft/connect.js';

async function runLiveVisionTest() {
  console.log('========================================================');
  console.log('  MIKA V1.3: LIVE MINECRAFT COMPUTER VISION TEST        ');
  console.log('========================================================');
  console.log('Target Server : localhost:56677');
  console.log('Target Task   : Visually detect tree trunk -> target -> collect wood -> verify delta');
  console.log('========================================================\n');

  let bot;
  try {
    bot = createBotConnection({
      host: 'localhost',
      port: 56677,
      username: 'MIKA_Vision'
    });
  } catch (err) {
    console.error('[Live Test] Failed to create bot connection:', err.message);
    process.exit(1);
  }

  // Handle disconnect or errors gracefully
  bot.on('error', (err) => console.error('[Live Test] Bot error:', err.message));
  bot.on('kicked', (reason) => console.warn('[Live Test] Bot was kicked:', reason));

  try {
    await waitForSpawn(bot, 30000);
  } catch (err) {
    console.error('[Live Test] Timeout waiting for bot spawn (30s):', err.message);
    disconnectBot(bot, 'Spawn timeout');
    process.exit(1);
  }

  console.log(`[Live Test] Bot spawned at (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)}).`);
  console.log(`[Live Test] Bot health: ${bot.health}/20 | food: ${bot.food}/20`);

  // Allow world chunks to load
  await new Promise(r => setTimeout(r, 2000));

  bot.chat('[MIKA V1.3] Starting Computer Vision Live Test: Scanning viewport for tree trunks...');

  console.log('\n--- Executing Visual Tree Harvest ---');
  const result = await bot.vision.executeVisualTreeHarvest(bot);

  console.log('\n========================================================');
  console.log('  LIVE VISION TEST EXECUTION RESULTS                   ');
  console.log('========================================================');
  console.log('Task Success          :', result.success ? 'YES (SUCCESS)' : 'NO (FAILED)');
  console.log('Target Class          :', result.target ? result.target.class : 'None');
  console.log('Target Position       :', result.target ? `(${result.target.worldPos.x}, ${result.target.worldPos.y}, ${result.target.worldPos.z})` : 'N/A');
  console.log('Target Distance       :', result.target ? `${result.target.distance}m` : 'N/A');
  console.log('Target Confidence     :', result.target ? result.target.confidence : 'N/A');
  console.log('Visual Bounding Box   :', result.target?.bbox ? JSON.stringify(result.target.bbox) : 'N/A');
  console.log('Inference Latency     :', `${result.inferenceLatencyMs}ms`);
  console.log('GPU VRAM Usage        :', `${result.gpuVramMb} MB`);
  console.log('Pre-Inventory Wood    :', result.outcome?.preCount ?? 'N/A');
  console.log('Post-Inventory Wood   :', result.outcome?.postCount ?? 'N/A');
  console.log('Physical Wood Delta   :', result.outcome?.delta ?? 'N/A');
  console.log('Execution Summary     :', result.outcome?.reason ?? 'N/A');
  console.log('Fallback to Mineflayer:', result.fallbackUsed ? 'YES' : 'NO (Pure Computer Vision)');
  console.log('========================================================\n');

  if (result.success) {
    bot.chat(`[MIKA V1.3: TEST PASSED] Visually harvested wood! (Delta: +${result.outcome.delta || 1} wood, Latency: ${result.inferenceLatencyMs}ms)`);
  } else {
    bot.chat(`[MIKA V1.3: TEST RESULT] ${result.outcome?.reason || 'Task concluded'}`);
  }

  // Gracefully disconnect
  await new Promise(r => setTimeout(r, 2000));
  console.log('[Live Test] Concluding test and disconnecting MIKA_Vision.');
  disconnectBot(bot, 'Test completed');

  process.exit(result.success ? 0 : 1);
}

runLiveVisionTest().catch((err) => {
  console.error('[Live Test] Fatal error:', err);
  process.exit(1);
});
