# Proxy ECS - Fargate proxy for WebSocket + session-status. VPC, ALB, ECS.

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
  az_names = sort(data.aws_availability_zones.available.names)
}

# --- VPC ---
resource "aws_vpc" "proxy" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(var.tags, { Name = "${var.project_name}-proxy-vpc-${var.environment}" })
}

resource "aws_internet_gateway" "proxy" {
  vpc_id = aws_vpc.proxy.id
  tags   = merge(var.tags, { Name = "${var.project_name}-proxy-igw-${var.environment}" })
}

resource "aws_subnet" "proxy" {
  count                   = 2
  vpc_id                  = aws_vpc.proxy.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.az_names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(var.tags, { Name = "${var.project_name}-proxy-subnet-${var.environment}-${count.index}" })
}

resource "aws_route_table" "proxy" {
  vpc_id = aws_vpc.proxy.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.proxy.id
  }
  tags = merge(var.tags, { Name = "${var.project_name}-proxy-rt-${var.environment}" })
}

resource "aws_route_table_association" "proxy" {
  count          = 2
  subnet_id      = aws_subnet.proxy[count.index].id
  route_table_id = aws_route_table.proxy.id
}

# --- Security groups ---
resource "aws_security_group" "alb" {
  name_prefix = "${var.project_name}-proxy-alb-"
  description = "ALB for proxy WebSocket and session-status"
  vpc_id      = aws_vpc.proxy.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(var.tags, { Name = "${var.project_name}-proxy-alb-${var.environment}" })
}

resource "aws_security_group" "ecs" {
  name_prefix = "${var.project_name}-proxy-ecs-"
  description = "ECS proxy tasks"
  vpc_id      = aws_vpc.proxy.id

  ingress {
    from_port       = var.proxy_websocket_port
    to_port         = var.proxy_websocket_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  ingress {
    from_port       = var.proxy_health_port
    to_port         = var.proxy_health_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  ingress {
    from_port       = var.proxy_status_port
    to_port         = var.proxy_status_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(var.tags, { Name = "${var.project_name}-proxy-ecs-${var.environment}" })
}

# --- ALB ---
resource "aws_lb" "proxy" {
  name               = "${var.project_name}-proxy-alb-${var.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.proxy[*].id
  idle_timeout       = var.alb_idle_timeout_seconds
  tags               = merge(var.tags, { Name = "${var.project_name}-proxy-alb-${var.environment}" })
}

resource "aws_lb_target_group" "proxy" {
  name        = "${var.project_name}-proxy-tg-${var.environment}"
  port        = var.proxy_websocket_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.proxy.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 6
    interval            = 15
    timeout             = 10
    path                = "/"
    port                = "8766"
    protocol            = "HTTP"
    matcher             = "200"
  }
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400 # 24h - matches WebSocket long-lived sessions
    enabled         = true
  }
  deregistration_delay = 30
  tags                 = merge(var.tags, { Name = "${var.project_name}-proxy-tg-${var.environment}" })
}

resource "aws_lb_target_group" "proxy_status" {
  count       = var.certificate_arn != "" ? 1 : 0
  name        = "${var.project_name}-proxy-st-tg-${var.environment}"
  port        = var.proxy_status_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.proxy.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 6
    interval            = 15
    timeout             = 10
    path                = "/"
    port                = "8766"
    protocol            = "HTTP"
    matcher             = "200"
  }
  deregistration_delay = 30
  tags                 = merge(var.tags, { Name = "${var.project_name}-proxy-st-tg-${var.environment}" })
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.proxy.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.proxy.arn
  }
}

resource "aws_lb_listener_rule" "session_status" {
  count        = var.certificate_arn != "" ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 5

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.proxy_status[0].arn
  }
  condition {
    path_pattern { values = ["/session-status"] }
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.proxy.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.certificate_arn != "" ? "redirect" : "forward"
    target_group_arn = var.certificate_arn == "" ? aws_lb_target_group.proxy.arn : null
    dynamic "redirect" {
      for_each = var.certificate_arn != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

# Session-status on HTTP (when no HTTPS) - Lambda needs this path
resource "aws_lb_listener_rule" "session_status_http" {
  count        = var.certificate_arn == "" ? 1 : 0
  listener_arn = aws_lb_listener.http.arn
  priority     = 5

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.proxy_status_http[0].arn
  }
  condition {
    path_pattern { values = ["/session-status"] }
  }
}

resource "aws_lb_target_group" "proxy_status_http" {
  count       = var.certificate_arn == "" ? 1 : 0
  name        = "${var.project_name}-proxy-st-http-${var.environment}"
  port        = var.proxy_status_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.proxy.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 6
    interval            = 15
    timeout             = 10
    path                = "/"
    port                = "8766"
    protocol            = "HTTP"
    matcher             = "200"
  }
  deregistration_delay = 30
  tags                 = merge(var.tags, { Name = "${var.project_name}-proxy-st-http-${var.environment}" })
}

