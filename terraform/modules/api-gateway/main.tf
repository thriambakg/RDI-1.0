# Simplified API Gateway Module
# Based on working CloudFormation pattern

# REST API Gateway
resource "aws_api_gateway_rest_api" "this" {
  name        = var.api_name
  description = var.api_description

  endpoint_configuration {
    types = ["EDGE"]
  }

  tags = var.tags
}

# Cognito Authorizer (required)
resource "aws_api_gateway_authorizer" "cognito" {
  name            = "${var.api_name}-cognito-authorizer"
  rest_api_id     = aws_api_gateway_rest_api.this.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [var.cognito_user_pool_arn]
  identity_source = "method.request.header.Authorization"

  # Cache auth results for 5 minutes to reduce Cognito calls
  authorizer_result_ttl_in_seconds = 300
}

# API Gateway deployment
resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  triggers = {
    redeployment = var.deployment_trigger
  }

  depends_on = [
    aws_api_gateway_rest_api.this,
    aws_api_gateway_resource.this,
    aws_api_gateway_method.this,
    aws_api_gateway_integration.this,
    aws_api_gateway_method_response.this,
    aws_api_gateway_integration_response.this,
    aws_api_gateway_method.options_methods,
    aws_api_gateway_integration.options_integrations,
    aws_api_gateway_method_response.options_method_responses,
    aws_api_gateway_integration_response.options_integration_responses,
    aws_api_gateway_gateway_response.cors_4xx,
    aws_api_gateway_gateway_response.cors_5xx,
    aws_api_gateway_gateway_response.cors_401,
    aws_api_gateway_gateway_response.cors_403
  ]

  lifecycle {
    create_before_destroy = true
  }
}

# API Gateway stage
resource "aws_api_gateway_stage" "this" {
  deployment_id = aws_api_gateway_deployment.this.id
  rest_api_id   = aws_api_gateway_rest_api.this.id
  stage_name    = var.stage_name

  tags = var.tags
}

# Resources - dynamically created based on var.resources
resource "aws_api_gateway_resource" "this" {
  for_each = var.resources

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = each.value.path_part


  lifecycle {
    create_before_destroy = true
  }
}

# Methods - dynamically created based on var.methods
resource "aws_api_gateway_method" "this" {
  for_each = var.methods

  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.this[each.value.resource_key].id
  http_method   = each.value.http_method
  authorization = var.force_cognito_authorization ? "COGNITO_USER_POOLS" : each.value.authorization_type
  authorizer_id = var.force_cognito_authorization || each.value.authorization_type == "COGNITO_USER_POOLS" ? aws_api_gateway_authorizer.cognito.id : null

  authorization_scopes = each.value.authorization_scopes

  request_parameters = each.value.request_parameters

  lifecycle {
    create_before_destroy = true
  }
}

# Integrations - dynamically created based on var.methods
resource "aws_api_gateway_integration" "this" {
  for_each = var.methods

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.value.resource_key].id
  http_method = aws_api_gateway_method.this[each.key].http_method

  type                    = each.value.integration_type
  integration_http_method = each.value.integration_http_method
  uri                     = each.value.lambda_arn != null ? "arn:aws:apigateway:${data.aws_region.current.name}:lambda:path/2015-03-31/functions/${each.value.lambda_arn}/invocations" : null
  timeout_milliseconds    = each.value.timeout_milliseconds

  # For MOCK integrations
  request_templates = each.value.integration_type == "MOCK" ? {
    "application/json" = "{\"statusCode\": 200}"
  } : null

  passthrough_behavior = each.value.integration_type == "MOCK" ? "WHEN_NO_MATCH" : null

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_method.this
  ]
}

# Method responses - dynamically created based on var.methods
resource "aws_api_gateway_method_response" "this" {
  for_each = var.methods

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.value.resource_key].id
  http_method = aws_api_gateway_method.this[each.key].http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers"     = true
    "method.response.header.Access-Control-Allow-Methods"     = true
    "method.response.header.Access-Control-Allow-Origin"      = true
    "method.response.header.Access-Control-Allow-Credentials" = true
  }

  response_models = {
    "application/json" = "Empty"
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_method.this
  ]
}

# Integration responses - for all methods (both Lambda and MOCK)
resource "aws_api_gateway_integration_response" "this" {
  for_each = var.methods

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.value.resource_key].id
  http_method = aws_api_gateway_method.this[each.key].http_method
  status_code = aws_api_gateway_method_response.this[each.key].status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With'"
    "method.response.header.Access-Control-Allow-Methods" = "'POST,OPTIONS,GET,DELETE,PUT'"
    # Note: Integration response parameters don't support dynamic header mapping
    # For AWS_PROXY, Lambda functions must return CORS headers in their response
    # This is just a placeholder - actual CORS headers come from Lambda
    "method.response.header.Access-Control-Allow-Origin"      = "'*'"
    "method.response.header.Access-Control-Allow-Credentials" = "'true'"
  }

  # For MOCK integrations, we need a response template
  response_templates = each.value.integration_type == "MOCK" ? {
    "application/json" = "{\"statusCode\": 200}"
    } : {
    "application/json" = ""
  }

  # Add lifecycle to prevent recreation issues
  lifecycle {
    create_before_destroy = true
  }

  # Ensure all dependencies exist before creating response
  depends_on = [
    aws_api_gateway_integration.this,
    aws_api_gateway_method_response.this
  ]
}

# Lambda permissions - dynamically created based on var.lambda_permissions
resource "aws_lambda_permission" "lambda_permissions" {
  for_each = var.lambda_permissions

  statement_id  = "AllowExecutionFromAPIGateway_${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_arn
  principal     = "apigateway.amazonaws.com"

  source_arn = "${aws_api_gateway_rest_api.this.execution_arn}/*/${each.value.http_method}/${each.value.resource_path}"
}

