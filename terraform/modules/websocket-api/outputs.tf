# WebSocket API Gateway Module Outputs
# modules/websocket-api/outputs.tf

output "api_id" {
  description = "ID of the WebSocket API Gateway"
  value       = aws_apigatewayv2_api.this.id
}

output "api_arn" {
  description = "ARN of the WebSocket API Gateway"
  value       = aws_apigatewayv2_api.this.arn
}

output "api_execution_arn" {
  description = "Execution ARN of the WebSocket API Gateway"
  value       = aws_apigatewayv2_api.this.execution_arn
}

output "stage_url" {
  description = "WebSocket URL for the API Gateway stage"
  value       = aws_apigatewayv2_stage.this.invoke_url
}

output "deployment_id" {
  description = "ID of the WebSocket API Gateway deployment"
  value       = aws_apigatewayv2_deployment.this.id
}

output "stage_name" {
  description = "Name of the WebSocket API Gateway stage"
  value       = aws_apigatewayv2_stage.this.name
}
