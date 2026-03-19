# Data sources - account, region, and base infra remote state

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "terraform_remote_state" "base" {
  count = var.base_state_bucket != "" ? 1 : 0

  backend = "s3"
  config = {
    bucket         = var.base_state_bucket
    key            = local.base_state_key
    region         = var.base_state_region
    dynamodb_table = "rdi-terraform-locks"
    encrypt        = true
  }
}
