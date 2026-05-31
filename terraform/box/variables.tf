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

variable "ami_id" {
  type        = string
  description = "AMI built by packer (see packer/README.md). Required."
  default     = ""
}

variable "instance_type" {
  type        = string
  description = "Default is Graviton arm64; the AMI is arm64-only"
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
  type    = number
  default = 30
}

variable "extra_tags" {
  type        = map(string)
  description = "Additional tags to attach to the instance"
  default     = {}
}
