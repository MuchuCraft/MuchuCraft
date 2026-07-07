#!/usr/bin/env node
/**
 * scripts/build-spawn.mjs — MuchuCraft spawn plaza builder (SPEC-PHASE4 §1).
 *
 * Builds "The Amethyst Compass": a circular-feel plaza (r≈20) centered on
 * block (0,116,0), terraced into the snowy cherry-grove mountain, with a
 * central diamond-motif dais, 4 torii-style gateways (N/E/S/W) with path
 * stubs, layered lighting (lanterns + froglights + amethyst + hidden light
 * blocks), tagged text_displays and cherry sign boards.
 *
 * Plus the ADVENTURE PAD (server-UX polish): a 3x3 smooth-quartz pad on the
 * south path grade (probed live: the flat channel past the grand stair is
 * x -3..-1 at z 29..31, tops y110-111; the hill rises to y116+ for x >= 0)
 * with a player-only polished_blackstone_pressure_plate wired to a hidden
 * impulse command block one block below its support (vanilla RTP via
 * spreadplayers). Requires gamerule command_blocks_work true — the 1.21.11
 * REPLACEMENT for the removed server.properties enable-command-block key
 * (verified: the key is gone from DedicatedServerProperties; the gamerule
 * defaults to true and persists in level.dat). Asserted below.
 *
 * - Vanilla console commands only over RCON (fill/setblock/summon/kill/...).
 * - IDEMPOTENT: safe to re-run. text_displays are tagged muchu_spawn and
 *   killed before re-summoning; all geometry is deterministic set/fill.
 * - Sets /setworldspawn 0 118 0 and gamerule respawn_radius 0 (1.21.11 name
 *   for the old spawnRadius). Writes plugins/Essentials/spawn.yml.
 * - Run:  node scripts/build-spawn.mjs        (against the RUNNING server)
 *         node scripts/build-spawn.mjs --dry  (print command counts only)
 *
 * 1.21.11 quirks discovered empirically (do not "simplify" these away):
 * - gamerules are renamed/registry-based: spawnRadius -> respawn_radius.
 * - /kill is overridden by Essentials: must call minecraft:kill.
 * - sign & text_display text is native SNBT components (not JSON strings).
 * - unloaded chunks fail vanilla commands: we forceload the build area.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may be set already */ }
const requireGw = createRequire(path.join(ROOT, 'gateway', 'package.json'));
const { Rcon } = requireGw('rcon-client');

const DRY = process.argv.includes('--dry');

// ---------------------------------------------------------------- constants
const DIM = 'minecraft:overworld';
const FLOOR_Y = 116;          // plaza floor block layer (players walk at 117)
const DAIS_Y = 117;           // dais tier layer (players stand/spawn at 118)
const SPAWN = { x: 0, y: 118, z: 0 };
const CLEAR_TOP = 134;        // clear air above the plaza up to here
const FOUND_BOTTOM = 100;     // foundation slab bottom (seals caves below floor)

const R2 = (r) => r * r;
const R_FLOOR = 20.49;        // main disc
const R_FIELD = 15.5;         // inner quartz field
const R_PROM = 18.5;          // purpur promenade outer edge
const R_WALL_IN = 19.5;       // perimeter wall band
const R_WALL_OUT = 20.5;
const R_TER1_OUT = 22.5;      // terrace ring 1 (cut down to y118)
const R_TER2_OUT = 24.5;      // terrace ring 2 (cut down to y122)

const PURPLE = '#9945FF';     // Muchu purple
const GREEN = '#14F195';      // Muchu green
const PALE = '#EDE4FF';       // pale lavender body text
const BG = 1712655150;        // 0x66150B2E translucent deep-purple background

const d2 = (x, z) => x * x + z * z;
const hash = (x, z, m) => (((x * 31 + z * 17) % m) + m) % m;

// ------------------------------------------------------------ row segments
// Contiguous x-intervals of a predicate along row z (bounded scan).
function segs(z, pred, max) {
  const out = [];
  let start = null;
  for (let x = -max; x <= max + 1; x++) {
    const inside = x <= max && pred(x, z);
    if (inside && start === null) start = x;
    if (!inside && start !== null) { out.push([start, x - 1]); start = null; }
  }
  return out;
}
function annulusFills(rIn2, rOut2, y1, y2, block, max, extra = '') {
  const cmds = [];
  for (let z = -max; z <= max; z++) {
    for (const [x1, x2] of segs(z, (x, zz) => d2(x, zz) > rIn2 && d2(x, zz) <= rOut2, max)) {
      cmds.push(`fill ${x1} ${y1} ${z} ${x2} ${y2} ${z} ${block}${extra ? ' ' + extra : ''}`);
    }
  }
  return cmds;
}

