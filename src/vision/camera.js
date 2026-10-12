import fs from 'fs';
import path from 'path';

/**
 * Standard Minecraft block RGB palette approximations for viewport synthesis.
 */
export const MINECRAFT_PALETTE = {
  // Logs & Wood
  oak_log: [105, 75, 45],
  birch_log: [215, 215, 210],
  spruce_log: [65, 45, 25],
  dark_oak_log: [55, 38, 20],
  acacia_log: [105, 95, 85],
  jungle_log: [85, 68, 30],
  oak_wood: [105, 75, 45],
  log: [105, 75, 45],

  // Foliage & Leaves
  oak_leaves: [40, 125, 35],
  birch_leaves: [60, 135, 45],
  spruce_leaves: [30, 95, 40],
  leaves: [40, 125, 35],
  grass_block: [75, 145, 50],
  dirt: [130, 85, 50],

  // Minerals & Stones
  stone: [125, 125, 125],
  cobblestone: [100, 100, 100],
  coal_ore: [45, 45, 45],
  iron_ore: [145, 125, 115],
  copper_ore: [175, 100, 75],
  diamond_ore: [90, 205, 215],

  // Liquids & Hazards
  water: [45, 95, 210],
  lava: [230, 105, 20],

  // Structures & Furniture
  crafting_table: [165, 115, 65],
  chest: [155, 105, 45],
  furnace: [90, 90, 90],
  bed: [195, 40, 40],
  oak_planks: [165, 125, 75],
  planks: [165, 125, 75],

  // Air / Sky / Void
  air: [120, 175, 245],
  cave_air: [20, 20, 25]
};

/**
 * MIKA Perspective Camera Viewport Engine
 * Projects a first-person synthetic camera frustum from the bot's eye position and orientation,
 * rendering realistic RGB screenshot frames for computer-vision object detection.
 */
export class MinecraftCamera {
  constructor(options = {}) {
    this.width = options.width || 320;
    this.height = options.height || 240;
    this.fov = options.fov || 70.0; // Standard Minecraft FOV in degrees
    this.maxRayDistance = options.maxRayDistance || 24.0;
    this.screenshotDir = options.screenshotDir || path.join(process.cwd(), 'data', 'vision', 'screenshots');
    this.captureIntervalMs = options.captureIntervalMs || 1000; // 1 Hz default
    this.lastCaptureTime = 0;
    this.frameCount = 0;

    if (!fs.existsSync(this.screenshotDir)) {
      try {
        fs.mkdirSync(this.screenshotDir, { recursive: true });
      } catch (_) {}
    }
  }

  /**
   * Captures a perspective screenshot from the Mineflayer bot's viewpoint.
   * @param {import('mineflayer').Bot} bot
   * @param {Object} [options]
   * @returns {{ width: number, height: number, buffer: Buffer, cameraState: Object, framePath?: string }}
   */
  captureScreenshot(bot, options = {}) {
    const now = Date.now();
    this.lastCaptureTime = now;
    this.frameCount++;

    const eyePos = bot.entity ? {
      x: bot.entity.position.x,
      y: bot.entity.position.y + (bot.entity.height || 1.62),
      z: bot.entity.position.z
    } : { x: 0, y: 64, z: 0 };

    const yaw = bot.entity ? bot.entity.yaw : 0.0;
    const pitch = bot.entity ? bot.entity.pitch : 0.0;

    const cameraState = {
      position: eyePos,
      yaw,
      pitch,
      fov: this.fov,
      width: this.width,
      height: this.height,
      timestamp: new Date().toISOString()
    };

    // Render perspective RGB buffer (width * height * 3 bytes)
    const rgbBuffer = this.renderPerspectiveViewport(bot, cameraState, options);

    let framePath = null;
    if (options.saveToDisk) {
      const filename = `frame-${now}-${this.frameCount}.ppm`;
      framePath = path.join(this.screenshotDir, filename);
      // Write PPM format (universally loadable by PIL / OpenCV without native image encoder dependencies)
      const header = `P6\n${this.width} ${this.height}\n255\n`;
      const ppmData = Buffer.concat([Buffer.from(header, 'ascii'), rgbBuffer]);
      fs.writeFileSync(framePath, ppmData);
    }

    return {
      width: this.width,
      height: this.height,
      buffer: rgbBuffer,
      cameraState,
      framePath
    };
  }