# --- ECS ---
resource "aws_ecs_cluster" "proxy" {
  name = "${var.project_name}-proxy-${var.environment}"
  tags = merge(var.tags, { Name = "${var.project_name}-proxy-cluster-${var.environment}" })
}

resource "aws_iam_role" "execution" {
  name = "${var.project_name}-proxy-exec-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
  tags = merge(var.tags, { Name = "${var.project_name}-proxy-exec-${var.environment}" })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ECR, CloudWatch, and Secrets Manager (for proxy_status_secret) access
resource "aws_iam_role_policy" "execution_custom" {
  name = "${var.project_name}-proxy-exec-custom-${var.environment}"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Effect   = "Allow"
          Action   = ["ecr:GetAuthorizationToken"]
          Resource = "*"
        },
        {
          Effect   = "Allow"
          Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
          Resource = var.ecr_repository_arn
        },
        {
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = "arn:aws:logs:*:*:log-group:${var.cloudwatch_log_group_name}:*"
        }
      ],
      var.proxy_status_secret_arn != "" ? [{
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.proxy_status_secret_arn
      }] : []
    )
  })
}

resource "aws_ecs_task_definition" "proxy" {
  family                   = "${var.project_name}-proxy-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "proxy"
    image     = "${var.ecr_repository_url}:latest"
    essential = true

    portMappings = [
      { containerPort = var.proxy_websocket_port, protocol = "tcp" },
      { containerPort = var.proxy_health_port, protocol = "tcp" },
      { containerPort = var.proxy_status_port, protocol = "tcp" }
    ]

    environment = concat(
      [
        { name = "RDI_PROXY_WS_PORT", value = tostring(var.proxy_websocket_port) },
        { name = "RDI_PROXY_HEALTH_PORT", value = tostring(var.proxy_health_port) },
        { name = "RDI_PROXY_STATUS_PORT", value = tostring(var.proxy_status_port) },
      ],
      var.proxy_status_secret_arn != "" ? [] : [{ name = "RDI_PROXY_STATUS_SECRET", value = var.proxy_status_secret }]
    )
    # Prefer Secrets Manager so Lambda and proxy share the same secret (avoids 401 on session-status)
    secrets = var.proxy_status_secret_arn != "" ? [
      { name = "RDI_PROXY_STATUS_SECRET", valueFrom = "${var.proxy_status_secret_arn}:value::" }
    ] : []

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.cloudwatch_log_group_name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "proxy"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:8766/ || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])

  tags = merge(var.tags, { Name = "${var.project_name}-proxy-task-${var.environment}" })
}

resource "aws_ecs_service" "proxy" {
  name            = "${var.project_name}-proxy-${var.environment}"
  cluster         = aws_ecs_cluster.proxy.id
  task_definition = aws_ecs_task_definition.proxy.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 50
  health_check_grace_period_seconds  = 120

  network_configuration {
    subnets          = aws_subnet.proxy[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.proxy.arn
    container_name   = "proxy"
    container_port   = var.proxy_websocket_port
  }

  dynamic "load_balancer" {
    for_each = var.certificate_arn != "" ? toset([aws_lb_target_group.proxy_status[0].arn]) : toset([])
    content {
      target_group_arn = load_balancer.value
      container_name   = "proxy"
      container_port   = var.proxy_status_port
    }
  }
  dynamic "load_balancer" {
    for_each = var.certificate_arn == "" ? toset([aws_lb_target_group.proxy_status_http[0].arn]) : toset([])
    content {
      target_group_arn = load_balancer.value
      container_name   = "proxy"
      container_port   = var.proxy_status_port
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = merge(var.tags, { Name = "${var.project_name}-proxy-service-${var.environment}" })
}
