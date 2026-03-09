# API Gateway Module Variables
# modules/api-gateway/variables.tf

variable "api_name" {
  description = "Name of the API Gateway"
  type        = string
}

variable "api_description" {
  description = "Description of the API Gateway"
  type        = string
  default     = "API Gateway for Lambda functions"
}

variable "stage_name" {
  description = "Name of the API Gateway stage"
  type        = string
  default     = "production"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}

# Resources configuration
variable "resources" {
  description = "Map of API Gateway resources to create"
  type = map(object({
    path_part           = string
    parent_resource_key = optional(string)
  }))
  default = {}
}

# Methods configuration
variable "methods" {
  description = "Map of API Gateway methods to create"
  type = map(object({
    resource_key            = string
    http_method             = string
    integration_type        = string # "AWS_PROXY" or "MOCK"
    integration_http_method = string
    lambda_arn              = optional(string)
    request_parameters      = optional(map(bool), {})
    timeout_milliseconds    = optional(number, 29000)  # Default 29 seconds, max for API Gateway
    authorization_type      = optional(string, "NONE") # "NONE" or "COGNITO_USER_POOLS"
    authorization_scopes    = optional(list(string), [])
  }))
  default = {}
}

# Lambda permissions configuration
variable "lambda_permissions" {
  description = "Map of Lambda permissions to create for API Gateway integration"
  type = map(object({
    function_arn  = string
    http_method   = string
    resource_path = string
  }))
  default = {}
}

# Deployment trigger variable
variable "deployment_trigger" {
  description = "Trigger for API Gateway deployment (change this to force redeployment)"
  type        = string
  default     = "1"
}

# Cognito User Pool authorizer (REST API)
variable "cognito_user_pool_arn" {
  description = "ARN of the Cognito User Pool for authorizer"
  type        = string
}

# Rate limiting configuration
variable "throttle_rate_limit" {
  description = "Throttle rate limit (requests per second)"
  type        = number
  default     = 5
}

variable "throttle_burst_limit" {
  description = "Throttle burst limit"
  type        = number
  default     = 10
}

variable "daily_quota_limit" {
  description = "Daily API quota per user"
  type        = number
  default     = 50000
}

# Force Cognito authorization for all methods
variable "force_cognito_authorization" {
  description = "When true, all methods use Cognito authorizer regardless of per-method config"
  type        = bool
  default     = true
}

