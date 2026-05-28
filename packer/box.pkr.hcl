// Packer template for the termag box AMI.
//
// Builds an Ubuntu 24.04 arm64 image with everything a termag box needs at
// runtime: system packages, agent CLIs (claude/cursor/devin), termag-agent
// code pre-cloned, agent-wiki pre-cloned, the termag unix user with linger.
//
// The image is SSM-only. We deliberately don't open inbound SSH — LD's dev
// VPC NACL blocks it anyway. Provisioning happens through SSM Session
// Manager (ssh_interface = "session_manager"), so the build instance never
// needs a public SG rule.
//
// Build:
//   packer init .
//   packer build box.pkr.hcl
//
// The resulting AMI is tagged App=termag, Component=box, plus the git commit
// the install script cloned.

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
  default     = "vpc-03e804ea9dfa8b76b"
  description = "LD development VPC"
}

variable "subnet_id" {
  type        = string
  default     = "subnet-0a74be64353787cf4"
  description = "public-subnet-a in the dev VPC (has IGW route for outbound apt/npm)"
}

variable "instance_type" {
  type    = string
  default = "t4g.medium"
}

variable "ami_name_prefix" {
  type    = string
  default = "termag-box"
}

variable "termag_repo_url" {
  type    = string
  default = "https://github.com/psecor/termag.git"
}

variable "termag_ref" {
  type        = string
  default     = "master"
  description = "git ref to clone for the baked termag source"
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

  // Larger root volume so npm/agent installs don't run out of space.
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    App         = "termag"
    Component   = "box"
    BaseImage   = "ubuntu-24.04-arm64"
    TermagRef   = var.termag_ref
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

  provisioner "shell" {
    script = "${path.root}/scripts/setup.sh"
    environment_vars = [
      "TERMAG_REPO_URL=${var.termag_repo_url}",
      "TERMAG_REF=${var.termag_ref}",
      "AGENT_WIKI_REPO_URL=${var.agent_wiki_repo_url}",
    ]
    // Long install — apt/snap/npm chains can take a while.
    timeout = "30m"
  }
}
