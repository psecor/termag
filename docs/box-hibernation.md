# Box hibernation

A box launched hibernation-capable gets a **Hibernate box** action next to **Stop box**. Hibernating saves the box's RAM to a swap file on its root volume and powers the instance off. A start then resumes it with tmux sessions, agents, dev servers and containers where they were. Like a stopped box, a hibernated box costs only its EBS volumes. Stop stays a plain stop.

## What has to line up

Hibernation is decided once, at `RunInstances`. EC2 does not accept `HibernationOptions` on an existing instance, so a box launched without it keeps plain Stop until it is replaced. `boxProvisioner.planHibernation` configures it only when all three of these hold:

| Condition | Where it comes from |
|---|---|
| Hibernation is allowed for the image the box launches from | the published image: the `box-hibernation-enabled` feature flag (boolean, default off; see below). An image the owner's `box-image` flag chose: always (the flag is the opt-in) |
| That image is tagged `Hibernation=supported` | `packer/box.pkr.hcl` `var.hibernation` → `scripts/enable-hibernation.sh` |
| `DescribeInstanceTypes` says the type supports hibernation | M8g, M9g and T4g all do |

Which image a box launches from is the owner's `box-image` string feature flag (`services/boxImage.ts`): empty is the newest published `Component=box` image; `ami-…` pins one; any other value is a channel, the newest image tagged `Channel=<value>`. A pin or channel must be a self-owned, available image tagged `App=termag` with `Component` `box` or `box-candidate`. Otherwise the box gets the published image, a warning is logged, and `Instance.imageSource` says `fallback:<what was asked>`. A flagged user never claims a warm-pool box, since pool boxes and the pool spec hash always use the published image. The box update target for a flagged box is its image's `TermagSha`. The box list badges a non-published image and its tooltip shows the AMI id; the admin Fleet detail has an `image` row.

`box-hibernation-enabled` (`services/boxHibernationFlag.ts`) is read two ways. The warm pool evaluates it once per spec for a fixed context (`kind: box`, key `termag-warm-pool`), which no per-user targeting matches, so the pool follows the flag's default value. Its value goes into the pool spec hash whenever the published image is tagged `Hibernation=supported`, so flipping the fallthrough rolls the pool onto boxes launched with the new value. A user's own box evaluates it for the owner (`routes/instances.ts`), read once beside `box-image` so the claim and the launch agree. A user whose value differs from the pool's (with per-user targeting) never claims a warm box and gets a fresh launch with their own value, the same way a `box-image` user does. With `TERMAG_FLAGS` not setting it, every read is `false`.

When all three hold, the root volume grows by the type's RAM size (120 → 152 GB on a 32 GiB m9g.2xlarge), because hibinit-agent refuses unless the root has that much free space. `Instance.hibernationConfigured` records the outcome. If EC2 rejects the hibernation launch, the box launches without it rather than failing.

