# WebSocket API Gateway Module
# modules/websocket-api/main.tf

# WebSocket API Gateway
resource "aws_apigatewayv2_api" "this" {
  name                       = var.api_name
  description                = var.api_description
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

# WebSocket API Gateway Stage
resource "aws_apigatewayv2_stage" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = var.stage_name
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 1000 # Increased from 100 for better scalability
    throttling_rate_limit  = 500  # Increased from 50 for better scalability
  }

  route_settings {
    route_key              = "$default"
    throttling_burst_limit = 1000 # Increased from 100 for better scalability
    throttling_rate_limit  = 500  # Increased from 50 for better scalability
  }

  route_settings {
    route_key              = "$connect"
    throttling_burst_limit = 1000 # Increased from 100 for better scalability
    throttling_rate_limit  = 500  # Increased from 50 for better scalability
  }

  route_settings {
    route_key              = "$disconnect"
    throttling_burst_limit = 1000 # Increased from 100 for better scalability
    throttling_rate_limit  = 500  # Increased from 50 for better scalability
  }

  tags = var.tags
}

# WebSocket API Gateway Deployment
resource "aws_apigatewayv2_deployment" "this" {
  api_id = aws_apigatewayv2_api.this.id

  depends_on = [
    aws_apigatewayv2_integration.connect,
    aws_apigatewayv2_integration.disconnect,
    aws_apigatewayv2_integration.default,
    aws_apigatewayv2_integration.message,
    aws_apigatewayv2_route.connect,
    aws_apigatewayv2_route.disconnect,
    aws_apigatewayv2_route.default,
    aws_apigatewayv2_route.message
  ]

  # Force new deployment when Lambda ARNs change
  triggers = {
    connection_lambda_arn = var.connection_lambda_arn
    message_lambda_arn    = var.message_lambda_arn
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Lambda Integration for $connect route
resource "aws_apigatewayv2_integration" "connect" {
  api_id               = aws_apigatewayv2_api.this.id
  integration_type     = "AWS_PROXY"
  integration_uri      = var.connection_lambda_arn
  integration_method   = "POST"
  timeout_milliseconds = 29000 # Maximum allowed (29 seconds)
}

# Lambda Integration for $disconnect route
resource "aws_apigatewayv2_integration" "disconnect" {
  api_id               = aws_apigatewayv2_api.this.id
  integration_type     = "AWS_PROXY"
  integration_uri      = var.connection_lambda_arn
  integration_method   = "POST"
  timeout_milliseconds = 29000 # Maximum allowed (29 seconds)
}

# Lambda Integration for $default route
resource "aws_apigatewayv2_integration" "default" {
  api_id               = aws_apigatewayv2_api.this.id
  integration_type     = "AWS_PROXY"
  integration_uri      = var.message_lambda_arn
  integration_method   = "POST"
  timeout_milliseconds = 29000 # Maximum allowed (29 seconds)
}

# Lambda Integration for message route
resource "aws_apigatewayv2_integration" "message" {
  api_id               = aws_apigatewayv2_api.this.id
  integration_type     = "AWS_PROXY"
  integration_uri      = var.message_lambda_arn
  integration_method   = "POST"
  timeout_milliseconds = 29000 # Maximum allowed (29 seconds)
}

# Route for $connect
resource "aws_apigatewayv2_route" "connect" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.connect.id}"
}

# Route for $disconnect
resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.disconnect.id}"
}

# Route for $default
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.default.id}"
}

# Route for message
resource "aws_apigatewayv2_route" "message" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "message"
  target    = "integrations/${aws_apigatewayv2_integration.message.id}"
}

# Lambda Permission for Connection Lambda
resource "aws_lambda_permission" "connection" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = var.connection_lambda_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

# Lambda Permission for Message Lambda
resource "aws_lambda_permission" "message" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = var.message_lambda_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
