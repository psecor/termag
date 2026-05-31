output "instance_id" {
  value       = aws_instance.box.id
  description = "EC2 instance ID — feed this to SSM commands and the backend's Instance.ec2InstanceId field"
}

output "private_ip" {
  value       = aws_instance.box.private_ip
  description = "VPC-internal IP. No public IP is allocated."
}

output "private_dns" {
  value       = aws_instance.box.private_dns
  description = "VPC-internal DNS name"
}

output "security_group_id" {
  value       = aws_security_group.box.id
  description = "SG ID — only useful if a follow-up needs to attach additional rules (V1: nothing inbound)"
}
