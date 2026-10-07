mock_provider "aws" {
  override_during = plan

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::mock-admin"
      bucket_regional_domain_name = "mock-admin.s3.ap-southeast-2.amazonaws.com"
    }
  }

  mock_resource "aws_cloudfront_origin_access_control" {
    defaults = {
      id = "E123MOCKOAC"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn            = "arn:aws:cloudfront::123456789012:distribution/MOCKDIST"
      domain_name    = "d111111abcdef8.cloudfront.net"
      hosted_zone_id = "Z2FDTNDATAQYW2"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock-admin"
      domain_validation_options = [
        {
          domain_name           = "admin.example.net"
          resource_record_name  = "_mock.admin.example.net."
          resource_record_type  = "CNAME"
          resource_record_value = "_mock.acm-validations.aws."
        },
      ]
    }
  }
}

run "happy" {
  command = plan

  variables {
    name        = "ch-staging"
    environment = "staging"
    project     = "community-hub"
    aws_region  = "ap-southeast-2"
    zone_name   = "example.net"
    zone_id     = "ZMOCKZONE"
  }

  assert {
    condition = (
      aws_s3_bucket.admin.bucket == "ch-staging-admin" &&
      aws_s3_bucket.admin.region == "ap-southeast-2" &&
      aws_s3_bucket_public_access_block.admin.region == "ap-southeast-2" &&
      aws_s3_bucket_server_side_encryption_configuration.admin.region == "ap-southeast-2" &&
      aws_s3_bucket_ownership_controls.admin.region == "ap-southeast-2" &&
      aws_s3_bucket_policy.admin.region == "ap-southeast-2"
    )
    error_message = "the bucket name is ch-staging-admin and the five S3 resources stay in ap-southeast-2"
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.admin.block_public_acls &&
      aws_s3_bucket_public_access_block.admin.block_public_policy &&
      aws_s3_bucket_public_access_block.admin.ignore_public_acls &&
      aws_s3_bucket_public_access_block.admin.restrict_public_buckets &&
      one(aws_s3_bucket_ownership_controls.admin.rule).object_ownership == "BucketOwnerEnforced" &&
      one(aws_s3_bucket_server_side_encryption_configuration.admin.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256" &&
      !strcontains(file("${path.module}/main.tf"), "kms_master_key_id")
    )
    error_message = "the bucket is private and encrypted with SSE-S3"
  }

  assert {
    condition = (
      try(toset(jsondecode(aws_s3_bucket_policy.admin.policy).Statement[0].Action), toset([jsondecode(aws_s3_bucket_policy.admin.policy).Statement[0].Action])) == toset(["s3:GetObject"]) &&
      jsondecode(aws_s3_bucket_policy.admin.policy).Statement[0].Principal != "*" &&
      keys(jsondecode(aws_s3_bucket_policy.admin.policy).Statement[0].Condition) == ["StringEquals"] &&
      keys(jsondecode(aws_s3_bucket_policy.admin.policy).Statement[0].Condition.StringEquals) == ["AWS:SourceArn"] &&
      jsondecode(aws_s3_bucket_policy.admin.policy).Statement[0].Condition.StringEquals["AWS:SourceArn"] == "arn:aws:cloudfront::123456789012:distribution/MOCKDIST"
    )
    error_message = "the bucket policy allows GetObject only through this distribution"
  }

  assert {
    condition = (
      one(aws_cloudfront_distribution.admin.origin).domain_name == "mock-admin.s3.ap-southeast-2.amazonaws.com" &&
      one(aws_cloudfront_distribution.admin.origin).origin_access_control_id == "E123MOCKOAC" &&
      aws_cloudfront_distribution.admin.aliases == toset(["admin.example.net"]) &&
      aws_cloudfront_distribution.admin.price_class == "PriceClass_All" &&
      aws_cloudfront_distribution.admin.is_ipv6_enabled == false &&
      aws_cloudfront_distribution.admin.web_acl_id == null &&
      length(aws_cloudfront_distribution.admin.logging_config) == 0 &&
      length(aws_cloudfront_distribution.admin.custom_error_response) == 0
    )
    error_message = "the distribution is pay-as-you-go, IPv6 off, with no web ACL, logs, or error rewrite"
  }

  assert {
    condition = (
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].content_security_policy[0].content_security_policy == "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'" &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].content_security_policy[0].override &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].strict_transport_security[0].access_control_max_age_sec == 31536000 &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].strict_transport_security[0].include_subdomains &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].strict_transport_security[0].preload == false &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].strict_transport_security[0].override &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].content_type_options[0].override &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].referrer_policy[0].referrer_policy == "no-referrer" &&
      aws_cloudfront_response_headers_policy.admin.security_headers_config[0].referrer_policy[0].override &&
      one(aws_cloudfront_response_headers_policy.admin.custom_headers_config[0].items).header == "X-Robots-Tag" &&
      one(aws_cloudfront_response_headers_policy.admin.custom_headers_config[0].items).value == "noindex" &&
      one(aws_cloudfront_response_headers_policy.admin.custom_headers_config[0].items).override
    )
    error_message = "the response headers match the five required values"
  }

  assert {
    condition = (
      aws_acm_certificate.admin.region == "us-east-1" &&
      aws_acm_certificate.admin.domain_name == "admin.example.net" &&
      aws_acm_certificate_validation.admin.region == "us-east-1" &&
      aws_acm_certificate_validation.admin.certificate_arn == "arn:aws:acm:us-east-1:123456789012:certificate/mock-admin"
    )
    error_message = "the viewer certificate and its validation stay in us-east-1"
  }

  assert {
    condition = (
      aws_route53_record.validation["admin.example.net"].name == "_mock.admin.example.net." &&
      aws_route53_record.validation["admin.example.net"].type == "CNAME" &&
      aws_route53_record.validation["admin.example.net"].records == toset(["_mock.acm-validations.aws."]) &&
      aws_route53_record.admin.type == "A" &&
      aws_route53_record.admin.alias[0].name == "d111111abcdef8.cloudfront.net" &&
      aws_route53_record.admin.alias[0].zone_id == "Z2FDTNDATAQYW2" &&
      aws_route53_record.admin.records == null
    )
    error_message = "DNS is one A alias and the certificate validation record"
  }

  assert {
    condition = (
      length(jsondecode(output.publish_policy).Statement) == 3 &&
      toset(flatten([
        for statement in jsondecode(output.publish_policy).Statement :
        try(tolist(statement.Action), [statement.Action])
      ])) == toset(["s3:ListBucket", "s3:PutObject", "s3:DeleteObject", "cloudfront:CreateInvalidation"]) &&
      one([
        for statement in jsondecode(output.publish_policy).Statement : statement
        if try(statement.Action, null) == "s3:ListBucket"
      ]).Resource == "arn:aws:s3:::mock-admin" &&
      one([
        for statement in jsondecode(output.publish_policy).Statement : statement
        if try(toset(statement.Action), toset([statement.Action])) == toset(["s3:PutObject", "s3:DeleteObject"])
      ]).Resource == "arn:aws:s3:::mock-admin/*" &&
      one([
        for statement in jsondecode(output.publish_policy).Statement : statement
        if try(statement.Action, null) == "cloudfront:CreateInvalidation"
      ]).Resource == "arn:aws:cloudfront::123456789012:distribution/MOCKDIST"
    )
    error_message = "the publish policy lists, writes, and deletes this bucket and invalidates this distribution only"
  }
}
