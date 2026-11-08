/**
 * Whether updating a tool is on, and whether the sweep updates it on its own:
 * the one place that decides, from the
 * policy flag's `mode`.
 *
 * | mode    | enabled (Software tab, a run's restart) | auto (the sweep) |
 * |---------|-----------------------------------------|------------------|
 * | off     | no (the floor stays: see below)         | no               |
 * | manual  | yes                                     | no               |
 * | auto    | yes                                     | yes              |
 *
 * `off` turns off the Software tab's actions, the sweep and session restarts,
 * and nothing else: the floor stays, so a box's policy fetch is floor only,
 * restart none, and Claude Code's v3 runner wrapper still gets and enforces
 * the floor (claudeRunnerFloor.ts). The floor is the security minimum.
 *
 * A missing or malformed mode parses to `off` (claudeUpdatePolicy.ts
 * parseUpdateMode, logged once per flag and value), and so does a policy
 * the flag source cannot serve, whose fallback is null: with a flag source
 * unreachable, everything but the floor is off. Pure.
 */
import type { ToolUpdateMode } from '../claudeUpdatePolicy';

/** Updating the tool is on: the Software tab's routes, and a requested run's restart. */
export const modeEnabled = (mode: ToolUpdateMode): boolean => mode !== 'off';

/** The sweep updates the tool on its own (floor, resume and nightly runs). */
export const modeAuto = (mode: ToolUpdateMode): boolean => mode === 'auto';
