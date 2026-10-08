output "bucket_name" {
  description = "Admin static bucket name."
  value       = aws_s3_bucket.admin.bucket
}

output "distribution_id" {
  description = "Admin CloudFront distribution id."
  value       = aws_cloudfront_distribution.admin.id
}

output "distribution_arn" {
  description = "Admin CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.admin.arn
}

output "publish_policy" {
  description = "IAM policy for the admin publish role."
  value       = local.publish_policy
}
