# Simplified API Gateway Module

This module creates a simplified API Gateway based on working CloudFormation patterns. It's designed to be easy to use and maintain, with minimal configuration required.

## Features

- ✅ **Simple Configuration**: Define resources and methods in a clean, declarative way
- ✅ **Automatic CORS**: Built-in CORS headers for all methods
- ✅ **Lambda Integration**: Easy Lambda function integration
- ✅ **MOCK Support**: Support for MOCK integrations (like OPTIONS preflight)
- ✅ **Automatic Permissions**: Lambda permissions created automatically

## Usage

### Basic Example

```hcl
module "api_gateway" {
  source = "./modules/api-gateway"

  api_name        = "my-api"
  api_description = "My API Gateway"
  stage_name      = "production"

  # Define resources
  resources = {
    users = {
      path_part = "users"
    }
    user_profile = {
      path_part = "profile"
    }
  }

  # Define methods
  methods = {
    # GET method for user profile
    user_profile_get = {
      resource_key         = "user_profile"
      http_method          = "GET"
      integration_type     = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn           = module.my_lambda.function_arn
    }
    
    # POST method for user profile
    user_profile_post = {
      resource_key         = "user_profile"
      http_method          = "POST"
      integration_type     = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn           = module.my_lambda.function_arn
    }
    
    # OPTIONS method for CORS preflight
    user_profile_options = {
      resource_key         = "user_profile"
      http_method          = "OPTIONS"
      integration_type     = "MOCK"
      integration_http_method = "POST"
      lambda_arn           = null
    }
  }

  tags = {
    Environment = "production"
    Project     = "my-project"
  }
}
```

### Advanced Example with Request Parameters

```hcl
module "api_gateway" {
  source = "./modules/api-gateway"

  api_name        = "my-api"
  api_description = "My API Gateway"
  stage_name      = "production"

  resources = {
    stocks = {
      path_part = "stocks"
    }
    volatility = {
      path_part = "volatility"
    }
  }

  methods = {
    volatility_get = {
      resource_key         = "volatility"
      http_method          = "GET"
      integration_type     = "AWS_PROXY"
      integration_http_method = "POST"
      lambda_arn           = module.stock_lambda.function_arn
      request_parameters = {
        "method.request.querystring.ticker" = true
        "method.request.querystring.period" = false  # optional
      }
    }
    
    volatility_options = {
      resource_key         = "volatility"
      http_method          = "OPTIONS"
      integration_type     = "MOCK"
      integration_http_method = "POST"
      lambda_arn           = null
    }
  }

  tags = var.common_tags
}
```

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| api_name | Name of the API Gateway | `string` | n/a | yes |
| api_description | Description of the API Gateway | `string` | `"API Gateway for Lambda functions"` | no |
| stage_name | Name of the API Gateway stage | `string` | `"production"` | no |
| resources | Map of API Gateway resources to create | `map(object({path_part = string}))` | `{}` | no |
| methods | Map of API Gateway methods to create | `map(object({resource_key = string, http_method = string, integration_type = string, integration_http_method = string, lambda_arn = optional(string), request_parameters = optional(map(bool))}))` | `{}` | no |
| tags | Tags to apply to resources | `map(string)` | `{}` | no |

## Outputs

| Name | Description |
|------|-------------|
| rest_api_id | ID of the REST API |
| rest_api_arn | ARN of the REST API |
| rest_api_execution_arn | Execution ARN of the REST API |
| stage_url | URL of the API Gateway stage |
| deployment_id | ID of the API Gateway deployment |
| stage_name | Name of the API Gateway stage |

## Method Configuration

Each method in the `methods` map supports the following configuration:

- **resource_key**: Key of the resource in the `resources` map
- **http_method**: HTTP method (GET, POST, PUT, DELETE, OPTIONS, etc.)
- **integration_type**: Either "AWS_PROXY" for Lambda or "MOCK" for preflight
- **integration_http_method**: HTTP method for integration (usually "POST")
- **lambda_arn**: Lambda function ARN (null for MOCK integrations)
- **request_parameters**: Map of request parameters (optional)

## CORS Support

The module automatically adds CORS headers to all methods:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token`
- `Access-Control-Allow-Methods: POST,OPTIONS,GET`

## Adding New Methods

To add a new method, simply add it to the `methods` map:

```hcl
methods = {
  # Existing methods...
  
  # New method
  new_endpoint_post = {
    resource_key         = "existing_resource"
    http_method          = "POST"
    integration_type     = "AWS_PROXY"
    integration_http_method = "POST"
    lambda_arn           = module.new_lambda.function_arn
  }
}
```

## Removing Methods

To remove a method, simply delete it from the `methods` map. Terraform will automatically remove the associated resources.
