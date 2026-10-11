// Packer template for the termag box AMI.

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
  description = "Public subnet with IGW route for outbound apt/npm. Required."
}

variable "iam_instance_profile" {
  type        = string
  default     = "AmazonSSMRoleForInstancesQuickSetup"
  description = "Instance profile for the builder; its role needs AmazonSSMManagedInstanceCore so the SSM agent registers. The default is the profile AWS Systems Manager Quick Setup creates."
}

variable "instance_type" {
  type    = string
  default = "t4g.medium"
}

variable "ami_name_prefix" {
  type    = string
  default = "termag-box"
}

variable "termag_baked_sha" {
  type        = string
  default     = "unknown"
  description = "git SHA of this repo's checkout the image was baked from. The build ships a git bundle of that checkout, cloned to ~termag/src/termag (the agent runs from it), alongside this template, scripts/setup.sh and the deploy/ files, so the image content is exactly this commit; setup.sh fails the bake if the bundle's HEAD disagrees. Set by CI to github.sha and recorded on the AMI's TermagSha tag, which the scheduled staleness check compares against main. Without it that check cannot tell a current image from a stale one."
}

locals {
  // Where scripts/bundle-source.sh writes the git bundle of the checkout being
  // baked (plus a "<bundle>.origin" sidecar with the checkout's remote URL).
  // Gitignored; the file provisioners below ship both.
  termag_bundle = "${path.root}/termag.bundle"

  base_termag_sha = var.bake_mode == "incremental" && var.base_termag_sha != "" ? var.base_termag_sha : var.termag_baked_sha
  base_baked_at   = var.base_baked_at != "" ? var.base_baked_at : formatdate("YYYY-MM-DD'T'hh:mm:ss'Z'", timestamp())
}

variable "final_component_tag" {
  type        = string
  default     = "box"
  description = "Component tag the NitroTPM post-processor puts on the finished AMI. \"box\" is the discovery tag the box provisioner and terraform/box look up, so the image becomes what new boxes launch from. Anything else (CI uses \"box-candidate\") bakes a real image that discovery ignores, for validating a branch without shipping it."
}

variable "agent_wiki_repo_url" {
  type    = string
  default = "https://github.com/psecor/agent-wiki.git"
}

variable "bake_mode" {
  type        = string
  default     = "full"
  description = "full: start from Canonical's Ubuntu image and run setup.sh. incremental: start from source_ami (a published termag box image), skip setup.sh, and refresh the termag checkout and deploy/ artifacts (scripts/refresh-box.sh); the snapshot then holds only the blocks that changed since that image."
  validation {
    condition     = contains(["full", "incremental"], var.bake_mode)
    error_message = "Set bake_mode to \"full\" or \"incremental\"."
  }
}

variable "hibernation" {
  type        = bool
  default     = false
  description = "Bake EC2 hibernation support: ec2-hibinit-agent and KASLR off (scripts/enable-hibernation.sh, which fails the bake if the kernel can't hibernate). Tags the AMI Hibernation=supported, which is what makes the orchestrator launch boxes from it with HibernationOptions when BOX_HIBERNATION_ENABLED=true; false tags it Hibernation=unsupported. Publish AMI sets it from its `hibernation` input or the BOX_HIBERNATION_BAKE repo Variable."
}

variable "source_ami" {
  type        = string
  default     = ""
  description = "Incremental bakes only: the published box AMI (Component=box, NitroTPM) to start from. Ignored by a full bake, which uses the Ubuntu filter. scripts/refresh-box.sh refuses an image that is not a termag box."
}

variable "base_termag_sha" {
  type        = string
  default     = ""
  description = "Incremental bakes only: the TermagSha of the full bake at the root of this image's chain, read off the source image's BaseTermagSha tag and carried onto this one. A full bake records its own termag_baked_sha. Publish AMI diffs the toolchain inputs against it to decide when the next full bake is due."
}

variable "base_baked_at" {
  type        = string
  default     = ""
  description = "Incremental bakes only: when the full bake at the root of the chain ran (RFC 3339 UTC), read off the source image's BaseBakedAt tag. Empty = now, which is right for a full bake. Publish AMI's age rule reads this tag, so a chain of incremental bakes still re-roots on a fresh Ubuntu image every BOX_AMI_MAX_AGE_DAYS."
}

variable "scratch_volume_size" {
  type        = number
  default     = 60
  description = "GB for the builder's scratch volume (bazel output root, apt archives), which the AMI omits."
}

