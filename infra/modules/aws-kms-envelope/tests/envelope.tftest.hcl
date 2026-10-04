mock_provider "aws" {
  override_during = plan

  mock_resource "aws_vpc_endpoint" {
    defaults = {
      id = "vpce-mock"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      managed_policy_arns = null
    }
  }
}

run "happy" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    policy_probe_action    = null
  }

  override_resource {
    target = aws_iam_role.execution
    values = {
      id = "role-execution"
    }
    override_during = plan
  }

  assert {
    condition     = aws_kms_key.envelope.region == "ap-southeast-2"
    error_message = "envelope KMS key region argument must be ap-southeast-2"
  }

  assert {
    condition     = aws_kms_key.envelope.enable_key_rotation == true
    error_message = "envelope KMS key must rotate"
  }

  assert {
    condition     = aws_kms_key.envelope.deletion_window_in_days == 30
    error_message = "envelope KMS key deletion window must be 30 days"
  }

  assert {
    condition     = aws_kms_key.envelope.bypass_policy_lockout_safety_check == false
    error_message = "envelope KMS key must keep the policy lockout safety check"
  }

  assert {
    condition     = aws_kms_key.envelope.multi_region == true
    error_message = "envelope KMS key must be multi-Region"
  }

  assert {
    condition     = aws_kms_alias.envelope.name == "alias/ch-staging-envelope"
    error_message = "envelope alias must be alias/ch-staging-envelope"
  }

  assert {
    condition     = length(aws_vpc_endpoint.kms) == 0
    error_message = "KMS endpoint must be absent when enable_kms_endpoint is off"
  }

  assert {
    condition     = output.endpoint_id == null
    error_message = "endpoint_id must be null when the KMS endpoint is off"
  }

  assert {
    condition     = !strcontains(aws_kms_key.envelope.policy, "aws:SourceVpce")
    error_message = "envelope key policy must not contain aws:SourceVpce when the endpoint is off"
  }

  assert {
    condition     = strcontains(file("${path.module}/main.tf"), "depends_on = [aws_iam_role.task]")
    error_message = "aws_kms_key.envelope must depend on aws_iam_role.task"
  }

  assert {
    condition     = length(jsondecode(aws_kms_key.envelope.policy).Statement) == 5
    error_message = "envelope key policy must have exactly five statements"
  }

  assert {
    condition = [for statement in jsondecode(aws_kms_key.envelope.policy).Statement : statement.Sid] == [
      "Admin",
      "GenerateDataKeyOrg",
      "GenerateDataKeyIdentity",
      "DecryptOrg",
      "DecryptIdentity",
    ]
    error_message = "envelope key policy sids must be Admin, GenerateDataKeyOrg, GenerateDataKeyIdentity, DecryptOrg, DecryptIdentity"
  }

  assert {
    condition = jsondecode(aws_kms_key.envelope.policy).Statement[0].Action == [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:EnableKey",
      "kms:DisableKey",
      "kms:EnableKeyRotation",
      "kms:DisableKeyRotation",
      "kms:UpdateKeyDescription",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
    ]
    error_message = "admin actions must equal the 16-name set, including kms:PutKeyPolicy"
  }

  assert {
    condition = (
      !contains(jsondecode(aws_kms_key.envelope.policy).Statement[0].Action, "kms:CreateGrant") &&
      !contains(jsondecode(aws_kms_key.envelope.policy).Statement[0].Action, "kms:Encrypt") &&
      !contains(jsondecode(aws_kms_key.envelope.policy).Statement[0].Action, "kms:Decrypt") &&
      !contains(jsondecode(aws_kms_key.envelope.policy).Statement[0].Action, "kms:GenerateDataKey")
    )
    error_message = "admin actions must not include kms:CreateGrant, kms:Encrypt, kms:Decrypt, or kms:GenerateDataKey"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_kms_key.envelope.policy).Statement :
      length(statement.Action) == 1 &&
      (
        (strcontains(statement.Sid, "GenerateDataKey") && statement.Action[0] == "kms:GenerateDataKey") ||
        (startswith(statement.Sid, "Decrypt") && statement.Action[0] == "kms:Decrypt")
      )
      if contains(["GenerateDataKeyOrg", "GenerateDataKeyIdentity", "DecryptOrg", "DecryptIdentity"], statement.Sid)
    ])
    error_message = "each cryptographic statement must allow exactly GenerateDataKey or Decrypt matching its sid"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_kms_key.envelope.policy).Statement :
      statement.Principal.AWS == "arn:aws:iam::123456789012:role/ch-staging-task" &&
      (
        endswith(statement.Sid, "Org") ? (
          statement.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"] == ["key_kind", "org_id", "key_version"] &&
          statement.Condition["Null"]["kms:EncryptionContext:key_kind"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:org_id"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:key_version"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:region"] == "true"
          ) : (
          statement.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"] == ["key_kind", "region", "key_version"] &&
          statement.Condition["Null"]["kms:EncryptionContext:key_kind"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:region"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:key_version"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:org_id"] == "true"
        )
      )
      if contains(["GenerateDataKeyOrg", "GenerateDataKeyIdentity", "DecryptOrg", "DecryptIdentity"], statement.Sid)
    ])
    error_message = "cryptographic statements must bind the task role, encryption context keys, and Null presence"
  }

  assert {
    condition = (
      !strcontains(aws_kms_key.envelope.policy, "kms:CreateGrant") &&
      !strcontains(aws_kms_key.envelope.policy, "\"kms:Encrypt\"") &&
      !strcontains(aws_kms_key.envelope.policy, "kms:ReEncrypt") &&
      !strcontains(aws_kms_key.envelope.policy, "kms:GenerateDataKeyWithoutPlaintext") &&
      !strcontains(aws_kms_key.envelope.policy, "kms:GenerateDataKeyPair")
    )
    error_message = "envelope key policy must not grant CreateGrant, Encrypt, ReEncrypt, GenerateDataKeyWithoutPlaintext, or GenerateDataKeyPair"
  }

  assert {
    condition     = aws_iam_role.task.name == "ch-staging-task"
    error_message = "task role name must be ch-staging-task"
  }

  assert {
    condition     = length(aws_iam_role.task.inline_policy) == 0
    error_message = "task role must have no inline policy"
  }

  assert {
    condition     = !strcontains(file("${path.module}/main.tf"), "managed_policy_arns")
    error_message = "task role must have no managed policy ARNs"
  }

  assert {
    condition     = !strcontains(file("${path.module}/main.tf"), "role = aws_iam_role.task")
    error_message = "module must not attach a policy to the task role"
  }

  assert {
    condition     = !strcontains(file("${path.module}/main.tf"), "aws_iam_role_policy_attachment")
    error_message = "module must not declare aws_iam_role_policy_attachment"
  }

  assert {
    condition     = aws_iam_role_policy.execution.role == aws_iam_role.execution.id
    error_message = "execution policy must attach to the execution role"
  }

  assert {
    condition     = aws_iam_role_policy.execution.name == "service-execution"
    error_message = "execution policy name must be service-execution"
  }

  assert {
    condition = (
      strcontains(aws_iam_role_policy.execution.policy, "logs:PutLogEvents") &&
      strcontains(aws_iam_role_policy.execution.policy, "/community-hub/ch-staging/service") &&
      !strcontains(aws_iam_role_policy.execution.policy, "kms:")
    )
    error_message = "execution role may write service logs and must not call kms"
  }

  assert {
    condition     = aws_iam_role.execution.name == "ch-staging-execution"
    error_message = "execution role name must be ch-staging-execution"
  }

  assert {
    condition     = output.execution_role_name == "ch-staging-execution"
    error_message = "execution_role_name must be the role name, not the ARN"
  }

  assert {
    condition     = output.log_group_name == "/community-hub/ch-staging/service"
    error_message = "log_group_name must be the service log group"
  }
}

