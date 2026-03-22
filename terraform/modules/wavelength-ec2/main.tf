# Wavelength EC2 Module - PX4 SITL / Drone control at carrier edge
# Deploys EC2 in a Wavelength Zone for low-latency 5G connectivity
#
# Prerequisites: Opt in to the Wavelength Zone in AWS Console
# https://docs.aws.amazon.com/wavelength/latest/developerguide/get-started-wavelength.html#enable-zone-group

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# VPC for Wavelength (carrier gateway requires dedicated VPC or subnet in Wavelength zone)
resource "aws_vpc" "wavelength" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${var.project_name}-wavelength-vpc-${var.environment}"
  })
}

# Carrier Gateway - connects Wavelength subnet to carrier 5G network
resource "aws_ec2_carrier_gateway" "main" {
  vpc_id = aws_vpc.wavelength.id

  tags = merge(var.tags, {
    Name = "${var.project_name}-carrier-gateway-${var.environment}"
  })
}

# Subnet in Wavelength Zone (availability_zone = zone ID, e.g. use1-wl1-atl-wlz1)
resource "aws_subnet" "wavelength" {
  vpc_id            = aws_vpc.wavelength.id
  cidr_block        = var.wavelength_subnet_cidr
  availability_zone = var.wavelength_zone_id

  tags = merge(var.tags, {
    Name = "${var.project_name}-wavelength-subnet-${var.environment}"
  })
}

# Route table - send traffic via carrier gateway
resource "aws_route_table" "wavelength" {
  vpc_id = aws_vpc.wavelength.id

  route {
    cidr_block         = "0.0.0.0/0"
    carrier_gateway_id = aws_ec2_carrier_gateway.main.id
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-wavelength-rt-${var.environment}"
  })
}

resource "aws_route_table_association" "wavelength" {
  subnet_id      = aws_subnet.wavelength.id
  route_table_id = aws_route_table.wavelength.id
}

# Security group for PX4 SITL (MAVLink, HTTP API, SSH)
resource "aws_security_group" "wavelength" {
  name_prefix = "${var.project_name}-wavelength-"
  description = "Security group for Wavelength EC2 - PX4 SITL, MAVLink"
  vpc_id      = aws_vpc.wavelength.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_ssh_cidrs
  }

  ingress {
    description = "MAVLink (UDP)"
    from_port   = 14540
    to_port     = 14550
    protocol    = "udp"
    cidr_blocks = var.allowed_mavlink_cidrs
  }

  ingress {
    description = "HTTP API"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = var.allowed_api_cidrs
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-wavelength-sg-${var.environment}"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# IAM instance profile for EC2 (SSM, CloudWatch, S3 if needed)
data "aws_iam_policy_document" "instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name_prefix        = "${var.project_name}-wavelength-"
  assume_role_policy = data.aws_iam_policy_document.instance_assume.json

  tags = merge(var.tags, {
    Name = "${var.project_name}-wavelength-role-${var.environment}"
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "s3_agent_binary" {
  count = var.enable_agent_binary_s3_access && var.agent_binary_s3_bucket != "" ? 1 : 0

  name = "${var.project_name}-wavelength-agent-s3"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:aws:s3:::${var.agent_binary_s3_bucket}/${var.agent_binary_s3_key}*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:DescribeKey"]
        Resource = var.kms_key_arn
      }
    ]
  })
}

# Allow Wavelength instance to ship agent logs to CloudWatch (for connection failure debugging)
resource "aws_iam_role_policy" "cloudwatch_logs" {
  count = var.cloudwatch_log_group_name != "" ? 1 : 0

  name = "${var.project_name}-wavelength-cloudwatch-logs"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:${var.cloudwatch_log_group_name}:*"
      }
    ]
  })
}

# Allow Wavelength instance to query DynamoDB for session reinstate after agent reboot
resource "aws_iam_role_policy" "reinstate_dynamodb" {
  count = var.reinstate_connection_pool_table != "" && var.reinstate_relay_registry_table != "" ? 1 : 0

  name = "${var.project_name}-wavelength-reinstate-dynamodb"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem"
        ]
        Resource = [
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${var.reinstate_connection_pool_table}",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${var.reinstate_connection_pool_table}/index/*",
          "arn:aws:dynamodb:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:table/${var.reinstate_relay_registry_table}"
        ]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name_prefix = "${var.project_name}-wavelength-"
  role        = aws_iam_role.instance.name
}

# AMI - Amazon Linux 2023
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

# EC2 instance in Wavelength Zone
resource "aws_instance" "wavelength" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.wavelength.id
  vpc_security_group_ids = [aws_security_group.wavelength.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = var.key_name != "" ? var.key_name : null

  root_block_device {
    volume_size           = var.root_volume_size
    volume_type           = "gp2"
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
    Name = "${var.project_name}-px4-wavelength-${var.environment}"
    Type = "PX4-SITL"
  })

  # Avoid replacing instance on every apply when data.aws_ami returns a newer image
  lifecycle {
    ignore_changes = [ami]
  }
}

# Carrier IP (Elastic IP in Wavelength - required for carrier connectivity)
resource "aws_eip" "wavelength" {
  network_border_group = var.wavelength_zone_id
  domain               = "vpc"
  instance             = aws_instance.wavelength.id

  tags = merge(var.tags, {
    Name = "${var.project_name}-wavelength-eip-${var.environment}"
  })

  depends_on = [aws_instance.wavelength]
}
