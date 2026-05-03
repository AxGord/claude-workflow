---
name: aws-lambda
description: AWS Lambda .NET deployment gotchas
---

# AWS Lambda + .NET Gotchas

## VPC Networking

- **Subnet IP exhaustion on scale-up.** Each ENI consumes an IP from subnet. ENI account limit = 350 default. New instances silently fail to start when exhausted.
- **ENI creation lag: up to 90s** when function is created or VPC config changes. Invocations during this window get unpredictable cold starts.
- **S3/Secrets Manager calls timeout silently (not connection refused)** when Lambda is in VPC without NAT/VPC Endpoint. Easy to misdiagnose as SDK bug.

## Logging

- **`Console.Error.WriteLine()` does NOT appear in CloudWatch.** Use `ILambdaContext.Logger.LogLine()` in handler code or `ILogger` in ASP.NET pipeline.
- **Missing `logs:CreateLogGroup` permission = logs silently lost.** Log group created lazily on first invoke. No permission = no log group = nowhere to write = no error visible anywhere.

## ASP.NET Core in Lambda

- **`UseHttpsRedirection()` hangs Lambda.** No Kestrel HTTPS port. Middleware hangs trying to discover one (aws-lambda-dotnet #1543). Only enable in Development.
- **Response > 6MB crashes INIT phase, not 413.** `APIGatewayHttpApiV2ProxyFunction` throws exception in Lambda runtime client during initialization, taking down the entire ASP.NET Core app instead of returning HTTP error.

## S3 from Lambda

- **SDK default timeout = infinite, retry = 4 with exponential backoff.** Total wait 30-60s can exceed Lambda timeout. Always set `Timeout` and `MaxErrorRetry` on `AmazonS3Config`.
- **`AmazonS3Client` without explicit region defaults to `us-east-1`.** Cross-region requests are slower. No error if IAM allows it — silent performance degradation.
- **IMDS credential error is cached.** If Instance Metadata Service is transiently unavailable during first init, SDK caches the error. All subsequent requests fail until container restart.

## .NET Cold Start

- **ReadyToRun (R2R) compiled on macOS/Windows is ignored in Lambda (Amazon Linux 2).** Must publish with `--runtime linux-x64`. R2R flag silently has no effect cross-platform.
- **Container deploy: INIT phase is billed. ZIP deploy: INIT phase is free.** For .NET with heavy startup, significant cost difference.
- **EF Core `Database.Migrate()` default command timeout = 30s.** Heavy migrations fail with EF timeout, not Lambda timeout. Set `CommandTimeout` explicitly.

## Function URL

- **CORS headers not returned without `Origin` header in request.** Preflight without Origin returns 200 but no Access-Control-* headers. Browser blocks the actual request. Hard to diagnose — server returns 200.

## IAM & Deployment

- **`UpdateFunctionCode` + `UpdateFunctionConfiguration` cannot run simultaneously.** Gives `ResourceConflictException`. CI/CD must wait for `LastUpdateStatus: Successful` between calls.
- **`State: Active` does NOT mean ready.** `LastUpdateStatus: InProgress` means API calls will fail with `ResourceConflictException`. Must check both fields.
- **Provisioned Concurrency on alias/version doesn't help `$LATEST`.** Must invoke the aliased version to benefit. CLI deploys without explicit alias still get cold starts.
