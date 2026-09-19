#!/usr/bin/env bash
# Re-register the freshly-baked termag box AMI with NitroTPM (TPM 2.0) enabled.
#
# WHY THIS EXISTS
#   Packer's amazon-ebs builder creates the AMI via the EC2 CreateImage API,
#   which has no parameter for TpmSupport/BootMode. NitroTPM can only be turned
#   on at *RegisterImage* time (--tpm-support v2.0 --boot-mode uefi). Rather than
#   rewrite the build onto the ebssurrogate/chroot builders — which build the
#   rootfs from scratch instead of layering on the Ubuntu base image — we let
#   amazon-ebs bake the image as usual (tagged Component=box-base), then here:
#     1. read the snapshot + device layout of the baked image,
#     2. RegisterImage an identical image with NitroTPM on,
#     3. copy the tags over and claim the Component=box discovery tag,
#     4. deregister the intermediate box-base image.
#
#   NitroTPM is an AMI attribute: every instance launched from the re-registered
#   AMI gets a /dev/tpm0 + /dev/tpmrm0 device automatically — no per-instance
#   flag in terraform/box or the SDK box provisioner.
#
# REQUIREMENTS: AWS CLI v2 + jq on the host running packer, same creds as the
# build (needs ec2:RegisterImage, DescribeImages, DescribeTags, CreateTags,
# DeregisterImage).
#
# Env (set by the shell-local post-processor): AWS_REGION, MANIFEST,
# FINAL_COMPONENT_TAG (default "box"), NITROTPM_AMI_ID_FILE (optional: path to
# write the published AMI id to, for a post-build check by whoever ran packer).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${MANIFEST:?MANIFEST is required}"
FINAL_COMPONENT_TAG="${FINAL_COMPONENT_TAG:-box}"

log() { echo "[nitrotpm] $*"; }

# Resolve the AMI this build just produced. The manifest lists every build's
# artifact_id as "<region>:<ami-id>"; match the current run via last_run_uuid
# so a stale manifest from an earlier build can't be picked up.
run_uuid=$(jq -r '.last_run_uuid' "$MANIFEST")
artifact=$(jq -r --arg u "$run_uuid" \
  '.builds[] | select(.packer_run_uuid==$u) | .artifact_id' "$MANIFEST")
base_ami="${artifact##*:}"
[ -n "$base_ami" ] || { echo "[nitrotpm] could not resolve base AMI from $MANIFEST" >&2; exit 1; }
log "baked base AMI: $base_ami"

# Pull the base image's snapshot + device layout so the re-registered image is
# byte-identical apart from the NitroTPM/boot-mode attributes.
img=$(aws ec2 describe-images --region "$AWS_REGION" --image-ids "$base_ami" \
  --query 'Images[0]' --output json)
arch=$(jq -r '.Architecture' <<<"$img")
root_dev=$(jq -r '.RootDeviceName' <<<"$img")
ena=$(jq -r '.EnaSupport // true' <<<"$img")
# RegisterImage defaults virtualization-type to paravirtual, which arm64/hvm
# images reject ("architecture supports HVM AMIs only"). Carry over the base
# image's type explicitly.
virt=$(jq -r '.VirtualizationType // "hvm"' <<<"$img")
name=$(jq -r '.Name' <<<"$img")
desc=$(jq -r '.Description // "termag box (NitroTPM)"' <<<"$img")
# Block device mappings carry the root snapshot id (+ size/type). Drop any
# ephemeral/no-device entries, and strip Encrypted from snapshot-backed EBS
# mappings — RegisterImage rejects the encrypted flag when a SnapshotId is given
# (encryption is inherited from the snapshot).
bdm=$(jq -c '[.BlockDeviceMappings[] | select(.Ebs != null)
             | if .Ebs.SnapshotId then .Ebs |= del(.Encrypted) else . end]' <<<"$img")

new_name="${name}-nitrotpm"
log "registering '$new_name' with boot-mode=uefi tpm-support=v2.0 virt=$virt"
ena_flag=$([ "$ena" = "true" ] && echo --ena-support || echo --no-ena-support)
new_ami=$(aws ec2 register-image --region "$AWS_REGION" \
  --name "$new_name" \
  --description "$desc" \
  --architecture "$arch" \
  --virtualization-type "$virt" \
  --root-device-name "$root_dev" \
  --boot-mode uefi \
  --tpm-support v2.0 \
  "$ena_flag" \
  --block-device-mappings "$bdm" \
  --query 'ImageId' --output text)
log "registered NitroTPM AMI: $new_ami"

# Hand the id to the caller (CI's verify step reads it) so a post-build check
# can wait on this exact image rather than guess at "newest".
if [ -n "${NITROTPM_AMI_ID_FILE:-}" ]; then
  printf '%s\n' "$new_ami" > "$NITROTPM_AMI_ID_FILE"
fi

# Copy the base image's tags onto the new one (minus Component), then claim the
# Component=box discovery tag + record NitroTPM. Note the JMESPath backticks are
# inside single quotes so bash leaves them alone.
mapfile -t kv < <(aws ec2 describe-tags --region "$AWS_REGION" \
  --filters "Name=resource-id,Values=$base_ami" \
  --query 'Tags[?Key!=`Component`].[Key,Value]' --output text)
tag_args=()
for line in "${kv[@]}"; do
  k=${line%%$'\t'*}; v=${line#*$'\t'}
  [ -n "$k" ] && tag_args+=("Key=$k,Value=$v")
done
tag_args+=("Key=Component,Value=$FINAL_COMPONENT_TAG" "Key=NitroTPM,Value=v2.0")
aws ec2 create-tags --region "$AWS_REGION" --resources "$new_ami" --tags "${tag_args[@]}"
log "tagged $new_ami: Component=$FINAL_COMPONENT_TAG NitroTPM=v2.0 (+ inherited)"

# Retire the intermediate, NitroTPM-less image so newest-by-tag discovery
# (Component=box) can only resolve to a NitroTPM AMI. Deregister leaves the root
# snapshot in place — it's now referenced by $new_ami.
log "deregistering intermediate base AMI $base_ami"
aws ec2 deregister-image --region "$AWS_REGION" --image-id "$base_ami"

log "done — NitroTPM box AMI ready: $new_ami (region $AWS_REGION)"
