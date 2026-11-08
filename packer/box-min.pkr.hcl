// Packer template for the lean termag box-min AMI — the image
// `termag box create <name> --minimal` launches from
// (backend src/services/boxProvisioner.resolveMinimalBoxImage).
//
// This is the standard box bake (box.pkr.hcl) reduced to the box contract:
//   * the placeholder `termag` unix user (sudo policy, sshd keys-only, linger)
//     that terraform/box's cloud-init renames to the owner at launch
//   * nvm + a default Node alias — there is no system node; the agent's
//     run-node.sh and the CLI launcher resolve the runtime through it
//   * the termag source as a git bundle clone at ~termag/src/termag, with the
//     agent npm-installed and the termag CLI built beside it
//   * the deploy/ units (agent, reconcile, warm hooks),
//     the TERMAG_BOX marker, the guest-browser wiring and the machine reset
//   * git, zsh, tmux (the agent creates tmux panes), gh (the first-run setup
//     flow's GitHub auth), jq (termag-reconcile's config merges) and tpm2-tools
//     (userspace for the NitroTPM device every termag box exposes)
//   * the SSM agent (Canonical ships it) and the NitroTPM post-processor that
//     moves the Component tag
//
// Everything the full bake installs beyond that — the language toolchains, the
// agent CLIs (claude/codex/cursor/devin/pi), Playwright, Docker, Chromium, the
// snap, neovim, the oh-my-zsh set and the app
// war-cache — is deliberately absent. A minimal box's owner scripts their own
// bring-up over the SSM tunnel (the plugin's bootstrap), and the box contract
// ships the rest through termag-reconcile at first boot.
//
// No incremental mode on purpose: this bake is ~15 minutes of small installs,
// so the full bake is the cheap path — there is no incremental-mode machinery
// worth re-rooting through a source image, and no auxiliary volume to exclude.

packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "vpc_id" {
  type        = string
  default     = ""
  description = "VPC to launch the builder instance in. Required."
}

variable "subnet_id" {
  type        = string
  default     = ""
  description = "Private subnet with a NAT route, for apt/npm/GitHub/GitHub releases. Required. Not a public subnet: an org policy that limits instance credentials to the VPC denies the builder's instance-role calls that leave through its own public IP."
}

variable "associate_public_ip_address" {
  type        = bool
  default     = false
  description = "Give the builder a public IP. Off: the builder runs in a private subnet behind the VPC's NAT (see subnet_id). Only for a local build in a public subnet of an account without such a policy."
}

variable "iam_instance_profile" {
  type        = string
  default     = "AmazonSSMRoleForInstancesQuickSetup"
  description = "Instance profile for the builder; its role needs the SSM agent's registration and session actions (packer communicates over Session Manager). AmazonSSMManagedInstanceCore provides them and also grants ssm:GetParameter and ssm:GetParameters on *; termag-ami-builder drops those reads when example-org/terraform#28995 is applied."
}

variable "instance_type" {
  type        = string
  default     = "t4g.large"
  description = "Builder instance type. The lean bake is apt + one npm install; a t4g.large does it comfortably."
}

variable "ami_name_prefix" {
  type    = string
  default = "termag-box-min"
}

variable "root_volume_gb" {
  type        = number
  default     = 60
  description = "GB for the baked root volume. The lean image needs well under half of this; 60 leaves room for an owner's node_modules-heavy project without the 120GB disk the full bake's dev stack requires. The orchestrator's BOX_MINIMAL_ROOT_VOLUME_GB default (60 in backend/src/services/boxProvisioner.ts) mirrors this and the snapshot can still raise a launch above it."
}

variable "termag_baked_sha" {
  type        = string
  default     = "unknown"
  description = "git SHA of this repo's checkout the image was baked from — same as box.pkr.hcl. CI sets it to github.sha and records it on the AMI's TermagSha tag, which the scheduled staleness check (check-box-min-ami) compares against main."
}

variable "final_component_tag" {
  type        = string
  default     = "box-min"
  description = "Component tag the NitroTPM post-processor puts on the finished AMI. \"box-min\" is the tag resolveMinimalBoxImage discovers, so the image becomes what --minimal boxes launch from. \"box-min-candidate\" bakes a real image that discovery ignores, for validating a branch without shipping one."
}

locals {
  // Where scripts/bundle-source.sh writes the git bundle of the checkout being
  // baked (plus a "<bundle>.origin" sidecar with the checkout's remote URL).
  // Gitignored; the file provisioners below ship both.
  termag_bundle = "${path.root}/termag.bundle"
}

