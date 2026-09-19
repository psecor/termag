// Identity ──────────────────────────────────────────────────────────────────

variable "box_name" {
  type        = string
  description = "User-supplied name for the box (used in tags + SG name)"
}

variable "owner" {
  type        = string
  description = "Email of the box owner — used in tags for billing/audit"
}

// Per-box runtime config (lands in cloud-init) ─────────────────────────────

variable "agent_bearer_token" {
  type        = string
  description = "Bearer token the agent uses to authenticate against the orchestrator"
  sensitive   = true
}

variable "termag_url" {
  type        = string
  description = "Orchestrator WebSocket URL the agent connects to"
  default     = "wss://your-host.example.com/termag/ws/agent"
}

variable "git_user_email" {
  type        = string
  description = "git config user.email for the termag user (used by the agent's git operations)"
}

variable "git_user_name" {
  type        = string
  description = "git config user.name for the termag user"
}

variable "remote_unix_user" {
  type        = string
  description = <<-EOT
    The unix username the orchestrator thinks the user maps to in its
    ALLOWED_USERS table (e.g. "youruser" for you@example.com). The
    agent's path_remap rewrites `/home/<remote_unix_user>` to `/home/termag`
    so reconstruction-on-reconnect doesn't try to mkdir under a home dir
    that doesn't exist on the box. This is a V1 hack; the long-term fix
    is for the backend to know the agent's host-side unix user.
  EOT
}

// AWS infra ────────────────────────────────────────────────────────────────

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type        = string
  description = <<-EOT
    Default is Graviton arm64; the AMI is arm64-only. Must be a
    NitroTPM-supported type so the baked TPM 2.0 device is available — all
    current Graviton families qualify (t4g, m6g/m7g/m8g/m9g, c6g–c8g, r6g–r8g).
  EOT
  default     = "t4g.medium"
}

variable "vpc_id" {
  type        = string
  description = "VPC to place the box in. Required."
  default     = ""
}

// Private subnet — outbound via NAT GW. No public IP. SSM only works if the
// VPC has SSM/SSMmessages/EC2messages endpoints.
variable "subnet_id" {
  type        = string
  description = "Private subnet ID. Use one with a NAT route for outbound. Required."
  default     = ""
}

variable "iam_instance_profile" {
  type        = string
  description = "Instance profile that grants SSM access. The QuickSetup role already exists in the account."
  default     = "AmazonSSMRoleForInstancesQuickSetup"
}

variable "root_volume_gb" {
  type = number
  # Must be >= the AMI snapshot size (120GB — the baked devbox toolset).
  # 50 was not enough for a full dev stack: docker images ~13GB, a bazel cache
  # ~13GB and a large monorepo checkout ~5GB fill it before any work happens.
  default = 120
}

variable "extra_tags" {
  type        = map(string)
  description = "Additional tags to attach to the instance"
  default     = {}
}
