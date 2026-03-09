# VPC Module for Secure Networking
# modules/vpc/main.tf

# Get available availability zones
data "aws_availability_zones" "available" {
  state = "available"
}

# VPC
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${var.project_name}-vpc-${var.environment}"
  })
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.tags, {
    Name = "${var.project_name}-igw-${var.environment}"
  })
}

# Public Subnets
# Public Subnets
# tfsec:ignore:aws-ec2-no-public-ip-subnet - Public subnets intentionally assign public IPs
resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.project_name}-public-subnet-${count.index + 1}-${var.environment}"
    Type = "Public"
  })
}

# Private Subnets
resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + var.az_count)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(var.tags, {
    Name = "${var.project_name}-private-subnet-${count.index + 1}-${var.environment}"
    Type = "Private"
  })
}

# Elastic IPs for NAT Gateways
resource "aws_eip" "nat" {
  count = var.az_count

  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]

  tags = merge(var.tags, {
    Name = "${var.project_name}-nat-eip-${count.index + 1}-${var.environment}"
  })
}

# NAT Gateways
resource "aws_nat_gateway" "main" {
  count = var.az_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.tags, {
    Name = "${var.project_name}-nat-gateway-${count.index + 1}-${var.environment}"
  })

  depends_on = [aws_internet_gateway.main]
}

# Route Table for Public Subnets
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-public-rt-${var.environment}"
  })
}

# Route Table Associations for Public Subnets
resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Route Tables for Private Subnets
resource "aws_route_table" "private" {
  count = var.az_count

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-private-rt-${count.index + 1}-${var.environment}"
  })
}

# Route Table Associations for Private Subnets
resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# VPC Flow Logs for security monitoring
resource "aws_flow_log" "vpc" {
  iam_role_arn    = aws_iam_role.flow_log.arn
  log_destination = aws_cloudwatch_log_group.vpc_flow_log.arn
  traffic_type    = "ALL"
  vpc_id          = aws_vpc.main.id

  tags = merge(var.tags, {
    Name = "${var.project_name}-vpc-flow-logs-${var.environment}"
  })
}

# CloudWatch Log Group for VPC Flow Logs
resource "aws_cloudwatch_log_group" "vpc_flow_log" {
  name              = "/aws/vpc/flowlogs/${var.project_name}-${var.environment}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = merge(var.tags, {
    Name = "${var.project_name}-vpc-flow-log-group-${var.environment}"
  })
}

# IAM Role for VPC Flow Logs
resource "aws_iam_role" "flow_log" {
  name = "${var.project_name}-flow-log-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "vpc-flow-logs.amazonaws.com"
        }
      }
    ]
  })

  lifecycle {
    ignore_changes = [name]
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-flow-log-role-${var.environment}"
  })
}

# IAM Policy Document for VPC Flow Logs
data "aws_iam_policy_document" "flow_log" {
  # CloudWatch Logs - log group access
  statement {
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams"
    ]
    resources = [aws_cloudwatch_log_group.vpc_flow_log.arn]
  }

  # CloudWatch Logs - log stream operations
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = [aws_cloudwatch_log_group.vpc_flow_log.arn]
    condition {
      test     = "StringEquals"
      variable = "logs:log-group"
      values   = [aws_cloudwatch_log_group.vpc_flow_log.name]
    }
  }
}

# IAM Policy for VPC Flow Logs
resource "aws_iam_role_policy" "flow_log" {
  name   = "${var.project_name}-flow-log-policy-${var.environment}"
  role   = aws_iam_role.flow_log.id
  policy = data.aws_iam_policy_document.flow_log.json
}
