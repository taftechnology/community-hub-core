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

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-envelope"
      key_id = "mock-envelope"
    }
  }

  mock_resource "aws_kms_replica_key" {
    defaults = {
      arn    = "arn:aws:kms:ap-southeast-4:123456789012:key/mock-envelope-replica"
      key_id = "mock-envelope-replica"
    }
  }

  mock_resource "aws_kms_alias" {
    defaults = {
      arn            = "arn:aws:kms:ap-southeast-2:123456789012:alias/mock-envelope"
      target_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-envelope"
    }
  }
}

run "happy" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    policy_probe_action    = null
    db_secret_arns = [
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
    ]
    db_secrets_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
    billing_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"
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
    condition = (
      aws_kms_key.envelope.tags["environment"] == "staging" &&
      aws_kms_key.envelope.tags["project"] == "community-hub"
    )
    error_message = "envelope key tags must be environment=staging and project=community-hub"
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
    condition     = length(jsondecode(aws_kms_key.envelope.policy).Statement) == 6
    error_message = "envelope key policy must have exactly six statements"
  }

  assert {
    condition = [for statement in jsondecode(aws_kms_key.envelope.policy).Statement : statement.Sid] == [
      "Admin",
      "GenerateDataKeyOrg",
      "GenerateDataKeyIdentity",
      "DecryptOrg",
      "DecryptIdentity",
      "ReplicateToMelbourne",
    ]
    error_message = "envelope key policy sids must be Admin, GenerateDataKeyOrg, GenerateDataKeyIdentity, DecryptOrg, DecryptIdentity, ReplicateToMelbourne"
  }

  assert {
    condition = (
      toset(jsondecode(aws_kms_key.envelope.policy).Statement[0].Action) == toset([
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
      ]) &&
      !contains(jsondecode(aws_kms_key.envelope.policy).Statement[0].Action, "kms:ReplicateKey")
    )
    error_message = "admin actions must equal the 16-name set and must not include kms:ReplicateKey"
  }

  assert {
    condition = (
      jsondecode(aws_kms_key.envelope.policy).Statement[5].Sid == "ReplicateToMelbourne" &&
      jsondecode(aws_kms_key.envelope.policy).Statement[5].Principal.AWS == "arn:aws:iam::123456789012:root" &&
      jsondecode(aws_kms_key.envelope.policy).Statement[5].Resource == "*" &&
      try(toset(jsondecode(aws_kms_key.envelope.policy).Statement[5].Action), toset([jsondecode(aws_kms_key.envelope.policy).Statement[5].Action])) == toset(["kms:ReplicateKey"]) &&
      keys(jsondecode(aws_kms_key.envelope.policy).Statement[5].Condition.StringEquals) == ["kms:ReplicaRegion"] &&
      jsondecode(aws_kms_key.envelope.policy).Statement[5].Condition.StringEquals["kms:ReplicaRegion"] == "ap-southeast-4" &&
      keys(jsondecode(aws_kms_key.envelope.policy).Statement[5].Condition) == ["StringEquals"]
    )
    error_message = "ReplicateToMelbourne must allow only kms:ReplicateKey into ap-southeast-4"
  }

  assert {
    condition     = aws_kms_replica_key.envelope.region == "ap-southeast-4"
    error_message = "envelope replica region must be ap-southeast-4"
  }

  assert {
    condition = (
      aws_kms_replica_key.envelope.primary_key_arn == aws_kms_key.envelope.arn &&
      aws_kms_replica_key.envelope.primary_key_arn == "arn:aws:kms:ap-southeast-2:123456789012:key/mock-envelope"
    )
    error_message = "envelope replica must target the mocked envelope key ARN"
  }

  assert {
    condition     = aws_kms_replica_key.envelope.deletion_window_in_days == 30
    error_message = "envelope replica deletion window must be 30 days"
  }

  assert {
    condition     = aws_kms_replica_key.envelope.bypass_policy_lockout_safety_check == false
    error_message = "envelope replica must keep the policy lockout safety check"
  }

  assert {
    condition = (
      aws_kms_replica_key.envelope.tags["environment"] == "staging" &&
      aws_kms_replica_key.envelope.tags["project"] == "community-hub"
    )
    error_message = "envelope replica tags must be environment=staging and project=community-hub"
  }

  assert {
    condition = (
      length(jsondecode(aws_kms_replica_key.envelope.policy).Statement) == 1 &&
      jsondecode(aws_kms_replica_key.envelope.policy).Statement[0].Sid == "Admin" &&
      try(toset(jsondecode(aws_kms_replica_key.envelope.policy).Statement[0].Action), toset([jsondecode(aws_kms_replica_key.envelope.policy).Statement[0].Action])) == toset([
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
      ]) &&
      !strcontains(aws_kms_replica_key.envelope.policy, "kms:Decrypt") &&
      !strcontains(aws_kms_replica_key.envelope.policy, "kms:GenerateDataKey") &&
      !strcontains(aws_kms_replica_key.envelope.policy, "arn:aws:iam::123456789012:role/ch-staging-task")
    )
    error_message = "replica policy must be the admin statement only"
  }

  assert {
    condition = (
      aws_kms_alias.envelope_replica.region == "ap-southeast-4" &&
      aws_kms_alias.envelope_replica.name == "alias/ch-staging-envelope" &&
      aws_kms_alias.envelope_replica.target_key_id == aws_kms_replica_key.envelope.key_id &&
      aws_kms_alias.envelope_replica.target_key_id == "mock-envelope-replica"
    )
    error_message = "replica alias must target the Melbourne replica key"
  }

  assert {
    condition = (
      aws_kms_alias.envelope.name == "alias/ch-staging-envelope" &&
      aws_kms_alias.envelope.region == "ap-southeast-2"
    )
    error_message = "Sydney envelope alias must stay alias/ch-staging-envelope in ap-southeast-2"
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
    condition = (
      strcontains(aws_iam_role_policy.task_secrets.policy, "secretsmanager:GetSecretValue") &&
      strcontains(aws_iam_role_policy.task_secrets.policy, "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf") &&
      [
        for statement in jsondecode(aws_iam_role_policy.task_secrets.policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "kms:Decrypt")
      ] == ["arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"]
    )
    error_message = "task secrets policy must read the app secret and decrypt only the secrets key"
  }

  assert {
    condition = (
      length([
        for statement in jsondecode(aws_iam_role_policy.task_secrets.policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "secretsmanager:GetSecretValue") &&
        statement.Resource == "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-??????"
      ]) == 1
    )
    error_message = "task secrets policy must grant GetSecretValue on exactly one fixed provision-owner secret name"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.task_secrets.policy, "\"*\"")
    error_message = "task secrets policy must never contain a bare wildcard resource"
  }

  assert {
    condition = jsondecode(aws_iam_role_policy.task_secrets.policy).Statement == [
      {
        Sid    = "ReadDbSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
          "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
          "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
        ]
      },
      {
        Sid      = "DecryptDbSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
      },
      {
        Sid      = "ReadProvisionSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-??????"
      },
      {
        Sid      = "ReadBillingSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"
      },
    ]
    error_message = "task_secrets policy statements must match the exact expected four statements including ReadBillingSecret"
  }

  assert {
    condition = one([
      for statement in jsondecode(aws_iam_role_policy.task_secrets.policy).Statement :
      statement.Action
      if statement.Sid == "ReadProvisionSecret"
    ]) == ["secretsmanager:GetSecretValue"]
    error_message = "the provision-owner statement must allow only secretsmanager:GetSecretValue"
  }

  assert {
    condition = (
      strcontains(aws_iam_role_policy.execution_secrets.policy, "secretsmanager:GetSecretValue") &&
      strcontains(aws_iam_role_policy.execution_secrets.policy, "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf") &&
      [
        for statement in jsondecode(aws_iam_role_policy.execution_secrets.policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "kms:Decrypt")
      ] == ["arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"]
    )
    error_message = "execution secrets policy must read the app secret and decrypt only the secrets key"
  }

  assert {
    condition = (
      !strcontains(aws_iam_role_policy.execution_secrets.policy, "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:master") &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.execution_secrets.policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "secretsmanager:GetSecretValue")
        ])) == toset([
        "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
        "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
        "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
      ])
    )
    error_message = "execution secrets must be the three role secrets and must not include the master secret"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.execution_secrets.policy, var.billing_secret_arn)
    error_message = "execution secrets policy must not contain the billing secret ARN"
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
    error_message = "service execution log policy may write service logs and must not call kms"
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
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    enable_kms_endpoint    = true
    db_secret_arns = [
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
    ]
    db_secrets_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
    billing_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"
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
    condition = (
      length(regexall("resource[[:space:]]+\"aws_vpc_security_group_ingress_rule\"", file("${path.module}/main.tf"))) == 0 &&
      length(regexall("resource[[:space:]]+\"aws_vpc_security_group_egress_rule\"", file("${path.module}/main.tf"))) == 0
    )
    error_message = "envelope module must not declare a standalone security group rule"
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

  assert {
    condition = (
      !strcontains(one([
        for statement in jsondecode(aws_kms_key.envelope.policy).Statement : jsonencode(statement)
        if statement.Sid == "ReplicateToMelbourne"
      ]), "aws:SourceVpce") &&
      !strcontains(aws_kms_replica_key.envelope.policy, "aws:SourceVpce")
    )
    error_message = "ReplicateToMelbourne and the replica policy must not contain aws:SourceVpce"
  }
}

run "probe_create_grant" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    policy_probe_action    = "kms:CreateGrant"
    db_secret_arns = [
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
    ]
    db_secrets_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
    billing_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"
  }

  expect_failures = [terraform_data.envelope_key_policy]
}

run "wrong_region" {
  command = plan

  variables {
    aws_region             = "us-east-1"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    db_secret_arns = [
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
    ]
    db_secrets_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
    billing_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"
  }

  expect_failures = [var.aws_region]
}

run "rotation_off" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    enable_key_rotation    = false
    db_secret_arns = [
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
    ]
    db_secrets_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
    billing_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"
  }

  expect_failures = [var.enable_key_rotation]
}

run "log_retention_zero" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-mock"
    public_subnet_id       = "subnet-mock"
    task_security_group_id = "sg-task"
    log_retention_days     = 0
    db_secret_arns = [
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-AbCdEf",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-AbCdEf",
    ]
    db_secrets_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
    billing_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"
  }

  expect_failures = [var.log_retention_days]
}