run "endpoint_on" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    enable_kms_endpoint    = true
  }

  override_resource {
    target = aws_vpc_endpoint.kms[0]
    values = {
      id = "vpce-mock"
    }
    override_during = plan
  }

  assert {
    condition     = length(aws_vpc_endpoint.kms) == 1
    error_message = "KMS endpoint must exist when enable_kms_endpoint is on"
  }

  assert {
    condition     = output.endpoint_id == "vpce-mock"
    error_message = "endpoint_id must be the mocked VPC endpoint id"
  }

  assert {
    condition     = aws_vpc_endpoint.kms[0].service_name == "com.amazonaws.ap-southeast-2.kms"
    error_message = "KMS endpoint service must be com.amazonaws.ap-southeast-2.kms"
  }

  assert {
    condition     = aws_vpc_endpoint.kms[0].vpc_endpoint_type == "Interface"
    error_message = "KMS endpoint must be an interface endpoint"
  }

  assert {
    condition     = aws_vpc_endpoint.kms[0].private_dns_enabled == true
    error_message = "KMS endpoint must enable private DNS"
  }

  assert {
    condition = (
      one(aws_security_group.endpoint[0].ingress).from_port == 443 &&
      one(aws_security_group.endpoint[0].ingress).to_port == 443 &&
      one(aws_security_group.endpoint[0].ingress).protocol == "tcp" &&
      length(one(aws_security_group.endpoint[0].ingress).cidr_blocks) == 0 &&
      toset(one(aws_security_group.endpoint[0].ingress).security_groups) == toset(["sg-task"])
    )
    error_message = "endpoint ingress must be TCP 443 from the task security group only"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_kms_key.envelope.policy).Statement :
      statement.Condition.StringEquals["aws:SourceVpce"] == "vpce-mock" &&
      (
        endswith(statement.Sid, "Org") ? (
          statement.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"] == ["key_kind", "org_id", "key_version"] &&
          statement.Condition["Null"]["kms:EncryptionContext:key_kind"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:org_id"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:key_version"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:region"] == "true"
          ) : (
          statement.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"] == ["key_kind", "region", "key_version"] &&
          statement.Condition["Null"]["kms:EncryptionContext:key_kind"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:region"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:key_version"] == "false" &&
          statement.Condition["Null"]["kms:EncryptionContext:org_id"] == "true"
        )
      )
      if contains(["GenerateDataKeyOrg", "GenerateDataKeyIdentity", "DecryptOrg", "DecryptIdentity"], statement.Sid)
    ])
    error_message = "cryptographic statements must bind SourceVpce, encryption context keys, and Null presence"
  }
}

run "probe_create_grant" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    policy_probe_action    = "kms:CreateGrant"
  }

  expect_failures = [terraform_data.envelope_key_policy]
}

run "wrong_region" {
  command = plan

  variables {
    aws_region             = "us-east-1"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
  }

  expect_failures = [var.aws_region]
}

run "rotation_off" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    enable_key_rotation    = false
  }

  expect_failures = [var.enable_key_rotation]
}

run "log_retention_zero" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    log_retention_days     = 0
  }

  expect_failures = [var.log_retention_days]
}
