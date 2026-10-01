mock_provider "aws" {
  override_during = plan

  mock_resource "aws_vpc_endpoint" {
    defaults = {
      id = "vpce-mock"
    }
  }
}

run "happy" {
  command = plan

  variables {
    aws_region          = "ap-southeast-2"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    vpc_id              = "vpc-mock"
    public_subnet_id    = "subnet-mock"
    broker_tunnel_token = "token-mock"
    policy_probe_action = null
  }

  override_resource {
    target = aws_security_group.broker
    values = {
      id = "sg-broker"
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
    condition     = aws_kms_alias.envelope.name == "alias/ch-staging-envelope"
    error_message = "envelope alias must be alias/ch-staging-envelope"
  }

  assert {
    condition     = aws_vpc_endpoint.kms.service_name == "com.amazonaws.ap-southeast-2.kms"
    error_message = "KMS endpoint service must be com.amazonaws.ap-southeast-2.kms"
  }

  assert {
    condition     = aws_vpc_endpoint.kms.vpc_endpoint_type == "Interface"
    error_message = "KMS endpoint must be an interface endpoint"
  }

  assert {
    condition     = aws_vpc_endpoint.kms.private_dns_enabled == true
    error_message = "KMS endpoint must enable private DNS"
  }

  assert {
    condition     = length(aws_security_group.broker.ingress) == 0
    error_message = "broker security group must set ingress = []"
  }

  assert {
    condition = (
      one(aws_security_group.endpoint.ingress).from_port == 443 &&
      one(aws_security_group.endpoint.ingress).to_port == 443 &&
      one(aws_security_group.endpoint.ingress).protocol == "tcp" &&
      length(one(aws_security_group.endpoint.ingress).cidr_blocks) == 0 &&
      toset(one(aws_security_group.endpoint.ingress).security_groups) == toset([aws_security_group.broker.id])
    )
    error_message = "endpoint ingress must be TCP 443 from the broker security group only"
  }

  assert {
    condition     = strcontains(file("${path.module}/main.tf"), "security_groups = [aws_security_group.broker.id]")
    error_message = "endpoint ingress source must be the broker security group in main.tf"
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
      statement.Condition["StringEquals"]["aws:SourceVpce"] == "vpce-mock" &&
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
    condition     = aws_iam_role.task.name == "ch-staging-kms-broker-task"
    error_message = "task role name must be ch-staging-kms-broker-task"
  }

  assert {
    condition     = !strcontains(file("${path.module}/main.tf"), "aws_iam_role_policy")
    error_message = "module must not declare aws_iam_role_policy"
  }

  assert {
    condition = (
      strcontains(one(aws_iam_role.execution.inline_policy).policy, "kms-broker-tunnel-token") &&
      strcontains(one(aws_iam_role.execution.inline_policy).policy, "secretsmanager:GetSecretValue") &&
      !strcontains(one(aws_iam_role.execution.inline_policy).policy, "kms:")
    )
    error_message = "execution role may read the broker tunnel secret and must not call kms"
  }

  assert {
    condition     = aws_secretsmanager_secret.broker_tunnel.kms_key_id == null
    error_message = "broker tunnel secret must use the AWS-managed key"
  }
}

run "probe_create_grant" {
  command = plan

  variables {
    aws_region          = "ap-southeast-2"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    vpc_id              = "vpc-mock"
    public_subnet_id    = "subnet-mock"
    broker_tunnel_token = "token-mock"
    policy_probe_action = "kms:CreateGrant"
  }

  expect_failures = [terraform_data.envelope_key_policy]
}

run "wrong_region" {
  command = plan

  variables {
    aws_region          = "us-east-1"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    vpc_id              = "vpc-mock"
    public_subnet_id    = "subnet-mock"
    broker_tunnel_token = "token-mock"
  }

  expect_failures = [var.aws_region]
}

run "rotation_off" {
  command = plan

  variables {
    aws_region          = "ap-southeast-2"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    vpc_id              = "vpc-mock"
    public_subnet_id    = "subnet-mock"
    broker_tunnel_token = "token-mock"
    enable_key_rotation = false
  }

  expect_failures = [var.enable_key_rotation]
}

run "log_retention_zero" {
  command = plan

  variables {
    aws_region          = "ap-southeast-2"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    vpc_id              = "vpc-mock"
    public_subnet_id    = "subnet-mock"
    broker_tunnel_token = "token-mock"
    log_retention_days  = 0
  }

  expect_failures = [var.log_retention_days]
}