The bake installs `ec2-hibinit-agent` and adds `nokaslr` (AWS's guidance for Ubuntu). It also checks `CONFIG_HIBERNATION=y` on the newest kernel and deletes anything the agent left on the builder.

A hibernation image is pinned to noble's GA 6.8 kernel (`linux-aws-lts-24.04`). The bake purges the rolling `linux-aws` meta and every kernel from 6.16 on, and fails if the box would still boot one. From 6.16 (upstream `713335b6ee29`, "irqchip/gic-v3-its: Implement .msi_teardown() callback") a Graviton resume leaves the GICv3 ITS unprogrammed. The memory image loads, but ENA never gets another interrupt (`didn't receive a MSI-X interrupt`, `Failed to create IO CQ. error: -62`), so the box comes back with no network and its agent never reconnects. The first channel box, on 7.0.0-1014-aws, failed exactly this way. An upstream fix ("irqchip/gic-v3-its: Reconfigure ITS from software state on resume") is proposed but not merged; drop the pin once a fixed kernel reaches noble. Purging the running kernel removes its modules, so the step runs after `bake-webapp.sh`, the last step that starts docker. Images baked without hibernation keep the rolling kernel. On each boot of a configured box, the agent fallocates `/swap-hibinit` with IMDSv2, sized to RAM, without touching its blocks. It also writes the resume offset into grub. The swap file is therefore never in the snapshot.

## Status model

```
ready ──hibernate──▶ hibernating ──sweep (EC2 stopped, StateReason hibernate)──▶ hibernated
                          │                                                         │
                          └─ EC2 refused the hibernate → stopping → stopped        start (resume)
                                                                                    ▼
                                                                         starting ──agent──▶ ready
```

- `hibernated` is deliberately not `stopped`. A stopped box has lost its RAM and may be replaced onto the newest AMI on start, which is the planned way boxes pick up a new image. A hibernated box must only be resumed.
- **Fallback:** if `StopInstances{Hibernate: true}` is refused (`UnsupportedHibernationConfiguration`, or "not ready to hibernate yet" while the agent is still preparing swap after a boot), the request plainly stops the box and puts the reason in `provisioningError`. The API answers `stopping` instead of `hibernating`.
- **Plain stop despite a hibernate request:** if EC2 reports the instance `stopped` with a `StateReason` other than `Client.UserInitiatedHibernate`, the sweep settles it to `stopped` with a note.
- **A resume that doesn't take:** if EC2 still reports the instance stopped a minute after the start, the box goes back to `hibernated`, not `stopped`.

## The 60-day limit

EC2 doesn't support keeping an instance hibernated for longer than 60 days. Once a box has been hibernated for `BOX_HIBERNATION_REFRESH_DAYS` (default 55), the power sweep resumes it with `rehibernatePending` set. When its agent connects, the sweep hibernates it again, which restarts the clock and keeps the RAM. If EC2 refuses the re-hibernate, the sweep retries every 10 s, up to 30 times, then plainly stops the box. The box list warns from day 50. Set `BOX_HIBERNATION_REFRESH_DAYS=0` to turn the refresh off.

## Rolling it out

Nothing here needs AWS access by hand: the orchestrator's own role launches, hibernates and resumes the test box.

1. Bake a candidate on a channel from main: Publish AMI → target `box`, `hibernation` ticked, `publish` off, `channel` `hibernation`. This makes a `Component=box-candidate` tagged `Hibernation=supported`, `Channel=hibernation` and `Retain=true`. The job summary shows the AMI id.
2. Set the `box-image` flag to `hibernation` for the tester only. That needs a flag source with per-user targeting; `TERMAG_FLAGS` sets one value for everyone, so on a stack configured that way, run this step on a test orchestrator.
3. As the tester, add a box (it launches as the orchestrator's `BOX_INSTANCE_TYPE`, which must support hibernation; M8g, M9g and T4g do). It skips the warm pool and launches from the candidate with hibernation configured; the box list shows a `hibernation` badge, and the tooltip the AMI id. Run tmux, Claude and `make dev`, then **Hibernate box** and **Start box** from the box menu. Check that the resume works (kernel lockdown on the NitroTPM image is the main unknown), and note how long hibernate and resume take, whether `/dev/tpm0` and containers survive, and how much first boot slows down.
4. Set the repo Variable `BOX_HIBERNATION_BAKE=true`, so scheduled bakes publish hibernation-capable images. Users on the published image still get plain Stop while `box-hibernation-enabled` serves `false`.
5. With per-user targeting, optionally turn `box-hibernation-enabled` on for a few users first. Their new boxes launch hibernation-capable from the published image and skip the warm pool, since the pool still launches without it.
6. Turn `box-hibernation-enabled` on for everyone (`TERMAG_FLAGS='{"box-hibernation-enabled": true}'`). The warm pool's spec hash then changes and rolls the pool onto hibernation-capable boxes, and every user at the default claims from it again.
7. Clear the tester's `box-image` flag, and remove `Retain=true` from the channel image (or retag it) so the nightly prune can take it.

If the candidate fails to resume, only the tester's box is affected: terminate it, clear the flag, and nothing else moved. The provisioner's IAM needs nothing new. `Hibernate` is a parameter of `ec2:StopInstances`, and `ec2:DescribeInstanceTypes` is already in its describe statement.

## Caveats

- After a resume, sockets are gone. The agent's heartbeat reconnects it, and SSM sessions, port forwards and SSO tokens behave as they do after a laptop wakes.
- The resize workflow (`resize-box.yml`) cannot retype a hibernated instance (EC2 refuses). Stop the box plainly first. A larger type gets a bigger swap file at its next boot.
- `nokaslr` applies to every box launched from a hibernation-capable image, hibernating or not.
- Channel images are `Retain=true`, so the prune never takes them. Remove the tag once a channel is finished with.
- There is no Replace box action yet. When there is, it should pick its image with `boxImageSelectionFor` + `resolveBoxImage` like a new box.
