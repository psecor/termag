// Packer template for the termag box AMI.
//
// Builds an Ubuntu 24.04 arm64 image with everything a termag box needs at
// runtime: system packages, agent CLIs (claude/cursor/devin), this checkout's
// termag source (the agent runs from it), agent-wiki pre-cloned, the termag
// unix user with linger.
//
// The image is SSM-only. We deliberately don't open inbound SSH — a locked-down
// dev VPC's NACL blocks it anyway. Provisioning happens through SSM Session
// Manager (ssh_interface = "session_manager"), so the build instance never
// needs a public SG rule.
//
// Build:
//   packer init .
//   packer build box.pkr.hcl
//
// The resulting AMI is tagged App=termag, Component=box, plus TermagSha: the
// commit of this checkout that was shipped into it.
//
// NitroTPM: every box gets a TPM 2.0 device so on-box utilities (LUKS via
// systemd-cryptenroll, Vault attestation, IMA, sealed secrets) can use it.
// NitroTPM is an *AMI attribute* (TpmSupport=v2.0 + BootMode=uefi), not a
// launch-time flag — instances inherit it automatically, so terraform/box and
// the SDK box provisioner need no change. The amazon-ebs builder creates the
// image via the CreateImage API, which can't set TpmSupport (only RegisterImage
// can), so the `enable-nitrotpm` post-processor re-registers the baked snapshot
// with NitroTPM enabled and hands it the Component=box discovery tag. See
// scripts/enable-nitrotpm.sh.

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

source "amazon-ebs" "termag_box" {
  region        = var.region
  ami_name      = "${var.ami_name_prefix}-{{timestamp}}"
  instance_type = var.instance_type

  // Canonical's latest Ubuntu 24.04 LTS arm64 server image.
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"
      architecture        = "arm64"
      "root-device-type"  = "ebs"
      "virtualization-type" = "hvm"
      state               = "available"
    }
    owners      = ["099720109477"] // Canonical
    most_recent = true
  }

  // Communicate via SSM Session Manager (no inbound SSH possible in this VPC).
  // Packer wraps the SSH protocol inside SSM, so we still set ssh_username for
  // the protocol-level identity.
  ssh_username             = "ubuntu"
  ssh_interface            = "session_manager"
  iam_instance_profile     = "AmazonSSMRoleForInstancesQuickSetup"
  // Public IP required so the build instance can reach apt mirrors via the
  // subnet's IGW. The VPC has SSM endpoints (which is why our smoke test
  // worked without a public IP), but there's no apt endpoint. The temporary
  // SG Packer creates has no inbound rules — SSM still tunnels via outbound.
  associate_public_ip_address = true

  vpc_id    = var.vpc_id
  subnet_id = var.subnet_id

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

  // Intermediate, NitroTPM-less image. The enable-nitrotpm post-processor
  // re-registers this with TpmSupport=v2.0 and moves the Component=box
  // discovery tag onto the NitroTPM AMI, then deregisters this one. Tagging it
  // "box-base" (not "box") guarantees newest-by-tag discovery can only ever
  // resolve to a NitroTPM image — if the re-register step fails, no Component=box
  // AMI is produced for this build and discovery falls back to the last good one.
  //
  // TermagSha is what the Publish AMI schedule diffs against main to decide
  // whether a bake is due. The NitroTPM post-processor copies every tag except
  // Component onto the final image, so it survives onto the discoverable AMI.
  tags = {
    App         = "termag"
    Component   = "box-base"
    BaseImage   = "ubuntu-24.04-arm64"
    TermagSha   = var.termag_baked_sha
    BuiltBy     = "packer"
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

  provisioner "shell" {
    script = "${path.root}/scripts/setup.sh"
    environment_vars = [
      "TERMAG_BAKED_SHA=${var.termag_baked_sha}",
      "AGENT_WIKI_REPO_URL=${var.agent_wiki_repo_url}",
    ]
    // Long install — the full devbox toolset (apt/snap/npm + Go/Python/Rust
    // toolchain builds + cargo-building rtk) can take a while.
    timeout = "45m"
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
