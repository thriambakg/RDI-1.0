# RDI Edge - resources inlined (no submodules). Add one resource at a time.
# Base: VPC. Everything else (subnets, ALB, proxy EC2, etc.) will live inside this VPC.
# Name includes infra_version so that only a version bump (or change to this file) triggers replacement.

resource "aws_vpc" "proxy" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-vpc-${var.environment}-v${var.infra_version}"
  })
}