source "amazon-ebs" "termag_box_min" {
  region        = var.region
  ami_name      = "${var.ami_name_prefix}-{{timestamp}}"
  instance_type = var.instance_type

  // Always a full bake, from Canonical's Ubuntu image. box-min carries no
  // toolchain caches worth re-rooting incrementally, and the bake is minutes —
  // no incremental-mode variables, no auxiliary volume.
  source_ami_filter {
    filters = {
      name                  = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"
      architecture          = "arm64"
      "root-device-type"    = "ebs"
      "virtualization-type" = "hvm"
      state                 = "available"
    }
    owners      = ["099720109477"] // Canonical
    most_recent = true
  }

  // Communicate via SSM Session Manager (no inbound SSH possible in this VPC).
  ssh_username                = "ubuntu"
  ssh_interface               = "session_manager"
  iam_instance_profile        = var.iam_instance_profile
  associate_public_ip_address = var.associate_public_ip_address

  vpc_id    = var.vpc_id
  subnet_id = var.subnet_id

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
    // One hop, same as box.pkr.hcl: the bake runs no containers, but the
    // tightened default costs nothing and the instance role is the only thing
    // IMDS should ever serve here.
    http_put_response_hop_limit = 1
  }

  // The baked home (~termag with nvm node + the agent clone) is a few hundred
  // MB; root_volume_gb leaves a comfortable margin for an owner's work without
  // paying for the full bake's 120GB.
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    delete_on_termination = true
  }

  // A lean bake's snapshot is small; the default wait is comfortably inside it.
  aws_polling {
    delay_seconds = 15
    max_attempts  = 360
  }

  // Intermediate, NitroTPM-less image, exactly like box.pkr.hcl: the
  // enable-nitrotpm post-processor re-registers this with TpmSupport=v2.0 and
  // moves the Component=<final_component_tag> discovery tag onto the NitroTPM
  // AMI, then deregisters this one. Tagging it "box-min-base" (not "box-min")
  // means discovery can only ever resolve to a NitroTPM image — if the
  // re-register fails, no Component=box-min AMI is produced for this build and
  // the flavor's loud-missing-image path is what a --minimal launch shows.
  tags = {
    App       = "termag"
    Component = "box-min-base"
    BaseImage = "ubuntu-24.04-arm64"
    TermagSha = var.termag_baked_sha
    BuiltBy   = "packer"
    // boxProvisioner reads it (AMI_HIBERNATION_TAG). The lean bake never runs
    // scripts/enable-hibernation.sh: no kernel purge, no KASLR drop-in, no
    // swap scaffolding. The tag is what keeps the orchestrator's
    // hibernation-capable launch path honest about what the image can do.
    Hibernation = "unsupported"
  }

  snapshot_tags = {
    App       = "termag"
    Component = "box-min-base"
    BaseImage = "ubuntu-24.04-arm64"
    TermagSha = var.termag_baked_sha
    BuiltBy   = "packer"
  }

  run_tags = {
    App       = "termag"
    Component = "ami-build"
    Owner     = "packer"
  }
  run_volume_tags = {
    App       = "termag"
    Component = "ami-build"
  }
}

