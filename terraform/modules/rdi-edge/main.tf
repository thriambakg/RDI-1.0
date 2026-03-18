# RDI Edge - resources inlined (no submodules). VPC + proxy EC2.
# Name includes infra_version where replacement on version bump is desired.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}
locals {
  az_names_sorted = sort(data.aws_availability_zones.available.names)
}

# --- VPC ---
resource "aws_vpc" "proxy" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-vpc-${var.environment}-v${var.infra_version}"
  })
}

# --- Internet Gateway ---
resource "aws_internet_gateway" "proxy" {
  vpc_id = aws_vpc.proxy.id

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-igw-${var.environment}-v${var.infra_version}"
  })
}

# --- Proxy subnet ---
resource "aws_subnet" "proxy" {
  vpc_id                  = aws_vpc.proxy.id
  cidr_block              = var.proxy_subnet_cidr
  availability_zone       = local.az_names_sorted[0]
  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-subnet-${var.environment}-v${var.infra_version}"
  })
}

resource "aws_route_table" "proxy" {
  vpc_id = aws_vpc.proxy.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.proxy.id
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-rt-${var.environment}-v${var.infra_version}"
  })
}

resource "aws_route_table_association" "proxy" {
  subnet_id      = aws_subnet.proxy.id
  route_table_id = aws_route_table.proxy.id
}

# --- Security group ---
resource "aws_security_group" "proxy" {
  name_prefix = "${var.project_name}-proxy-"
  description = "Proxy EC2 - WebSocket, UDP MAVLink, health, status API"
  vpc_id      = aws_vpc.proxy.id

  ingress {
    description = "WebSocket"
    from_port   = var.proxy_websocket_port
    to_port     = var.proxy_websocket_port
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  ingress {
    description = "Health check"
    from_port   = var.proxy_health_port
    to_port     = var.proxy_health_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  ingress {
    description = "Session status API (Lambda)"
    from_port   = var.proxy_status_port
    to_port     = var.proxy_status_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "MAVLink UDP"
    from_port   = 14540
    to_port     = 14550
    protocol    = "udp"
    cidr_blocks = var.allowed_cidrs
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_ssh_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-sg-${var.environment}-v${var.infra_version}"
  })

  lifecycle { create_before_destroy = true }
}

# --- IAM ---
data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name_prefix        = "${var.project_name}-proxy-"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-role-${var.environment}-v${var.infra_version}"
  })
}

resource "aws_iam_role_policy_attachment" "proxy_ssm" {
  role       = aws_iam_role.proxy.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "proxy_s3" {
  count = var.enable_s3_proxy_binary_access ? 1 : 0

  name = "${var.project_name}-proxy-s3"
  role = aws_iam_role.proxy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "arn:aws:s3:::${var.proxy_binary_s3_bucket}/${var.proxy_binary_s3_key}*"
    }]
  })
}

resource "aws_iam_role_policy" "proxy_cloudwatch_logs" {
  count = var.cloudwatch_log_group_name != "" ? 1 : 0

  name = "${var.project_name}-proxy-cloudwatch-logs"
  role = aws_iam_role.proxy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogStreams",
          "logs:DescribeLogGroups", "logs:PutLogEvents"
        ]
        Resource = [
          "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${var.cloudwatch_log_group_name}:*",
          "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${var.cloudwatch_log_group_name}"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "CWAgent" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeVolumes", "ec2:DescribeTags"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "proxy" {
  name_prefix = "${var.project_name}-proxy-"
  role        = aws_iam_role.proxy.name
}

# --- AMI ---
data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-*-kernel-*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

# --- Proxy instance ---
resource "aws_instance" "proxy" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.proxy.id
  vpc_security_group_ids = [aws_security_group.proxy.id]
  iam_instance_profile   = aws_iam_instance_profile.proxy.name
  key_name               = var.key_name != "" ? var.key_name : null

  root_block_device {
    volume_size           = var.root_volume_size
    volume_type           = "gp3"
    encrypted             = true
    kms_key_id            = var.kms_key_arn
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = var.user_data

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-${var.environment}-v${var.infra_version}"
    Type = "MAVLink-Proxy"
  })

  lifecycle { ignore_changes = [ami] }
}

resource "aws_eip" "proxy" {
  domain   = "vpc"
  instance = aws_instance.proxy.id

  tags = merge(var.tags, {
    Name = "${var.project_name}-proxy-eip-${var.environment}-v${var.infra_version}"
  })

  depends_on = [aws_instance.proxy]
}
