/**
 * Swarm Inter-Bot Message Bus.
 * Handles decentralized messaging, distress broadcasts, resource requests,
 * and status updates over EventEmitter and Minecraft chat.
 */

import { EventEmitter } from 'events';

export class SwarmMessageBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.messageLog = [];
    this.lastBroadcasts = new Map(); // key -> timestamp
  }

  /**
   * Broadcasts a message to all bots in the swarm.
   * Suppresses spamming identical chat messages within a 15-second cooldown.
   * @param {string} sender - Name of sending bot
   * @param {string} type - Message type (e.g. 'DISTRESS', 'NEED_RESOURCE', 'SHELTER_BUILT')
   * @param {Object} payload - Message data
   * @param {import('mineflayer').Bot} [bot=null] - Optional bot to emit in Minecraft chat
   */
  broadcast(sender, type, payload = {}, bot = null) {
    const event = {
      sender,
      type: type.toUpperCase(),
      payload,
      timestamp: Date.now()
    };

    this.messageLog.push(event);
    if (this.messageLog.length > 200) {
      this.messageLog.shift();
    }

    // Emit event locally on message bus
    this.emit(event.type, event);
    this.emit('*', event);

    // Broadcast in Minecraft chat with debouncing to prevent chat flood
    if (bot && typeof bot.chat === 'function') {
      const debounceKey = `${sender}:${event.type}:${payload.resource || payload.mob || 'general'}`;
      const now = Date.now();
      const lastTime = this.lastBroadcasts.get(debounceKey) || 0;
      const cooldownMs = event.type === 'DISTRESS' ? 5000 : 15000;

      if (now - lastTime >= cooldownMs) {
        this.lastBroadcasts.set(debounceKey, now);
        try {
          const chatPayload = JSON.stringify(payload);
          bot.chat(`[SWARM:${event.type}] ${chatPayload}`);
        } catch (err) {
          console.warn(`[Swarm Bus] Failed to broadcast in chat:`, err.message);
        }
      }
    }

    return event;
  }

  /**
   * Parses incoming Minecraft chat messages and triggers bus events if it matches swarm protocol.
   * @param {string} sender
   * @param {string} message
   * @returns {Object|null}
   */
  handleIncomingChat(sender, message) {
    if (!message || !message.startsWith('[SWARM:')) return null;

    const match = message.match(/^\[SWARM:([A-Z_]+)\]\s*(.*)$/);
    if (!match) return null;

    const type = match[1];
    let payload = {};
    try {
      if (match[2]) {
        payload = JSON.parse(match[2]);
      }
    } catch (_) {
      payload = { raw: match[2] };
    }

    const event = {
      sender,
      type,
      payload,
      timestamp: Date.now()
    };

    this.messageLog.push(event);
    this.emit(type, event);
    this.emit('*', event);
    return event;
  }

  // --- Convenience Helpers ---

  sendDistress(bot, mobName, health, position) {
    return this.broadcast(bot.username, 'DISTRESS', {
      mob: mobName,
      health: Math.round(health * 10) / 10,
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: Math.round(position.z)
    }, bot);
  }

  sendDistressResolved(bot, distressId, targetBot) {
    return this.broadcast(bot.username, 'DISTRESS_RESOLVED', {
      distressId,
      targetBot,
      resolvedBy: bot.username
    }, bot);
  }

  requestResource(bot, resource, count = 1, position = null) {
    return this.broadcast(bot.username, 'NEED_RESOURCE', {
      resource,
      count,
      position: position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null
    }, bot);
  }

  offerResource(bot, item, count = 1, forBot = null) {
    return this.broadcast(bot.username, 'RESOURCE_DROPPED', {
      item,
      count,
      forBot,
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z)
    }, bot);
  }

  alertShelterBuilt(bot, position, isSafe = true) {
    return this.broadcast(bot.username, 'SHELTER_BUILT', {
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: Math.round(position.z),
      isSafe
    }, bot);
  }

  alertResourceSpotted(bot, resource, position) {
    return this.broadcast(bot.username, 'RESOURCE_SPOTTED', {
      resource,
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: Math.round(position.z)
    }, bot);
  }

  alertThreatSpotted(bot, mob, position) {
    return this.broadcast(bot.username, 'THREAT_SPOTTED', {
      mob,
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: Math.round(position.z)
    }, bot);
  }

  requestFood(bot, urgency = 'normal', position = null) {
    return this.broadcast(bot.username, 'NEED_FOOD', {
      urgency,
      position: position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null
    }, bot);
  }

  alertCreatureKilled(bot, creature, drops = [], position = null) {
    return this.broadcast(bot.username, 'CREATURE_KILLED', {
      creature,
      drops,
      position: position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null
    }, bot);
  }
}

export const defaultSwarmMessageBus = new SwarmMessageBus();
export default defaultSwarmMessageBus;