// ------------------------------------------------------------ floor design
// Full desired floor block at (x,z) — deterministic, so re-runs are no-ops.
function floorBlock(x, z) {
  const dd = d2(x, z);
  if (dd > R2(R_FLOOR)) return null;
  if (dd <= R2(5.5)) return 'minecraft:quartz_block';                    // under-dais
  // Cross paths (3 wide) from dais to the four gateways.
  if (Math.abs(z) <= 1 && Math.abs(x) >= 6) {
    if (z === 0) return 'minecraft:purpur_pillar[axis=x]';
    return Math.abs(x) % 6 === 0 ? 'minecraft:crying_obsidian' : 'minecraft:purpur_block';
  }
  if (Math.abs(x) <= 1 && Math.abs(z) >= 6) {
    if (x === 0) return 'minecraft:purpur_pillar[axis=z]';
    return Math.abs(z) % 6 === 0 ? 'minecraft:crying_obsidian' : 'minecraft:purpur_block';
  }
  // Inner purpur ring (r≈10) with amethyst gems.
  if (dd > R2(9.7) && dd <= R2(10.7)) {
    return hash(x, z, 11) === 0 ? 'minecraft:amethyst_block' : 'minecraft:purpur_block';
  }
  // Diagonal cherry rays.
  if (Math.abs(x) === Math.abs(z) && Math.abs(x) >= 7 && Math.abs(x) <= 15) {
    return 'minecraft:stripped_cherry_wood';
  }
  if (dd > R2(R_PROM)) return 'minecraft:smooth_quartz';                 // rim walk
  if (dd > R2(R_FIELD)) {                                                 // promenade
    return hash(x, z, 19) === 0 ? 'minecraft:crying_obsidian' : 'minecraft:purpur_block';
  }
  return hash(x, z, 31) === 0 ? 'minecraft:amethyst_block' : 'minecraft:quartz_block';
}
function floorBase(x, z) {                       // per-band base laid by row fills
  const dd = d2(x, z);
  if (dd > R2(R_FLOOR)) return null;
  if (dd > R2(R_PROM)) return 'minecraft:smooth_quartz';
  if (dd > R2(R_FIELD)) return 'minecraft:purpur_block';
  return 'minecraft:quartz_block';
}

// ------------------------------------------------------------- dais design
// Tier at y117 (d<=4.5) with a purpur diamond motif on quartz, amethyst
// center cross + corner gems, crying-obsidian spawn block; walkable
// purpur-stairs skirt (4.5<d<=5.5) so bots never need to jump.
function daisBlocks() {
  const cmds = [];
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      const dd = d2(x, z);
      if (dd > R2(5.5)) continue;
      if (dd > R2(4.5)) {                                    // stair skirt
        let facing;
        if (Math.abs(x) > Math.abs(z)) facing = x > 0 ? 'west' : 'east';
        else facing = z > 0 ? 'north' : 'south';
        cmds.push(`setblock ${x} ${DAIS_Y} ${z} minecraft:purpur_stairs[facing=${facing},half=bottom]`);
        continue;
      }
      const m = Math.abs(x) + Math.abs(z);
      let b = 'minecraft:quartz_block';
      if (x === 0 && z === 0) b = 'minecraft:crying_obsidian';          // spawn block
      else if (m === 1) b = 'minecraft:amethyst_block';
      else if (m === 2 || m === 4) b = 'minecraft:smooth_quartz';
      else if (m === 3) b = 'minecraft:purpur_block';                    // diamond ◇
      else if (Math.abs(x) === 3 && Math.abs(z) === 3) b = 'minecraft:amethyst_block';
      cmds.push(`setblock ${x} ${DAIS_Y} ${z} ${b}`);
    }
  }
  // amethyst clusters on the 4 corner gems
  for (const [x, z] of [[3, 3], [3, -3], [-3, 3], [-3, -3]]) {
    cmds.push(`setblock ${x} ${DAIS_Y + 1} ${z} minecraft:amethyst_cluster[facing=up]`);
  }
  return cmds;
}