# Data source for current region
data "aws_region" "current" {}

# Automatic OPTIONS methods for CORS - one for each resource
resource "aws_api_gateway_method" "options_methods" {
  for_each = var.resources

  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.this[each.key].id
  http_method   = "OPTIONS"
  authorization = "NONE"

  # Declare Origin header in request parameters so we can reference it in integration response
  request_parameters = {
    "method.request.header.Origin" = false # false means optional, true means required
  }

  lifecycle {
    create_before_destroy = true
  }
}

# OPTIONS integrations - MOCK integrations for CORS
resource "aws_api_gateway_integration" "options_integrations" {
  for_each = var.resources

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.key].id
  http_method = aws_api_gateway_method.options_methods[each.key].http_method

  type                 = "MOCK"
  passthrough_behavior = "WHEN_NO_MATCH"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }

  depends_on = [
    aws_api_gateway_method.options_methods
  ]

  lifecycle {
    create_before_destroy = true
  }
}

# OPTIONS method responses
resource "aws_api_gateway_method_response" "options_method_responses" {
  for_each = var.resources

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.key].id
  http_method = aws_api_gateway_method.options_methods[each.key].http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
    # Removed Access-Control-Allow-Credentials - cannot use with '*' origin in integration response
    # Lambda functions will return proper CORS headers with credentials for actual requests
  }

  response_models = {
    "application/json" = "Empty"
  }

  depends_on = [
    aws_api_gateway_method.options_methods
  ]

  lifecycle {
    create_before_destroy = true
  }
}

# OPTIONS integration responses
resource "aws_api_gateway_integration_response" "options_integration_responses" {
  for_each = var.resources

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.key].id
  http_method = aws_api_gateway_method.options_methods[each.key].http_method
  status_code = aws_api_gateway_method_response.options_method_responses[each.key].status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With'"
    "method.response.header.Access-Control-Allow-Methods" = "'POST,OPTIONS,GET,DELETE,PUT'"
    # Note: Integration response parameters don't support dynamic header mapping
    # Using '*' for preflight - browsers accept this for OPTIONS requests
    # Actual API responses will need CORS headers from Lambda functions
    "method.response.header.Access-Control-Allow-Origin" = "'*'"
    # Cannot use credentials with '*' - browsers reject it
    # Credentials will work for actual API responses if Lambda returns proper CORS headers
  }

  response_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }

  depends_on = [
    aws_api_gateway_integration.options_integrations,
    aws_api_gateway_method_response.options_method_responses
  ]

  lifecycle {
    create_before_destroy = true
  }
}

# API Gateway method throttling settings
resource "aws_api_gateway_method_settings" "protected_endpoints" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  method_path = "*/*"

  settings {
    # Throttle settings: 5 requests per second, burst of 10
    throttling_burst_limit = var.throttle_burst_limit
    throttling_rate_limit  = var.throttle_rate_limit

    # Logging
    logging_level      = "ERROR"
    data_trace_enabled = false
    metrics_enabled    = true
  }

  depends_on = [aws_api_gateway_stage.this]
}

# Usage plan for additional rate limiting control
resource "aws_api_gateway_usage_plan" "protected" {
  name = "${var.api_name}-usage-plan"

  api_stages {
    api_id = aws_api_gateway_rest_api.this.id
    stage  = aws_api_gateway_stage.this.stage_name
  }

  # Daily quota: 50,000 requests per day
  quota_settings {
    limit  = var.daily_quota_limit
    period = "DAY"
  }

  throttle_settings {
    burst_limit = var.throttle_burst_limit
    rate_limit  = var.throttle_rate_limit
  }

  tags = var.tags

  depends_on = [aws_api_gateway_stage.this]
}

# API Key for machine-to-machine communication (internal services only)
resource "aws_api_gateway_api_key" "internal" {
  name        = "${var.api_name}-internal-key"
  description = "API key for internal machine-to-machine communication"
  enabled     = true

  tags = var.tags
}

# Usage plan key to enable API key throttling
resource "aws_api_gateway_usage_plan_key" "internal" {
  key_id        = aws_api_gateway_api_key.internal.id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.protected.id
}

# Gateway Response for CORS - handles CORS headers for error responses (including AWS_PROXY)
# Note: Gateway Response response_parameters don't support Velocity expressions for request headers,
# so we use '*' for origin. This is acceptable for error responses since preflight (OPTIONS) 
# already handles dynamic origin correctly.
resource "aws_api_gateway_gateway_response" "cors_4xx" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "DEFAULT_4XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'*'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'POST,OPTIONS,GET,DELETE,PUT'"
    # Note: Cannot use credentials with '*' origin - browsers will reject it
    # Preflight OPTIONS requests handle credentials correctly via integration responses
  }

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
}

resource "aws_api_gateway_gateway_response" "cors_5xx" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "DEFAULT_5XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'*'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'POST,OPTIONS,GET,DELETE,PUT'"
  }

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
}

# Gateway Response for UNAUTHORIZED (401) - common for auth errors
resource "aws_api_gateway_gateway_response" "cors_401" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "UNAUTHORIZED"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'*'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'POST,OPTIONS,GET,DELETE,PUT'"
  }

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
}

# Gateway Response for ACCESS_DENIED (403) - common for authorization errors
resource "aws_api_gateway_gateway_response" "cors_403" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "ACCESS_DENIED"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'*'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Requested-With'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'POST,OPTIONS,GET,DELETE,PUT'"
  }

  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
}

