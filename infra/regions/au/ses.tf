resource "aws_sesv2_configuration_set" "mail" {
  count                  = local.ses_enabled ? 1 : 0
  configuration_set_name = "${local.name}-mail"

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_email_identity" "mail" {
  count                  = local.ses_enabled ? 1 : 0
  email_identity         = local.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.mail[0].configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "mail" {
  count                  = local.ses_enabled ? 1 : 0
  email_identity         = aws_sesv2_email_identity.mail[0].email_identity
  mail_from_domain       = "bounces.${local.mail_domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "ses_dkim" {
  count   = local.ses_enabled ? 3 : 0
  zone_id = coalesce(var.staging_zone_id, "ZUNUSED")
  name    = "${aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.mail_domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_mx" {
  count   = local.ses_enabled ? 1 : 0
  zone_id = coalesce(var.staging_zone_id, "ZUNUSED")
  name    = "bounces.${local.mail_domain}"
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.ap-southeast-2.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_txt" {
  count   = local.ses_enabled ? 1 : 0
  zone_id = coalesce(var.staging_zone_id, "ZUNUSED")
  name    = "bounces.${local.mail_domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "ses_dmarc_txt" {
  count   = local.ses_enabled ? 1 : 0
  zone_id = coalesce(var.staging_zone_id, "ZUNUSED")
  name    = "_dmarc.${local.mail_domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=none;"]
}

resource "aws_iam_role_policy" "ses_send" {
  count = local.ses_enabled ? 1 : 0
  name  = "ses-send"
  role  = module.envelope.task_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ses:SendEmail"]
        Resource = [
          "arn:aws:ses:${var.aws_region}:${var.aws_account_id}:identity/*",
          aws_sesv2_configuration_set.mail[0].arn,
        ]
        Condition = {
          StringEquals = {
            "ses:FromAddress" = local.mail_from
          }
        }
      },
    ]
  })
}