build {
  name    = "termag-box-min"
  sources = ["source.amazon-ebs.termag_box_min"]

  provisioner "shell" {
    // Wait until cloud-init has finished its work — apt locks are otherwise
    // a flaky failure mode early in the build.
    inline = [
      "echo 'Waiting for cloud-init...'",
      "cloud-init status --wait || true",
    ]
  }

  provisioner "file" {
    source      = "${path.root}/scripts/box-lib.sh"
    destination = "/tmp/box-lib.sh"
  }

  provisioner "shell" {
    // The full bake lands a copy of box-lib.sh at /var/lib/termag-bake (through
    // its token-fetch provisioner) so a function in it survives the /tmp wipe
    // every setup script does on its way out. Same convention here.
    //
    // Checked at runtime above: the copy is what box-min-setup.sh sources.
    inline = [
      "sudo install -d -m 0755 /var/lib/termag-bake",
      "sudo install -m 0644 /tmp/box-lib.sh /var/lib/termag-bake/box-lib.sh",
    ]
  }

  provisioner "file" {
    // Single source of truth — reuse the systemd unit shipped with the rest
    // of the deploy assets.
    source      = "${path.root}/../deploy/termag-agent.service"
    destination = "/tmp/termag-agent.service"
  }

  provisioner "file" {
    // Claude Code status hooks — install_deploy_artifacts seeds ~/.claude
    // /settings.json with them so the agent's status lights work on a minimal
    // box without a manual step. It stays the user's file on the box; termag
    // -reconcile never rewrites it (only appends when keys are missing).
    source      = "${path.root}/../deploy/claude-settings.json"
    destination = "/tmp/claude-settings.json"
  }

  provisioner "file" {
    source      = "${path.root}/../deploy/termag-status"
    destination = "/tmp/termag-status"
  }

  // The termag source itself: a git bundle of the checkout being baked, with
  // its full history and nothing else (a bundle is objects + refs: no
  // credentials, no node_modules, nothing untracked). The agent's npm install
  // turns ~termag/src/termag/agent into the runtime image box-min exists to
  // carry. Cut on the host running packer; the file provisioners ship the
  // bundle and its origin sidecar, and box-min-setup.sh clones it.
  //
  // `generated = true`: the files do not exist at `packer validate` time.
  provisioner "shell-local" {
    environment_vars = ["BUNDLE=${local.termag_bundle}"]
    scripts          = ["${path.root}/scripts/bundle-source.sh"]
  }

  provisioner "file" {
    source      = local.termag_bundle
    destination = "/tmp/termag.bundle"
    generated   = true
  }

  provisioner "file" {
    source      = "${local.termag_bundle}.origin"
    destination = "/tmp/termag.bundle.origin"
    generated   = true
  }

  provisioner "file" {
    // Reconciles the installed box artifacts against the checkout on every
    // boot, so a merged fix in deploy/ reaches a running box without a bake.
    source      = "${path.root}/../deploy/termag-reconcile"
    destination = "/tmp/termag-reconcile"
  }

  provisioner "file" {
    source      = "${path.root}/../deploy/termag-reconcile.service"
    destination = "/tmp/termag-reconcile.service"
  }

  provisioner "file" {
    // Warm-pool lifecycle hooks. The runner and its unit are baked so a pool
    // box can run them before it has an owner — a --minimal box is never a
    // pool box (warm-pool claims are skipped for the minimal flavor), but the
    // units are part of the box contract install_deploy_artifacts lays down.
    source      = "${path.root}/../deploy/termag-hook-run"
    destination = "/tmp/termag-hook-run"
  }

  provisioner "file" {
    source      = "${path.root}/../deploy/termag-on-warm.service"
    destination = "/tmp/termag-on-warm.service"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/box-min-setup.sh"
    environment_vars = [
      "TERMAG_BAKED_SHA=${var.termag_baked_sha}",
    ]
    timeout = "30m"
  }

  // First-boot path rewrite, bake half — same mechanism as box.pkr.hcl, even
  // though this home is tiny. cloud-init renames /home/termag to the owner and
  // must then fix every symlink target and text file that embeds the old path
  // (the CLI launcher pins an absolute nvm node path). The index walk here is
  // seconds on this home; the value is keeping the boot machinery identical to
  // the full image's, so nothing learns a second shape.
  provisioner "file" {
    source      = "${path.root}/scripts/rewrite-home-paths.sh"
    destination = "/tmp/rewrite-home-paths.sh"
  }
  provisioner "shell" {
    script  = "${path.root}/scripts/index-home-paths.sh"
    timeout = "10m"
  }

  // NitroTPM re-register. Same mechanism and same script as the box bake:
  // amazon-ebs bakes the image via CreateImage (no TpmSupport support); this
  // re-registers its root snapshot via RegisterImage with --boot-mode uefi
  // --tpm-support v2.0, tags the NitroTPM AMI Component=<final_component_tag>
  // (box-min = discoverable by resolveMinimalBoxImage) and retires this
  // intermediate. Runs on the host running packer — needs the AWS CLI v2 + jq
  // (same creds as the build).
  post-processors {
    post-processor "manifest" {
      output     = "${path.root}/packer-manifest-box-min.json"
      strip_path = true
    }
    post-processor "shell-local" {
      environment_vars = [
        "AWS_REGION=${var.region}",
        "MANIFEST=${path.root}/packer-manifest-box-min.json",
        "FINAL_COMPONENT_TAG=${var.final_component_tag}",
        // No channel tag on a minimal image: the box-image flag never selects
        // a Component=box-min image (services/boxImage.ts), so a channel here
        // would tag a launch path nobody can reach. The dispatch's publish
        // gate (box-min vs box-min-candidate) is the only visibility control
        // this image needs.
        "CHANNEL=",
        "NITROTPM_AMI_ID_FILE=${path.root}/nitrotpm-ami-id-box-min",
      ]
      scripts = ["${path.root}/scripts/enable-nitrotpm.sh"]
    }
  }
}
