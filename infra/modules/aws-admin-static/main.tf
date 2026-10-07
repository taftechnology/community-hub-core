locals {
  hostname                = "admin.${var.zone_name}"
  content_security_policy = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'"
  tags = {
    environment = var.environment
    project     = var.project
  }
  publish_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListAdminBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.admin.arn
      },
      {
        Sid      = "WriteAdminObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.admin.arn}/*"
      },
      {
        Sid      = "InvalidateAdmin"
        Effect   = "Allow"
        Action   = "cloudfront:CreateInvalidation"
        Resource = aws_cloudfront_distribution.admin.arn
      },
    ]
  })
}

resource "aws_s3_bucket" "admin" {
  bucket        = "${var.name}-admin"
  region        = var.aws_region
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "admin" {
  bucket                  = aws_s3_bucket.admin.id
  region                  = var.aws_region
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "admin" {
  bucket = aws_s3_bucket.admin.id
  region = var.aws_region

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "admin" {
  bucket = aws_s3_bucket.admin.id
  region = var.aws_region

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_cloudfront_origin_access_control" "admin" {
  name                              = "${var.name}-admin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "admin" {
  name = "${var.name}-admin"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      override = true
      value    = "noindex"
    }
  }
}

resource "aws_acm_certificate" "admin" {
  region            = "us-east-1"
  domain_name       = local.hostname
  validation_method = "DNS"
  tags              = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = toset([local.hostname])

  zone_id = var.zone_id
  name    = one(aws_acm_certificate.admin.domain_validation_options).resource_record_name
  type    = one(aws_acm_certificate.admin.domain_validation_options).resource_record_type
  records = [one(aws_acm_certificate.admin.domain_validation_options).resource_record_value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "admin" {
  region                  = "us-east-1"
  certificate_arn         = aws_acm_certificate.admin.arn
  validation_record_fqdns = [aws_route53_record.validation[local.hostname].fqdn]
}

resource "aws_cloudfront_distribution" "admin" {
  enabled             = true
  is_ipv6_enabled     = false
  price_class         = "PriceClass_All"
  default_root_object = "index.html"
  aliases             = [local.hostname]

  origin {
    domain_name              = aws_s3_bucket.admin.bucket_regional_domain_name
    origin_id                = "admin"
    origin_access_control_id = aws_cloudfront_origin_access_control.admin.id
  }

  default_cache_behavior {
    target_origin_id           = "admin"
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    response_headers_policy_id = aws_cloudfront_response_headers_policy.admin.id

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.admin.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.tags
}

resource "aws_s3_bucket_policy" "admin" {
  bucket = aws_s3_bucket.admin.id
  region = var.aws_region
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontRead"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.admin.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.admin.arn
          }
        }
      },
    ]
  })
}

resource "aws_route53_record" "admin" {
  zone_id = var.zone_id
  name    = local.hostname
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.admin.domain_name
    zone_id                = aws_cloudfront_distribution.admin.hosted_zone_id
    evaluate_target_health = false
  }
}
