// Auto-discover the latest termag-box AMI by tag — same filter the
// orchestrator's boxProvisioner.ts uses, so both methods resolve to the
// same image.
data "aws_ami" "termag_box" {
  most_recent = true
  owners      = ["self"]

  filter {
    name   = "tag:App"
    values = ["termag"]
  }

  filter {
    name   = "tag:Component"
    values = ["box"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

// Egress-only security group. No inbound rules — termag boxes have no
// network services. Access happens via SSM (outbound HTTPS to AWS).
resource "aws_security_group" "box" {
  name        = "termag-box-${var.box_name}"
  description = "termag box ${var.box_name} - outbound only, no inbound"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound (via NAT GW)"
  }

  tags = merge({
    Name      = "termag-box-${var.box_name}"
    App       = "termag"
    Component = "box-sg"
    Owner     = var.owner
    BoxName   = var.box_name
  }, var.extra_tags)
}

resource "aws_instance" "box" {
  ami           = data.aws_ami.termag_box.id
  instance_type = var.instance_type
  subnet_id     = var.subnet_id

  vpc_security_group_ids      = [aws_security_group.box.id]
  iam_instance_profile        = var.iam_instance_profile
  associate_public_ip_address = false

  // First-boot wiring: drop the bearer token, set git identity, start the agent.
  user_data = templatefile("${path.module}/cloudinit.sh.tftpl", {
    termag_url       = var.termag_url
    agent_token      = var.agent_bearer_token
    git_user_email   = var.git_user_email
    git_user_name    = var.git_user_name
    remote_unix_user = var.remote_unix_user
  })

  // Changing user_data (e.g. rotating the token) recreates the instance.
  // Per design: V1 doesn't support in-place token rotation; users get a
  // fresh box if config changes. Acceptable since tmux state isn't preserved.
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  // IMDSv2 only — prevents the metadata service from being abused via SSRF.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tags = merge({
    Name      = "termag-${var.box_name}"
    App       = "termag"
    Component = "box"
    Owner     = var.owner
    BoxName   = var.box_name
  }, var.extra_tags)

  volume_tags = merge({
    App       = "termag"
    Component = "box-volume"
    Owner     = var.owner
    BoxName   = var.box_name
  }, var.extra_tags)

  lifecycle {
    // Cloud-init only runs on first boot. If someone changes ami_id we DO
    // want the replace (new image). If just the token changes, replace too
    // (consistent with user_data_replace_on_change above).
    ignore_changes = []
  }
}
