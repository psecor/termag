# Box hibernation

A box launched hibernation-capable gets a **Hibernate box** action next to **Stop box**. Hibernating saves the box's RAM to a swap file on its root volume and powers the instance off. A start then resumes it with tmux sessions, agents, dev servers and containers where they were. Like a stopped box, a hibernated box costs only its EBS volumes. Stop stays a plain stop.

## What has to line up

Hibernation is decided once, at `RunInstances`. EC2 does not accept `HibernationOptions` on an existing instance, so a box launched without it keeps plain Stop until it is replaced. `boxProvisioner.planHibernation` configures it only when all three of these hold:

| Condition | Where it comes from |
|---|---|
| `BOX_HIBERNATION_ENABLED=true` on the orchestrator | env, default off |
| The newest `Component=box` AMI is tagged `Hibernation=supported` | `packer/box.pkr.hcl` `var.hibernation` → `scripts/enable-hibernation.sh` |
| `DescribeInstanceTypes` says the type supports hibernation | M8g, M9g and T4g all do |

When all three hold, the root volume grows by the type's RAM size (120 → 152 GB on a 32 GiB m9g.2xlarge), because hibinit-agent refuses unless the root has that much free space. `Instance.hibernationConfigured` records the outcome. If EC2 rejects the hibernation launch, the box launches without it rather than failing.

The bake installs `ec2-hibinit-agent` and adds `nokaslr` (AWS's guidance for Ubuntu). It also checks `CONFIG_HIBERNATION=y` on the newest kernel and deletes anything the agent left on the builder. On each boot of a configured box, the agent fallocates `/swap-hibinit` with IMDSv2, sized to RAM, without touching its blocks. It also writes the resume offset into grub. The swap file is therefore never in the snapshot.

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

1. Bake a candidate with hibernation: Publish AMI → target `box`, `hibernation` ticked, `publish` off. This makes a `Component=box-candidate` tagged `Hibernation=supported`.
2. Spike one box from it by hand. Launch m9g.2xlarge with `--hibernation-options Configured=true`, a 152 GB encrypted gp3 root and NitroTPM. Run tmux, Claude and `make dev`, then `aws ec2 stop-instances --hibernate`, then start. Check that the resume works (kernel lockdown on the NitroTPM image is the main unknown), and note how long hibernate and resume take, whether `/dev/tpm0` and containers survive, and how much first boot slows down.
3. Set the repo Variable `BOX_HIBERNATION_BAKE=true`, so scheduled bakes publish hibernation-capable images.
4. Set `BOX_HIBERNATION_ENABLED=true` on the orchestrator. The warm pool's spec hash then changes and rolls the pool onto hibernation-capable boxes.

The provisioner's IAM needs nothing new. `Hibernate` is a parameter of `ec2:StopInstances`, and `ec2:DescribeInstanceTypes` is already in its describe statement.

## Caveats

- After a resume, sockets are gone. The agent's heartbeat reconnects it, and SSM sessions, port forwards and SSO tokens behave as they do after a laptop wakes.
- The resize workflow (`resize-box.yml`) cannot retype a hibernated instance (EC2 refuses). Stop the box plainly first. A larger type gets a bigger swap file at its next boot.
- `nokaslr` applies to every box launched from a hibernation-capable image, hibernating or not.
