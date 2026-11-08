/**
 * Docker updates ("Docker: an update at the box's
 * start"): the docker-update-policy flag as a parsed value, in the shape of
 * Claude Code's (claudeUpdatePolicy.ts), whose parser it uses with Docker's
 * defaults. Pure: Docker's entry in services/toolUpdate/components.ts reads
 * the flag for the owner and the box.
 *
 * The version is Docker Engine's (docker-ce and docker-ce-cli, released
 * together; `dockerd --version`, the inventory's `docker --version`). The
 * box moves containerd.io and the two plugins to the newest Docker's
 * repository lists alongside it.
 *
 * The defaults are the safe side:
 *
 *   * floor 29.9.3, the newest version a Docker Engine advisory requires,
 *     checked on 2026-11-04 against Docker Engine 29's release notes
 *     (docs.docker.com/engine/release-notes/29) and moby/moby's GitHub
 *     security advisories:
 *       - 29.9.3 (2026-11-03): CVE-2026-115538 (GHSA-6jhp-7446-hf7f), Swarm
 *         overlay networks lose encryption and spoofing protection after
 *         firewalld flushes Docker's rules; with dependency fixes for
 *         CVE-2026-116587 (GHSA-mgcc-cww5-fp2q, go-jose RSA key DoS, high)
 *         and CVE-2026-116591 (GHSA-fpmh-frq8-7rj8, zstd panic, high), and
 *         SwarmKit's CVE-2026-115539 and BuildKit 0.34.2's fixes. The engine
 *         advisory was not yet published in moby's database that day.
 *       - 29.8.2 (2026-09-30): CVE-2026-92543 (GHSA-7cfq-22r6-qp73, high), a
 *         malicious DNS answer makes registry connections skip TLS or fall
 *         back to HTTP; CVE-2026-92542 (GHSA-6m9p-4h64-m6vh, medium); the
 *         newest one moby's database lists.
 *       - 29.5.1: CVE-2026-42306, CVE-2026-41567 (high; docker cp and the
 *         archive API reaching the host), CVE-2026-41568. 29.3.1:
 *         CVE-2026-34040 (AuthZ bypass, high), CVE-2026-33997. 28.3.3:
 *         CVE-2025-54388. 27.1.1: CVE-2024-41110 (AuthZ, critical).
 *     The fleet's reference was 29.9.3 on 2026-11-04 with about half the
 *     online boxes behind it, so this floor is above part of the fleet, as
 *     gh's is: those boxes are exposed, and their floor runs install only at
 *     each box's next start. The runtime containerd.io ships has its own
 *     minimums (containerd 2.4.2, runc 1.3.3), which the box's recipe checks
 *     after every run (deploy/termag-docker-update, MIN_CONTAINERD, MIN_RUNC).
 *   * target latest: the newest docker-ce download.docker.com lists for the
 *     box's release.
 *   * restart none: a run has no sessions to restart, and it only ever runs
 *     before any container does.
 */
import { parseClaudeUpdatePolicy, type ClaudeUpdatePolicy } from './claudeUpdatePolicy';

export const DOCKER_UPDATE_POLICY_FLAG = 'docker-update-policy';

export const DOCKER_TARGET_TAGS: readonly string[] = ['latest'];

export const DEFAULT_DOCKER_UPDATE_POLICY: ClaudeUpdatePolicy = {
  mode: 'off',
  floor: '29.9.3',
  target: 'latest',
  restart: 'none',
  drainSec: 600,
  forceAfterHours: 24,
};

/** The flag's value, key by key over Docker's defaults; a bad key keeps its default. */
export function parseDockerUpdatePolicy(value: unknown): ClaudeUpdatePolicy {
  return parseClaudeUpdatePolicy(value, DEFAULT_DOCKER_UPDATE_POLICY, DOCKER_TARGET_TAGS, undefined, DOCKER_UPDATE_POLICY_FLAG);
}