// ------------------------------------------------------- signs and displays
const sq = (s) => `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
function signNBT(front, back, color = 'purple') {
  const msgs = (lines) =>
    '[' + [0, 1, 2, 3].map((i) => `{text:${sq(lines[i] ?? '')}}`).join(',') + ']';
  return `{is_waxed:1b,front_text:{has_glowing_text:1b,color:"${color}",messages:${msgs(front)}},` +
    `back_text:{has_glowing_text:1b,color:"${color}",messages:${msgs(back)}}}`;
}
function textDisplay(x, y, z, comps, scale, tags = ['muchu_spawn']) {
  const text = comps.length === 1 ? comps[0]
    : `${comps[0].slice(0, -1)},extra:[${comps.slice(1).join(',')}]}`;
  return `summon minecraft:text_display ${x} ${y} ${z} ` +
    `{Tags:[${tags.map(sq).join(',')}],billboard:"center",see_through:0b,` +
    `background:${BG},line_width:220,` +
    `transformation:{translation:[0f,0f,0f],scale:[${scale}f,${scale}f,${scale}f],` +
    `left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f]},text:${text}}`;
}
const C = (text, color, bold = false) =>
  `{text:${sq(text)},color:"${color}"${bold ? ',bold:1b' : ''}}`;

// ------------------------------------------------------------------ phases
function phaseFoundation() {
  const cmds = [];
  for (let z = -20; z <= 20; z++) {
    for (const [x1, x2] of segs(z, (x, zz) => d2(x, zz) <= R2(R_FLOOR) && d2(x, zz) <= R2(18.5), 20)) {
      cmds.push(`fill ${x1} ${FOUND_BOTTOM} ${z} ${x2} 115 ${z} minecraft:stone`);
    }
    for (const [x1, x2] of segs(z, (x, zz) => d2(x, zz) > R2(18.5) && d2(x, zz) <= R2(R_FLOOR), 20)) {
      cmds.push(`fill ${x1} ${FOUND_BOTTOM} ${z} ${x2} 109 ${z} minecraft:stone`);
      cmds.push(`fill ${x1} 110 ${z} ${x2} 115 ${z} minecraft:quartz_bricks`); // visible plinth
    }
  }
  return cmds;
}
function phaseClear() {
  const cmds = [];
  for (let z = -20; z <= 20; z++) {
    for (const [x1, x2] of segs(z, (x, zz) => d2(x, zz) <= R2(R_FLOOR), 20)) {
      cmds.push(`fill ${x1} ${FLOOR_Y + 1} ${z} ${x2} ${CLEAR_TOP} ${z} minecraft:air`);
    }
  }
  return cmds;
}
function phaseTerraces() {
  const cmds = [];
  // ring 1: cut to a bench at y118, strip tree trunks, re-grass exposed dirt
  cmds.push(...annulusFills(R2(R_WALL_OUT), R2(R_TER1_OUT), 119, CLEAR_TOP, 'minecraft:air', 23));
  cmds.push(...annulusFills(R2(R_WALL_OUT), R2(R_TER1_OUT), 113, 118, 'minecraft:air', 23, 'replace minecraft:cherry_log'));
  cmds.push(...annulusFills(R2(R_WALL_OUT), R2(R_TER1_OUT), 113, 118, 'minecraft:air', 23, 'replace minecraft:spruce_log'));
  cmds.push(...annulusFills(R2(R_WALL_OUT), R2(R_TER1_OUT), 118, 118, 'minecraft:grass_block', 23, 'replace minecraft:dirt'));
  // ring 2: higher bench at y122
  cmds.push(...annulusFills(R2(R_TER1_OUT), R2(R_TER2_OUT), 123, CLEAR_TOP, 'minecraft:air', 25));
  cmds.push(...annulusFills(R2(R_TER1_OUT), R2(R_TER2_OUT), 122, 122, 'minecraft:grass_block', 25, 'replace minecraft:dirt'));
  return cmds;
}
function phaseFloor() {
  const cmds = [];
  for (let z = -20; z <= 20; z++) {
    for (const band of [
      (x, zz) => d2(x, zz) <= R2(R_FIELD),
      (x, zz) => d2(x, zz) > R2(R_FIELD) && d2(x, zz) <= R2(R_PROM),
      (x, zz) => d2(x, zz) > R2(R_PROM) && d2(x, zz) <= R2(R_FLOOR),
    ]) {
      for (const [x1, x2] of segs(z, band, 20)) {
        cmds.push(`fill ${x1} ${FLOOR_Y} ${z} ${x2} ${FLOOR_Y} ${z} ${floorBase(x1, z)}`);
      }
    }
  }
  // decorative overlays where the pattern differs from the band base
  for (let z = -20; z <= 20; z++) {
    for (let x = -20; x <= 20; x++) {
      const want = floorBlock(x, z);
      if (want && want !== floorBase(x, z)) cmds.push(`setblock ${x} ${FLOOR_Y} ${z} ${want}`);
    }
  }
  return cmds;
}
function phaseWall() {
  const cmds = [];
  for (let z = -20; z <= 20; z++) {
    for (let x = -20; x <= 20; x++) {
      const dd = d2(x, z);
      if (dd <= R2(R_WALL_IN) || dd > R2(R_WALL_OUT)) continue;
      if (Math.abs(x) <= 3 || Math.abs(z) <= 3) continue;           // gateway openings
      cmds.push(`setblock ${x} 117 ${z} minecraft:quartz_bricks`);
      cmds.push(`setblock ${x} 118 ${z} minecraft:purpur_slab[type=bottom]`);
    }
  }
  // 8 lantern pillars between the gates
  for (const [x, z] of [[8, 18], [8, -18], [-8, 18], [-8, -18], [18, 8], [18, -8], [-18, 8], [-18, -8]]) {
    cmds.push(`fill ${x} 117 ${z} ${x} 118 ${z} minecraft:purpur_pillar`);
    cmds.push(`setblock ${x} 119 ${z} minecraft:lantern[hanging=false]`);
  }
  return cmds;
}
// Torii-style gateways: purpur posts, stripped-cherry lintel, froglights,
// amethyst caps and a waxed hanging sign per gate.
function phaseGates() {
  const cmds = [];
  const welcome = ['MuchuCraft', 'Spawn Plaza', 'wallet = you', ''];
  const gates = [
    { name: 'N', axis: 'x', fixed: -20, rot: 0, front: ['North Gate', 'up the', 'mountain', ''] },
    { name: 'S', axis: 'x', fixed: 20, rot: 8, front: ['South Gate', 'down to', 'the village', ''] },
    { name: 'E', axis: 'z', fixed: 20, rot: 4, front: ['East Gate', 'ravine', 'bridge', ''] },
    { name: 'W', axis: 'z', fixed: -20, rot: 12, front: ['West Gate', 'up the', 'mountain', ''] },
  ];
  const at = (g, v, y) => g.axis === 'x' ? `${v} ${y} ${g.fixed}` : `${g.fixed} ${y} ${v}`;
  for (const g of gates) {
    for (const p of [-4, 4]) cmds.push(`fill ${at(g, p, 117)} ${at(g, p, 121)} minecraft:purpur_pillar`);
    cmds.push(`fill ${at(g, -3, 120)} ${at(g, 3, 120)} minecraft:stripped_cherry_log[axis=${g.axis}]`);   // nuki
    cmds.push(`fill ${at(g, -5, 122)} ${at(g, 5, 122)} minecraft:stripped_cherry_log[axis=${g.axis}]`);   // kasagi
    cmds.push(`setblock ${at(g, 0, 123)} minecraft:verdant_froglight`);
    for (const p of [-5, 5]) cmds.push(`setblock ${at(g, p, 123)} minecraft:amethyst_cluster[facing=up]`);
    // hanging sign under the kasagi (air-then-place so text updates on re-run)
    cmds.push(`setblock ${at(g, 2, 121)} minecraft:air`);
    cmds.push(`setblock ${at(g, 2, 121)} minecraft:cherry_hanging_sign[rotation=${g.rot},attached=false]${signNBT(g.front, welcome)}`);
    // hidden light blocks so the gateway floor stays bright
    cmds.push(`setblock ${at(g, 0, 117)} minecraft:light[level=15]`);
  }
  return cmds;
}
// 4 grand pillars on the diagonals: cherry shafts, froglight crowns,
// info wall signs facing the dais.
function phasePillars() {
  const cmds = [];
  const pillars = [
    { x: 12, z: -12, sz: -11, face: 'south', lines: ['— JOBS —', '/jobs join', 'earn MUCHU', 'as you play'] },
    { x: 12, z: 12, sz: 11, face: 'north', lines: ['— MUCHU —', '/deposit', 'top up in-game', '/withdraw: web'] },
    { x: -12, z: 12, sz: 11, face: 'north', lines: ['— HOMES —', '/sethome saves', '/spawn returns', 'you here'] },
    { x: -12, z: -12, sz: -11, face: 'south', lines: ['— LAND —', 'claim with a', 'golden shovel', 'build safely'] },
  ];
  for (const p of pillars) {
    cmds.push(`setblock ${p.x} 117 ${p.z} minecraft:purpur_block`);
    cmds.push(`fill ${p.x} 118 ${p.z} ${p.x} 120 ${p.z} minecraft:stripped_cherry_log`);
    cmds.push(`setblock ${p.x} 121 ${p.z} minecraft:purpur_block`);
    cmds.push(`setblock ${p.x} 122 ${p.z} minecraft:verdant_froglight`);
    cmds.push(`setblock ${p.x} 123 ${p.z} minecraft:amethyst_cluster[facing=up]`);
    cmds.push(`setblock ${p.x} 119 ${p.sz} minecraft:air`);
    cmds.push(`setblock ${p.x} 119 ${p.sz} minecraft:cherry_wall_sign[facing=${p.face}]${signNBT(p.lines, p.lines)}`);
  }
  return cmds;
}
// Path stubs beyond the four gateways, following the real terrain:
//  N/W: stairs carved up into the mountain ending in a froglight-lit landing.
//  S:   grand stair descending to the village path grade (~y110).
//  E:   quartz balcony merging into the generated village ravine bridge.
function phaseStubs() {
  const cmds = [];
  for (const g of [{ ax: 'z', dir: -1 }, { ax: 'x', dir: -1 }]) {  // N (z-), W (x-)
    // steps at 21..24 rising y116->119, landing 25..27 at y119
    for (let i = 0; i <= 3; i++) {
      const v = (21 + i) * g.dir, top = 116 + i;
      const [a, b] = g.ax === 'z' ? [`-1 ${top - 2} ${v} 1 ${top} ${v}`, `-1 ${top + 1} ${v} 1 ${top + 7} ${v}`]
        : [`${v} ${top - 2} -1 ${v} ${top} 1`, `${v} ${top + 1} -1 ${v} ${top + 7} 1`];
      cmds.push(`fill ${a} minecraft:smooth_quartz`);
      cmds.push(`fill ${b} minecraft:air`);
    }
    const [v1, v2] = [25 * g.dir, 27 * g.dir];
    const box = (y1, y2, w) => g.ax === 'z'
      ? `${-w} ${y1} ${Math.min(v1, v2)} ${w} ${y2} ${Math.max(v1, v2)}`
      : `${Math.min(v1, v2)} ${y1} ${-w} ${Math.max(v1, v2)} ${y2} ${w}`;
    cmds.push(`fill ${box(117, 119, 2)} minecraft:smooth_quartz`);            // landing
    cmds.push(`fill ${box(120, 127, 2)} minecraft:air`);                      // alcove
    const mid = 26 * g.dir, end = 28 * g.dir;
    cmds.push(g.ax === 'z' ? `fill 0 119 ${21 * g.dir} 0 119 ${v2} minecraft:purpur_pillar[axis=z] replace minecraft:smooth_quartz`
      : `fill ${21 * g.dir} 119 0 ${v2} 119 0 minecraft:purpur_pillar[axis=x] replace minecraft:smooth_quartz`);
    cmds.push(g.ax === 'z' ? `setblock 0 122 ${end} minecraft:verdant_froglight` : `setblock ${end} 122 0 minecraft:verdant_froglight`);
    for (const w of [-2, 2]) {
      cmds.push(g.ax === 'z' ? `setblock ${w} 120 ${mid} minecraft:lantern[hanging=false]` : `setblock ${mid} 120 ${w} minecraft:lantern[hanging=false]`);
    }
    cmds.push(g.ax === 'z' ? `setblock 0 119 ${23 * g.dir} minecraft:light[level=15]` : `setblock ${23 * g.dir} 119 0 minecraft:light[level=15]`);
  }
  // South grand stair down to the village path (~y110 at z≈26)
  for (let i = 0; i <= 5; i++) {
    const z = 21 + i, top = 115 - i;
    cmds.push(`fill -1 ${top - 2} ${z} 1 ${top} ${z} minecraft:smooth_quartz`);
    cmds.push(`fill -1 ${top + 1} ${z} 1 121 ${z} minecraft:air`);
    cmds.push(`setblock 0 ${top} ${z} minecraft:purpur_pillar[axis=z]`);
  }
  cmds.push(`setblock 0 114 23 minecraft:light[level=15]`);
  for (const x of [-2, 2]) {
    cmds.push(`setblock ${x} 110 26 minecraft:quartz_bricks keep`);
    cmds.push(`setblock ${x} 111 26 minecraft:cherry_fence`);
    cmds.push(`setblock ${x} 112 26 minecraft:lantern[hanging=false]`);
  }
  // East balcony over the ravine, threading the generated village bridge
  cmds.push(`fill 21 114 -3 24 115 3 minecraft:smooth_quartz replace minecraft:air`);
  cmds.push(`fill 21 110 -3 24 113 3 minecraft:quartz_bricks replace minecraft:air`);
  for (const z of [-3, -2, 2, 3]) cmds.push(`setblock 24 116 ${z} minecraft:cherry_fence keep`);
  for (let x = 21; x <= 24; x++) for (const z of [-3, 3]) cmds.push(`setblock ${x} 116 ${z} minecraft:cherry_fence keep`);
  for (const z of [-3, 3]) cmds.push(`setblock 24 117 ${z} minecraft:lantern[hanging=false] keep`);
  for (const z of [-2, 2]) {
    cmds.push(`setblock 23 115 ${z} minecraft:crying_obsidian`);
    cmds.push(`setblock 22 116 ${z} minecraft:light[level=15]`);
  }
  return cmds;
}
// ADVENTURE PAD (south path, past the grand stair): 3x3 smooth-quartz pad,
// player-only polished_blackstone_pressure_plate centered on a quartz_block,
// impulse command block hidden directly below the plate's support block.
// Wiring (vanilla): the plate STRONGLY powers its support block; a mechanism
// component adjacent to a powered block activates, so the CB one block below
// fires on step. Proven live by pulsing plate[powered=true] and reading the
// CB's LastOutput (see the verification section in main()).
const PAD = { x: -2, y: 110, z: 30 };   // pad floor center; players walk at 111
const PAD_CMD = 'spreadplayers 0 0 200 2400 false @p[distance=..5]';
function phaseAdventure() {
  const cmds = [];
  const { x, y, z } = PAD;
  // foundations: seal caves under the approach strip + pad (probe found holes
  // to y105 nearby); 'keep' plugs the two open pits west of the pad (x=-4).
  cmds.push(`fill ${x} ${y - 4} 27 ${x + 2} ${y - 1} 28 minecraft:stone`);
  cmds.push(`fill ${x - 1} ${y - 4} ${z - 1} ${x + 1} ${y - 1} ${z + 1} minecraft:stone`);
  for (const zz of [28, 30]) cmds.push(`fill -4 ${y - 5} ${zz} -4 ${y} ${zz} minecraft:stone keep`);
  // hidden command block (air-then-place so Command/LastOutput reset on re-run)
  cmds.push(`setblock ${x} ${y - 1} ${z} minecraft:air`);
  cmds.push(`setblock ${x} ${y - 1} ${z} minecraft:command_block[facing=up]{Command:${sq(PAD_CMD)},auto:0b}`);
  // approach strip from the stair exit (walk y111 at z26) + pad floor
  cmds.push(`fill ${x} ${y} 27 ${x + 2} ${y} 28 minecraft:smooth_quartz`);
  cmds.push(`fill ${x - 1} ${y} ${z - 1} ${x + 1} ${y} ${z + 1} minecraft:smooth_quartz`);
  cmds.push(`setblock ${x} ${y} ${z} minecraft:quartz_block`);          // plate support
  // headroom (BEFORE plate/gate so the clears cannot delete them)
  cmds.push(`fill ${x} ${y + 1} 27 ${x + 2} ${y + 4} 28 minecraft:air`);
  cmds.push(`fill ${x - 1} ${y + 1} ${z - 1} ${x + 1} ${y + 4} ${z + 1} minecraft:air`);
  // the player-only plate (blackstone: mobs/items cannot trigger it)
  cmds.push(`setblock ${x} ${y + 1} ${z} minecraft:polished_blackstone_pressure_plate`);
  // mini torii behind the pad (z=32) framing the way out, hanging sign under
  // the lintel facing the arriving player (rotation=8 = faces north).
  cmds.push(`fill ${x - 1} ${y} 32 ${x + 1} ${y} 32 minecraft:smooth_quartz`);
  cmds.push(`fill ${x - 1} ${y + 1} 32 ${x + 1} ${y + 5} 32 minecraft:air`);
  for (const px of [x - 1, x + 1]) cmds.push(`fill ${px} ${y + 1} 32 ${px} ${y + 3} 32 minecraft:purpur_pillar`);
  cmds.push(`fill ${x - 1} ${y + 4} 32 ${x + 1} ${y + 4} 32 minecraft:stripped_cherry_log[axis=x]`);
  cmds.push(`setblock ${x} ${y + 5} 32 minecraft:lantern[hanging=false]`);
  cmds.push(`setblock ${x} ${y + 3} 32 minecraft:air`);
  cmds.push(`setblock ${x} ${y + 3} 32 minecraft:cherry_hanging_sign[rotation=8,attached=false]` +
    signNBT(['ADVENTURE →', 'step the plate', 'or /tpr', ''], ['← SPAWN', 'plaza', '', '']));
  // night safety: invisible light above the plate (head space, no collision)
  cmds.push(`setblock ${x} ${y + 2} ${z} minecraft:light[level=15]`);
  return cmds;
}

// Hidden light grid: light level 15 every 5 blocks at feet level keeps the
// whole floor >= light 10 mathematically (worst case taxicab distance 5).
function phaseLights() {
  const cmds = [];
  for (let x = -15; x <= 15; x += 5) {
    for (let z = -15; z <= 15; z += 5) {
      if (x === 0 && z === 0) continue;                    // never at the spawn block
      if (d2(x, z) > R2(19)) continue;
      const y = d2(x, z) <= R2(5.5) ? 118 : 117;           // above dais tier if needed
      cmds.push(`setblock ${x} ${y} ${z} minecraft:light[level=15]`);
    }
  }
  return cmds;
}
function lightGridCount() { return phaseLights().length; }
function phaseDisplays() {
  const cmds = [`minecraft:kill @e[type=minecraft:text_display,tag=muchu_spawn]`];
  cmds.push(textDisplay(0.5, 121.9, 0.5, [
    C('⬡ Welcome to MuchuCraft ⬡', PURPLE, true),
    C('\nYour wallet is your identity', GREEN),
  ], 2.3));
  cmds.push(textDisplay(0.5, 120.6, 0.5, [
    C('connect wallet · play · earn — withdraw MUCHU on the MuchuCraft website', PALE),
  ], 0.85));
  cmds.push(textDisplay(0.5, 119.8, -7.5, [
    C('❖ ', GREEN), C('/jobs join', PURPLE, true), C(' — earn MUCHU while you play', PALE),
  ], 1.0));
  cmds.push(textDisplay(9.5, 119.8, 0.5, [
    C('❖ ', GREEN), C('/deposit', PURPLE, true), C(' tops you up in-game · ', PALE),
    C('/withdraw', PURPLE, true), C(' on the website', PALE),
  ], 1.0));
  cmds.push(textDisplay(0.5, 119.8, 8.5, [
    C('❖ ', GREEN), C('/sethome', PURPLE, true), C(' saves your base · ', PALE),
    C('/spawn', PURPLE, true), C(' brings you back', PALE),
  ], 1.0));
  cmds.push(textDisplay(-8.5, 119.8, 0.5, [
    C('❖ claim land with a ', PALE), C('golden shovel', GREEN, true),
    C(' — the wilderness is yours', PALE),
  ], 1.0));
  cmds.push(textDisplay(0.5, 119.4, 0.5, [
    C('$MUCHU is live on ', PALE), C('MAINNET', GREEN, true),
  ], 0.8));
  // adventure pad marker (south path; PAD center block +0.5 each axis)
  cmds.push(textDisplay(PAD.x + 0.5, PAD.y + 3.4, PAD.z + 0.5, [
    C('step on the plate', PURPLE, true),
    C(' — the wild awaits ', PALE),
    C('(or /tpr in chat)', GREEN),
  ], 0.9));
  return cmds;
}
const EXPECTED_DISPLAYS = 8;

// ------------------------------------------------------------------ runner
const BENIGN = [
  /No blocks were/i, /Could not set the block/i, /No entity was found/i,
  /already exists/i, /Nothing changed/i, /^Killed/i, /force loaded/i, /Test (passed|failed)/,
];
const HARD = [
  /Unknown or incomplete command/i, /Incorrect argument/i, /Expected /i,
  /That position is not loaded/i, /Invalid /i, /Incomplete /i, /Player not found/i,
];

async function main() {
  const phases = [
    ['foundation', phaseFoundation()],
    ['clear', phaseClear()],
    ['terraces', phaseTerraces()],
    ['floor', phaseFloor()],
    ['dais', daisBlocks()],
    ['wall', phaseWall()],
    ['gates', phaseGates()],
    ['pillars', phasePillars()],
    ['stubs', phaseStubs()],
    ['adventure', phaseAdventure()],
    ['lights', phaseLights()],
    ['displays', phaseDisplays()],
  ];
  if (DRY) {
    for (const [name, cmds] of phases) console.log(`[build-spawn] phase ${name}: ${cmds.length} commands`);
    console.log(`[build-spawn] total: ${phases.reduce((n, [, c]) => n + c.length, 0)} commands (dry run)`);
    return;
  }

  const rcon = await Rcon.connect({
    host: process.env.MC_HOST ?? '127.0.0.1',
    port: Number(process.env.RCON_PORT ?? 25575),
    password: process.env.RCON_PASSWORD,
  });
  let sent = 0;
  const hardErrors = [];
  const send = async (cmd, { raw = false } = {}) => {
    const full = raw ? cmd : `execute in ${DIM} run ${cmd}`;
    const reply = (await rcon.send(full)).replace(/§./g, '');
    sent++;
    if (HARD.some((re) => re.test(reply)) && !BENIGN.some((re) => re.test(reply))) {
      hardErrors.push({ cmd: full, reply: reply.slice(0, 160) });
    }
    return reply;
  };
  const countTagged = async () => {
    await send('scoreboard objectives add muchu_diag dummy', { raw: true });
    await send('execute store result score #muchu muchu_diag if entity @e[tag=muchu_spawn]', { raw: true });
    const r = await send('scoreboard players get #muchu muchu_diag', { raw: true });
    await send('scoreboard objectives remove muchu_diag', { raw: true });
    const m = r.match(/has (-?\d+)/);
    return m ? Number(m[1]) : NaN;
  };

  console.log('[build-spawn] forceloading build area...');
  await send('forceload add -48 -48 47 47', { raw: true });

  const before = await countTagged();
  console.log(`[build-spawn] muchu_spawn text_displays before: ${before}`);

  const t0 = Date.now();
  for (const [name, cmds] of phases) {
    const p0 = Date.now();
    let killed = null;
    for (const cmd of cmds) {
      // namespaced kill must run at the dispatcher root (Essentials owns /kill)
      const reply = await send(cmd, { raw: cmd.startsWith('minecraft:kill') });
      if (cmd.startsWith('minecraft:kill')) {
        const m = reply.match(/Killed (\d+)/);
        killed = m ? Number(m[1]) : (/^Killed/.test(reply) ? 1 : 0);
      }
    }
    console.log(`[build-spawn] phase ${name}: ${cmds.length} commands in ${Date.now() - p0}ms` +
      (killed !== null ? ` (killed ${killed} stale display(s))` : ''));
  }

  // ---- spawn administration -------------------------------------------
  const wsReply = await send(`setworldspawn ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);
  console.log(`[build-spawn] setworldspawn -> ${wsReply.trim()}`);
  const grReply = await send('gamerule respawn_radius 0');
  console.log(`[build-spawn] respawn_radius -> ${grReply.trim()}`);
  // 1.21.11: command blocks are gamerule-gated (enable-command-block was
  // REMOVED from server.properties). Default is true; assert it anyway so the
  // adventure pad works on fresh installs. Persists in level.dat.
  const cbReply = await send('gamerule command_blocks_work true');
  console.log(`[build-spawn] command_blocks_work -> ${cbReply.trim()}`);
  // survival QoL: 30% of online players sleeping skips the night.
  const slReply = await send('gamerule players_sleeping_percentage 30');
  console.log(`[build-spawn] players_sleeping_percentage -> ${slReply.trim()}`);

  // ---- Essentials spawn (EssentialsXSpawn reads plugins/Essentials/spawn.yml)
  const spawnYml = path.join(ROOT, 'server', 'plugins', 'Essentials', 'spawn.yml');
  const yml = [
    '# MuchuCraft — written by scripts/build-spawn.mjs (Phase 4 §1). Do not hand-edit.',
    '# Requires the EssentialsXSpawn addon jar for /spawn & /setspawn commands.',
    'spawns:',
    ...['default', 'all'].flatMap((k) => [
      `  ${k}:`, `    world: world`,
      `    x: ${SPAWN.x + 0.5}`, `    y: ${SPAWN.y}.0`, `    z: ${SPAWN.z + 0.5}`,
      `    yaw: 0.0`, `    pitch: 0.0`,
    ]),
    '',
  ].join('\n');
  fs.writeFileSync(spawnYml, yml);
  await send('essentials reload', { raw: true });
  const written = fs.readFileSync(spawnYml, 'utf8');
  console.log(`[build-spawn] Essentials spawn.yml written (${written.length} bytes) + essentials reload sent`);

  // ---- verification ----------------------------------------------------
  const probes = [
    [`if block 0 ${DAIS_Y} 0 minecraft:crying_obsidian`, 'spawn block solid (crying_obsidian @ 0,117,0)'],
    [`if block 0 118 0 minecraft:air`, 'spawn feet air (0,118,0)'],
    [`if block 0 119 0 minecraft:air`, 'spawn head air (0,119,0)'],
    [`if block 0 ${FLOOR_Y} 0 minecraft:quartz_block`, 'floor under dais (0,116,0)'],
    [`if block 5 118 0 minecraft:light`, 'light grid sample (5,118,0)'],
    [`if block 10 117 5 minecraft:light`, 'light grid sample (10,117,5)'],
    [`if block -10 117 -10 minecraft:light`, 'light grid sample (-10,117,-10)'],
    [`if block 0 117 -20 minecraft:light`, 'gateway light sample (0,117,-20)'],
    [`if block ${PAD.x} ${PAD.y - 1} ${PAD.z} minecraft:command_block`, `adventure CB hidden (${PAD.x},${PAD.y - 1},${PAD.z})`],
    [`if block ${PAD.x} ${PAD.y} ${PAD.z} minecraft:quartz_block`, 'adventure plate support block'],
    [`if block ${PAD.x} ${PAD.y + 1} ${PAD.z} minecraft:polished_blackstone_pressure_plate`, 'adventure plate (player-only)'],
  ];
  let pass = 0, fail = 0;
  for (const [probe, label] of probes) {
    const r = await send(`execute in ${DIM} ${probe}`, { raw: true });
    const ok = r.includes('Test passed');
    ok ? pass++ : fail++;
    console.log(`[build-spawn] ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  }

  // ---- adventure pad: command + live wiring proof ----------------------
  // 1) the hidden CB carries the exact RTP command;
  const cbData = await send(`data get block ${PAD.x} ${PAD.y - 1} ${PAD.z} Command`);
  const cbOk = cbData.includes('spreadplayers 0 0 200 2400 false @p[distance=..5]');
  cbOk ? pass++ : fail++;
  console.log(`[build-spawn] ${cbOk ? 'PASS' : 'FAIL'}: adventure CB Command -> ${cbData.trim().slice(0, 120)}`);
  // 2) pulse the plate state (powered=true emulates a player step: the plate
  // strongly powers its support block, which activates the CB below). One
  // caveat found empirically: /setblock only updates the PLATE's direct
  // neighbours, so the CB two blocks down never re-checks its power — on a
  // real step vanilla's BasePressurePlateBlock.updateNeighbours() updates the
  // neighbours of both the plate AND its support block, which reaches the CB.
  // Emulate that by nudging a block adjacent to the CB while the plate state
  // is powered: the CB re-evaluates (power checks are state-based) and RUNS
  // spreadplayers — nobody is within 5 blocks, so LastOutput records the
  // attempt. Any LastOutput proves plate-power -> support -> CB end-to-end
  // (the air-then-place above cleared LastOutput this run).
  await send(`setblock ${PAD.x} ${PAD.y + 1} ${PAD.z} minecraft:polished_blackstone_pressure_plate[powered=true]`);
  await send(`setblock ${PAD.x} ${PAD.y - 2} ${PAD.z} minecraft:air`);      // update reaches the CB
  await new Promise((r) => setTimeout(r, 1500));
  const lastOut = await send(`data get block ${PAD.x} ${PAD.y - 1} ${PAD.z} LastOutput`);
  const fired = !/Found no elements/i.test(lastOut) && /LastOutput|following block data/i.test(lastOut);
  fired ? pass++ : fail++;
  console.log(`[build-spawn] ${fired ? 'PASS' : 'FAIL'}: adventure CB fired on plate pulse -> ${lastOut.trim().slice(0, 160)}`);
  await send(`setblock ${PAD.x} ${PAD.y - 2} ${PAD.z} minecraft:stone`);    // restore the nudged block
  await send(`setblock ${PAD.x} ${PAD.y + 1} ${PAD.z} minecraft:polished_blackstone_pressure_plate[powered=false]`);
  const after = await countTagged();
  console.log(`[build-spawn] muchu_spawn text_displays after: ${after} (expected ${EXPECTED_DISPLAYS})`);
  if (after !== EXPECTED_DISPLAYS) fail++;

  // light-audit: grid spacing is 5 => worst-case taxicab distance 5 from a
  // level-15 source => min light 10 >= 9 across the plaza floor.
  console.log(`[build-spawn] light audit: ${lightGridCount()} hidden light[15] blocks on a 5-block grid` +
    ` + 4 gateway lights + lanterns/froglights/crying obsidian => min floor light >= 10`);

  await send('save-all', { raw: true });
  await send('forceload remove -48 -48 47 47', { raw: true });

  // level.dat probe (best-effort; uses prismarine-nbt from e2e/)
  try {
    const requireE2e = createRequire(path.join(ROOT, 'e2e', 'package.json'));
    const nbt = requireE2e('prismarine-nbt');
    await new Promise((r) => setTimeout(r, 1500)); // let save-all flush
    const buf = fs.readFileSync(path.join(ROOT, 'server', 'world', 'level.dat'));
    const { parsed } = await nbt.parse(buf);
    const data = nbt.simplify(parsed);
    // 1.21.11 stores Data.spawn = {pos:[x,y,z], yaw, pitch, dimension}
    const sp = (data.Data ?? data).spawn;
    const ok = sp && Array.isArray(sp.pos) &&
      sp.pos[0] === SPAWN.x && sp.pos[1] === SPAWN.y && sp.pos[2] === SPAWN.z;
    console.log(`[build-spawn] ${ok ? 'PASS' : 'FAIL'}: level.dat spawn probe -> ${JSON.stringify(sp)}`);
    if (!ok) fail++;
  } catch (err) {
    console.log(`[build-spawn] level.dat probe skipped: ${err.message}`);
  }

  await rcon.end();
  console.log(`[build-spawn] done: ${sent} commands in ${Date.now() - t0}ms; ` +
    `verify PASS=${pass} FAIL=${fail}; hard errors: ${hardErrors.length}`);
  for (const e of hardErrors.slice(0, 10)) console.error(`[build-spawn] ERROR ${e.reply} <- ${e.cmd}`);
  if (hardErrors.length > 0 || fail > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('[build-spawn] fatal:', err); process.exit(1); });