  /**
   * Casts rays across the frustum grid to produce a 2D RGB viewport frame.
   */
  renderPerspectiveViewport(bot, cameraState, options = {}) {
    const { width, height, position, yaw, pitch, fov } = cameraState;
    const buffer = Buffer.alloc(width * height * 3);

    const fovRad = (fov * Math.PI) / 180.0;
    const aspect = width / height;
    const halfFovX = fovRad / 2.0;
    const halfFovY = halfFovX / aspect;

    // View direction vector from yaw & pitch
    // In Minecraft: yaw = 0 faces South (+Z), -PI/2 faces East (+X), PI faces North (-Z), PI/2 faces West (-X)
    const forward = {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: -Math.sin(pitch),
      z: Math.cos(yaw) * Math.cos(pitch)
    };

    const right = {
      x: Math.cos(yaw),
      y: 0,
      z: Math.sin(yaw)
    };

    // Up vector = right x forward
    const up = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x
    };

    // Sample ray grid (step across pixels)
    // For extreme performance, subsample if lowDetail is requested
    const step = options.lowDetail ? 4 : 2;

    for (let py = 0; py < height; py += step) {
      const ny = 1.0 - (2.0 * py) / height; // +1 at top, -1 at bottom
      const rayOffsetY = ny * Math.tan(halfFovY);

      for (let px = 0; px < width; px += step) {
        const nx = (2.0 * px) / width - 1.0; // -1 at left, +1 at right
        const rayOffsetX = nx * Math.tan(halfFovX);

        // Ray direction in world space
        const rayDir = {
          x: forward.x + right.x * rayOffsetX + up.x * rayOffsetY,
          y: forward.y + right.y * rayOffsetX + up.y * rayOffsetY,
          z: forward.z + right.z * rayOffsetX + up.z * rayOffsetY
        };

        // Normalize ray
        const len = Math.hypot(rayDir.x, rayDir.y, rayDir.z) || 1.0;
        rayDir.x /= len;
        rayDir.y /= len;
        rayDir.z /= len;

        // Cast ray into world
        const color = this.castRay(bot, position, rayDir);

        // Fill pixel block (step x step)
        for (let dy = 0; dy < step && py + dy < height; dy++) {
          for (let dx = 0; dx < step && px + dx < width; dx++) {
            const idx = ((py + dy) * width + (px + dx)) * 3;
            buffer[idx] = color[0];
            buffer[idx + 1] = color[1];
            buffer[idx + 2] = color[2];
          }
        }
      }
    }

    return buffer;
  }

  /**
   * Casts a single ray from origin along direction vector to find block or entity hit.
   */
  castRay(bot, origin, dir) {
    if (!bot || !bot.blockAt) {
      // Default horizon/sky synthetic color if bot is not in a live world
      return dir.y > 0 ? MINECRAFT_PALETTE.air : MINECRAFT_PALETTE.grass_block;
    }

    const stepDist = 0.5;
    const maxSteps = Math.floor(this.maxRayDistance / stepDist);

    for (let i = 1; i <= maxSteps; i++) {
      const rx = origin.x + dir.x * (i * stepDist);
      const ry = origin.y + dir.y * (i * stepDist);
      const rz = origin.z + dir.z * (i * stepDist);

      const blockPos = {
        x: Math.floor(rx),
        y: Math.floor(ry),
        z: Math.floor(rz)
      };

      try {
        const block = bot.blockAt(blockPos);
        if (block && block.name && block.name !== 'air' && block.name !== 'cave_air') {
          // Check palette or fallback to generic wood/stone/grass
          if (MINECRAFT_PALETTE[block.name]) {
            return MINECRAFT_PALETTE[block.name];
          }
          if (block.name.includes('log') || block.name.includes('wood')) {
            return MINECRAFT_PALETTE.oak_log;
          }
          if (block.name.includes('leaves')) {
            return MINECRAFT_PALETTE.oak_leaves;
          }
          if (block.name.includes('ore')) {
            return MINECRAFT_PALETTE.iron_ore;
          }
          if (block.name.includes('water')) {
            return MINECRAFT_PALETTE.water;
          }
          if (block.name.includes('stone') || block.name.includes('cobble')) {
            return MINECRAFT_PALETTE.stone;
          }
          return MINECRAFT_PALETTE.dirt;
        }
      } catch (_) {
        break;
      }
    }

    // Sky or void if no solid block was hit
    return dir.y > 0 ? MINECRAFT_PALETTE.air : MINECRAFT_PALETTE.cave_air;
  }
}

export default MinecraftCamera;
