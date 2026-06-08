// Packer template for the termag ORCHESTRATOR AMI.
//
// Builds an Ubuntu 24.04 arm64 image with everything the shared termag host
// needs at runtime, pre-installed and pre-built: system packages, Node 20,
// Docker (for the Postgres container), the AWS CLI, the `termag` service user,
// and the termag backend + frontend already compiled at /opt/termag.
//
// Unlike the box build, the orchestrator source is NOT cloned from GitHub at
// bake time — it's shipped straight from the CI checkout via a `file`
// provisioner. That means no GitHub PAT is ever needed (at bake OR at boot),
// and the running instance never clones or `npm`-builds anything: cloud-init
// only does per-instance runtime config (mount EBS, render .env, start
// Postgres + the service). Your own Terraform module is expected to supply
// the per-instance cloud-init template.
//
// The image is SSM-only — same VPC/SSM-tunnel story as box.pkr.hcl.
//
// Build:
//   packer init .
//   packer build \
//     -var vpc_id=vpc-... -var subnet_id=subnet-... \
//     -var termag_baked_sha=$(git rev-parse HEAD) \
//     orchestrator.pkr.hcl
//
// The resulting AMI is tagged App=termag, Component=orchestrator — the
// expected discovery key for your launching Terraform.

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
  description = "Subnet with outbound internet (IGW or NAT) for apt/npm. Required."
}

variable "instance_type" {
  type        = string
  default     = "t4g.large"
  description = "Builder size. Large-ish so the npm build doesn't crawl."
}

variable "ami_name_prefix" {
  type    = string
  default = "termag-orchestrator"
}

variable "termag_baked_sha" {
  type        = string
  default     = "unknown"
  description = "git SHA of the termag source being baked. Set by CI to github.sha; recorded on the AMI tag and at /opt/termag/.termag-baked-sha for traceability."
}

source "amazon-ebs" "termag_orchestrator" {
  region        = var.region
  ami_name      = "${var.ami_name_prefix}-{{timestamp}}"
  instance_type = var.instance_type

  // Canonical's latest Ubuntu 24.04 LTS arm64 server image.
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
  ssh_username         = "ubuntu"
  ssh_interface        = "session_manager"
  iam_instance_profile = "AmazonSSMRoleForInstancesQuickSetup"
  // Public IP so the build instance can reach apt mirrors + npm registry. The
  // temporary SG Packer creates has no inbound rules — SSM still tunnels out.
  associate_public_ip_address = true

  vpc_id    = var.vpc_id
  subnet_id = var.subnet_id

  // Room for node_modules + two builds (backend dist + frontend dist).
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    App       = "termag"
    Component = "orchestrator"
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
  name    = "termag-orchestrator"
  sources = ["source.amazon-ebs.termag_orchestrator"]

  provisioner "shell" {
    // Wait until cloud-init has finished its work — apt locks are otherwise
    // a flaky failure mode early in the build. Also pre-create the upload
    // target for the file provisioner below: a trailing-slash source copies
    // the directory *contents*, which requires the destination to already
    // exist — scp won't create it and otherwise fails with
    // "scp: /tmp/termag-src: Not a directory".
    inline = [
      "echo 'Waiting for cloud-init...'",
      "cloud-init status --wait || true",
      "mkdir -p /tmp/termag-src",
    ]
  }

  provisioner "file" {
    // Ship the CI checkout itself — no clone, no PAT. The trailing slash means
    // "copy the contents of the repo root into /tmp/termag-src" (which the
    // shell provisioner above creates). setup.sh then stages it to /opt/termag
    // and prunes the non-runtime dirs.
    source      = "${path.root}/../"
    destination = "/tmp/termag-src"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/orchestrator-setup.sh"
    environment_vars = [
      "TERMAG_BAKED_SHA=${var.termag_baked_sha}",
    ]
    // Long install — apt + two npm builds can take a while.
    timeout = "30m"
  }
}
