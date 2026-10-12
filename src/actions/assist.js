/**
 * Assist Teammate Action.
 * Navigates to a teammate's position to provide mutual assistance
 * (defending them from attacking hostiles or rendezvousing).
 */

import { executeNavigateTo } from './navigation.js';
import { executeAttackTarget } from '../combat/index.js';

export async function executeAssistTeammate(bot, args = {}) {
  if (!bot || !bot.entity) {
    return { status: 'failed', error_code: 'BOT_NOT_READY', error: 'Bot entity not ready' };
  }

  const teammateName = args.teammate;
  if (!teammateName) {
    return { status: 'failed', error_code: 'INVALID_ARGUMENTS', error: "Action 'assist_teammate' requires a 'teammate' string" };
  }

  const startTime = Date.now();

  // 1. Locate teammate entity or use provided coordinates
  let targetPos = null;
  const teammateEntity = bot.players && bot.players[teammateName]?.entity;

  if (teammateEntity && teammateEntity.position) {
    targetPos = teammateEntity.position;
  } else if (args.x !== undefined && args.z !== undefined) {
    targetPos = {
      x: args.x,
      y: args.y !== undefined ? args.y : bot.entity.position.y,
      z: args.z
    };
  }

  if (!targetPos) {
    return {
      status: 'failed',
      error_code: 'TEAMMATE_NOT_FOUND',
      error: `Teammate '${teammateName}' not found in visual proximity and no coordinates provided`,
      duration_ms: Date.now() - startTime
    };
  }

  // 2. Navigate to teammate proximity (within 3 meters)
  const navRes = await executeNavigateTo(bot, {
    x: targetPos.x,
    y: targetPos.y,
    z: targetPos.z,
    range: 3.0
  });

  // 3. Check for hostile threats near the teammate to engage
  let threatEngaged = null;
  const hostileMobs = ['creeper', 'skeleton', 'zombie', 'spider', 'husk', 'drowned', 'witch', 'enderman'];

  if (bot.entities) {
    let closestHostile = null;
    let closestDist = Infinity;

    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e && e.name && hostileMobs.includes(e.name.toLowerCase()) && e.position) {
        const d = targetPos.distanceTo ? targetPos.distanceTo(e.position) : Math.hypot(e.position.x - targetPos.x, e.position.z - targetPos.z);
        if (d < 10 && d < closestDist) {
          closestDist = d;
          closestHostile = e;
        }
      }
    }

    if (closestHostile) {
      const attackRes = await executeAttackTarget(bot, { mob: closestHostile.name });
      threatEngaged = {
        mob: closestHostile.name,
        result: attackRes.status
      };
    }
  }

  return {
    status: 'success',
    duration_ms: Date.now() - startTime,
    data: {
      assisted_teammate: teammateName,
      navigation_status: navRes.status,
      threat_engaged: threatEngaged
    }
  };
}

export default {
  executeAssistTeammate
};