source "amazon-ebs" "termag_box" {
  region        = var.region
  ami_name      = "${var.ami_name_prefix}-{{timestamp}}"
  instance_type = var.instance_type

  // Exclusive on purpose: with both set, the amazon plugin ANDs the filter
  // onto the image id and finds nothing.
  source_ami = var.bake_mode == "incremental" ? var.source_ami : ""
  dynamic "source_ami_filter" {
    for_each = var.bake_mode == "full" ? ["ubuntu"] : []
    content {
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
  }

  // Communicate via SSM Session Manager (no inbound SSH possible in this VPC).
  // Packer wraps the SSH protocol inside SSM, so we still set ssh_username for
  // the protocol-level identity.
  ssh_username             = "ubuntu"
  ssh_interface            = "session_manager"
  iam_instance_profile     = var.iam_instance_profile
  // Public IP required so the build instance can reach apt mirrors via the
  // subnet's IGW. The VPC has SSM endpoints (which is why our smoke test
  // worked without a public IP), but there's no apt endpoint. The temporary
  // SG Packer creates has no inbound rules — SSM still tunnels via outbound.
  associate_public_ip_address = true

  vpc_id    = var.vpc_id
  subnet_id = var.subnet_id

  // IMDSv2 only, one hop. A bake may build docker images on this instance; a
  // hop limit of 1 means nothing behind
  // the docker bridge can obtain a metadata token, so a Dockerfile step or a
  // container cannot reach the builder's instance role. The AWS CLI, the SSM
  // agent and packer's session-manager connection all speak IMDSv2.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  // Root volume must hold the full devbox toolset baked under /home/termag:
  // Go + Python + Rust toolchains, Docker, Chromium, node, and several CLIs.
  // 120GB because the baked toolset plus a real workload does not fit in 50:
  // a full dev stack on a box (docker images ~13GB, a bazel cache ~13GB, a
  // large monorepo checkout ~5GB) exhausts a 50GB volume outright.
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 120
    volume_type           = "gp3"
    delete_on_termination = true
  }

  // EBS snapshots every block ever written to a volume, deleted files
  // included; the no_device entry below keeps this one out of CreateImage.
  launch_block_device_mappings {
    device_name           = "/dev/sdf"
    volume_size           = var.scratch_volume_size
    volume_type           = "gp3"
    delete_on_termination = true
  }
  ami_block_device_mappings {
    device_name = "/dev/sdf"
    no_device   = true
  }

  // CreateImage of a well-filled 120G volume can exceed the plugin's default
  // ImageAvailable wait (seen at ~30m after the image was created, with every
  // provisioner already passed). 15s * 360 = 90m.
  aws_polling {
    delay_seconds = 15
    max_attempts  = 360
  }

  // Intermediate, NitroTPM-less image. The enable-nitrotpm post-processor
  // re-registers this with TpmSupport=v2.0 and moves the Component=box
  // discovery tag onto the NitroTPM AMI, then deregisters this one. Tagging it
  // "box-base" (not "box") guarantees newest-by-tag discovery can only ever
  // resolve to a NitroTPM image — if the re-register step fails, no Component=box
  // AMI is produced for this build and discovery falls back to the last good one.
  tags = {
    App           = "termag"
    Component     = "box-base"
    BaseImage     = "ubuntu-24.04-arm64"
    TermagSha     = var.termag_baked_sha
    BuiltBy       = "packer"
    BakeMode      = var.bake_mode
    SourceAmi     = "{{ .SourceAMI }}"
    SourceAmiName = "{{ .SourceAMIName }}"
    BaseTermagSha = local.base_termag_sha
    BaseBakedAt   = local.base_baked_at
    // Copied onto the NitroTPM AMI by enable-nitrotpm.sh with the rest;
    // boxProvisioner reads it (AMI_HIBERNATION_TAG).
    Hibernation = var.hibernation ? "supported" : "unsupported"
  }

  snapshot_tags = {
    App       = "termag"
    Component = "box-base"
    BaseImage = "ubuntu-24.04-arm64"
    TermagSha = var.termag_baked_sha
    BuiltBy   = "packer"
  }

  // Tag the temporary build instance + its volume too, so it's findable while
  // packer is running.
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
  name    = "termag-box"
  sources = ["source.amazon-ebs.termag_box"]

  provisioner "shell" {
    // Wait until cloud-init has finished its work — apt locks are otherwise
    // a flaky failure mode early in the build.
    inline = [
      "echo 'Waiting for cloud-init...'",
      "cloud-init status --wait || true",
    ]
  }

  provisioner "shell" {
    script = "${path.root}/scripts/prepare-scratch.sh"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/box-lib.sh"
    destination = "/tmp/box-lib.sh"
  }

  // Keep the shared provisioner functions where later steps source them:
  // setup.sh and refresh-box.sh wipe /tmp at their end.
  provisioner "shell" {
    inline = [
      "sudo install -d -m 755 /var/lib/termag-bake",
      "sudo install -m 644 /tmp/box-lib.sh /var/lib/termag-bake/box-lib.sh",
    ]
  }

  provisioner "file" {
    // Single source of truth — reuse the systemd unit shipped with the rest
    // of the deploy assets.
    source      = "${path.root}/../deploy/termag-agent.service"
    destination = "/tmp/termag-agent.service"
  }

  provisioner "file" {
    // Claude Code status hooks — baked into ~/.claude/settings.json by
    // setup.sh so status lights work without the manual step in setup.md.
    source      = "${path.root}/../deploy/claude-settings.json"
    destination = "/tmp/claude-settings.json"
  }

  provisioner "file" {
    source      = "${path.root}/../deploy/termag-status"
    destination = "/tmp/termag-status"
  }

  // The termag source itself: a git bundle of the checkout being baked, with
  // its full history and nothing else (a bundle is objects + refs: no
  // credentials, no node_modules, nothing untracked). What lands on the box is
  // exactly the commit TermagSha names, so a merge to main reaches new boxes
  // through the scheduled bake with no remote clone and no PAT. Cut on the
  // host running packer; the file provisioners ship the bundle and its origin
  // sidecar, and setup.sh clones it to ~termag/src/termag.
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
    // box can run them before it has an owner; the scripts they run come from
    // the checkout, inside the git bundle above.
    source      = "${path.root}/../deploy/termag-hook-run"
    destination = "/tmp/termag-hook-run"
  }

  provisioner "file" {
    source      = "${path.root}/../deploy/termag-on-warm.service"
    destination = "/tmp/termag-on-warm.service"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/refresh-box.sh"
    environment_vars = [
      "BAKE_MODE=${var.bake_mode}",
      "TERMAG_BAKED_SHA=${var.termag_baked_sha}",
      "AGENT_WIKI_REPO_URL=${var.agent_wiki_repo_url}",
    ]
    timeout = "20m"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/setup.sh"
    environment_vars = [
      "BAKE_MODE=${var.bake_mode}",
      "TERMAG_BAKED_SHA=${var.termag_baked_sha}",
      "AGENT_WIKI_REPO_URL=${var.agent_wiki_repo_url}",
    ]
    timeout = "45m"
  }

  // EC2 hibernation support. After setup.sh in both bake modes: an
  // incremental bake's source image may predate it, and it is idempotent.
  // Writes nothing under /home/termag, so its place relative to the home-path
  // index doesn't matter, but it stays ahead of it like every other step.
  provisioner "shell" {
    script = "${path.root}/scripts/enable-hibernation.sh"
    environment_vars = [
      "HIBERNATION=${var.hibernation}",
    ]
    timeout = "15m"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/detach-scratch.sh"
  }

  // First-boot path rewrite, bake half. cloud-init renames /home/termag to the
  // owner and must then fix every symlink target and text file that embeds the
  // old path. Finding them at boot walked the whole home on a lazily-restored
  // EBS volume: 15 minutes on the quick-start image, against the orchestrator's
  // 15-minute stuck-provisioning sweep. index-home-paths.sh takes that walk
  // here, on a warm volume, and installs the boot half
  // (scripts/rewrite-home-paths.sh) as /usr/local/sbin/termag-rewrite-home-paths.
  // The script is uploaded here rather than with the deploy/ files above
  // because setup.sh clears /tmp when it finishes. This MUST stay the last
  // provisioner that runs on the instance: anything written under /home/termag
  // afterwards is not rewritten at boot. scripts/home-paths.test.sh checks the
  // order.
  provisioner "file" {
    source      = "${path.root}/scripts/rewrite-home-paths.sh"
    destination = "/tmp/rewrite-home-paths.sh"
  }
  provisioner "shell" {
    script  = "${path.root}/scripts/index-home-paths.sh"
    timeout = "10m"
  }

  // NitroTPM re-register. amazon-ebs bakes the image via CreateImage (no
  // TpmSupport support); this re-registers its root snapshot via RegisterImage
  // with --boot-mode uefi --tpm-support v2.0, then tags the NitroTPM AMI
  // Component=<final_component_tag> (box = discoverable, anything else = a
  // candidate discovery ignores) and retires the intermediate. Runs on
  // the host running packer — needs the AWS CLI v2 + jq (same creds as the
  // build).
  post-processors {
    post-processor "manifest" {
      output     = "${path.root}/packer-manifest.json"
      strip_path = true
    }
    post-processor "shell-local" {
      environment_vars = [
        "AWS_REGION=${var.region}",
        "MANIFEST=${path.root}/packer-manifest.json",
        "FINAL_COMPONENT_TAG=${var.final_component_tag}",
        // The post-processor writes the published AMI id here so CI's verify
        // step can wait on that exact image. Gitignored.
        "NITROTPM_AMI_ID_FILE=${path.root}/nitrotpm-ami-id",
      ]
      scripts = ["${path.root}/scripts/enable-nitrotpm.sh"]
    }
  }
}
